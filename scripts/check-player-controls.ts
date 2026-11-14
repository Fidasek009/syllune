import type { browser } from "wxt/browser"

import { pageScript } from "./page-script.ts"

interface AudioObservation {
	sources: number
	stops: number
	starts: { requestedAt: number }[]
	lastStop: number
	elements: HTMLMediaElement[]
	mediaActions: Map<MediaSessionAction, MediaSessionActionHandler | null>
}

type ProbeWindow = Window &
	typeof globalThis & {
		__probeAudio: AudioObservation
		browser?: Pick<typeof browser, "storage">
		chrome?: Pick<typeof browser, "storage">
	}

/** Self-contained: serialized into the copied test package, never the shipped extension. */
function installAudioObservation() {
	const probeWindow = window as ProbeWindow
	const audio: AudioObservation = {
		sources: 0,
		stops: 0,
		starts: [],
		lastStop: 0,
		mediaActions: new Map(),
		elements: [],
	}
	probeWindow.__probeAudio = audio
	const register = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession)
	navigator.mediaSession.setActionHandler = (action, handler) => {
		register(action, handler)
		audio.mediaActions.set(action, handler)
	}
	window.addEventListener("error", (event) => {
		document.documentElement.dataset.probeError = String(event.message)
	})
	window.addEventListener("unhandledrejection", (event) => {
		document.documentElement.dataset.probeRejection = String(event.reason)
	})
	window.addEventListener("message", (event) => {
		if (event.source !== window.parent) return
		const message: unknown = event.data
		if (message && typeof message === "object" && "type" in message && message.type === "read-aloud-source-changed")
			document.body.dataset.probeControlChange = "message"
	})
	const NativeAudio = window.Audio
	window.Audio = function (src?: string) {
		if (document.body.hasAttribute("data-probe-fail-buffer")) {
			document.body.removeAttribute("data-probe-fail-buffer")
			throw new Error("Internal test diagnostic")
		}
		const element = new NativeAudio(src)
		audio.elements.push(element)
		audio.sources++
		const pause = element.pause.bind(element),
			play = element.play.bind(element)
		element.pause = () => {
			if (!element.paused) {
				audio.stops++
				audio.lastStop = performance.now()
			}
			pause()
		}
		element.play = async () => {
			const wasPaused = element.paused
			await play()
			if (wasPaused) audio.starts.push({ requestedAt: performance.now() })
		}
		return element
	} as unknown as typeof Audio
}

/** Observe the real output graph; allow one explicit output failure in copied test packages only. */
export async function observePlayerAudio(directory: string) {
	await Bun.write(`${directory}/probe-audio.js`, pageScript(installAudioObservation))
	const html = Bun.file(`${directory}/player.html`)
	await Bun.write(html, (await html.text()).replace("<head>", '<head><script src="probe-audio.js"></script>'))
}

/** Run during active playback; native keyboard dismissal is checked by each browser driver. */
async function verifyVolume() {
	const probeWindow = window as ProbeWindow
	const settle = async (predicate: () => boolean) => {
		const deadline = performance.now() + 1500
		while (!predicate() && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
	}
	const recordedAt = (stored: unknown) => {
		if (stored && typeof stored === "object" && "lastSpeechPerformance" in stored) {
			const measurement = stored.lastSpeechPerformance
			if (measurement && typeof measurement === "object" && "recordedAt" in measurement)
				if (typeof measurement.recordedAt === "string") return measurement.recordedAt
		}
		throw new Error("Playback has no performance measurement")
	}
	const extension = probeWindow.browser ?? probeWindow.chrome
	if (!extension) throw new Error("Extension storage API is unavailable")
	const audio = probeWindow.__probeAudio
	// Invoke the callbacks registered with the real browser API. This verifies
	// routing and playback, rather than pretending DOM key events are OS keys.
	const play = document.querySelector<HTMLButtonElement>("#play")!
	for (const action of ["pause", "pause"] as const) audio.mediaActions.get(action)?.({ action })
	await settle(() => play.getAttribute("aria-label") === "Play" && !play.disabled)
	if (navigator.mediaSession.playbackState !== "paused" || play.disabled)
		throw new Error("Media pause did not pause playback")
	const initialStops = audio.stops
	for (const action of ["play", "play"] as const) audio.mediaActions.get(action)?.({ action })
	await settle(() => navigator.mediaSession.playbackState === "playing" && !play.disabled)
	// Read-ahead may schedule the next buffer while paused; it must never stop
	// and replace existing audio just because play/pause was delivered twice.
	if (play.getAttribute("aria-label") !== "Pause" || audio.stops !== initialStops)
		throw new Error("Media play did not resume existing audio idempotently")
	for (const action of ["previoustrack", "nexttrack", "stop"] as const)
		if (!audio.mediaActions.get(action)) throw new Error(`Missing media action: ${action}`)
	const currentVolume = () => audio.elements.find((element) => !element.paused)?.volume ?? NaN
	if (!Number.isFinite(currentVolume())) throw new Error("Playback has no active output element")
	const bar = document.querySelector<HTMLElement>("#bar")
	const volume = document.querySelector<HTMLInputElement>("#volume")
	const sound = document.querySelector<HTMLButtonElement>("#sound")
	const panel = document.querySelector<HTMLElement>("#volume-panel")
	const voice = document.querySelector<HTMLSelectElement>("#voice")
	if (!bar || !volume || !sound || !panel || !voice) throw new Error("Playback controls are missing")
	const before = audio.stops
	const barHeight = bar.getBoundingClientRect().height
	const previous = recordedAt(await extension.storage.local.get("lastSpeechPerformance"))
	sound.click()
	await new Promise((resolve) => setTimeout(resolve, 150))
	if (!panel.matches(":popover-open") || document.activeElement !== volume)
		throw new Error("Volume did not open and focus its native slider")
	const rect = panel.getBoundingClientRect()
	if (
		rect.bottom > innerHeight ||
		rect.top < barHeight + 7 ||
		bar.getBoundingClientRect().height !== barHeight ||
		voice.getBoundingClientRect().width > 148
	)
		throw new Error("Volume panel clipped or voice selector is too wide")
	volume.value = "50"
	volume.dispatchEvent(new Event("input"))
	volume.dispatchEvent(new Event("change"))
	await settle(() => Math.abs(currentVolume() - 0.25) <= 0.01)
	const gain = currentVolume()
	if (Math.abs(gain - 0.25) > 0.01) throw new Error(`Output gain did not follow volume: ${gain}`)
	const stored: unknown = await extension.storage.local.get(["volume", "lastSpeechPerformance"])
	if (
		!stored ||
		typeof stored !== "object" ||
		!("volume" in stored) ||
		stored.volume !== 50 ||
		recordedAt(stored) !== previous ||
		audio.stops !== before
	)
		throw new Error("Volume restarted synthesis/audio or did not persist")
	volume.value = "0"
	volume.dispatchEvent(new Event("input"))
	await settle(() => currentVolume() <= 0.001)
	if (currentVolume() > 0.001)
		throw new Error(
			`Zero volume did not mute output: ${JSON.stringify({ gain: currentVolume(), playing: audio.elements.filter((element) => !element.paused).length })}`,
		)
	volume.value = "75"
	volume.dispatchEvent(new Event("input"))
	volume.dispatchEvent(new Event("change"))
	return {
		mediaPlayPause: true,
		perceptualGain: gain,
		muted: true,
		persisted: true,
		sourceUnchanged: true,
		sliderFocused: true,
		voiceWidth: voice.getBoundingClientRect().width,
	}
}

async function verifySpeedPanel(verifyLiveAdjustment = false) {
	const bar = document.querySelector<HTMLElement>("#bar")
	const rate = document.querySelector<HTMLButtonElement>("#rate")
	const panel = document.querySelector<HTMLElement>("#speed-panel")
	const volumePanel = document.querySelector<HTMLElement>("#volume-panel")
	if (!bar || !rate || !panel || !volumePanel) throw new Error("Playback controls are missing")
	const barHeight = bar.getBoundingClientRect().height
	rate.click()
	const deadline = performance.now() + 1500
	while (performance.now() < deadline) {
		const rect = panel.getBoundingClientRect()
		if (panel.matches(":popover-open") && rect.bottom <= innerHeight && rect.top >= barHeight + 7) break
		await new Promise((resolve) => setTimeout(resolve, 25))
	}
	if (!panel.matches(":popover-open") || document.activeElement?.id !== "speed" || volumePanel.matches(":popover-open"))
		throw new Error("Speed panel did not replace volume and focus its slider")
	const rect = panel.getBoundingClientRect()
	if (rect.top < barHeight + 7 || rect.bottom > innerHeight || bar.getBoundingClientRect().height !== barHeight)
		throw new Error("Speed panel enlarged the bar or clipped")
	if (verifyLiveAdjustment) {
		const speed = document.querySelector<HTMLInputElement>("#speed")!
		// Committing the current rate must keep the live control usable and focused.
		speed.dispatchEvent(new Event("input"))
		speed.dispatchEvent(new Event("change"))
		await new Promise((resolve) => setTimeout(resolve, 150))
		if (!panel.matches(":popover-open") || document.activeElement !== speed || speed.disabled || rate.disabled)
			throw new Error("Speed adjustment dismissed or disabled the live slider")
	}
	panel.hidePopover()
	return { focusPreserved: verifyLiveAdjustment, floating: true, barHeightUnchanged: true, sliderFocused: true }
}

function failPlayback() {
	const voice = document.querySelector<HTMLSelectElement>("#voice")
	if (!voice || voice.disabled || !voice.value) throw new Error("Playback voice control is unavailable")
	document.body.setAttribute("data-probe-fail-buffer", "")
	// Reprepare the current voice so the next output fails even when paused with buffered clips.
	voice.dispatchEvent(new Event("change"))
}

// Drivers still consume expressions, but every assertion above is checked by TypeScript.
export const checkVolume = pageScript(verifyVolume)
export const checkSpeedPanel = pageScript(verifySpeedPanel)
export const checkSpeedFocus = pageScript(verifySpeedPanel, true)
export const failNextPlayback = pageScript(failPlayback)

/** Change speed during real playback without replacing or pausing the current audio. */
async function verifyLiveSpeed() {
	const observation = (window as ProbeWindow).__probeAudio
	const audio = observation.elements.find((element) => !element.paused)
	if (!audio) throw new Error("Speed check requires active playback")
	const starts = observation.starts.length
	const stops = observation.stops
	const time = audio.currentTime
	const slider = document.querySelector<HTMLInputElement>("#speed")!
	slider.value = "1.1"
	slider.dispatchEvent(new Event("input"))
	if (audio.playbackRate !== 1.1 || !audio.preservesPitch) throw new Error("Live speed must preserve pitch")
	slider.dispatchEvent(new Event("change"))
	await new Promise((resolve) => setTimeout(resolve, 150))
	if (audio.paused || audio.currentTime <= time || observation.starts.length !== starts || observation.stops !== stops)
		throw new Error("Speed change interrupted playback")
	return { playbackRate: audio.playbackRate, preservesPitch: audio.preservesPitch }
}
export const checkLiveSpeed = pageScript(verifyLiveSpeed)
