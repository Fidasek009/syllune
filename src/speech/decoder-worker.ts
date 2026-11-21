import * as ort from "onnxruntime-web"

import type { DecoderResponse } from "./decoder-protocol.ts"

import { isDecoderRequest } from "./decoder-protocol.ts"

// Browsers without cross-origin isolation run one WebAssembly thread, so the
// speech worker splits the vocoder across these workers instead.
const base = new URL("../", self.location.href)
ort.env.wasm.wasmPaths = new URL("ort/wasm/", base).href
ort.env.wasm.numThreads = 1
ort.env.wasm.proxy = false

let session: ort.InferenceSession | undefined
let busy = false
self.onmessage = async ({ data }: MessageEvent<unknown>) => {
	if (!isDecoderRequest(data)) return
	const { id } = data
	if (busy) {
		self.postMessage({ id, ok: false, error: "Vocoder worker is busy" } satisfies DecoderResponse)
		return
	}
	busy = true
	try {
		if (data.type === "load") {
			const started = performance.now()
			await session?.release()
			session = undefined
			session = await ort.InferenceSession.create(data.model, {
				executionProviders: ["wasm"],
				executionMode: "parallel",
				graphOptimizationLevel: "disabled",
				extra: { session: { disable_prepacking: "1" } },
			})
			self.postMessage({
				id,
				ok: true,
				type: "load",
				loadMs: performance.now() - started,
			} satisfies DecoderResponse)
		} else {
			if (!session) throw new Error("Vocoder is not loaded")
			const [batch, channels, frames] = data.dims
			const result = await session.run({
				[session.inputNames[0]!]: new ort.Tensor("float32", data.latent, [batch, channels, frames]),
			})
			const pcm = Float32Array.from(result[session.outputNames[0]!]!.data as Float32Array)
			self.postMessage({ id, ok: true, type: "decode", pcm } satisfies DecoderResponse, [pcm.buffer])
		}
	} catch (error) {
		self.postMessage({
			id,
			ok: false,
			error: error instanceof Error ? error.message : "Vocoder failed",
		} satisfies DecoderResponse)
	} finally {
		busy = false
	}
}
