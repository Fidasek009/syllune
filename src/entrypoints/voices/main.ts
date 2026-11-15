import { browser } from "wxt/browser"

import { localKeys } from "../../extension/storage.ts"
import { catalogVoices, compareVoices, languageLabel, qualityLabel, qualityRank, voices } from "../../speech/catalog.ts"
import { deleteVoice, downloadVoice, installedVoices, onVoicesChanged } from "../../speech/vault.ts"
import { type Choice, choiceMenu } from "../../ui/choice-menu.ts"
import "./style.css"

const list = document.querySelector<HTMLDivElement>("#voices")!
const status = document.querySelector<HTMLParagraphElement>("#status")!
const search = document.querySelector<HTMLInputElement>("#search")!
const count = document.querySelector<HTMLParagraphElement>("#count")!
const audio = new Audio()
audio.preload = "none"
audio.crossOrigin = "anonymous"
let preview: HTMLButtonElement | undefined
let previewRequest = 0
let renderRevision = 0
const installed = new Set<string>()
const rows = new Map<string, HTMLElement>()
const deleting = new Set<string>()
const downloads = new Map<string, { controller: AbortController; fraction: number }>()
const notices = new Map<string, { message: string; error: boolean }>()

const icons = {
	play: "m8 5 11 7-11 7z",
	pause: "M8 5v14M16 5v14",
	loading: "M20 12a8 8 0 1 1-8-8",
	download: "M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5",
	delete: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7",
	cancel: "m6 6 12 12M18 6 6 18",
	retry: "M20 4v6h-6m6 0a8 8 0 1 0 0 5",
}

function setAction(button: HTMLButtonElement, icon: keyof typeof icons, label: string, title = label) {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
	svg.setAttribute("viewBox", "0 0 24 24")
	svg.setAttribute("aria-hidden", "true")
	svg.setAttribute("focusable", "false")
	const path = document.createElementNS(svg.namespaceURI, "path")
	path.setAttribute("d", icons[icon])
	svg.append(path)
	button.replaceChildren(svg)
	button.setAttribute("aria-label", label)
	button.title = title
}

function downloadNotice(id: string, message?: string, error = false) {
	if (message) notices.set(id, { message, error })
	else notices.delete(id)
	const notice = list.querySelector<HTMLParagraphElement>(`[data-voice="${id}"] .download-status`)
	if (notice) {
		notice.textContent = message ?? ""
		notice.hidden = !message
		notice.classList.toggle("error", error)
	}
}

function stopPreview() {
	previewRequest++
	audio.pause()
	audio.removeAttribute("src")
	audio.load()
	if (preview) {
		setAction(preview, "play", `Listen to ${preview.dataset.voiceName}`, "Play an online sample")
		preview.removeAttribute("aria-busy")
		preview.setAttribute("aria-pressed", "false")
	}
	preview = undefined
}
const sorted = [...catalogVoices].sort(compareVoices)
const languageChoices: Choice[] = [
	{ value: "", label: "All languages" },
	...[...new Map(voices.map((voice) => [voice.locale, languageLabel(voice)]))]
		.sort((a, b) => a[1].localeCompare(b[1]))
		.map(([locale, label]) => ({ value: locale, label })),
]
const qualityChoices: Choice[] = [
	{ value: "", label: "All qualities" },
	...[...new Set(voices.map((voice) => voice.quality))]
		.sort((a, b) => qualityRank(a) - qualityRank(b))
		.map((quality) => ({ value: quality, label: qualityLabel(quality) })),
]
/**
 * Mirrors Radix's select: 10px of collision padding against the viewport, and the
 * menu opens on the side with more room.
 */
const collisionMargin = 10
function filter(id: "language" | "quality", choices: Choice[]) {
	const button = document.querySelector<HTMLButtonElement>(`#${id}`)!
	const menu = document.querySelector<HTMLDivElement>(`#${id}-menu`)!
	const control = choiceMenu({ button, menu, onChange: () => void render() })
	menu.addEventListener("toggle", (event) => {
		if ((event as ToggleEvent).newState !== "open") return
		const rect = button.getBoundingClientRect()
		const below = innerHeight - rect.bottom - collisionMargin * 2
		const above = rect.top - collisionMargin * 2
		const openUp = above > below
		menu.classList.toggle("above", openUp)
		menu.style.setProperty("--choice-available-height", `${Math.max(0, openUp ? above : below)}px`)
	})
	control.setChoices(choices, "")
	return control
}
const languageMenu = filter("language", languageChoices)
const qualityMenu = filter("quality", qualityChoices)

async function refreshInstalled() {
	const current = ++renderRevision
	const latest = await installedVoices()
	if (current !== renderRevision) return
	installed.clear()
	for (const id of latest) installed.add(id)
	render()
}
function updateRow(row: HTMLElement, voice: (typeof voices)[number]) {
	const action = row.querySelector<HTMLButtonElement>('[data-action="download"]')!
	const progress = row.querySelector<HTMLProgressElement>("progress")!
	const notice = row.querySelector<HTMLParagraphElement>(".download-status")!
	const downloading = downloads.get(voice.id)
	const outcome = notices.get(voice.id)
	const quality = qualityLabel(voice.quality)
	action.className = installed.has(voice.id) ? "danger" : "primary"
	const label = downloading
		? "Cancel"
		: installed.has(voice.id)
			? "Delete"
			: voice.unsupported
				? "Unavailable"
				: outcome?.error
					? "Retry"
					: "Download"
	action.disabled = deleting.has(voice.id) || (!!voice.unsupported && !installed.has(voice.id))
	setAction(
		action,
		downloading ? "cancel" : installed.has(voice.id) ? "delete" : outcome?.error ? "retry" : "download",
		`${label} ${voice.name} ${quality}`,
	)
	progress.hidden = !downloading
	if (downloading?.fraction) progress.value = downloading.fraction
	else progress.removeAttribute("value")
	notice.classList.toggle("error", outcome?.error ?? false)
	notice.textContent = outcome?.message ?? ""
	notice.hidden = !outcome
}
function render() {
	const query = search.value.toLocaleLowerCase().trim()
	const shown = sorted.filter(
		(voice) =>
			(!voice.unsupported || installed.has(voice.id)) &&
			(!languageMenu.value || voice.locale === languageMenu.value) &&
			(!qualityMenu.value || voice.quality === qualityMenu.value) &&
			`${voice.name} ${voice.id} ${voice.language} ${voice.nativeLanguage} ${voice.quality}`
				.toLocaleLowerCase()
				.includes(query),
	)
	const resultCount = shown.length
		? `${shown.length} of ${sorted.filter((voice) => !voice.unsupported || installed.has(voice.id)).length} models · ${installed.size} downloaded`
		: "No models match these filters."
	if (count.textContent !== resultCount) count.textContent = resultCount
	const shownIds = new Set(shown.map((voice) => voice.id))
	for (const [id, row] of rows) row.hidden = !shownIds.has(id)
	for (const voice of shown) {
		const existing = rows.get(voice.id)
		if (existing) {
			updateRow(existing, voice)
			continue
		}
		const row = document.createElement("section")
		row.dataset.voice = voice.id
		const description = document.createElement("div")
		const title = document.createElement("h2")
		title.textContent = voice.name
		const detail = document.createElement("p")
		const quality = qualityLabel(voice.quality)
		detail.textContent = `${languageLabel(voice)} · ${quality} · ${Math.round(voice.bytes / 1e6)} MB`
		const terms = document.createElement("a")
		terms.className = "terms"
		terms.textContent = "License"
		terms.setAttribute("aria-label", `${voice.name}, ${languageLabel(voice)}, ${quality}: license (opens in a new tab)`)
		terms.href = voice.termsUrl
		terms.target = "_blank"
		terms.rel = "noopener noreferrer"
		description.append(title, detail, terms)
		if (voice.unsupported) {
			const warning = document.createElement("p")
			warning.className = "compatibility"
			warning.textContent = "This voice cannot be used with this version. You can delete the download."
			description.append(warning)
		}
		const sample = document.createElement("button")
		sample.dataset.action = "preview"
		sample.dataset.voiceName = `${voice.name} ${quality}`
		setAction(
			sample,
			"play",
			`Listen to ${sample.dataset.voiceName}`,
			voice.previewUrl ? "Play an online sample" : "No prerecorded sample is available",
		)
		sample.disabled = !voice.previewUrl
		sample.setAttribute("aria-pressed", "false")
		sample.onclick = async () => {
			if (preview === sample) {
				stopPreview()
				return
			}
			if (!voice.previewUrl) return
			stopPreview()
			const request = previewRequest
			status.textContent = ""
			preview = sample
			setAction(sample, "loading", `Cancel loading sample for ${sample.dataset.voiceName}`)
			sample.setAttribute("aria-busy", "true")
			audio.src = voice.previewUrl
			try {
				await audio.play()
				if (request !== previewRequest) return
				setAction(sample, "pause", `Pause sample for ${sample.dataset.voiceName}`)
				sample.removeAttribute("aria-busy")
				sample.setAttribute("aria-pressed", "true")
			} catch {
				if (request !== previewRequest) return
				stopPreview()
				status.textContent = "Preview unavailable. Check your connection and try again."
			}
		}
		const action = document.createElement("button")
		action.dataset.action = "download"
		const progress = document.createElement("progress")
		progress.max = 1
		progress.setAttribute("aria-label", `Downloading ${voice.name}`)
		const notice = document.createElement("p")
		notice.id = `download-status-${voice.id}`
		notice.className = "download-status"
		action.setAttribute("aria-describedby", notice.id)
		action.onclick = async () => {
			const running = downloads.get(voice.id)
			if (running) {
				running.controller.abort()
				return
			}
			status.textContent = ""
			downloadNotice(voice.id)
			if (installed.has(voice.id)) {
				deleting.add(voice.id)
				action.disabled = true
				try {
					await deleteVoice(voice.id, () =>
						browser.storage.local.set({
							[localKeys.voiceChange]: { id: voice.id, deleted: true, revision: crypto.randomUUID() },
						}),
					)
				} catch {
					downloadNotice(voice.id, "The voice could not be deleted. Please try again.", true)
				} finally {
					deleting.delete(voice.id)
				}
				await refreshInstalled()
				return
			}
			const task = { controller: new AbortController(), fraction: 0 }
			downloads.set(voice.id, task)
			updateRow(row, voice)
			try {
				await downloadVoice(
					voice.id,
					task.controller.signal,
					(value) => {
						task.fraction = value
						const visible = list.querySelector<HTMLProgressElement>(`[data-voice="${voice.id}"] progress`)
						if (visible) visible.value = value
						if (value === 1) downloadNotice(voice.id, "Finishing download…")
					},
					async () => {
						const preferences = await browser.storage.local.get(localKeys.voice)
						await browser.storage.local.set({
							...(!preferences[localKeys.voice] ? { [localKeys.voice]: voice.id } : {}),
							[localKeys.voiceChange]: { id: voice.id, deleted: false, revision: crypto.randomUUID() },
						})
					},
				)
				downloadNotice(voice.id)
			} catch (error) {
				const cancelled =
					task.controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")
				const message = cancelled
					? "Download cancelled."
					: error instanceof DOMException && error.name === "QuotaExceededError"
						? "Not enough storage. Delete a downloaded voice and try again."
						: error instanceof Error
							? error.message
							: "Download failed."
				downloadNotice(voice.id, message, !cancelled)
			} finally {
				downloads.delete(voice.id)
				await refreshInstalled()
			}
		}
		row.append(description, sample, action, progress, notice)
		updateRow(row, voice)
		rows.set(voice.id, row)
		list.append(row)
	}
}
search.oninput = render
audio.onended = stopPreview
audio.onerror = () => {
	if (preview && audio.error) {
		stopPreview()
		status.textContent = "Preview unavailable. Check your connection and try again."
	}
}
const stopWatchingVoices = onVoicesChanged((id) => {
	// This page refreshes its own operation once its final button state is ready.
	if (!downloads.has(id) && !deleting.has(id)) void refreshInstalled()
})
window.addEventListener("pagehide", () => {
	stopWatchingVoices()
	for (const task of downloads.values()) task.controller.abort()
	stopPreview()
})
void refreshInstalled()
