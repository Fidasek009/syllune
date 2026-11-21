export interface WorkerTimings {
	threads?: number
	decoders?: number
	crossOriginIsolated?: boolean
	splitMs?: number
	gpuAdapterMs?: number
	modelBytesMs?: number
	phonemizerMs?: number
	sessionMs?: number
	workerLoadMs?: number
}

export const workerDurationFields = [
	"splitMs",
	"gpuAdapterMs",
	"modelBytesMs",
	"phonemizerMs",
	"sessionMs",
	"workerLoadMs",
] as const

export function isElapsed(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value)
}

export function isWorkerField(key: string, value: unknown): boolean {
	if (key === "threads" || key === "decoders")
		return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 256
	if (key === "crossOriginIsolated") return typeof value === "boolean"
	return workerDurationFields.some((field) => field === key) && isElapsed(value)
}

/** Reject extra worker fields before an engine can spread them into diagnostics. */
export function isWorkerTimings(value: unknown): value is WorkerTimings {
	return isRecord(value) && Object.entries(value).every(([key, item]) => isWorkerField(key, item))
}
