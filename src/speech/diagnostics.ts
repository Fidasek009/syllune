import { MAX_VOICE_ID_LENGTH } from "./protocol.ts"
import catalog from "./voices.json"
import { isElapsed, isRecord, isWorkerField, workerDurationFields, type WorkerTimings } from "./worker-timings.ts"

/** Configured runtime values and elapsed times only; never source text or errors. */
const gpuFallbackReasons = [
	"gpu-initialization-failed",
	"gpu-inference-failed",
	"gpu-initialization-timeout",
	"gpu-inference-timeout",
	"cpu-first-clip",
] as const
export type GpuFallbackReason = (typeof gpuFallbackReasons)[number]

export interface SpeechDiagnostics extends WorkerTimings {
	backend?: "cpu" | "gpu"
	voice?: string
	modelReadMs?: number
	loadMs?: number
	synthesisMs?: number
	reusedSession?: boolean
	modelReusedOnFallback?: boolean
	gpuFallbackReason?: GpuFallbackReason
}

export interface SpeechPerformance extends SpeechDiagnostics {
	timeToFirstBufferMs: number
	/** Native `playing` event readiness; not a hardware speaker-loopback measurement. */
	timeToFirstAudioMs?: number
	recordedAt: string
}

const engineDurations = ["modelReadMs", "loadMs", "synthesisMs"] as const
const voiceIds = new Set(catalog.voices.map((voice) => voice.id))

function knownVoice(id: unknown): id is string {
	return typeof id === "string" && id.length <= MAX_VOICE_ID_LENGTH && voiceIds.has(id)
}

/** Copy an explicit allowlist at transport and persistence boundaries. */
export function speechDiagnostics(value: unknown): SpeechDiagnostics {
	if (!isRecord(value)) return {}
	const result: SpeechDiagnostics = {}
	for (const field of [...workerDurationFields, ...engineDurations])
		if (isElapsed(value[field])) result[field] = value[field]
	if (isWorkerField("threads", value.threads)) result.threads = value.threads as number
	if (isWorkerField("decoders", value.decoders)) result.decoders = value.decoders as number
	if (typeof value.crossOriginIsolated === "boolean") result.crossOriginIsolated = value.crossOriginIsolated
	if (value.backend === "cpu" || value.backend === "gpu") result.backend = value.backend
	if (knownVoice(value.voice)) result.voice = value.voice
	if (typeof value.reusedSession === "boolean") result.reusedSession = value.reusedSession
	if (typeof value.modelReusedOnFallback === "boolean") result.modelReusedOnFallback = value.modelReusedOnFallback
	const fallback = gpuFallbackReasons.find((reason) => reason === value.gpuFallbackReason)
	if (fallback) result.gpuFallbackReason = fallback
	return result
}

/** Buffer readiness and native playback readiness are distinct metrics. */
export function firstBufferPerformance(
	diagnostics: unknown,
	timeToFirstBufferMs: number,
): SpeechPerformance | undefined {
	if (!isElapsed(timeToFirstBufferMs)) return
	return { ...speechDiagnostics(diagnostics), timeToFirstBufferMs, recordedAt: new Date().toISOString() }
}

export function firstAudioPerformance(
	diagnostics: unknown,
	timeToFirstBufferMs: number,
	timeToFirstAudioMs: number,
): SpeechPerformance | undefined {
	const record = firstBufferPerformance(diagnostics, timeToFirstBufferMs)
	if (!record || !isElapsed(timeToFirstAudioMs) || timeToFirstAudioMs < timeToFirstBufferMs) return
	return { ...record, timeToFirstAudioMs }
}
