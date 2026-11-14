import type { SpeechDiagnostics } from "../speech/diagnostics.ts"
import type { SpeechClip } from "../speech/protocol.ts"
import type { PlaybackAudio } from "./audio.ts"

import { type ReadingChunk, readingChunks, sentenceTarget } from "../reading/chunks.ts"
import { isSpeechCancellation, speechFailure, SpeechTextError } from "../speech/errors.ts"
import { playbackCopy } from "./copy.ts"

export type PlaybackIntent = "play" | "pause" | "gesture"
type RestingState =
	{ kind: "ready"; intent: "pause" | "gesture" } | { kind: "ended" } | { kind: "failed"; error: unknown }
export type PlaybackState =
	| { kind: "preparing"; intent: PlaybackIntent }
	| { kind: "ready"; intent: PlaybackIntent }
	| { kind: "selecting"; previous: RestingState }
	| { kind: "closed" }
	| RestingState
export interface PlaybackEngine {
	readonly diagnostics: SpeechDiagnostics
	load(voice: string): Promise<void>
	synthesize(text: string, speed: number): Promise<SpeechClip>
	cancelQueued(): void
	dispose(): void
}
export interface PlaybackEvents {
	change(): void
	highlight(start: number, end: number): void
	firstBuffer(diagnostics: SpeechDiagnostics, elapsed: number): void
	firstAudio(diagnostics: SpeechDiagnostics, elapsed: number): void
}
interface QueuedClip {
	clip: SpeechClip
	offset: number
	index: number
}
interface PlayingClip extends QueuedClip {
	audio: PlaybackAudio
}

/** Owns one listening scope. DOM, preferences, transport and native audio stay at its boundaries. */
export class PlaybackController {
	private phase: PlaybackState = { kind: "preparing", intent: "play" }
	private text = ""
	private chunks: ReadingChunk[] = []
	private voice = ""
	private language = "en"
	private speed = 1
	private volume = 1
	private cursor = 0
	private epoch = 0
	private active: PlayingClip | undefined
	private scheduled: PlayingClip | undefined
	private queue: QueuedClip[] = []
	private generating = false
	private lastWord = -1
	private consecutiveSkipped = 0
	skippedText = false
	private began = 0
	private measuredBuffer = false
	private measuredAudio = false
	constructor(
		private readonly engine: PlaybackEngine,
		private readonly createAudio: (clip: SpeechClip) => PlaybackAudio,
		private readonly events: PlaybackEvents,
		private readonly now: () => number = () => performance.now(),
	) {}
	get state(): Readonly<PlaybackState> {
		return this.phase
	}
	get revision() {
		return this.epoch
	}
	get closed() {
		return this.phase.kind === "closed"
	}
	get playing() {
		return !!this.active && !this.active.audio.paused && this.phase.kind === "ready" && this.phase.intent === "play"
	}
	get busy() {
		return this.phase.kind === "preparing" || this.phase.kind === "selecting"
	}
	get canPrevious() {
		return this.cursor > 0
	}
	get canNext() {
		return sentenceTarget(this.chunks, this.cursor, 1) >= 0
	}
	private changed() {
		this.events.change()
	}
	private halt() {
		this.epoch++
		this.engine.cancelQueued()
		this.active?.audio.dispose()
		this.scheduled?.audio.dispose()
		this.active = this.scheduled = undefined
		this.queue = []
		this.generating = false
		this.lastWord = -1
		this.events.highlight(0, 0)
	}
	prepare() {
		if (this.closed) return
		this.halt()
		this.began = this.now()
		this.phase = { kind: "preparing", intent: "play" }
		this.changed()
	}
	setVolume(level: number) {
		this.volume = (level / 100) ** 2
		for (const item of [this.active, this.scheduled]) if (item) item.audio.volume = this.volume
	}
	setSpeed(speed: number) {
		if (this.closed || !Number.isFinite(speed) || speed < 0.5 || speed > 2) return
		this.speed = speed
		for (const item of [this.active, this.scheduled]) if (item) item.audio.playbackRate = speed
	}
	async setScope(text: string, voice: string, language: string, speed: number, startedAt = this.now()) {
		this.text = text
		this.voice = voice
		this.language = language
		this.speed = speed
		this.chunks = readingChunks(text, language)
		await this.begin(0, undefined, startedAt)
	}
	async restart(voice: string, language: string, speed: number) {
		const offset = this.lastWord >= 0 ? this.lastWord : (this.chunks[this.cursor]?.start ?? 0)
		this.voice = voice
		this.language = language
		this.speed = speed
		this.chunks = readingChunks(this.text, language)
		const index = Math.max(
			0,
			this.chunks.findIndex((chunk) => chunk.end > offset),
		)
		await this.begin(index, offset)
	}
	async step(direction: -1 | 1) {
		if (this.busy || this.closed) return
		const index = sentenceTarget(this.chunks, this.cursor, direction)
		if (index >= 0) await this.begin(index)
	}
	pause() {
		if (this.closed || (this.phase.kind !== "ready" && this.phase.kind !== "preparing")) return
		this.phase = { kind: this.phase.kind, intent: "pause" }
		this.active?.audio.pause()
		this.changed()
	}
	async play(selection: () => Promise<string | null>) {
		if (this.phase.kind === "preparing" || this.phase.kind === "selecting" || this.phase.kind === "closed") return
		if (this.playing) {
			this.pause()
			return
		}
		const began = this.now()
		const previous: RestingState =
			this.phase.kind === "ready"
				? { kind: "ready", intent: this.phase.intent === "gesture" ? "gesture" : "pause" }
				: this.phase
		const current = this.epoch
		this.phase = { kind: "selecting", previous }
		this.changed()
		try {
			const selected = await selection()
			if (current !== this.epoch || this.closed) return
			if (selected !== null && !selected.trim()) throw new SpeechTextError(playbackCopy.selectionUnavailable)
			if (selected !== null || previous.kind === "ended" || previous.kind === "failed") {
				if (selected !== null) {
					this.text = selected
					this.chunks = readingChunks(selected, this.language)
				}
				this.phase = { kind: "ready", intent: "play" }
				await this.begin(selected !== null || previous.kind === "ended" ? 0 : this.cursor, undefined, began)
			} else {
				this.phase = { kind: "ready", intent: "play" }
				if (this.active) await this.resume(current)
				else await this.begin(this.cursor, undefined, began)
				this.changed()
			}
		} catch (error) {
			if (current === this.epoch && !this.closed) this.fail(error)
		}
	}
	mediaPlay() {
		if (this.phase.kind === "preparing") {
			this.phase = { kind: "preparing", intent: "play" }
			this.changed()
		} else if (!this.playing) void this.play(async () => null)
	}
	unavailable() {
		if (this.closed) return
		this.halt()
		this.engine.dispose()
		this.phase = { kind: "ready", intent: "pause" }
		this.changed()
	}
	fail(error: unknown) {
		if (this.closed) return
		this.halt()
		// Losing shared inference ownership is a normal interruption, not a broken reader.
		if (isSpeechCancellation(error)) {
			this.phase = { kind: "ready", intent: "pause" }
		} else {
			this.engine.dispose()
			this.phase = { kind: "failed", error }
		}
		this.changed()
	}
	close() {
		if (this.closed) return
		this.phase = { kind: "closed" }
		this.halt()
		this.text = ""
		this.chunks = []
		this.engine.dispose()
		this.changed()
	}
	private async begin(index: number, offset?: number, began = this.now()) {
		if (this.closed) return
		const intent = this.phase.kind === "ready" || this.phase.kind === "preparing" ? this.phase.intent : "play"
		this.halt()
		this.began = began
		this.measuredBuffer = this.measuredAudio = false
		this.skippedText = false
		this.consecutiveSkipped = 0
		this.cursor = Math.min(Math.max(0, index), this.chunks.length - 1)
		const chunk = this.chunks[this.cursor]
		if (!chunk) {
			this.fail(new SpeechTextError("Select some text to read first."))
			return
		}
		const resumeOffset = offset !== undefined && offset >= chunk.start && offset < chunk.end ? offset : undefined
		const current = this.epoch
		this.phase = { kind: "preparing", intent }
		this.changed()
		try {
			await this.engine.load(this.voice)
			if (current === this.epoch) void this.fill(current, resumeOffset)
		} catch (error) {
			if (current === this.epoch) this.fail(error)
		}
	}
	private async fill(current: number, firstOffset?: number) {
		if (this.generating || current !== this.epoch) return
		this.generating = true
		try {
			while (current === this.epoch && this.queue.length + Number(!!this.scheduled) < 2) {
				const index = this.active
					? this.cursor + this.queue.length + Number(!!this.scheduled) + 1
					: this.cursor + this.queue.length
				const chunk = this.chunks[index]
				if (!chunk) break
				const offset = index === this.cursor && firstOffset !== undefined ? firstOffset : chunk.start
				const clip = await this.engine.synthesize(this.text.slice(offset, chunk.end), 1)
				if (current !== this.epoch) return
				this.consecutiveSkipped = clip.skippedText && !clip.words.length ? this.consecutiveSkipped + 1 : 0
				if (this.consecutiveSkipped >= 3) throw speechFailure("text")
				this.queue.push({ clip, offset, index })
				if (!this.active) this.startNext(current)
				else this.preload(current)
			}
		} catch (error) {
			if (current === this.epoch) this.fail(error)
		} finally {
			if (current === this.epoch) this.generating = false
		}
	}
	private startNext(current: number) {
		if (current !== this.epoch || this.active) return
		const item = this.queue.shift()
		if (!item) return
		this.active = this.output(item, current)
		this.activate(this.active, current)
		this.preload(current)
	}
	private output(item: QueuedClip, current: number): PlayingClip {
		const audio = this.createAudio(item.clip)
		audio.volume = this.volume
		audio.playbackRate = this.speed
		const playing = { ...item, audio }
		audio.onerror = () => {
			if (current === this.epoch) this.fail(new SpeechTextError("Audio could not play. Press Play to try again."))
		}
		audio.onplaying = () => {
			if (current !== this.epoch || this.active !== playing) return
			if (!this.measuredAudio) {
				this.measuredAudio = true
				this.events.firstAudio(this.engine.diagnostics, this.now() - this.began)
			}
			this.changed()
		}
		audio.onended = () => {
			if (current !== this.epoch || this.active !== playing) return
			audio.dispose()
			this.active = this.scheduled
			this.scheduled = undefined
			this.cursor = playing.index + 1
			if (this.active) {
				this.activate(this.active, current)
				this.preload(current)
			} else if (this.cursor >= this.chunks.length) {
				this.phase = { kind: "ended" }
				this.events.highlight(0, 0)
				this.changed()
			} else this.startNext(current)
			void this.fill(current)
		}
		return playing
	}
	private preload(current: number) {
		if (current !== this.epoch || !this.active || this.scheduled || !this.queue.length) return
		this.scheduled = this.output(this.queue.shift()!, current)
	}
	private activate(item: PlayingClip, current: number) {
		this.cursor = item.index
		this.skippedText ||= item.clip.skippedText === true
		if (!this.measuredBuffer) {
			this.measuredBuffer = true
			this.events.firstBuffer(this.engine.diagnostics, this.now() - this.began)
		}
		if (this.phase.kind === "selecting") return
		const intent = this.phase.kind === "preparing" || this.phase.kind === "ready" ? this.phase.intent : "play"
		this.phase = { kind: "ready", intent }
		if (intent === "play") void this.resume(current)
		this.changed()
	}
	private async resume(current: number) {
		try {
			await this.active?.audio.play()
			if (current === this.epoch && !this.closed) this.changed()
		} catch (error) {
			if (current !== this.epoch || this.closed || (this.phase.kind === "ready" && this.phase.intent === "pause"))
				return
			if (error instanceof DOMException && error.name === "NotAllowedError") {
				this.phase = { kind: "ready", intent: "gesture" }
				this.changed()
			} else this.fail(error)
		}
	}
	updateHighlight() {
		if (!this.playing || !this.active) return
		const seconds = this.active.audio.currentTime
		const word = this.active.clip.words.find((word) => seconds >= word.from && seconds < word.to)
		if (word && this.active.offset + word.start !== this.lastWord) {
			this.lastWord = this.active.offset + word.start
			this.events.highlight(this.lastWord, this.active.offset + word.end)
		}
	}
}
