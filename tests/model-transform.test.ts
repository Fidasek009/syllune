import { expect, test } from "bun:test"
import protobuf from "protobufjs"

import { instrumentInWorker } from "../src/speech/instrument-client.ts"
import { instrumentModel, splitVoice } from "../src/speech/instrument.ts"

const schema = protobuf.parse(await Bun.file(new URL("../vendor/onnx/onnx.proto3", import.meta.url)).text()).root
const Model = schema.lookupType("onnx.ModelProto")
const fixture = (ceils = 1, names: "scoped" | "numeric" | "absent" = "scoped", strides = [8, 8, 4]) =>
	Model.encode(
		Model.create({
			irVersion: 7,
			graph: {
				name: "timing-fixture",
				node: [
					...Array.from({ length: ceils }, (_, index) => ({
						name: `ceil-${index}`,
						opType: "Ceil",
						input: ["predictions"],
						output: ["frames"],
					})),
					...strides.map((stride, index) => ({
						...(names === "absent"
							? {}
							: { name: names === "scoped" ? `/dec/ups.${index}/ConvTranspose` : `ConvTranspose_${5875 + index}` }),
						opType: "ConvTranspose",
						input: ["audio"],
						output: ["audio"],
						attribute: [{ name: "strides", type: 7, ints: [stride] }],
					})),
				],
				initializer: [{ name: "original-weights", dataType: 1, dims: [1], rawData: Uint8Array.of(0, 0, 128, 63) }],
				output: [{ name: "output" }],
			},
		}),
	).finish()

test("model instrumentation preserves original operators and weights while exposing duration frames", () => {
	const source = fixture()
	const sourceModel = Model.toObject(Model.decode(source)) as any
	const transformed = instrumentModel(Uint8Array.from(source).buffer)
	const result = Model.toObject(Model.decode(transformed)) as any
	expect(result.graph.node.slice(0, -1)).toEqual(sourceModel.graph.node)
	expect(result.graph.initializer).toEqual(sourceModel.graph.initializer)
	expect(result.graph.node.at(-1)).toMatchObject({
		opType: "Identity",
		input: ["frames"],
		output: ["read_aloud_durations"],
	})
	expect(result.graph.output.at(-1)).toMatchObject({
		name: "read_aloud_durations",
		type: { tensorType: { elemType: 1 } },
	})
	expect(result.docString).toContain("Modified by Syllune")
})

test("unrecognized and truncated model graphs are rejected before installation", () => {
	expect(() => instrumentModel(Uint8Array.from(fixture(2)).buffer)).toThrow("unsupported timing graph")
	expect(() => instrumentModel(Uint8Array.from(fixture().slice(0, -3)).buffer)).toThrow()
	expect(() => instrumentModel(new ArrayBuffer(0))).toThrow()
	expect(() => instrumentModel(Uint8Array.from(fixture(1, "numeric", [4, 4, 4])).buffer)).toThrow(
		"unsupported timing graph",
	)
	expect(() => instrumentModel(Uint8Array.from(fixture(1, "absent", [8, 8, 2, 1, 2])).buffer)).toThrow(
		"unsupported timing graph",
	)
})

test("catalog exports with numeric or absent node names retain genuine duration outputs", () => {
	for (const names of ["numeric", "absent"] as const) {
		for (const strides of [
			[8, 8, 4],
			[8, 8, 2, 2],
		]) {
			const source = fixture(1, names, strides)
			const original = Model.toObject(Model.decode(source)) as any
			const transformed = Model.toObject(Model.decode(instrumentModel(Uint8Array.from(source).buffer))) as any
			expect(transformed.graph.node.slice(0, -1)).toEqual(original.graph.node)
			expect(transformed.graph.initializer).toEqual(original.graph.initializer)
			expect(transformed.graph.node.at(-1).input).toEqual(["frames"])
			expect(transformed.graph.output.at(-1).name).toBe("read_aloud_durations")
		}
	}
})

test("duplicate graph operations share a value while keeping exported and nonstandard outputs", () => {
	const original = Model.toObject(Model.decode(fixture())) as any
	original.graph.node.unshift(
		{ opType: "Shape", input: ["predictions"], output: ["first-shape"] },
		{ opType: "Shape", input: ["predictions"], output: ["second-shape"] },
		{ opType: "Shape", input: ["predictions"], output: ["output"] },
		{ opType: "Shape", domain: "example", input: ["predictions"], output: ["custom-shape"] },
		{ opType: "Concat", input: ["second-shape", "output", "custom-shape"], output: ["combined"] },
	)
	original.graph.valueInfo = [{ name: "second-shape" }, { name: "first-shape" }]
	const bytes = Model.encode(original).finish()
	const result = Model.toObject(Model.decode(instrumentModel(Uint8Array.from(bytes).buffer))) as any
	expect(result.graph.node.slice(0, 4).map((node: { output: string[] }) => node.output)).toEqual([
		["first-shape"],
		["output"],
		["custom-shape"],
		["combined"],
	])
	expect(result.graph.node[3].input).toEqual(["first-shape", "output", "custom-shape"])
	expect(result.graph.valueInfo).toEqual([{ name: "first-shape" }])

	// A nested graph can capture a value by name even without an explicit node input.
	original.graph.node.push({
		opType: "If",
		input: ["predicate"],
		output: ["conditional"],
		attribute: [{ name: "then_branch", type: 5, g: { name: "branch", output: [{ name: "second-shape" }] } }],
	})
	const nested = Model.encode(original).finish()
	const kept = Model.toObject(Model.decode(instrumentModel(Uint8Array.from(nested).buffer))) as any
	expect(kept.graph.node[1].output).toEqual(["second-shape"])
	expect(kept.graph.node[4].input[0]).toBe("second-shape")
})

test("voice preparation runs in a worker and returns the same instrumented graph", async () => {
	const source = Uint8Array.from(fixture()).buffer
	const expected = instrumentModel(source.slice(0))
	const output = await instrumentInWorker(
		source,
		new AbortController().signal,
		() => new Worker(new URL("../src/speech/instrument-worker.ts", import.meta.url), { type: "module" }),
	)
	expect(new Uint8Array(output)).toEqual(expected)
	expect(source.byteLength).toBe(0)
})

test("cancelling voice preparation terminates its worker without saving a result", async () => {
	const controller = new AbortController()
	let terminated = false
	const worker = {
		postMessage: () => {},
		terminate: () => {
			terminated = true
		},
	} as unknown as Worker
	const preparation = instrumentInWorker(new ArrayBuffer(8), controller.signal, () => worker)
	controller.abort()
	await expect(preparation).rejects.toMatchObject({ name: "AbortError" })
	expect(terminated).toBe(true)
})

const vocoderFixture = (strides = [8, 8, 4]) =>
	Model.encode(
		Model.create({
			irVersion: 7,
			graph: {
				name: "vocoder-fixture",
				node: [
					{ name: "scale", opType: "Mul", input: ["predictions", "scale"], output: ["latent"] },
					{ name: "ceil", opType: "Ceil", input: ["predictions"], output: ["frames"] },
					{ name: "durations", opType: "Identity", input: ["frames"], output: ["read_aloud_durations"] },
					{ name: "relu", opType: "LeakyRelu", input: ["latent"], output: ["hidden"] },
					...strides.map((stride, index) => ({
						name: `ups-${index}`,
						opType: "ConvTranspose",
						input: [index ? `up-${index - 1}` : "hidden", `weight-${index}`],
						output: [index === strides.length - 1 ? "output" : `up-${index}`],
						attribute: [{ name: "strides", type: 7, ints: [stride] }],
					})),
				],
				initializer: [
					{ name: "scale", dataType: 1, dims: [1], rawData: Uint8Array.of(0, 0, 128, 63) },
					...strides.map((_, index) => ({
						name: `weight-${index}`,
						dataType: 1,
						dims: [192, 1, 16],
						rawData: Uint8Array.of(0, 0, 128, 63),
					})),
				],
				input: [{ name: "predictions" }],
				output: [{ name: "output" }, { name: "read_aloud_durations" }],
			},
		}),
	).finish()

test("voice split keeps the vocoder in a decoder graph that takes the latent", () => {
	const result = splitVoice(Uint8Array.from(vocoderFixture()).buffer)
	const encoder = Model.toObject(Model.decode(result.encoder)) as any
	const decoder = Model.toObject(Model.decode(result.decoder)) as any
	expect(encoder.graph.node.map((node: { name: string }) => node.name)).toEqual(["scale", "ceil", "durations", "relu"])
	expect(encoder.graph.output.map((value: { name: string }) => value.name)).toEqual(["hidden", "read_aloud_durations"])
	expect(decoder.graph.node.map((node: { name: string }) => node.name)).toEqual(["ups-0", "ups-1", "ups-2"])
	expect(decoder.graph.input.map((value: { name: string }) => value.name)).toEqual(["hidden"])
	expect(decoder.graph.output.map((value: { name: string }) => value.name)).toEqual(["output"])
	expect(decoder.graph.initializer.map((value: { name: string }) => value.name)).toEqual([
		"weight-0",
		"weight-1",
		"weight-2",
	])
	expect(encoder.graph.initializer.map((value: { name: string }) => value.name)).toEqual(["scale"])
})

test("voice split rejects graphs whose vocoder cannot stand alone", () => {
	expect(() => splitVoice(Uint8Array.from(vocoderFixture([8, 8, 2])).buffer)).toThrow("hop")
	const withoutUpsampling = Model.encode(
		Model.create({
			irVersion: 7,
			graph: {
				name: "no-vocoder",
				node: [{ name: "ceil", opType: "Ceil", input: ["predictions"], output: ["output"] }],
				input: [{ name: "predictions" }],
				output: [{ name: "output" }],
			},
		}),
	).finish()
	expect(() => splitVoice(Uint8Array.from(withoutUpsampling).buffer)).toThrow("one waveform")
})
