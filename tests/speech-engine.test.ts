import { expect, test } from "bun:test"

import type { WorkerRequest, WorkerResponse } from "../src/speech/worker-protocol.ts"

import { SpeechEngine, type SpeechEngineRuntime, type SpeechWorker } from "../src/speech/engine.ts"
import config from "./fixtures/en_US-ljspeech-medium.json"

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

function fixture(
	options: {
		gpu?: boolean
		gpuAvailable?: () => Promise<boolean>
		gpuStartupTimeoutMs?: number
		read?: SpeechEngineRuntime["readVoice"]
		respond?: (request: WorkerRequest, backend: "cpu" | "gpu") => Promise<WorkerResponse> | WorkerResponse
	} = {},
) {
	const commands: { request: WorkerRequest; backend: "cpu" | "gpu" }[] = []
	const workers: { backend: string; terminated: boolean }[] = []
	let reads = 0,
		disabled = false
	const runtime: SpeechEngineRuntime = {
		gpuAvailable: options.gpuAvailable ?? (async () => !!options.gpu && !disabled),
		disableGpu: () => {
			disabled = true
		},
		readVoice: async (voice) => {
			reads++
			return options.read ? options.read(voice) : { model: new ArrayBuffer(8), config }
		},
		createWorker(backend) {
			const state = { backend, terminated: false }
			workers.push(state)
			const worker: SpeechWorker = {
				onmessage: null,
				onerror: null,
				terminate: () => {
					state.terminated = true
				},
				postMessage(request, transfer) {
					const received = structuredClone(request, { transfer })
					commands.push({ request: received, backend })
					const response =
						options.respond?.(received, backend) ??
						(received.type === "load"
							? { id: received.id, ok: true, type: "load", timings: { sessionMs: 10 } }
							: {
									id: received.id,
									ok: true,
									type: "synthesize",
									pcm: Float32Array.of(0.1),
									sampleRate: 22050,
									words: [],
								})
					void Promise.resolve(response).then((data) => {
						if (!state.terminated) worker.onmessage?.({ data } as MessageEvent<unknown>)
					})
				},
			}
			return worker
		},
	}
	return {
		engine: new SpeechEngine(runtime, options.gpuStartupTimeoutMs),
		runtime,
		commands,
		workers,
		get reads() {
			return reads
		},
	}
}

test("a reused voice reports warm diagnostics without past initialization timings", async () => {
	const { engine } = fixture()
	await engine.load("en_US-ljspeech-medium")
	await engine.load("en_US-ljspeech-medium")
	expect(engine.diagnostics).toEqual({ backend: "cpu", voice: "en_US-ljspeech-medium", reusedSession: true })
	engine.dispose()
})

test("completed cancelled inference is cached without delivering stale audio", async () => {
	const started = deferred<WorkerRequest>()
	const finished = deferred<WorkerResponse>()
	const f = fixture({
		respond: (request) => {
			if (request.type !== "synthesize") return { id: request.id, ok: true, type: "load", timings: {} }
			if (request.text === "first")
				return { id: request.id, ok: true, type: "synthesize", pcm: Float32Array.of(0.1), sampleRate: 22050, words: [] }
			started.resolve(request)
			return finished.promise
		},
	})
	await f.engine.load("en_US-ljspeech-medium")
	const stale = f.engine.synthesize("hello", 1)
	const request = await started.promise
	f.engine.cancelQueued()
	finished.resolve({
		id: request.id,
		ok: true,
		type: "synthesize",
		pcm: Float32Array.of(0.2),
		sampleRate: 22050,
		words: [],
	})
	await expect(stale).rejects.toMatchObject({ name: "AbortError" })
	expect([...(await f.engine.synthesize("hello", 1)).pcm]).toEqual([...Float32Array.of(0.2)])
	expect(f.commands.filter(({ request }) => request.type === "synthesize")).toHaveLength(1)
	f.engine.dispose()
})

test("cancelled GPU failures do not start CPU fallback", async () => {
	const started = deferred<WorkerRequest>(),
		finished = deferred<WorkerResponse>()
	let model: ArrayBuffer | undefined
	const f = fixture({
		gpu: true,
		respond: (request, backend) => {
			if (request.type === "load") {
				if (backend === "gpu" && request.model instanceof ArrayBuffer) model = request.model
				return { id: request.id, ok: true, type: "load", timings: {} }
			}
			if (backend === "cpu" && request.text === "first") return deferred<WorkerResponse>().promise
			if (backend === "cpu")
				return {
					id: request.id,
					ok: true,
					type: "synthesize",
					pcm: Float32Array.of(0.1),
					sampleRate: 22050,
					words: [],
				}
			if (request.text === "first")
				return {
					id: request.id,
					ok: true,
					type: "synthesize",
					pcm: Float32Array.of(0.1),
					sampleRate: 22050,
					words: [],
				}
			started.resolve(request)
			return finished.promise
		},
	})
	await f.engine.load("en_US-ljspeech-medium")
	await f.engine.synthesize("first", 1)
	const stale = f.engine.synthesize("hello", 1)
	const request = await started.promise
	f.engine.cancelQueued()
	finished.resolve({ id: request.id, ok: false, error: "GPU failed", ...(model ? { model } : {}) })
	await expect(stale).rejects.toMatchObject({ name: "AbortError" })
	expect(f.workers.map(({ backend }) => backend)).toEqual(["cpu", "gpu"])
	expect(await f.runtime.gpuAvailable()).toBe(false)
	// Only an explicit subsequent request initializes CPU, reusing the bytes.
	await f.engine.synthesize("hello again", 1)
	expect(f.workers.map(({ backend }) => backend)).toEqual(["cpu", "gpu", "cpu"])
	expect(f.reads).toBe(1)
	f.engine.dispose()
})

test("GPU inference failure transfers the original model into CPU fallback and disables repeat GPU attempts", async () => {
	let model: ArrayBuffer | undefined
	const f = fixture({
		gpu: true,
		respond: (request, backend) => {
			if (request.type === "load") {
				if (backend === "gpu" && request.model instanceof ArrayBuffer) model = request.model
				else expect(request.model).toBeInstanceOf(ArrayBuffer)
				return { id: request.id, ok: true, type: "load", timings: {} }
			}
			if (backend === "cpu" && request.text === "first") return deferred<WorkerResponse>().promise
			return backend === "gpu" && request.text !== "first"
				? { id: request.id, ok: false, error: "GPU failed", ...(model ? { model } : {}) }
				: { id: request.id, ok: true, type: "synthesize", pcm: Float32Array.of(0.1), sampleRate: 22050, words: [] }
		},
	})
	await f.engine.load("en_US-ljspeech-medium")
	await f.engine.synthesize("first", 1)
	await f.engine.synthesize("hello", 1)
	expect(f.reads).toBe(1)
	expect(f.engine.diagnostics).toMatchObject({
		backend: "cpu",
		gpuFallbackReason: "gpu-inference-failed",
		modelReusedOnFallback: true,
	})
	f.engine.dispose()
	await f.engine.load("en_US-ljspeech-medium")
	expect(f.workers.map(({ backend }) => backend)).toEqual(["cpu", "gpu", "cpu", "cpu"])
	f.engine.dispose()
})

test("worker startup overlaps the model read and concurrent loads cannot install a stale voice", async () => {
	const firstRead = deferred<{ model: ArrayBuffer; config: typeof config }>()
	const reading = deferred<void>()
	const f = fixture({
		read: (voice) => {
			if (voice === "en_US-ljspeech-medium") {
				reading.resolve()
				return firstRead.promise
			}
			return Promise.resolve({ model: new ArrayBuffer(8), config })
		},
	})
	const old = f.engine.load("en_US-ljspeech-medium")
	await reading.promise
	expect(f.workers).toHaveLength(1)
	await f.engine.load("cs_CZ-jirka-medium")
	firstRead.resolve({ model: new ArrayBuffer(8), config })
	await expect(old).rejects.toMatchObject({ name: "AbortError" })
	expect(f.engine.diagnostics.voice).toBe("cs_CZ-jirka-medium")
	expect(f.workers[0]!.terminated).toBe(true)
	expect(f.workers[1]!.terminated).toBe(false)
	f.engine.dispose()
})

test("changing reader ownership during a shared model load preserves the pending model preparation", async () => {
	const reading = deferred<void>()
	const model = deferred<{ model: ArrayBuffer; config: typeof config }>()
	const f = fixture({
		read: () => {
			reading.resolve()
			return model.promise
		},
	})
	const oldOwner = f.engine.load("en_US-ljspeech-medium")
	await reading.promise
	f.engine.clearClips()
	const newOwner = f.engine.load("en_US-ljspeech-medium")
	model.resolve({ model: new ArrayBuffer(8), config })
	await Promise.all([oldOwner, newOwner])
	expect(f.reads).toBe(1)
	expect(f.workers).toHaveLength(1)
	expect(f.engine.diagnostics.voice).toBe("en_US-ljspeech-medium")
	await expect(f.engine.synthesize("New reader's text", 1)).resolves.toMatchObject({ sampleRate: 22050 })
	f.engine.dispose()
})

for (const stage of ["load", "synthesize"] as const) {
	test(`a stalled GPU ${stage} cannot delay the CPU first clip`, async () => {
		const f = fixture({
			gpu: true,
			gpuStartupTimeoutMs: 5_000,
			respond(request, backend) {
				if (backend === "gpu" && request.type === stage) return deferred<WorkerResponse>().promise
				if (request.type === "load") return { id: request.id, ok: true, type: "load", timings: {} }
				return {
					id: request.id,
					ok: true,
					type: "synthesize",
					pcm: Float32Array.of(0.1),
					sampleRate: 22050,
					words: [],
				}
			},
		})
		await f.engine.load("en_GB-cori-high")
		const clip = await f.engine.synthesize("Hello", 1)
		expect(clip.pcm).toEqual(Float32Array.of(0.1))
		expect(f.engine.diagnostics).toMatchObject({
			backend: "cpu",
			gpuFallbackReason: "cpu-first-clip",
		})
		expect(f.workers).toEqual([
			{ backend: "cpu", terminated: false },
			{ backend: "gpu", terminated: true },
		])
		expect(f.reads).toBe(1)
		f.engine.dispose()
	})
}

test("CPU playback proceeds while GPU availability is unresolved", async () => {
	const availability = deferred<boolean>()
	const f = fixture({ gpuAvailable: () => availability.promise })
	await f.engine.load("en_GB-cori-high")
	await f.engine.synthesize("Hello", 1)
	availability.resolve(true)
	await Promise.resolve()
	expect(f.workers).toEqual([{ backend: "cpu", terminated: false }])
	expect(f.reads).toBe(1)
	f.engine.dispose()
})

test("a Blob model can start GPU preparation after CPU preparation starts", async () => {
	const availability = deferred<boolean>()
	const cpuLoad = deferred<void>()
	let firstCpuLoad = true
	const f = fixture({
		gpuAvailable: () => availability.promise,
		read: async () => ({ model: new Blob([new Uint8Array([1, 2, 3])]), config }),
		async respond(request, backend) {
			if (request.type === "load") {
				if (!(request.model instanceof Blob)) throw new Error("Expected a cloned Blob")
				expect([...new Uint8Array(await request.model.arrayBuffer())]).toEqual([1, 2, 3])
				if (backend === "cpu" && firstCpuLoad) {
					firstCpuLoad = false
					cpuLoad.resolve()
					return deferred<WorkerResponse>().promise
				}
				return { id: request.id, ok: true, type: "load", timings: {} }
			}
			if (backend === "gpu" && request.text === "Second clip") return { id: request.id, ok: false, error: "GPU failed" }
			return {
				id: request.id,
				ok: true,
				type: "synthesize",
				pcm: Float32Array.of(0.1),
				sampleRate: 22050,
				words: [],
			}
		},
	})
	const loaded = f.engine.load("en_GB-cori-high")
	await cpuLoad.promise
	availability.resolve(true)
	await loaded
	await f.engine.synthesize("First clip", 1)
	expect(f.engine.diagnostics.backend).toBe("gpu")
	expect(f.workers).toEqual([
		{ backend: "cpu", terminated: true },
		{ backend: "gpu", terminated: false },
	])
	await f.engine.synthesize("Second clip", 1)
	expect(f.engine.diagnostics).toMatchObject({
		backend: "cpu",
		modelReusedOnFallback: true,
		gpuFallbackReason: "gpu-inference-failed",
	})
	expect(f.reads).toBe(1)
	f.engine.dispose()
})

test("a voice change closes both workers competing for stale speech", async () => {
	const started = deferred<void>()
	let requests = 0
	const f = fixture({
		gpu: true,
		respond(request) {
			if (request.type === "load") return { id: request.id, ok: true, type: "load", timings: {} }
			if (request.text === "Old selection") {
				if (++requests === 2) started.resolve()
				return deferred<WorkerResponse>().promise
			}
			return {
				id: request.id,
				ok: true,
				type: "synthesize",
				pcm: Float32Array.of(0.2),
				sampleRate: 22050,
				words: [],
			}
		},
	})
	await f.engine.load("en_GB-cori-high")
	const stale = f.engine.synthesize("Old selection", 1)
	const result = stale.catch((error: unknown) => error)
	await started.promise
	await f.engine.load("cs_CZ-jirka-medium")
	const fresh = await f.engine.synthesize("Nový výběr", 1)
	expect(await result).toMatchObject({ name: "AbortError" })
	expect(fresh.pcm).toEqual(Float32Array.of(0.2))
	expect(f.workers.slice(0, 2).every(({ terminated }) => terminated)).toBe(true)
	expect(f.engine.diagnostics.voice).toBe("cs_CZ-jirka-medium")
	f.engine.dispose()
})

test("GPU synthesis after startup uses the normal request deadline", async () => {
	const gpuStartupTimeoutMs = 10
	const f = fixture({
		gpu: true,
		gpuStartupTimeoutMs,
		async respond(request, backend) {
			if (request.type === "load") return { id: request.id, ok: true, type: "load", timings: {} }
			if (backend === "cpu") return deferred<WorkerResponse>().promise
			if (request.text === "A longer passage") await Bun.sleep(gpuStartupTimeoutMs * 2)
			return {
				id: request.id,
				ok: true,
				type: "synthesize",
				pcm: Float32Array.of(0.1),
				sampleRate: 22050,
				words: [],
			}
		},
	})
	await f.engine.load("en_GB-cori-high")
	await f.engine.synthesize("Hello", 1)
	await f.engine.synthesize("A longer passage", 1)
	expect(f.engine.diagnostics.backend).toBe("gpu")
	expect(f.workers).toEqual([
		{ backend: "cpu", terminated: true },
		{ backend: "gpu", terminated: false },
	])
	f.engine.dispose()
})
