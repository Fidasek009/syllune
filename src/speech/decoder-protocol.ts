/** Speech worker to vocoder worker contract, validated on both sides. */

export type DecoderRequest =
	| { id: number; type: "load"; model: ArrayBuffer }
	| { id: number; type: "decode"; latent: Float32Array<ArrayBuffer>; dims: [number, number, number] }

export type DecoderResponse =
	| { id: number; ok: true; type: "load"; loadMs: number }
	| { id: number; ok: true; type: "decode"; pcm: Float32Array<ArrayBuffer> }
	| { id: number; ok: false; error: string }

export function isDecoderRequest(value: unknown): value is DecoderRequest {
	if (!value || typeof value !== "object" || !("id" in value) || !Number.isSafeInteger(value.id)) return false
	if (!("type" in value)) return false
	if (value.type === "load")
		return "model" in value && Object.prototype.toString.call(value.model) === "[object ArrayBuffer]"
	if (value.type !== "decode" || !("dims" in value)) return false
	const dims = value.dims
	if (!Array.isArray(dims) || dims.length !== 3) return false
	if (!dims.every((dim) => Number.isSafeInteger(dim) && dim > 0)) return false
	return (
		"latent" in value &&
		ArrayBuffer.isView(value.latent) &&
		Object.prototype.toString.call(value.latent) === "[object Float32Array]" &&
		(value.latent as Float32Array).length === (dims[0] as number) * (dims[1] as number) * (dims[2] as number)
	)
}

export function isDecoderResponse(value: unknown): value is DecoderResponse {
	if (!value || typeof value !== "object" || !("id" in value) || !Number.isSafeInteger(value.id)) return false
	if (!("ok" in value)) return false
	if (value.ok === false) return "error" in value && typeof value.error === "string"
	if (!("type" in value)) return false
	if (value.type === "load") return "loadMs" in value && typeof value.loadMs === "number" && value.loadMs >= 0
	return (
		value.type === "decode" &&
		"pcm" in value &&
		ArrayBuffer.isView(value.pcm) &&
		Object.prototype.toString.call(value.pcm) === "[object Float32Array]"
	)
}
