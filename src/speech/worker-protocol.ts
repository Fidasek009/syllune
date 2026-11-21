import type { WordTiming } from "./phonemes.ts"
import type { VoiceModel } from "./voice-store.ts"

import { MAX_VOICE_ID_LENGTH, speechRequest } from "./protocol.ts"
import { validateConfig, type VoiceConfig } from "./voice-config.ts"
import { isWorkerTimings, type WorkerTimings } from "./worker-timings.ts"

function isArrayBuffer(value: unknown): value is ArrayBuffer {
	return Object.prototype.toString.call(value) === "[object ArrayBuffer]"
}

export type WorkerRequest =
	| { id: number; type: "load"; voice: string; config: VoiceConfig; model: VoiceModel }
	| { id: number; type: "synthesize"; text: string; speed: number }

export type WorkerCommand =
	Omit<Extract<WorkerRequest, { type: "load" }>, "id"> | Omit<Extract<WorkerRequest, { type: "synthesize" }>, "id">

export type WorkerSuccess =
	| { id: number; ok: true; type: "load"; timings: WorkerTimings }
	| {
			id: number
			ok: true
			type: "synthesize"
			pcm: Float32Array<ArrayBuffer>
			sampleRate: number
			words: WordTiming[]
	  }

export type WorkerResponse =
	WorkerSuccess | { id: number; ok: false; error: string; code?: "unreadable-text"; model?: ArrayBuffer }

/** Validate data received across the worker boundary, including the stored model config. */
export function isWorkerRequest(value: unknown): value is WorkerRequest {
	if (!value || typeof value !== "object" || !("type" in value)) return false
	if (value.type === "synthesize") return speechRequest(value) && value.type === "synthesize"
	if (
		value.type !== "load" ||
		!("id" in value) ||
		!Number.isSafeInteger(value.id) ||
		!("voice" in value) ||
		typeof value.voice !== "string" ||
		!value.voice ||
		value.voice.length > MAX_VOICE_ID_LENGTH ||
		!("model" in value) ||
		!(isArrayBuffer(value.model) || value.model instanceof Blob) ||
		!("config" in value)
	)
		return false
	try {
		validateConfig(value.config)
		return true
	} catch {
		return false
	}
}

export function isWorkerResponse(value: unknown): value is WorkerResponse {
	if (!value || typeof value !== "object" || !("id" in value) || !Number.isSafeInteger(value.id) || !("ok" in value))
		return false
	if (value.ok === false)
		return (
			"error" in value &&
			typeof value.error === "string" &&
			(!("code" in value) || value.code === undefined || value.code === "unreadable-text") &&
			(!("model" in value) || value.model === undefined || isArrayBuffer(value.model))
		)
	if (value.ok !== true || !("type" in value)) return false
	if (value.type === "load") return "timings" in value && isWorkerTimings(value.timings)
	return (
		value.type === "synthesize" &&
		"pcm" in value &&
		ArrayBuffer.isView(value.pcm) &&
		Object.prototype.toString.call(value.pcm) === "[object Float32Array]" &&
		"sampleRate" in value &&
		typeof value.sampleRate === "number" &&
		Number.isFinite(value.sampleRate) &&
		value.sampleRate > 0 &&
		"words" in value &&
		Array.isArray(value.words) &&
		value.words.every(
			(word: unknown) =>
				!!word &&
				typeof word === "object" &&
				"start" in word &&
				typeof word.start === "number" &&
				Number.isSafeInteger(word.start) &&
				word.start >= 0 &&
				"end" in word &&
				typeof word.end === "number" &&
				Number.isSafeInteger(word.end) &&
				word.end >= word.start &&
				"from" in word &&
				typeof word.from === "number" &&
				Number.isFinite(word.from) &&
				word.from >= 0 &&
				"to" in word &&
				typeof word.to === "number" &&
				Number.isFinite(word.to) &&
				word.to >= word.from,
		)
	)
}
