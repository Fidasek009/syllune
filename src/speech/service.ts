import { type SpeechDiagnostics, speechDiagnostics } from "./diagnostics.ts"
import { speechFailure, speechFailureCode } from "./errors.ts"
import { type SpeechClip, type SpeechRequest, type SpeechResponse } from "./protocol.ts"
import { synthesizeWithRecovery } from "./recovery.ts"

interface SpeechBackend {
	diagnostics: SpeechDiagnostics
	load(voice: string): Promise<void>
	synthesize(text: string, speed: number): Promise<SpeechClip>
	cancelQueued(): void
	clearClips(): void
	dispose(): void
}

/** The browser shares one speech engine. The reading tab owns audio and the source page. */
export class SpeechService {
	private owner = ""
	private generation = 0
	private requestedVoice = ""
	constructor(
		private engine: SpeechBackend,
		private encoding: "base64" | "structured" = "base64",
	) {}
	voiceDeleted(id: string) {
		if (this.requestedVoice === id) {
			this.generation++
			this.engine.dispose()
		}
	}
	async request(client: string, value: SpeechRequest): Promise<SpeechResponse> {
		try {
			if (value.type === "load") {
				if (client === this.owner && this.requestedVoice && this.requestedVoice !== value.voice) {
					this.generation++
					this.engine.cancelQueued()
				}
				this.requestedVoice = value.voice
				if (client !== this.owner) {
					this.engine.clearClips()
					this.generation++
					this.owner = client
				}
				await this.engine.load(value.voice)
				if (client !== this.owner) throw speechFailure("cancelled")
				return { id: value.id, ok: true, diagnostics: speechDiagnostics(this.engine.diagnostics) }
			}
			if (client !== this.owner) throw speechFailure("cancelled")
			if (value.type === "cancel") {
				this.generation++
				this.engine.cancelQueued()
				return { id: value.id, ok: true }
			}
			const generation = this.generation
			const clip = await synthesizeWithRecovery(value.text, (text) => {
				if (client !== this.owner || generation !== this.generation) throw speechFailure("cancelled")
				return this.engine.synthesize(text, value.speed)
			})
			if (client !== this.owner || generation !== this.generation) throw speechFailure("cancelled")
			return {
				id: value.id,
				ok: true,
				diagnostics: speechDiagnostics(this.engine.diagnostics),
				clip: {
					pcm:
						this.encoding === "structured"
							? clip.pcm
							: new Uint8Array(clip.pcm.buffer, clip.pcm.byteOffset, clip.pcm.byteLength).toBase64(),
					sampleRate: clip.sampleRate,
					words: clip.words,
					skippedText: clip.skippedText === true,
				},
			}
		} catch (error) {
			return { id: value.id, ok: false, code: speechFailureCode(error) }
		}
	}
	release(client: string) {
		if (client !== this.owner) return
		this.owner = ""
		this.generation++
		this.engine.clearClips()
		// The owning host's lifetime clock controls model disposal. Source text
		// is cleared immediately; there is no competing service retention timer.
	}
	dispose() {
		this.owner = ""
		this.requestedVoice = ""
		this.engine.dispose()
	}
}
