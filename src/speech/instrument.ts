// Wire fields follow the vendored ONNX 1.19.1 schema.
interface Field {
	number: number
	wire: number
	start: number
	payload: number
	end: number
}
const decoder = new TextDecoder()
const encoder = new TextEncoder()
function readInteger(bytes: Uint8Array, start: number, limit: number): [number, number] {
	let value = 0,
		factor = 1
	for (let offset = start; offset < Math.min(start + 5, limit); offset++) {
		const byte = bytes[offset]!
		value += (byte & 127) * factor
		if (byte < 128) {
			if (value > 0xffffffff) throw new Error("ONNX integer exceeds the supported size")
			return [value, offset + 1]
		}
		factor *= 128
	}
	throw new Error("Malformed ONNX integer")
}
function* fields(bytes: Uint8Array, start = 0, limit = bytes.length): Generator<Field> {
	let cursor = start
	while (cursor < limit) {
		const begin = cursor
		const [tag, afterTag] = readInteger(bytes, cursor, limit)
		cursor = afterTag
		const wire = tag & 7,
			number = tag >>> 3
		let payload = cursor
		if (!number) throw new Error("Malformed ONNX field")
		if (wire === 2) {
			const [length, afterLength] = readInteger(bytes, cursor, limit)
			payload = afterLength
			cursor = payload + length
		} else if (wire === 0) {
			// Generic protobuf int64 fields can consume ten bytes. We only read
			// the values of the small positive decoder strides below.
			let count = 0
			do {
				if (cursor >= limit || ++count > 10) throw new Error("Malformed ONNX varint")
			} while (bytes[cursor++]! >= 128)
		} else if (wire === 1) cursor += 8
		else if (wire === 5) cursor += 4
		else throw new Error("Unsupported ONNX wire type")
		if (cursor > limit) throw new Error("Truncated ONNX field")
		yield { number, wire, start: begin, payload, end: cursor }
	}
}
function integer(value: number): Uint8Array<ArrayBuffer> {
	const bytes: number[] = []
	do {
		const byte = value % 128
		value = Math.floor(value / 128)
		bytes.push(byte | (value ? 128 : 0))
	} while (value)
	return Uint8Array.from(bytes)
}
function join(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
	let cursor = 0
	for (const part of parts) {
		result.set(part, cursor)
		cursor += part.length
	}
	return result
}
const message = (field: number, bytes: Uint8Array) => join(integer(field * 8 + 2), integer(bytes.length), bytes)
const string = (field: number, value: string) => message(field, encoder.encode(value))
const scalar = (field: number, value: number) => join(integer(field * 8), integer(value))

const sharedOperators = new Set([
	"Cast",
	"Concat",
	"Constant",
	"ConstantOfShape",
	"Expand",
	"Gather",
	"Identity",
	"ReduceSum",
	"Reshape",
	"Shape",
	"Slice",
	"Squeeze",
	"Transpose",
	"Unsqueeze",
])

function fieldText(bytes: Uint8Array, field?: Field): string {
	return field ? decoder.decode(bytes.subarray(field.payload, field.end)) : ""
}

function shareExpressions(bytes: Uint8Array, graph: Field[]): Uint8Array[] {
	const original = (field: Field) => bytes.subarray(field.start, field.end)
	// Quantization annotations and nested graphs can refer to the original tensor names.
	if (graph.some(({ number }) => number === 14)) return graph.map(original)
	const nodes = new Map<Field, Field[]>()
	for (const field of graph) {
		if (field.number !== 1) continue
		const node = [...fields(bytes, field.payload, field.end)]
		for (const item of node) {
			if (
				item.number === 10 ||
				(item.number === 5 &&
					[...fields(bytes, item.payload, item.end)].some(({ number }) => number === 6 || number === 11))
			)
				return graph.map(original)
		}
		nodes.set(field, node)
	}
	const outputs = new Set(
		graph
			.filter(({ number }) => number === 12)
			.map(({ payload, end }) =>
				fieldText(
					bytes,
					[...fields(bytes, payload, end)].find(({ number }) => number === 1),
				),
			),
	)
	const aliases = new Map<string, string>()
	const expressions = new Map<string, string>()
	const result: Uint8Array[] = []
	for (const field of graph) {
		const node = nodes.get(field)
		if (!node) continue
		const inputs = node.filter(({ number }) => number === 1).map((input) => fieldText(bytes, input))
		const resolved = inputs.map((name) => aliases.get(name) ?? name)
		const names = node.filter(({ number }) => number === 2)
		const output = fieldText(bytes, names[0])
		const op = fieldText(
			bytes,
			node.find(({ number }) => number === 4),
		)
		const attributes = node.filter(({ number }) => number === 5)
		// The standard domain and overload rules determine which implementation runs.
		if (
			names.length === 1 &&
			output &&
			!outputs.has(output) &&
			sharedOperators.has(op) &&
			!node.some((member) => (member.number === 7 || member.number === 8) && fieldText(bytes, member)) &&
			attributes.every(({ start, end }) => end - start <= 64_000)
		) {
			const key = JSON.stringify([op, resolved, attributes.map((item) => original(item).toBase64())])
			const previous = expressions.get(key)
			if (previous) {
				aliases.set(output, previous)
				continue
			}
			expressions.set(key, output)
		}
		let index = 0
		result.push(
			resolved.some((name, i) => name !== inputs[i])
				? message(
						1,
						join(...node.map((member) => (member.number === 1 ? string(1, resolved[index++]!) : original(member)))),
					)
				: original(field),
		)
	}
	for (const field of graph) {
		if (field.number === 1) continue
		if (
			field.number === 13 &&
			aliases.has(
				fieldText(
					bytes,
					[...fields(bytes, field.payload, field.end)].find(({ number }) => number === 1),
				),
			)
		)
			continue
		result.push(original(field))
	}
	return result
}

/** Expose VITS durations and merge repeated deterministic graph operations. */
export function instrumentModel(source: ArrayBuffer): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(source)
	const graphs = [...fields(bytes)].filter((field) => field.number === 7 && field.wire === 2)
	if (graphs.length !== 1) throw new Error("Voice must contain exactly one ONNX graph")
	const graph = graphs[0]!
	const graphFields = [...fields(bytes, graph.payload, graph.end)]
	const ceils: string[] = []
	let upsamplers = 0,
		hop = 1
	for (const field of graphFields) {
		if (field.number !== 1 || field.wire !== 2) continue
		const node = [...fields(bytes, field.payload, field.end)]
		const text = (number: number) => {
			const value = node.find((field) => field.number === number && field.wire === 2)
			return value ? decoder.decode(bytes.subarray(value.payload, value.end)) : ""
		}
		if (text(4) === "Ceil") ceils.push(text(2))
		// Node names are optional exporter metadata, not graph semantics. Older
		// catalog exports use names such as ConvTranspose_5875 instead of /dec/ups.
		if (text(4) === "ConvTranspose") {
			upsamplers++
			let stride: number | undefined
			for (const attr of node.filter((field) => field.number === 5 && field.wire === 2)) {
				const members = [...fields(bytes, attr.payload, attr.end)]
				const name = members.find((field) => field.number === 1)
				if (!name || decoder.decode(bytes.subarray(name.payload, name.end)) !== "strides") continue
				const values = members.filter((field) => field.number === 8)
				if (values.length !== 1) throw new Error("Unsupported ONNX decoder strides")
				const value = values[0]!
				const [number, after] = readInteger(bytes, value.payload, value.end)
				if (after !== value.end || number < 1) throw new Error("Unsupported ONNX decoder stride")
				stride = number
			}
			if (!stride) throw new Error("Missing ONNX decoder stride")
			hop *= stride
		}
	}
	if (ceils.length !== 1 || !ceils[0] || ![3, 4].includes(upsamplers) || hop !== 256)
		throw new Error("This voice has an unsupported timing graph")
	const name = "read_aloud_durations"
	const node = join(string(1, ceils[0]), string(2, name), string(3, name), string(4, "Identity"))
	// ValueInfoProto -> TypeProto.tensor_type -> Tensor{elem_type, shape}
	const shape = join(message(1, scalar(1, 1)), message(1, scalar(1, 1)), message(1, string(2, "tokens")))
	const tensor = join(scalar(1, 1), message(2, shape))
	const info = join(string(1, name), message(2, message(1, tensor)))
	const extraNode = message(1, node)
	const extraOutput = message(12, info)
	const parts = shareExpressions(bytes, graphFields)
	const graphLength = parts.reduce((size, part) => size + part.length, extraNode.length + extraOutput.length)
	return join(
		bytes.subarray(0, graph.start),
		integer(7 * 8 + 2),
		integer(graphLength),
		...parts,
		extraNode,
		extraOutput,
		bytes.subarray(graph.end),
		string(
			6,
			"Modified by Syllune: exposed token durations and shared repeated graph operations. Original weights retained.",
		),
	)
}

/** TensorProto dims are repeated int64, packed by newer exporters and plain by older ones. */
function tensorDims(bytes: Uint8Array, initializer: Field): number[] {
	const dims: number[] = []
	for (const member of fields(bytes, initializer.payload, initializer.end)) {
		if (member.number !== 1) continue
		if (member.wire === 2) {
			for (let cursor = member.payload; cursor < member.end;) {
				const [value, next] = readInteger(bytes, cursor, member.end)
				dims.push(value)
				cursor = next
			}
		} else if (member.wire === 0) dims.push(readInteger(bytes, member.payload, member.end)[0])
	}
	return dims
}

/** Decoder context in latent frames; keeps split windows numerically identical. */
export const DECODER_CONTEXT_FRAMES = 13

export interface SplitVoice {
	encoder: Uint8Array<ArrayBuffer>
	decoder: Uint8Array<ArrayBuffer>
}

function memberText(bytes: Uint8Array, field: Field, number: number): string {
	return fieldText(
		bytes,
		[...fields(bytes, field.payload, field.end)].find((member) => member.number === number && member.wire === 2),
	)
}

/** ValueInfoProto names live in field 1; TensorProto names live in field 8. */
function valueName(bytes: Uint8Array, field: Field): string {
	return memberText(bytes, field, 1)
}

function initializerName(bytes: Uint8Array, field: Field): string {
	return memberText(bytes, field, 8)
}

/**
 * Cut an instrumented voice in two so decoder workers can decode latent windows
 * without shared memory. The encoder keeps the text encoder, flow, duration
 * predictor and everything before the vocoder's first transposed convolution;
 * the decoder keeps the upsampling half and takes the encoder's last tensor.
 */
export function splitVoice(source: ArrayBuffer): SplitVoice {
	const bytes = new Uint8Array(source)
	const graphs = [...fields(bytes)].filter((field) => field.number === 7 && field.wire === 2)
	if (graphs.length !== 1) throw new Error("Voice must contain exactly one ONNX graph")
	const graph = graphs[0]!
	const graphFields = [...fields(bytes, graph.payload, graph.end)]
	if (graphFields.some(({ number }) => number === 14 || number === 15))
		throw new Error("Voice graph contains quantization or sparse annotations")
	const nodeFields = graphFields.filter((field) => field.number === 1 && field.wire === 2)
	const nodes = nodeFields.map((field) => {
		const members = [...fields(bytes, field.payload, field.end)]
		if (members.some(({ number }) => number === 10)) throw new Error("Voice graph contains a nested graph")
		const names = (number: number) =>
			members
				.filter((member) => member.number === number && member.wire === 2)
				.map((member) => fieldText(bytes, member))
		return {
			field,
			inputs: names(1),
			outputs: names(2),
			op: fieldText(
				bytes,
				members.find((member) => member.number === 4 && member.wire === 2),
			),
			members,
		}
	})
	const initializers = graphFields.filter((field) => field.number === 5 && field.wire === 2)
	const initializerNames = new Set(initializers.map((field) => initializerName(bytes, field)))
	const inputFields = graphFields.filter((field) => field.number === 11 && field.wire === 2)
	const outputFields = graphFields.filter((field) => field.number === 12 && field.wire === 2)
	const durationOutput = outputFields.find((field) => valueName(bytes, field) === "read_aloud_durations")
	const waveformOutputs = outputFields.filter((field) => field !== durationOutput)
	if (!durationOutput || waveformOutputs.length !== 1)
		throw new Error("Voice must expose one waveform and one duration output")

	const producer = new Map<string, number>()
	for (const [index, node] of nodes.entries()) for (const name of node.outputs) producer.set(name, index)
	const ancestors = (names: string[]) => {
		const visited = new Set<number>()
		const stack = [...names]
		while (stack.length) {
			const index = producer.get(stack.pop()!)
			if (index === undefined || visited.has(index)) continue
			visited.add(index)
			for (const input of nodes[index]!.inputs) if (!initializerNames.has(input)) stack.push(input)
		}
		return visited
	}
	// The waveform is the upsampling half of the vocoder. Its first transposed
	// convolution divides that half from the encoder and flow that run once.
	const waveform = ancestors([valueName(bytes, waveformOutputs[0]!)])
	const upsamplers = [...waveform].filter((index) => nodes[index]!.op === "ConvTranspose").sort((a, b) => a - b)
	const first = upsamplers[0]
	if (first === undefined) throw new Error("Voice has no transposed convolution in its waveform")
	const latent = nodes[first]!.inputs.find((name) => producer.has(name))
	if (!latent) throw new Error("Voice vocoder has no latent input")
	const feeding = ancestors([latent])
	const decoderNodes = new Set([...waveform].filter((index) => !feeding.has(index)))
	// Shared stateless operations may feed both halves; duplicate them into the
	// decoder rather than moving them out of the encoder.
	const pending = [...decoderNodes]
	while (pending.length) {
		const index = pending.pop()!
		for (const input of nodes[index]!.inputs) {
			if (initializerNames.has(input) || input === latent) continue
			const source = producer.get(input)
			if (source === undefined || decoderNodes.has(source)) continue
			if (!sharedOperators.has(nodes[source]!.op)) throw new Error("Voice graph cannot be split at one tensor")
			decoderNodes.add(source)
			pending.push(source)
		}
	}
	const strideOf = (index: number) => {
		for (const attribute of nodes[index]!.members.filter((member) => member.number === 5 && member.wire === 2)) {
			const members = [...fields(bytes, attribute.payload, attribute.end)]
			const name = members.find((member) => member.number === 1 && member.wire === 2)
			if (!name || fieldText(bytes, name) !== "strides") continue
			const values = members.filter((member) => member.number === 8)
			if (values.length !== 1) throw new Error("Unsupported ONNX decoder strides")
			const value = values[0]!
			const [stride, after] = readInteger(bytes, value.payload, value.end)
			if (after !== value.end || stride < 1) throw new Error("Unsupported ONNX decoder stride")
			return stride
		}
		throw new Error("Missing ONNX decoder stride")
	}
	let hop = 1
	for (const index of decoderNodes) if (nodes[index]!.op === "ConvTranspose") hop *= strideOf(index)
	if (hop !== 256) throw new Error("Voice vocoder does not cover the full waveform hop")
	const encoderNodes = new Set([...feeding, ...ancestors(["read_aloud_durations"])])
	const graphFor = (retained: Set<number>, extraInputs: Uint8Array[], extraOutputs: Uint8Array[]) => {
		const ordered = [...retained].sort((left, right) => left - right)
		const names = new Set(ordered.flatMap((index) => nodes[index]!.inputs))
		const inputs = inputFields.filter((field) => names.has(valueName(bytes, field)))
		const weights = initializers.filter((field) => names.has(initializerName(bytes, field)))
		return join(
			...ordered.map((index) => bytes.subarray(nodes[index]!.field.start, nodes[index]!.field.end)),
			...weights.map((field) => bytes.subarray(field.start, field.end)),
			...inputs.map((field) => bytes.subarray(field.start, field.end)),
			...extraInputs,
			...extraOutputs,
		)
	}
	const weight = nodes[first]!.inputs.find((name) => initializerNames.has(name))
	const channels = weight
		? tensorDims(
				bytes,
				initializers.find((field) => initializerName(bytes, field) === weight)!,
			)![0]
		: undefined
	const dimension = (value: number | string) => (typeof value === "number" ? scalar(1, value) : string(2, value))
	const latentInfo = join(
		string(1, latent),
		message(
			2,
			message(
				1,
				join(
					scalar(1, 1),
					message(
						2,
						join(
							message(1, dimension(1)),
							message(1, dimension(channels ?? "channels")),
							message(1, dimension("frames")),
						),
					),
				),
			),
		),
	)
	const modelFields = [...fields(bytes)].filter(({ number }) => number !== 7)
	const assemble = (name: string, graphField: Uint8Array) =>
		join(
			...modelFields.map((field) => bytes.subarray(field.start, field.end)),
			message(7, join(graphField, string(2, name))),
			string(6, "Modified by Syllune: split into encoder and decoder graphs for parallel synthesis."),
		)
	return {
		encoder: assemble(
			"encoder",
			graphFor(encoderNodes, [], [message(12, latentInfo), bytes.subarray(durationOutput.start, durationOutput.end)]),
		),
		decoder: assemble(
			"decoder",
			graphFor(
				decoderNodes,
				[message(11, latentInfo)],
				[bytes.subarray(waveformOutputs[0]!.start, waveformOutputs[0]!.end)],
			),
		),
	}
}
