import type { SpeechClip } from "../speech/protocol.ts"

import { speechWav } from "./wav.ts"

/** The audio boundary is replaceable without a DOM or a speech worker in controller tests. */
export interface PlaybackAudio {
	readonly paused: boolean
	readonly currentTime: number
	playbackRate: number
	volume: number
	onended: (() => void) | null
	onerror: (() => void) | null
	onplaying: (() => void) | null
	play(): Promise<void>
	pause(): void
	dispose(): void
}

export function nativeSpeechAudio(clip: SpeechClip): PlaybackAudio {
	const url = URL.createObjectURL(speechWav(clip.pcm, clip.sampleRate))
	try {
		const audio = new Audio(url)
		audio.preservesPitch = true
		const output: PlaybackAudio = {
			get paused() {
				return audio.paused
			},
			get currentTime() {
				return audio.currentTime
			},
			get playbackRate() {
				return audio.playbackRate
			},
			set playbackRate(value) {
				audio.playbackRate = value
			},
			get volume() {
				return audio.volume
			},
			set volume(value) {
				audio.volume = value
			},
			onended: null,
			onerror: null,
			onplaying: null,
			play: () => audio.play(),
			pause: () => audio.pause(),
			dispose: () => {
				audio.onended = audio.onerror = audio.onplaying = null
				audio.pause()
				audio.removeAttribute("src")
				audio.load()
				URL.revokeObjectURL(url)
			},
		}
		audio.onended = () => output.onended?.()
		audio.onerror = () => output.onerror?.()
		audio.onplaying = () => output.onplaying?.()
		audio.preload = "auto"
		audio.load()
		return output
	} catch (error) {
		URL.revokeObjectURL(url)
		throw error
	}
}
