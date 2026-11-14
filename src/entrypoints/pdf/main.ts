import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist"

import { getDocument, GlobalWorkerOptions, TextLayer } from "pdfjs-dist"
import { browser } from "wxt/browser"

import { isExtensionBackgroundSender } from "../../extension/sender.ts"
import { createReaderDispatcher } from "../../reading/dispatch.ts"
import {
	concatDocuments,
	overlappingRuns,
	type ReadingDocument,
	sourceRange,
	type TextRun,
} from "../../reading/document.ts"
import { currentWordHighlight, paintReaderHighlight } from "../../reading/layout.ts"
import { sourceChangedMessage } from "../../reading/messages.ts"
import { normalizeDocument } from "../../reading/normalize.ts"
import { fetchPdf } from "../../reading/pdf-access.ts"
import { isPdfCommand, isPdfSelectionToken, type PdfCommand, pdfSelectionKey } from "../../reading/pdf-control.ts"
import { PdfSelectionSearch } from "../../reading/pdf-locate.ts"
import { nativeSelectionMapping, selectRange, sliceDocument } from "../../reading/selection.ts"
import { ReaderSession } from "../../reading/session.ts"
import { parsePdfReaders, readingKeys } from "../../reading/state.ts"
import "pdfjs-dist/web/pdf_viewer.css"
import "../../reading/current-word.css"
import "./style.css"

const pages = document.querySelector<HTMLDivElement>("#pages")!
const status = document.querySelector<HTMLParagraphElement>("#status")!
const controls = document.querySelector<HTMLDivElement>("#controls")!
const zoomControls = document.querySelector<HTMLDivElement>("#zoom")!
const zoomLevel = document.querySelector<HTMLSpanElement>("#zoom-level")!
const params = new URLSearchParams(location.search)
const highlightKey = currentWordHighlight
const session = new ReaderSession<ReadingDocument>()
let nativeMapping: ReturnType<typeof nativeSelectionMapping> | undefined
let frame: HTMLIFrameElement | undefined
let tabId: number | undefined
let alive = true
let allowStart = true
let initialSelection: ReadingDocument | undefined
let pendingSelection: ReadingDocument | undefined
let pendingSelectionKey: string | undefined
const ownTab = browser.tabs.getCurrent().then((tab) => (tabId = tab?.id))

// The document promise lets an explicit command wait for startup without
// guessing whether fetching has finished.
const documentReady = Promise.withResolvers<PDFDocumentProxy>()
void documentReady.promise.catch(() => {})
// A native-viewer handoff is playable only after its printed region is located.
const selectionLocated = Promise.withResolvers<void>()
void selectionLocated.promise.catch(() => {})

interface PdfTextRun extends TextRun {
	node: Text
}
type PageTextContent = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>
interface PageState {
	number: number
	page: PDFPageProxy
	canvas: HTMLCanvasElement
	section: HTMLElement
	container: HTMLDivElement
	viewport: ReturnType<PDFPageProxy["getViewport"]>
	fitScale: number
	content?: PageTextContent
	contentReady?: Promise<PageTextContent>
	text: string
	runs: (PdfTextRun | undefined)[]
	document?: ReadingDocument
	textReady?: Promise<void>
	task?: RenderTask
	visible: boolean
	pending: Promise<void>
}
const owners = new WeakMap<Text, PageState>()
const renderers = new Map<Element, PageState>()
/** Pages are created in order; index 0 is page 1. */
const pageStates: PageState[] = []
let nextPage: Promise<PageState> | undefined
let articlePromise: Promise<ReadingDocument> | undefined
let articleBuilt = false

function yieldToMain() {
	const runtime = globalThis as {
		scheduler?: { yield?: () => Promise<void> }
	}
	const yieldTask = runtime.scheduler?.yield
	return yieldTask ? yieldTask.call(runtime.scheduler) : new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function pageDocument(state: PageState) {
	return (state.document ??= {
		text: state.text,
		runs: state.runs.filter((run): run is PdfTextRun => run !== undefined),
	})
}

async function pageThrough(number: number): Promise<PageState> {
	const pdf = await documentReady.promise
	if (!Number.isSafeInteger(number) || number < 1 || number > pdf.numPages)
		throw new Error("This PDF page does not exist.")
	while (pageStates.length < number) {
		nextPage ??= createPage(pageStates.length + 1).finally(() => {
			nextPage = undefined
		})
		await nextPage
	}
	const state = pageStates[number - 1]
	if (!state) throw new Error("This PDF page could not be opened.")
	return state
}

async function createPage(number: number): Promise<PageState> {
	const pdf = await documentReady.promise
	const page = await pdf.getPage(number)
	if (!alive) throw new Error("This PDF reader has closed.")
	const fitScale = Math.min(1.4, Math.max(280, innerWidth - 40) / page.getViewport({ scale: 1 }).width)
	const viewport = page.getViewport({ scale: fitScale * zoom })
	const section = document.createElement("section")
	section.className = "pdf-page"
	section.setAttribute("aria-label", `Page ${number}`)
	setPageMetrics(section, viewport, fitScale * zoom)
	const canvas = document.createElement("canvas")
	canvas.width = canvas.height = 0
	canvas.setAttribute("aria-hidden", "true")
	const container = document.createElement("div")
	container.className = "textLayer"
	section.append(canvas, container)
	pages.append(section)
	if (number === 1) zoomControls.hidden = false
	const state: PageState = {
		number,
		page,
		canvas,
		section,
		container,
		viewport,
		fitScale,
		text: "",
		runs: [],
		visible: false,
		pending: Promise.resolve(),
	}
	pageStates.push(state)
	renderers.set(section, state)
	observer.observe(section)
	return state
}

/** Extract page text once. Text layers and article indexing share this cache. */
function ensureContent(state: PageState): Promise<PageTextContent> {
	return (state.contentReady ??= (async () => {
		const content = await state.page.getTextContent()
		state.content = content
		let text = ""
		const runs: (PdfTextRun | undefined)[] = []
		for (const item of content.items) {
			if (!("str" in item)) continue
			if (!item.str) {
				if (item.hasEOL && !text.endsWith("\n")) text += "\n"
				runs.push(undefined)
				continue
			}
			const node = document.createTextNode(item.str)
			const run = { from: text.length, to: text.length + item.str.length, node, offset: 0 }
			owners.set(node, state)
			runs.push(run)
			text += item.str
			if (item.hasEOL) text += "\n"
		}
		state.text = text.replace(/\n?$/u, "\n\n")
		state.runs = runs
		delete state.document
		return content
	})().catch((error) => {
		delete state.contentReady
		throw error
	}))
}

function ensureText(state: PageState): Promise<void> {
	return (state.textReady ??= (async () => {
		const content = await ensureContent(state)
		state.container.replaceChildren()
		const layer = new TextLayer({
			textContentSource: content,
			container: state.container,
			viewport: state.viewport,
		})
		await layer.render()
		for (let index = 0; index < state.runs.length; index++) {
			const run = state.runs[index]
			if (!run) continue
			const node = layer.textDivs[index]?.firstChild
			if (!(node instanceof Text) || node.data !== run.node.data)
				throw new Error("The PDF text layer could not be mapped accurately.")
			run.node = node
			owners.set(node, state)
		}
	})().catch((error) => {
		delete state.textReady
		throw error
	}))
}

function pageDocuments(from: number, to: number): ReadingDocument {
	const parts: ReadingDocument[] = []
	for (let number = from; number <= to; number++) {
		const state = pageStates[number - 1]
		if (!state) throw new Error("Select some PDF text first.")
		parts.push(pageDocument(state))
	}
	return concatDocuments(parts)
}

function pageAt(node: Node | null): PageState | undefined {
	if (!node) return undefined
	if (node instanceof Text) return owners.get(node)
	const element = node instanceof Element ? node : node.parentElement
	const section = element?.closest(".pdf-page")
	return section ? renderers.get(section) : undefined
}

function selectedDocument(range: Range): ReadingDocument {
	const first = pageAt(range.startContainer)
	const last = pageAt(range.endContainer)
	if (!first || !last) throw new Error("Select some PDF text first.")
	const from = Math.min(first.number, last.number)
	const to = Math.max(first.number, last.number)
	return normalizeDocument(selectRange(pageDocuments(from, to), range), true)
}

function captureSelection() {
	const selection = getSelection()
	if (!selection?.toString().trim() || !selection.rangeCount) return
	try {
		pendingSelection = selectedDocument(selection.getRangeAt(0))
	} catch {
		pendingSelection = undefined
	}
}
function takeSelection(): ReadingDocument | undefined {
	const selection = getSelection()
	const captured =
		selection?.toString().trim() && selection.rangeCount ? selectedDocument(selection.getRangeAt(0)) : pendingSelection
	pendingSelection = undefined
	selection?.removeAllRanges()
	return captured
}
document.addEventListener("selectionchange", captureSelection)
pages.addEventListener("contextmenu", captureSelection)
pages.addEventListener("pointerdown", (event) => {
	if (event.button === 0) pendingSelection = undefined
})
document.addEventListener("keydown", (event) => {
	if (event.key === "Escape" || event.key.startsWith("Arrow")) pendingSelection = undefined
})

function setPageMetrics(section: HTMLElement, viewport: PageState["viewport"], scale: number) {
	section.style.width = `${viewport.width}px`
	section.style.height = `${viewport.height}px`
	section.style.setProperty("--total-scale-factor", String(scale))
}

// The page raster is background only; the text layer stays crisp at any zoom.
// These caps keep re-rendered pages inside browser canvas limits.
const MAX_CANVAS_SIDE = 16_384
const MAX_CANVAS_AREA = 24_000_000
const MIN_ZOOM = 0.5
const MAX_ZOOM = 5
const ZOOM_STEP = 1.25
let zoom = 1
let paintTimer: ReturnType<typeof setTimeout> | undefined

function canvasPixelRatio(viewport: PageState["viewport"]) {
	const side = MAX_CANVAS_SIDE / Math.max(viewport.width, viewport.height)
	const area = Math.sqrt(MAX_CANVAS_AREA / (viewport.width * viewport.height))
	return Math.min(devicePixelRatio, 2, side, area)
}

function scrollAnchor() {
	const center = scrollY + innerHeight / 2
	for (const item of pageStates) {
		const rect = item.section.getBoundingClientRect()
		if (rect.bottom < center) continue
		return {
			section: item.section,
			x: Math.min(1, Math.max(0, (scrollX + innerWidth / 2 - rect.left) / rect.width)),
			y: Math.min(1, Math.max(0, (center - rect.top) / rect.height)),
		}
	}
	return undefined
}

function applyZoom() {
	const anchor = scrollAnchor()
	for (const item of pageStates) {
		const scale = item.fitScale * zoom
		const viewport = item.page.getViewport({ scale })
		item.viewport = viewport
		setPageMetrics(item.section, viewport, scale)
	}
	if (anchor) {
		const rect = anchor.section.getBoundingClientRect()
		const top = rect.top + scrollY + anchor.y * rect.height
		const left = rect.left + scrollX + anchor.x * rect.width
		scrollTo({ top: Math.max(0, top - innerHeight / 2), left: Math.max(0, left - innerWidth / 2) })
	}
	zoomLevel.textContent = `${Math.round(zoom * 100)}%`
	// Re-rasterize visible pages once the gesture settles; layout stays immediate.
	clearTimeout(paintTimer)
	paintTimer = setTimeout(() => {
		for (const item of pageStates) {
			item.task?.cancel()
			if (item.visible) queuePaint(item)
		}
	}, 120)
}

function zoomTo(value: number) {
	const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value))
	if (next === zoom) return
	zoom = next
	applyZoom()
}

function clearMapping() {
	nativeMapping = undefined
	pendingSelection = undefined
	CSS.highlights?.delete(highlightKey)
}

function stop() {
	clearMapping()
	session.close()
	frame?.remove()
	frame = undefined
}

function describe(error: unknown) {
	return error instanceof Error ? error.message : "This PDF could not be read."
}

async function start(mode: "article" | "selection", initial?: ReadingDocument): Promise<boolean> {
	// Any explicit request supersedes startup, including a rejected selection.
	allowStart = false
	const started = await session.start(async () => {
		if (mode === "article") {
			const source = await articleDocument()
			if (!source.text.trim()) throw new Error("This PDF has no readable text layer.")
			return source
		}
		if (initial) {
			await selectionLocated.promise
			return initial
		}
		const selected = takeSelection()
		if (!selected) throw new Error("Select some PDF text first.")
		return selected
	})
	if (!started || !alive) return false
	if (mode === "article" || !initial) clearMapping()
	status.textContent = ""
	status.setAttribute("aria-live", "polite")
	if (frame?.isConnected) {
		frame.contentWindow?.postMessage(sourceChangedMessage(), location.origin)
		return true
	}
	frame = document.createElement("iframe")
	frame.title = "Syllune playback controls"
	if (import.meta.env.BROWSER !== "firefox") frame.allow = "autoplay"
	frame.src = `${browser.runtime.getURL("/player.html")}#${session.id}`
	controls.append(frame)
	return true
}

async function handleCommand(command: PdfCommand) {
	if (command.action === "stop") {
		allowStart = false
		stop()
		return
	}
	if (command.reveal && frame?.isConnected) {
		frame.focus()
		return
	}
	const reading = start(command.mode)
	if (command.mode === "article" && !articleBuilt) {
		// Accept preparation without holding the background's routing lock until
		// indexing finishes. A newer selection/stop can invalidate this request.
		void reading.catch((error: unknown) => {
			if (alive) {
				status.setAttribute("aria-live", "polite")
				status.textContent = describe(error)
			}
		})
		return
	}
	await reading
}

// A synchronous guard leaves unrelated runtime messages for their own receiver.
// Identity is established before the load routine yields its first document work.
browser.runtime.onMessage.addListener((message: unknown, sender) => {
	if (
		!isPdfCommand(message) ||
		message.tabId !== tabId ||
		!isExtensionBackgroundSender(sender, browser.runtime.id, browser.runtime.getURL("/"))
	)
		return
	return (async () => {
		try {
			await handleCommand(message)
			return { ok: true }
		} catch (error) {
			const failure = describe(error)
			if (alive) {
				status.setAttribute("aria-live", "polite")
				status.textContent = failure
			}
			return { ok: false, error: failure }
		}
	})()
})

window.readAloudHost = createReaderDispatcher({
	session,
	selection: takeSelection,
	replaced: clearMapping,
	close: stop,
	resize(size) {
		if (!frame) throw new Error("This reading session has ended.")
		frame.style.height = `${size.height}px`
		if (size.width !== undefined) controls.style.maxWidth = `${size.width}px`
	},
	async highlight(start, end) {
		const printed = nativeMapping?.document ?? session.source
		const bounds = nativeMapping ? nativeMapping.range(start, end) : { start, end }
		if (!bounds || !printed) {
			paintReaderHighlight(null)
			return
		}
		const current = session.revision
		try {
			for (const run of overlappingRuns(printed, bounds.start, bounds.end)) {
				const page = owners.get(run.node)
				if (page) await ensureText(page)
			}
		} catch {
			if (alive) status.textContent = "Could not highlight this page. Playback continues."
			throw new Error("Could not highlight this page. Playback continues.")
		}
		if (!session.isCurrent(current) || !alive || !frame) return
		paintReaderHighlight(sourceRange(printed, bounds.start, bounds.end))
	},
})

function queuePaint(item: PageState) {
	item.pending = item.pending
		.catch(() => {})
		.then(async () => {
			if (!alive) return
			if (!item.visible) {
				item.canvas.width = item.canvas.height = 0
				item.section.removeAttribute("data-painted")
				return
			}
			await ensureText(item)
			if (!item.visible || !alive) return
			const pixelRatio = canvasPixelRatio(item.viewport)
			const canvas = document.createElement("canvas")
			canvas.setAttribute("aria-hidden", "true")
			canvas.width = Math.ceil(item.viewport.width * pixelRatio)
			canvas.height = Math.ceil(item.viewport.height * pixelRatio)
			const task = item.page.render({
				canvas,
				viewport: item.viewport,
				...(pixelRatio === 1 ? {} : { transform: [pixelRatio, 0, 0, pixelRatio, 0, 0] }),
			})
			item.task = task
			try {
				await task.promise
				if (!item.visible || !alive) return
				// Swap only painted frames so zooming never blanks a visible page.
				item.canvas.replaceWith(canvas)
				item.canvas = canvas
				item.section.setAttribute("data-painted", "")
			} catch (error) {
				if (!(error instanceof Error && error.name === "RenderingCancelledException") && alive) throw error
			}
		})
		.catch(() => {
			if (alive) status.textContent = "A page image could not be rendered. Its text is still available."
		})
}

const observer = new IntersectionObserver(
	(entries) => {
		for (const entry of entries) {
			const item = renderers.get(entry.target)
			if (!item) continue
			item.visible = entry.isIntersecting
			if (!entry.isIntersecting) item.task?.cancel()
			queuePaint(item)
		}
	},
	{ rootMargin: "100% 0px" },
)

window.addEventListener(
	"wheel",
	(event) => {
		if (!event.ctrlKey || !event.cancelable || !event.deltaY) return
		event.preventDefault()
		const delta =
			event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * innerHeight : event.deltaY
		zoomTo(zoom * Math.exp(-delta * 0.0025))
	},
	{ passive: false },
)
window.addEventListener("keydown", (event) => {
	if (!(event.ctrlKey || event.metaKey) || event.altKey) return
	if (event.key === "+" || event.key === "=") {
		event.preventDefault()
		zoomTo(zoom * ZOOM_STEP)
	} else if (event.key === "-" || event.key === "_") {
		event.preventDefault()
		zoomTo(zoom / ZOOM_STEP)
	} else if (event.key === "0") {
		event.preventDefault()
		zoomTo(1)
	}
})
zoomControls.addEventListener("click", (event) => {
	const button = (event.target as Element | null)?.closest("button")
	if (button?.id === "zoom-in") zoomTo(zoom * ZOOM_STEP)
	else if (button?.id === "zoom-out") zoomTo(zoom / ZOOM_STEP)
	else if (button?.id === "zoom-reset") zoomTo(1)
})
let pdfTask: ReturnType<typeof getDocument> | undefined
const lifecycle = new AbortController()
window.addEventListener(
	"pagehide",
	() => {
		alive = false
		lifecycle.abort()
		clearTimeout(paintTimer)
		stop()
		observer.disconnect()
		for (const renderer of pageStates) renderer.task?.cancel()
		if (pendingSelectionKey) void browser.storage.session.remove(pendingSelectionKey)
		void pdfTask?.destroy()
	},
	{ once: true },
)

/** Build the full reading text only when the whole PDF is the requested scope. */
function articleDocument(): Promise<ReadingDocument> {
	return (articlePromise ??= (async () => {
		const pdf = await documentReady.promise
		const parts: ReadingDocument[] = []
		for (let number = 1; number <= pdf.numPages; number++) {
			if (!alive) throw new Error("This PDF reader has closed.")
			if (!frame) {
				status.setAttribute("aria-live", "off")
				status.textContent = `Preparing text · ${number} of ${pdf.numPages} pages`
			}
			const state = await pageThrough(number)
			await ensureContent(state)
			parts.push(pageDocument(state))
			await yieldToMain()
		}
		if (!frame) {
			status.setAttribute("aria-live", "off")
			status.textContent = "Preparing text"
		}
		const reading = normalizeDocument(concatDocuments(parts), true)
		articleBuilt = true
		if (!frame) {
			status.textContent = ""
			status.setAttribute("aria-live", "polite")
		}
		return reading
	})().catch((error) => {
		articlePromise = undefined
		throw error
	}))
}

/** Fill page geometry in the background so the viewer scrolls like a normal document. */
async function fillPageShells() {
	const pdf = await documentReady.promise
	while (alive && pageStates.length < pdf.numPages) {
		await pageThrough(pageStates.length + 1)
		await yieldToMain()
	}
}

function scrollToSelected(scope: ReadingDocument, mapping: ReturnType<typeof nativeSelectionMapping>, length: number) {
	const bounds = mapping.range(0, length)
	const range = bounds ? sourceRange(scope, bounds.start, bounds.end) : null
	const rect = range?.getClientRects()[0] ?? range?.getBoundingClientRect()
	if (rect) scrollBy({ top: rect.top - innerHeight * 0.35, behavior: "instant" })
}

async function locateInitialSelection(selection: ReadingDocument, revision: number) {
	const pdf = await documentReady.promise
	const search = new PdfSelectionSearch(selection.text)
	status.setAttribute("aria-live", "off")
	try {
		for (let number = 1; number <= pdf.numPages; number++) {
			if (!alive || !session.isCurrent(revision)) {
				selectionLocated.resolve()
				return
			}
			status.textContent = `Finding your selection · ${number} of ${pdf.numPages}`
			const state = await pageThrough(number)
			await ensureContent(state)
			if (number === 1) await ensureText(state).catch(() => {})
			const match = search.push(state.text)
			if (!match) {
				await yieldToMain()
				continue
			}
			const from = match.startPage + 1
			const to = match.endPage + 1
			for (let page = from; page <= to; page++) await ensureText(await pageThrough(page))
			const parts: ReadingDocument[] = []
			let end = match.end
			for (let page = from; page <= to; page++) {
				const part = pageDocument(await pageThrough(page))
				if (page < to) end += part.text.length
				parts.push(part)
			}
			const scope = sliceDocument(concatDocuments(parts), match.start, end)
			const mapping = nativeSelectionMapping(scope, selection.text)
			if (!session.isCurrent(revision) || !alive) {
				selectionLocated.resolve()
				return
			}
			nativeMapping = mapping
			scrollToSelected(scope, mapping, selection.text.length)
			status.textContent = ""
			status.setAttribute("aria-live", "polite")
			selectionLocated.resolve()
			return
		}
		selectionLocated.reject(
			new Error("This selection could not be located in the PDF. Select it in this reader and try again."),
		)
	} catch (error) {
		selectionLocated.reject(error)
		throw error
	}
}

async function load() {
	const raw = params.get("src")
	if (!raw) throw new Error("Open a PDF and choose Syllune from the browser toolbar.")
	const url = new URL(raw)
	if (!["https:", "http:", "file:"].includes(url.protocol)) throw new Error("This PDF address is not supported.")
	await ownTab
	if (params.has("source") && tabId !== undefined) {
		const stored = await browser.storage.session.get(readingKeys.pdfReaders)
		if (parsePdfReaders(stored[readingKeys.pdfReaders])[tabId] !== Number(params.get("source"))) {
			allowStart = false
			status.textContent = "Reading stopped because the original PDF changed or closed."
		}
	}
	let locationRevision = 0
	let wouldLocate = false
	if (params.get("mode") === "selection" && tabId !== undefined) {
		const token = params.get("selection")
		if (token !== null && !isPdfSelectionToken(token)) throw new Error("This PDF selection could not be opened.")
		const name = pdfSelectionKey(tabId, token ?? undefined)
		pendingSelectionKey = name
		const stored = await browser.storage.session.get(name)
		await browser.storage.session.remove(name)
		pendingSelectionKey = undefined
		if (typeof stored[name] !== "string" || !stored[name].trim())
			throw new Error("The PDF selection is no longer available. Select it in this reader and try again.")
		initialSelection = normalizeDocument({ text: stored[name], runs: [] }, true)
		if (allowStart && alive) {
			const reading = start("selection", initialSelection)
			locationRevision = session.revision
			wouldLocate = true
			void reading.catch((error: unknown) => {
				if (alive) {
					status.setAttribute("aria-live", "polite")
					status.textContent = describe(error)
				}
			})
		}
	}
	GlobalWorkerOptions.workerSrc = new URL("/pdf-runtime/pdf.worker.mjs", location.href).href
	let bytes: Uint8Array<ArrayBuffer> | undefined
	for (let attempt = 0; attempt < 2; attempt++) {
		const response = await fetchPdf(url, lifecycle.signal, status)
		if (!response.ok) throw new Error("The PDF could not be downloaded. Open it on its original site and try again.")
		const candidate = new Uint8Array(await response.arrayBuffer())
		// A login/challenge response can establish cookies before serving the
		// document. PDF.js remains the authority on whether the bytes are valid.
		if (
			attempt === 0 &&
			response.headers.get("content-type")?.includes("text/html") &&
			!new TextDecoder().decode(candidate.subarray(0, 1024)).includes("%PDF-")
		) {
			await new Promise((resolve) => setTimeout(resolve, 700))
			continue
		}
		bytes = candidate
		break
	}
	if (!bytes) throw new Error("The document could not be opened. Try again.")
	lifecycle.signal.throwIfAborted()
	const base = new URL("pdf-runtime/", location.href)
	const task = getDocument({
		data: bytes,
		cMapUrl: new URL("cmaps/", base).href,
		cMapPacked: true,
		standardFontDataUrl: new URL("standard_fonts/", base).href,
		wasmUrl: new URL("wasm/", base).href,
		iccUrl: new URL("iccs/", base).href,
		verbosity: 0,
	})
	pdfTask = task
	const pdf = await task.promise.catch(async (error: unknown) => {
		if (error instanceof Error && error.message.startsWith("Setting up fake worker failed:")) {
			let reason = error.message
			let line: number | undefined
			try {
				// Recover the module error swallowed by PDF.js. Only packaged-code
				// metadata is logged, never a PDF URL or selected text.
				// @ts-expect-error Packaged by prepare-runtime.ts, outside the module graph.
				await import(/* @vite-ignore */ "/pdf-runtime/pdf.worker.mjs")
			} catch (moduleError: unknown) {
				if (moduleError instanceof Error) {
					reason = moduleError.message
					if ("lineNumber" in moduleError && typeof moduleError.lineNumber === "number") line = moduleError.lineNumber
				}
			}
			console.error("Syllune: PDF worker startup failed", {
				asset: new URL(GlobalWorkerOptions.workerSrc, location.href).pathname,
				reason,
				line,
			})
			throw new Error("The PDF reader could not start. Reload the extension and reopen this PDF.")
		}
		if (error instanceof Error && error.name === "InvalidPDFException")
			throw new Error("This document is not a readable PDF. Open a PDF and try again.")
		throw error
	})
	documentReady.resolve(pdf)
	// The opening page is the viewer, and for a native selection it is also the
	// first candidate for locating the selected passage.
	const first = await pageThrough(1)
	await ensureText(first).catch(() => {})
	status.textContent = ""
	if (wouldLocate && initialSelection) {
		void locateInitialSelection(initialSelection, locationRevision)
			.catch((error: unknown) => {
				if (alive) {
					status.setAttribute("aria-live", "polite")
					status.textContent = describe(error)
				}
			})
			.finally(() => {
				if (alive && !articlePromise) void fillPageShells().catch(() => {})
			})
		return
	}
	if (allowStart && alive) {
		void start("article").catch((error: unknown) => {
			if (alive) {
				status.setAttribute("aria-live", "polite")
				status.textContent = describe(error)
			}
		})
	}
}

void load().catch((error) => {
	documentReady.reject(error)
	selectionLocated.reject(error)
	status.setAttribute("aria-live", "polite")
	if (pendingSelectionKey) void browser.storage.session.remove(pendingSelectionKey)
	if (!alive) return
	status.textContent = describe(error)
})
