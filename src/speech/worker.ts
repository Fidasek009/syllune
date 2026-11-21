import { createEspeak } from "@spelling-creator/spellophone/browser"
import * as ort from "onnxruntime-web"

import type { DecoderRequest, DecoderResponse } from "./decoder-protocol.ts"
import type { VoiceConfig } from "./voice-config.ts"
import type { WorkerTimings } from "./worker-timings.ts"

import { speechDataFetch } from "./data-fetch.ts"
import { isDecoderResponse } from "./decoder-protocol.ts"
import { SpeechTextError } from "./errors.ts"
import { DECODER_CONTEXT_FRAMES, splitVoice } from "./instrument.ts"
import { alignWords, tokenizeEvents, tokenizeText } from "./phonemes.ts"
import { isWorkerRequest, type WorkerResponse } from "./worker-protocol.ts"

declare const SPEECH_BACKEND: "wasm" | "webgpu"
const base = new URL("../", self.location.href)
ort.env.wasm.wasmPaths = new URL(`ort/${SPEECH_BACKEND}/`, base).href
const cores = navigator.hardwareConcurrency || 1
const threads = self.crossOriginIsolated ? Math.max(1, Math.min(4, cores)) : 1
ort.env.wasm.numThreads = threads
ort.env.wasm.proxy = false
// Without cross-origin isolation there is one WebAssembly thread to spend, so
// the vocoder runs in separate workers on overlapping latent windows instead.
const parallelDecode = SPEECH_BACKEND === "wasm" && threads < 2 && cores >= 2
const decoderCount = parallelDecode ? Math.min(4, Math.max(2, cores - 1)) : 0
const hop = 256

interface Decoder {
	ready: Promise<void>
	send(message: DecoderRequest, transfer?: Transferable[]): Promise<DecoderResponse>
	terminate(): void
}

let session: ort.InferenceSession | undefined
let decoders: Decoder[] | undefined
let latentName: string | undefined
let phonemizer: Awaited<ReturnType<typeof createEspeak>> | undefined
let voiceId: string | undefined
// GPU inference can fail after a successful load. Retain its source buffer so
// the CPU retry transfers ownership rather than rereading the full model.
let fallbackModel: ArrayBuffer | undefined
let config: VoiceConfig | undefined
let busy = false

function createDecoders(model: ArrayBuffer, count: number): Decoder[] {
	return Array.from({ length: count }, () => {
		const worker = new Worker(new URL("decoder.js", self.location.href), { type: "module" })
		let sequence = 0
		let settle: { resolve: () => void; reject: (error: Error) => void } | undefined
		const ready = new Promise<void>((resolve, reject) => {
			settle = { resolve, reject }
		})
		// A rejection here is observed by the first decode that awaits it.
		ready.catch(() => {})
		const send = (message: DecoderRequest, transfer: Transferable[] = []) =>
			new Promise<DecoderResponse>((resolve, reject) => {
				const id = ++sequence
				worker.onmessage = ({ data }: MessageEvent<unknown>) => {
					if (!isDecoderResponse(data) || data.id !== id) return
					if (!data.ok) {
						const error = new Error(data.error)
						settle?.reject(error)
						reject(error)
						return
					}
					if (data.type === "load") settle?.resolve()
					resolve(data)
				}
				worker.onerror = (event) => {
					const error = new Error(event.message || "Vocoder worker stopped")
					settle?.reject(error)
					reject(error)
				}
				worker.postMessage({ ...message, id } satisfies DecoderRequest, transfer)
			})
		// Load without blocking the speech load: the first window starts as soon
		// as its own worker answers, while the others keep initializing.
		send({ id: 0, type: "load", model }).catch(() => {})
		return { ready, send, terminate: () => worker.terminate() }
	})
}

function stopDecoders() {
	for (const decoder of decoders ?? []) decoder.terminate()
	decoders = undefined
	latentName = undefined
}

/** Decode latent windows in parallel and trim each window to the samples it owns. */
async function decodeWindows(latent: ort.Tensor): Promise<Float32Array<ArrayBuffer>> {
	const workers = decoders
	const [batch, channels, frames] = latent.dims as [number, number, number]
	if (!workers || batch !== 1 || !channels || !frames) throw new Error("Voice latent is invalid")
	const data = latent.data as Float32Array
	// Each window carries decoder context on both sides; very short clips gain
	// nothing from splitting.
	const count = Math.min(workers.length, Math.max(1, Math.ceil(frames / 24)))
	const size = Math.ceil(frames / count)
	const parts = await Promise.all(
		Array.from({ length: count }, async (_, index) => {
			const first = index * size
			const last = Math.min(frames, first + size)
			const from = Math.max(0, first - DECODER_CONTEXT_FRAMES)
			const to = Math.min(frames, last + DECODER_CONTEXT_FRAMES)
			const window = new Float32Array(channels * (to - from))
			for (let channel = 0; channel < channels; channel++)
				window.set(data.subarray(channel * frames + from, channel * frames + to), channel * (to - from))
			await workers[index]!.ready
			const response = await workers[index]!.send(
				{ id: 0, type: "decode", latent: window, dims: [1, channels, to - from] },
				[window.buffer],
			)
			if (!response.ok || response.type !== "decode") throw new Error("Vocoder returned no audio")
			const start = (first - from) * hop
			return response.pcm.subarray(start, start + (last - first) * hop)
		}),
	)
	const pcm = new Float32Array(frames * hop)
	let offset = 0
	for (const part of parts) {
		pcm.set(part, offset)
		offset += part.length
	}
	return pcm
}

self.onmessage = async ({ data }: MessageEvent<unknown>) => {
	if (
		!data ||
		typeof data !== "object" ||
		!("id" in data) ||
		typeof data.id !== "number" ||
		!Number.isSafeInteger(data.id) ||
		!("type" in data)
	)
		return
	const id = data.id
	if (busy) {
		self.postMessage({ id, ok: false, error: "Speech worker is busy" } satisfies WorkerResponse)
		return
	}
	busy = true
	try {
		if (!isWorkerRequest(data)) throw new Error("Invalid speech request")
		if (data.type === "load") {
			const started = performance.now()
			const model = data.model
			fallbackModel = SPEECH_BACKEND === "webgpu" && model instanceof ArrayBuffer ? model : undefined
			await session?.release()
			session = undefined
			stopDecoders()
			voiceId = undefined
			config = data.config
			const timings: WorkerTimings = { crossOriginIsolated: self.crossOriginIsolated }
			const pronunciation = (async () => {
				const began = performance.now()
				phonemizer ??= await createEspeak({
					dataUrl: new URL("espeak-ng-data/", base),
					fetch: speechDataFetch(new URL("espeak-ng-data/", base)),
					wasmUrl: new URL("espeak-ng.wasm", base),
					languages: [],
					phonemeEvents: "ipa",
				})
				await phonemizer.loadVoice(data.config.espeak.voice)
				timings.phonemizerMs = performance.now() - began
			})()
			const modelBytes = (async () => {
				if (!(model instanceof Blob)) return model
				const began = performance.now()
				const bytes = await model.arrayBuffer()
				timings.modelBytesMs = performance.now() - began
				return bytes
			})()
			const gpuAdapter = (async () => {
				if (SPEECH_BACKEND === "webgpu") {
					const began = performance.now()
					const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" })
					if (!adapter || adapter.info.isFallbackAdapter) throw new Error("Hardware GPU is unavailable")
					ort.env.webgpu.adapter = adapter
					timings.gpuAdapterMs = performance.now() - began
				}
			})()
			const modelSession = (async () => {
				let [bytes] = await Promise.all([modelBytes, gpuAdapter])
				const began = performance.now()
				if (parallelDecode) {
					let workers: Decoder[] | undefined
					try {
						const splitBegan = performance.now()
						const split = splitVoice(bytes as ArrayBuffer)
						timings.splitMs = performance.now() - splitBegan
						session = await ort.InferenceSession.create(split.encoder, {
							executionProviders: ["wasm"],
							executionMode: "parallel",
							graphOptimizationLevel: "disabled",
							extra: { session: { disable_prepacking: "1" } },
						})
						// Spawn the vocoder workers after the encoder is ready so their
						// initialization cannot delay the load response. Small vocoders
						// decode quickly enough that a wider pool only adds startup work.
						workers = createDecoders(
							split.decoder.buffer,
							split.decoder.byteLength >= 24_000_000 ? decoderCount : Math.min(2, decoderCount),
						)
						latentName = session.outputNames.find((name) => name !== "read_aloud_durations")
						if (!latentName) throw new Error("Voice encoder has no latent output")
						decoders = workers
						// Release the full model before the vocoder copies take memory.
						bytes = new ArrayBuffer(0)
					} catch {
						for (const decoder of workers ?? []) decoder.terminate()
						await session?.release()
						session = undefined
						decoders = undefined
						latentName = undefined
					}
				}
				if (!session)
					session = await ort.InferenceSession.create(bytes, {
						executionProviders: [SPEECH_BACKEND],
						// Parallel mode avoids the costly sequential allocation plan in ORT 1.31.
						executionMode: SPEECH_BACKEND === "wasm" ? "parallel" : "sequential",
						graphOptimizationLevel: SPEECH_BACKEND === "wasm" ? "disabled" : "all",
						extra: { session: { disable_prepacking: "1" } },
					})
				timings.sessionMs = performance.now() - began
				if (decoders) timings.decoders = decoders.length
			})()
			await Promise.all([pronunciation, modelSession])
			// Runtime initialization lowers this value when WebAssembly threads are
			// unavailable, so report the effective count rather than the request.
			timings.threads = ort.env.wasm.numThreads ?? 1
			voiceId = data.voice
			timings.workerLoadMs = performance.now() - started
			self.postMessage({ id, ok: true, type: "load", timings } satisfies WorkerResponse)
		} else if (data.type === "synthesize" && voiceId && session && phonemizer && config) {
			const tokens =
				config.phoneme_type === "text"
					? tokenizeText(data.text, config.phoneme_id_map, config.espeak.voice)
					: tokenizeEvents(
							data.text,
							phonemizer.synthesize(data.text).events,
							config.phoneme_id_map,
							config.phoneme_map,
						)
			const ids = BigInt64Array.from(tokens.ids, BigInt)
			const feeds: Record<string, ort.Tensor> = {
				input: new ort.Tensor("int64", ids, [1, ids.length]),
				input_lengths: new ort.Tensor("int64", new BigInt64Array([BigInt(ids.length)]), [1]),
				scales: new ort.Tensor(
					"float32",
					new Float32Array([
						config.inference.noise_scale,
						config.inference.length_scale / data.speed,
						config.inference.noise_w,
					]),
					[3],
				),
			}
			// Multi-speaker models read with their first speaker; the app exposes one voice per model.
			if (session.inputNames.includes("sid")) feeds.sid = new ort.Tensor("int64", new BigInt64Array([0n]), [1])
			const output = await session.run(feeds)
			const pcm =
				decoders && latentName
					? await decodeWindows(output[latentName]!)
					: Float32Array.from(output.output!.data as Float32Array)
			const durations = output.read_aloud_durations!.data as Float32Array
			const alignment = alignWords(tokens, durations, config.audio.sample_rate, config.hop_length ?? hop)
			if (!pcm.length || pcm.some((value) => !Number.isFinite(value)) || Math.abs(pcm.length - alignment.samples) > 256)
				throw new Error("Speech output is invalid")
			self.postMessage(
				{
					id,
					ok: true,
					type: "synthesize",
					pcm,
					sampleRate: config.audio.sample_rate,
					words: alignment.timings,
				} satisfies WorkerResponse,
				[pcm.buffer],
			)
		} else throw new Error("Invalid speech request")
	} catch (error) {
		// Return ownership after a failed load so CPU fallback can reuse the
		// exact bytes without an unconditional 60+ MB copy on successful loads.
		const model =
			data.type === "load" && "model" in data && data.model instanceof ArrayBuffer && data.model.byteLength
				? data.model
				: !(error instanceof SpeechTextError)
					? fallbackModel
					: undefined
		if (model) fallbackModel = undefined
		self.postMessage(
			{
				id,
				ok: false,
				error: error instanceof Error ? error.message : "Speech could not be generated",
				...(error instanceof SpeechTextError ? { code: "unreadable-text" as const } : {}),
				...(model ? { model } : {}),
			} satisfies WorkerResponse,
			model ? [model] : [],
		)
	} finally {
		busy = false
	}
}
