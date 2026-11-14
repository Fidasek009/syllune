import { browser } from "wxt/browser"

import { localKeys } from "../../extension/storage.ts"
import { nativeSpeechAudio } from "../../playback/audio.ts"
import { PlaybackController } from "../../playback/controller.ts"
import { playbackCopy } from "../../playback/copy.ts"
import { bindMediaSession } from "../../playback/media-session.ts"
import { parentReaderHost } from "../../reading/bridge.ts"
import { isReaderResponse, type ReaderCommand, type ReaderResponse } from "../../reading/host.ts"
import { isSourceChangedMessage, readerMessage } from "../../reading/messages.ts"
import { compareVoices, getVoice, languageLabel, qualityLabel, voices } from "../../speech/catalog.ts"
import { SpeechClient } from "../../speech/client.ts"
import { firstAudioPerformance, firstBufferPerformance } from "../../speech/diagnostics.ts"
import { SpeechError, SpeechTextError } from "../../speech/errors.ts"
import { sendSpeechHost } from "../../speech/host-protocol.ts"
import { isVoiceChange } from "../../speech/protocol.ts"
import "./style.css"

const session = location.hash.slice(1)
const readerHost = parentReaderHost()
// Firefox exposes runtime messaging, but not tabs, to this embedded extension frame.
const canReadCurrentTab = !readerHost && import.meta.env.BROWSER !== "firefox"
const currentTab = canReadCurrentTab ? browser.tabs.getCurrent().catch(() => undefined) : undefined
async function send(command: ReaderCommand): Promise<ReaderResponse> {
	const request = { ...command, session }
	const tab = await currentTab
	const response: unknown = readerHost
		? await readerHost(request)
		: tab?.id === undefined
			? await browser.runtime.sendMessage(readerMessage(request))
			: await browser.tabs.sendMessage(tab.id, readerMessage(request), { frameId: 0 })
	if (!isReaderResponse(command, response))
		throw new SpeechError("transport", "The page did not respond. Press Play to try again.")
	return response
}
const button = (id: string) => document.querySelector<HTMLButtonElement>(`#${id}`)!
const play = button("play"),
	previous = button("previous"),
	next = button("next"),
	rate = button("rate")
const speed = document.querySelector<HTMLInputElement>("#speed")!
const speedLevel = document.querySelector<HTMLOutputElement>("#speed-level")!
const voiceSelect = document.querySelector<HTMLSelectElement>("#voice")!
const status = document.querySelector<HTMLSpanElement>("#status")!
const bar = document.querySelector<HTMLDivElement>("#bar")!
const playback = document.querySelector<HTMLDivElement>("#playback")!
const statusContainer = document.querySelector<HTMLDivElement>("#message")!
const setup = document.querySelector<HTMLAnchorElement>("#setup")!
const volume = document.querySelector<HTMLInputElement>("#volume")!
const volumePanel = document.querySelector<HTMLDivElement>("#volume-panel")!
const speedPanel = document.querySelector<HTMLDivElement>("#speed-panel")!
const panels = [speedPanel, volumePanel]
const volumeLevel = document.querySelector<HTMLOutputElement>("#volume-level")!
let checkingVoices = true,
	hasVoices = false,
	voiceRevision = 0,
	highlightFrame = 0
let firstBufferMs: number | undefined
const engine = new SpeechClient()
const controller = new PlaybackController(engine, nativeSpeechAudio, {
	change: updateControls,
	highlight: (start, end) => {
		void send({ command: "highlight", start, end }).catch(() => {})
	},
	firstBuffer: (diagnostics, elapsed) => {
		firstBufferMs = elapsed
		const record = firstBufferPerformance(diagnostics, elapsed)
		if (record) void browser.storage.local.set({ [localKeys.lastSpeechPerformance]: record })
	},
	firstAudio: (diagnostics, elapsed) => {
		const record = firstAudioPerformance(diagnostics, firstBufferMs ?? elapsed, elapsed)
		if (record) void browser.storage.local.set({ [localKeys.lastSpeechPerformance]: record })
	},
})
const mediaControls = bindMediaSession(navigator.mediaSession, {
	play: () => controller.mediaPlay(),
	pause: () => controller.pause(),
	previoustrack: () => previous.click(),
	nexttrack: () => next.click(),
	stop: () => button("close").click(),
})
function userError(error: unknown): string {
	return error instanceof SpeechError ? error.message : playbackCopy.failed
}
function announce(copy: string, quiet: boolean) {
	status.setAttribute("aria-live", quiet ? "off" : "polite")
	if (status.textContent !== copy) status.textContent = copy
	statusContainer.classList.toggle("quiet", quiet)
}
function updateControls() {
	const state = controller.state
	const playing = controller.playing
	const busy = controller.busy
	const ended = state.kind === "ended",
		failed = state.kind === "failed"
	const awaitingGesture = state.kind === "ready" && state.intent === "gesture"
	mediaControls.update(
		controller.closed || !hasVoices || failed
			? "none"
			: playing || (state.kind === "preparing" && state.intent === "play")
				? "playing"
				: "paused",
	)
	if (playing && !highlightFrame) highlightFrame = requestAnimationFrame(highlight)
	else if (!playing && highlightFrame) {
		cancelAnimationFrame(highlightFrame)
		highlightFrame = 0
	}
	document.querySelector("#play-icon")!.setAttribute("d", playing ? "M8 5v14M16 5v14" : "m8 5 11 7-11 7z")
	play.setAttribute("aria-label", ended ? "Read again" : playing ? "Pause" : "Play")
	play.title = play.getAttribute("aria-label")!
	play.disabled = !hasVoices || busy
	previous.disabled = !hasVoices || busy || !controller.canPrevious
	next.disabled = !hasVoices || busy || !controller.canNext
	// Dismiss before disabling: never leave a disabled, focused slider in an open popover.
	if (busy && speedPanel.matches(":popover-open")) {
		speedPanel.hidePopover()
		if (document.activeElement === speed || document.activeElement === rate) button("sound").focus()
	}
	speed.disabled = rate.disabled = voiceSelect.disabled = !hasVoices || busy
	playback.hidden = !hasVoices
	button("close").title = hasVoices ? "Stop reading" : "Close"
	button("close").setAttribute("aria-label", button("close").title)
	setup.hidden = hasVoices || (checkingVoices && !failed)
	bar.dataset.view = hasVoices ? "playback" : setup.hidden ? "loading" : "setup"
	const quiet = hasVoices && !busy && !awaitingGesture && !failed && !controller.skippedText
	const copy =
		!hasVoices && !checkingVoices
			? "No voice downloaded."
			: failed
				? userError(state.error)
				: busy
					? playbackCopy.preparing
					: ended
						? `Finished${controller.skippedText ? ` · ${playbackCopy.skipped}` : ""}`
						: awaitingGesture
							? "Press Play to start listening."
							: state.kind === "ready" && state.intent === "pause"
								? "Paused"
								: controller.skippedText
									? playbackCopy.skipped
									: "Reading"
	announce(copy, quiet)
	resizeBar()
}
function resizeBar() {
	if (controller.closed) return
	let height = bar.getBoundingClientRect().bottom
	for (const panel of panels) {
		if (!panel.matches(":popover-open")) continue
		const anchor = (panel === volumePanel ? button("sound") : rate).getBoundingClientRect()
		const width = panel.getBoundingClientRect().width
		panel.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, anchor.left + anchor.width / 2 - width / 2))}px`
		panel.style.top = `${height + 8}px`
		height = panel.getBoundingClientRect().bottom + 12
	}
	void send({
		command: "resize",
		height: Math.ceil(height),
		width: hasVoices ? 460 : checkingVoices ? 320 : 400,
	}).catch(() => {})
}
for (const panel of panels) panel.addEventListener("toggle", resizeBar)
window.addEventListener("blur", () => {
	for (const panel of panels) if (panel.matches(":popover-open")) panel.hidePopover()
})
function highlight() {
	highlightFrame = 0
	controller.updateHighlight()
	if (controller.playing) highlightFrame = requestAnimationFrame(highlight)
}
function updateVolume() {
	const level = Number(volume.value)
	controller.setVolume(level)
	volumeLevel.value = `${level}%`
	volume.setAttribute("aria-valuetext", `${level} percent`)
	button("sound").title = `Volume · ${level}%`
	document
		.querySelector("#sound-waves")!
		.setAttribute(
			"d",
			level === 0
				? "m16 9 6 6m0-6-6 6"
				: level < 50
					? "M15 8a6 6 0 0 1 0 8"
					: "M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14",
		)
}
volume.oninput = updateVolume
volume.onchange = () => void browser.storage.local.set({ [localKeys.volume]: Number(volume.value) })
play.onclick = () => {
	void controller.play(async () => {
		const selection = await send({ command: "selection" })
		if (!("text" in selection)) throw new SpeechTextError(playbackCopy.selectionUnavailable)
		return selection.text
	})
}
previous.onclick = () => void controller.step(-1)
next.onclick = () => void controller.step(1)
button("close").onclick = () => {
	controller.close()
	mediaControls.dispose()
	void send({ command: "close" }).catch(() => {})
}
function updateSpeed() {
	rate.textContent = `${Number(speed.value)}×`
	rate.title = `Reading speed · ${rate.textContent}`
	rate.setAttribute("aria-label", `Reading speed, ${Number(speed.value)}×`)
	speedLevel.value = rate.textContent
	speed.setAttribute("aria-valuetext", `${Number(speed.value)}× normal speed`)
}
function restart() {
	const voice = getVoice(voiceSelect.value)
	void controller.restart(voiceSelect.value, voice.locale, Number(speed.value))
}
speed.oninput = () => {
	updateSpeed()
	controller.setSpeed(Number(speed.value))
}
speed.onchange = () => {
	void browser.storage.local.set({ [localKeys.speed]: Number(speed.value) })
}
voiceSelect.onchange = () => {
	void browser.storage.local.set({ [localKeys.voice]: voiceSelect.value })
	restart()
}

async function refreshVoices(
	preferencesPromise = browser.storage.local.get([localKeys.voice, localKeys.speed, localKeys.volume]),
) {
	const current = ++voiceRevision
	const response = await sendSpeechHost({ type: "installed-voices" }).catch(() => {
		throw new SpeechError("voice", "Your voices could not be loaded. Open Voices and try again.")
	})
	const installed = new Set<string>(response)
	const preferences = await preferencesPromise
	if (controller.closed || current !== voiceRevision) return hasVoices
	const previousChoice = voiceSelect.value
	voiceSelect.replaceChildren()
	for (const voice of voices.filter((voice) => installed.has(voice.id)).sort(compareVoices)) {
		const option = document.createElement("option")
		option.value = voice.id
		option.textContent = `${voice.name} · ${qualityLabel(voice.quality)} · ${languageLabel(voice)}`
		voiceSelect.append(option)
	}
	for (const preferred of [preferences.voice, previousChoice]) {
		// Earlier releases stored a speaker suffix after the voice ID.
		const id = typeof preferred === "string" ? preferred.split("#")[0] : undefined
		if (id && Array.from(voiceSelect.options).some((option) => option.value === id)) {
			voiceSelect.value = id
			break
		}
	}
	hasVoices = voiceSelect.options.length > 0
	checkingVoices = false
	updateControls()
	return hasVoices
}

async function voicesChanged(id: string, deleted: boolean) {
	if (controller.closed) return
	const wasWaiting = !hasVoices
	const previousChoice = voiceSelect.value
	const pending = refreshVoices()
	const revision = voiceRevision
	const available = await pending
	if (controller.closed || revision !== voiceRevision) return
	const stillInstalled = Array.from(voiceSelect.options).some((option) => option.value === id)
	if (!available) controller.unavailable()
	else if (deleted && id === previousChoice && !stillInstalled)
		controller.fail(new SpeechError("voice", "Voice removed. Press Play to use another downloaded voice."))
	else if (wasWaiting && !deleted) await initialize()
	updateControls()
}
browser.storage.onChanged.addListener((changes, area) => {
	const change: unknown = changes[localKeys.voiceChange]?.newValue
	if (area === "local" && isVoiceChange(change))
		void voicesChanged(change.id, change.deleted).catch((error) => controller.fail(error))
})
window.addEventListener("pagehide", () => {
	controller.close()
	mediaControls.dispose()
})
new ResizeObserver(resizeBar).observe(bar)
window.addEventListener("keydown", (event) => {
	if (event.key === "Escape" && !panels.some((panel) => panel.matches(":popover-open"))) button("close").click()
})
async function initialize() {
	if (controller.closed) return
	const began = performance.now()
	controller.prepare()
	const generation = controller.revision
	try {
		const preferencesPromise = browser.storage.local.get([localKeys.voice, localKeys.speed, localKeys.volume])
		const [source, preferences] = await Promise.all([
			send({ command: "document" }),
			preferencesPromise,
			refreshVoices(preferencesPromise),
		])
		if (controller.closed || generation !== controller.revision) return
		if (!("text" in source) || typeof source.text !== "string" || !source.text.trim())
			throw new SpeechTextError("Start reading from a page or a text selection.")
		if (typeof preferences.speed === "number" && preferences.speed >= 0.5 && preferences.speed <= 2)
			speed.value = String(preferences.speed)
		updateSpeed()
		if (
			typeof preferences.volume === "number" &&
			Number.isFinite(preferences.volume) &&
			preferences.volume >= 0 &&
			preferences.volume <= 100
		)
			volume.value = String(preferences.volume)
		updateVolume()
		if (!hasVoices) {
			controller.unavailable()
			updateControls()
			return
		}
		await controller.setScope(
			source.text,
			voiceSelect.value,
			getVoice(voiceSelect.value).locale,
			Number(speed.value),
			began,
		)
	} catch (error) {
		if (!controller.closed && generation === controller.revision) controller.fail(error)
	}
}
void initialize()
window.addEventListener("message", (event) => {
	if (event.source === window.parent && isSourceChangedMessage(event.data)) void initialize()
})
