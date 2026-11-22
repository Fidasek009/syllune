import type { browser } from "wxt/browser"

import type {} from "../src/reading/bridge.ts"
import type { ReaderHost } from "../src/reading/host.ts"

import { pageScript } from "./page-script.ts"

type ProbeWindow = Window & { browser?: typeof browser; chrome?: typeof browser }

/** Self-contained acceptance assertions serialized into the real extension PDF tab. */
async function checkPdfSelectionInBrowser() {
	function element<T extends Element>(selector: string): T {
		const node = document.querySelector<T>(selector)
		if (!node) throw Error("Missing PDF fixture element: " + selector)
		return node
	}
	function pageSelection(): Selection {
		const selection = window.getSelection()
		if (!selection) throw Error("PDF selection API is unavailable")
		return selection
	}
	function requiredTabId(id: number | undefined): number {
		if (id === undefined) throw Error("PDF fixture tab ID is unavailable")
		return id
	}
	function record(value: unknown): Record<string, unknown> {
		if (!value || typeof value !== "object") throw Error("Invalid PDF probe response")
		return value as Record<string, unknown>
	}
	function highlightRange(): Range {
		const range = CSS.highlights?.get("read-aloud-current-word")?.values().next().value
		if (!(range instanceof Range)) throw Error("PDF range could not be highlighted")
		return range
	}
	const host: ReaderHost | undefined = window.readAloudHost
	if (!host) throw Error("PDF reading host is unavailable")
	const probeWindow = window as ProbeWindow
	const api = probeWindow.browser ?? probeWindow.chrome
	if (!api) throw Error("PDF extension APIs are unavailable")
	const selectedText = async () => {
		const response = await host({ session, command: "selection" })
		if (!("text" in response)) throw Error("PDF selection response has no text")
		return response.text
	}
	const readerMap = async (): Promise<Record<string, number>> => {
		const raw: unknown = (await api.storage.session.get("pdfReaders")).pdfReaders
		if (raw === undefined) return {}
		const values = record(raw)
		const result: Record<string, number> = {}
		for (const [key, value] of Object.entries(values)) {
			if (typeof value !== "number") throw Error("Invalid PDF reader mapping")
			result[key] = value
		}
		return result
	}

	const frame = element<HTMLIFrameElement>("iframe")
	const frameWindow = frame.contentWindow as ProbeWindow | null
	if (!frameWindow) throw Error("PDF player window is unavailable")
	if (frameWindow.location.href !== frame.src || frame.contentDocument?.readyState !== "complete")
		await new Promise<void>((resolve) => frame.addEventListener("load", () => resolve(), { once: true }))
	let session = new URL(frame.src).hash.slice(1)
	const invalid = await host({ session, command: "highlight", start: 2, end: 1 })
	if (!("error" in invalid)) throw Error("PDF reader accepted an invalid highlight")
	const extension = frameWindow.browser ?? frameWindow.chrome
	if (!extension) throw Error("PDF player extension APIs are unavailable")
	const { tabs } = extension
	// Keep only parent-owned data: Firefox invalidates objects from a closed iframe.
	const tab = { id: requiredTabId((await tabs.getCurrent())?.id) }
	const read = async (mode: "article" | "selection", allowError = false) => {
		// Use the same background->reader route as the production context menu.
		await api.runtime.sendMessage({
			type: "probe-context-menu",
			tab,
			info: { menuItemId: mode === "selection" ? "read-selection" : "read-page", pageUrl: location.href },
		})

		const error = element<HTMLParagraphElement>("#status").textContent
		if (error && !allowError) throw Error(error)
		return { error }
	}
	const documentText = async () => {
		const response = await host({ session, command: "document" })
		if (!("text" in response) || typeof response.text !== "string") throw Error("PDF document text is unavailable")
		return response.text
	}
	const full = await documentText()
	const abstract = full.indexOf("Abstract")
	const start = full.indexOf("Molecular dynamics (MD)", abstract)
	const ending = "open-source project."
	const end = full.indexOf(ending, start) + ending.length
	if (abstract < 0 || start < abstract || end < start) throw Error("Abstract fixture not found")
	// Select real lazy-rendered text before any highlight can repair its mappings.
	const abstractPage = element<HTMLElement>(".pdf-page:nth-child(6)")
	abstractPage.scrollIntoView()
	let first: Text | undefined, last: Text | undefined
	const lazyDeadline = performance.now() + 10000
	do {
		const walker = document.createTreeWalker(abstractPage.querySelector(".textLayer")!, NodeFilter.SHOW_TEXT)
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			if (node instanceof Text && node.data.includes("Their day-to-day")) first = node
			if (node instanceof Text && node.data.includes("disconnection of analysis")) last = node
		}
		if (first && last) break
		await new Promise<void>((resolve) => setTimeout(resolve, 25))
	} while (performance.now() < lazyDeadline)
	if (!first || !last) throw Error("Visible abstract text layer did not render")
	const freshRange = document.createRange()
	freshRange.setStart(first, first.data.indexOf("Their day-to-day"))
	freshRange.setEnd(last, last.data.indexOf("workflow.") + "workflow.".length)
	const expectedFresh = full.slice(
		full.indexOf("Their day-to-day", start),
		full.indexOf("workflow.", start) + "workflow.".length,
	)
	pageSelection().removeAllRanges()
	pageSelection().addRange(freshRange)
	const fresh = await host({ session, command: "selection" })
	if (!("text" in fresh) || fresh.text !== expectedFresh)
		throw Error("A fresh DOM selection failed without a preceding highlight: " + JSON.stringify(fresh))
	await read("article")
	pageSelection().addRange(freshRange)
	document.dispatchEvent(new Event("selectionchange"))
	pageSelection().removeAllRanges()
	const afterFocus = await host({ session, command: "selection" })
	if (!("text" in afterFocus) || afterFocus.text !== expectedFresh)
		throw Error("Play lost selection when focus moved to controls")
	await read("article")
	element<HTMLDivElement>("#pages").dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }))
	if ((await selectedText()) !== null) throw Error("Consumed selection was reused")
	const select = async (from: number, to: number, fromPlay = false) => {
		await read("article")
		await host({ session, command: "highlight", start: from, end: to })
		const marked = CSS.highlights.get("read-aloud-current-word")
		if (!marked)
			throw Error(
				"PDF range could not be highlighted: " +
					JSON.stringify({ from, to, first: full.slice(from, from + 30), last: full.slice(to - 30, to) }),
			)
		const range = highlightRange().cloneRange()
		pageSelection().removeAllRanges()
		pageSelection().addRange(range)
		if (fromPlay) await host({ session, command: "selection" })
		else await read("selection")
		const actual = await documentText()
		if (actual !== full.slice(from, to)) throw Error("PDF selection lost text or layout separators")
		return actual
	}
	const text = await select(start, end)
	const expectedSentence =
		"Their day-to-day use is nevertheless constrained by four limitations: the absence of systematic performance tuning, the command-line nature of the dominant simulation engines, the lack of standardized data stewardship, and the disconnection of analysis from the rest of the workflow."
	if (!text.includes(expectedSentence)) throw Error("The reported abstract sentence is still hyphenated incorrectly")
	for (const word of ["nevertheless", "simulation"]) {
		const from = full.indexOf(word, full.indexOf("Their day-to-day", start))
		await read("article")
		await host({ session, command: "highlight", start: from, end: from + word.length })
		const range = highlightRange()
		if (range.getClientRects().length < 2 || range.toString().replace(/[-\s]/gu, "") !== word)
			throw Error("Reported split word does not map across both lines: " + word)
	}
	await select(start, end)
	if (!text.includes("workflow. This thesis") || !text.includes("metadata. The platform"))
		throw Error("PDF sentence boundaries collapsed into dotted words")
	const word = text.indexOf("This thesis")
	await host({ session, command: "highlight", start: word, end: word + 4 })
	if (highlightRange().toString() !== "This") throw Error("Highlight shifted after preserving PDF whitespace")
	const boundary = full.indexOf("workflow. This thesis", start) + 4
	const partial = await select(boundary, boundary + "flow. This the".length, true)
	if (partial !== "flow. This the") throw Error("Selection extended past its exact boundaries")
	const selection = pageSelection()
	const caret = document.createRange()
	const layer = element<HTMLDivElement>(".pdf-page:nth-child(6) .textLayer")
	caret.selectNodeContents(layer)
	caret.collapse(true)
	selection.removeAllRanges()
	selection.addRange(caret)
	const rejected = await read("selection", true)
	if (!rejected?.error || (await documentText()) !== partial) throw Error("Empty PDF selection started reading")
	const empty = await host({ session, command: "selection" })
	if (!("text" in empty) || empty.text !== null || (await documentText()) !== partial)
		throw Error("Play without a selection replaced the reading scope")
	selection.removeAllRanges()
	const domain = "Consensus.app",
		domainStart = full.indexOf(domain)
	if (domainStart < 0) throw Error("Domain fixture not found")
	if ((await select(domainStart, domainStart + domain.length, true)) !== domain)
		throw Error("PDF selection changed a genuine domain dot")
	const acknowledgements = full.indexOf("Acknowledgements")
	const crossStart = full.indexOf("This work was supported", acknowledgements)
	const crossEnd = full.slice(0, full.indexOf("This thesis", crossStart)).trimEnd().length
	if (crossStart < 0 || crossEnd < crossStart) throw Error("Cross-page fixture not found")
	const crossPage = await select(crossStart, crossEnd, true)
	if (!crossPage.includes("Abstract") || !crossPage.includes("iv"))
		throw Error("Cross-page selection lost a page boundary")
	await read("article")
	const joined = full.indexOf("infrastructure", acknowledgements)
	if (joined < 0) throw Error("PDF line-end hyphenation was not joined")
	await host({ session, command: "highlight", start: joined, end: joined + "infrastructure".length })
	const joinedRange = highlightRange()
	if (joinedRange.toString().replace(/[-\s]/gu, "") !== "infrastructure" || joinedRange.getClientRects().length < 2)
		throw Error("Joined PDF word no longer highlights both printed fragments")
	const compoundText = full.match(/pre-exascale/iu)?.[0] ?? ""
	const compound = compoundText ? full.indexOf(compoundText) : -1
	if (compound < 0) throw Error("Genuine compound hyphen was removed")
	await host({ session, command: "highlight", start: compound, end: compound + "pre-exascale".length })
	if (highlightRange().toString() !== compoundText) throw Error("Full compound highlight was lost")
	await read("article")
	await host({ session, command: "highlight", start, end })
	const restartRange = highlightRange().cloneRange()
	await host({ session, command: "close" })
	if (document.querySelector("iframe")) throw Error("PDF player did not close")
	pageSelection().removeAllRanges()
	pageSelection().addRange(restartRange)
	element<HTMLDivElement>("#pages").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2 }))
	pageSelection().removeAllRanges()
	const restart = record(
		await api.runtime.sendMessage({
			type: "probe-context-menu",
			omitTabUrl: true,
			tab,
			info: { menuItemId: "read-selection", pageUrl: location.href, selectionText: restartRange.toString() },
		}),
	)
	const deadline = performance.now() + 5000
	while (!document.querySelector("iframe") && performance.now() < deadline)
		await new Promise<void>((resolve) => setTimeout(resolve, 25))
	if (!document.querySelector("iframe")) throw Error("PDF context-menu command did not reopen the player")
	if (!restart?.omittedUrl) throw Error("PDF restart test did not exercise missing Tab.url")
	const oldSession = session
	session = new URL(element<HTMLIFrameElement>("iframe").src).hash.slice(1)
	if (session === oldSession) throw Error("PDF restart reused a closed session")
	const rejectedSession = "error" in (await host({ session: oldSession, command: "close" }))
	if (!rejectedSession || !document.querySelector("iframe"))
		throw Error("Closed PDF session still controls the new player")
	if ((await documentText()) !== full.slice(start, end)) throw Error("PDF restart lost its exact selection")
	await api.runtime.sendMessage({
		type: "probe-context-menu",
		tab,
		info: { menuItemId: "read-page", pageUrl: location.href },
	})
	const restoreDeadline = performance.now() + 5000
	while ((await documentText()) !== full && performance.now() < restoreDeadline)
		await new Promise<void>((resolve) => setTimeout(resolve, 25))
	if ((await documentText()) !== full) throw Error("PDF context-menu article restart failed")
	const firstPage = element<HTMLElement>(".pdf-page")
	const pageTop = firstPage.getBoundingClientRect().top + scrollY
	const frameHeight = element<HTMLIFrameElement>("iframe").getBoundingClientRect().height
	await host({ session, command: "resize", height: 160 })
	if (Math.abs(firstPage.getBoundingClientRect().top + scrollY - pageTop) > 1)
		throw Error("Floating PDF controls shifted the document")
	await host({ session, command: "resize", height: frameHeight })

	const sourceUrl = new URL(location.href).searchParams.get("src")
	if (!sourceUrl) throw Error("PDF source URL is unavailable")
	const createdSource = await api.tabs.create({ url: sourceUrl, active: false })
	const sourceTab = { ...createdSource, id: requiredTabId(createdSource.id) }
	try {
		const loadDeadline = performance.now() + 30000
		while ((await api.tabs.get(sourceTab.id)).status !== "complete" && performance.now() < loadDeadline)
			await new Promise<void>((resolve) => setTimeout(resolve, 50))
		// Let the background consume the source tab's initial loading event before mapping it.
		await new Promise<void>((resolve) => setTimeout(resolve, 500))
		await navigator.locks.request("read-aloud-pdf-readers", async () => {
			const previous = await readerMap()
			await api.storage.session.set({ pdfReaders: { ...previous, [tab.id]: sourceTab.id }, readingTab: tab.id })
		})
		await host({ session, command: "close" })
		const action = await api.runtime.sendMessage({
			type: "probe-action-click",
			tab: { id: sourceTab.id, url: sourceUrl },
		})
		const reopenDeadline = performance.now() + 5000
		while (!document.querySelector("iframe") && performance.now() < reopenDeadline)
			await new Promise<void>((resolve) => setTimeout(resolve, 25))
		if (!document.querySelector("iframe"))
			throw Error(
				"Toolbar did not reopen closed PDF controls: " +
					JSON.stringify({
						action,
						source: await api.tabs.get(sourceTab.id),
						reader: await api.tabs.get(tab.id),
						readers: await api.storage.session.get("pdfReaders"),
						badge: await api.action.getBadgeText({ tabId: sourceTab.id }),
						title: await api.action.getTitle({ tabId: sourceTab.id }),
						status: element<HTMLParagraphElement>("#status").textContent,
					}),
			)
	} finally {
		await navigator.locks.request("read-aloud-pdf-readers", async () => {
			const stored = await readerMap()
			delete stored[tab.id]
			await api.storage.session.set({ pdfReaders: stored })
		})
		await api.tabs.remove(sourceTab.id)
	}
	const createdSecondSource = await api.tabs.create({ url: sourceUrl, active: false })
	const secondSource = { ...createdSecondSource, id: requiredTabId(createdSecondSource.id) }
	let secondReader: number | undefined
	let navigatedReader: number | undefined
	try {
		const loadDeadline = performance.now() + 30000
		while ((await api.tabs.get(secondSource.id)).status !== "complete" && performance.now() < loadDeadline)
			await new Promise<void>((resolve) => setTimeout(resolve, 50))
		await new Promise<void>((resolve) => setTimeout(resolve, 500))
		const invoke = async (selectionText = "This thesis") =>
			record(
				await api.runtime.sendMessage({
					type: "probe-context-menu",
					omitReaderUrls: true,
					tab: { id: secondSource.id, url: sourceUrl },
					info: { menuItemId: "read-selection", pageUrl: sourceUrl, selectionText },
				}),
			)
		const first = await invoke()
		if (!first?.ok) throw Error("First native PDF selection failed: " + JSON.stringify(first))
		const readers = await readerMap()
		const matching = Object.entries(readers).filter(([, source]) => source === secondSource.id)
		if (matching.length !== 1)
			throw Error(
				"First PDF selection did not create one mapped reader: " +
					JSON.stringify({ first, readers, source: await api.tabs.get(secondSource.id), sourceUrl }),
			)
		secondReader = Number(matching[0]![0])
		const beforeRepeat = await api.tabs.get(secondReader).catch(() => null)
		const second = await invoke("Virtual Research Environment")
		if (!second?.ok) throw Error("Second native PDF selection failed: " + JSON.stringify(second))
		if (!second.omittedReaderUrls) throw Error("PDF reuse did not exercise missing reader Tab.url/pendingUrl")
		const token = (result: Record<string, unknown>) => {
			const trace = result.trace
			if (!Array.isArray(trace)) return null
			const navigation = trace
				.map((entry: unknown) => record(entry))
				.filter((entry) => entry.type === "update-tab" && typeof entry.url === "string")
				.at(-1)
			return typeof navigation?.url === "string" ? new URL(navigation.url).searchParams.get("selection") : null
		}
		const firstToken = token(first),
			secondToken = token(second)
		if (!firstToken || !secondToken || firstToken === secondToken)
			throw Error("PDF selections did not get independent navigation tokens")
		const updated = await readerMap()
		const repeated = Object.entries(updated).filter(([, source]) => source === secondSource.id)
		if (repeated.length !== 1 || Number(repeated[0]![0]) !== secondReader)
			throw Error(
				"Repeated PDF selections created another reader: " +
					JSON.stringify({ first, second, beforeRepeat, readers, updated }),
			)
		for (let attempt = 0; attempt < 8; attempt++) {
			const before = await api.tabs.get(secondReader).catch(() => null)
			const result = await invoke()
			const current = await readerMap()
			const matches = Object.entries(current).filter(([, source]) => source === secondSource.id)
			if (!result?.ok || matches.length !== 1 || Number(matches[0]![0]) !== secondReader)
				throw Error(
					"PDF reader reuse failed during repetition: " + JSON.stringify({ attempt, result, before, current }),
				)
		}
		const concurrent = await Promise.all([invoke(), invoke()])
		if (concurrent.some((result) => !result?.ok))
			throw Error("Concurrent PDF selections failed: " + JSON.stringify(concurrent))
		const afterConcurrent = await readerMap()
		const remaining = Object.entries(afterConcurrent).filter(([, source]) => source === secondSource.id)
		if (remaining.length !== 1 || Number(remaining[0]![0]) !== secondReader)
			throw Error("Concurrent PDF selections lost their reader mapping")
		// A mapped tab the user has navigated away from belongs to that new page.
		// Missing tab URLs must not cause us to overwrite it or mistake it for a reader.
		navigatedReader = secondReader
		await api.tabs.update(navigatedReader, { url: "about:blank" })
		const navigationDeadline = performance.now() + 5_000
		while (
			(await api.runtime.getContexts({ tabIds: [navigatedReader], frameIds: [0] })).length &&
			performance.now() < navigationDeadline
		)
			await new Promise<void>((resolve) => setTimeout(resolve, 25))
		const replacement = await invoke()
		const replacementReaders = Object.entries(await readerMap()).filter(([, source]) => source === secondSource.id)
		if (!replacement.ok || replacementReaders.length !== 1 || Number(replacementReaders[0]![0]) === navigatedReader)
			throw Error(
				"A PDF command reused a tab that had navigated away: " + JSON.stringify({ replacement, replacementReaders }),
			)
		secondReader = Number(replacementReaders[0]![0])
		// Simulate a reader closed before its latest staged selection is consumed.
		await api.storage.session.set({
			["pdfSelection:" + secondReader + ":" + crypto.randomUUID()]: "pending cleanup fixture",
		})
	} finally {
		if (navigatedReader !== undefined) await api.tabs.remove(navigatedReader).catch(() => {})
		if (secondReader !== undefined) await api.tabs.remove(secondReader).catch(() => {})
		await api.tabs.remove(secondSource.id).catch(() => {})
	}
	if (secondReader !== undefined) {
		const prefix = "pdfSelection:" + secondReader
		const pendingKeys = async () => {
			const keys =
				typeof api.storage.session.getKeys === "function"
					? await api.storage.session.getKeys()
					: Object.keys(await api.storage.session.get(null))
			return keys.filter((key) => key === prefix || key.startsWith(prefix + ":"))
		}
		const cleanupDeadline = performance.now() + 5000
		while ((await pendingKeys()).length && performance.now() < cleanupDeadline)
			await new Promise<void>((resolve) => setTimeout(resolve, 25))
		if ((await pendingKeys()).length) throw Error("Closing the PDF reader left staged selection text")
	}
	await api.runtime.sendMessage({
		type: "probe-context-menu",
		tab,
		info: { menuItemId: "read-page", pageUrl: location.href },
	})
	const restoreReaderDeadline = performance.now() + 5000
	while (
		!document.querySelector<HTMLIFrameElement>("iframe")?.contentDocument?.querySelector("#close") &&
		performance.now() < restoreReaderDeadline
	)
		await new Promise<void>((resolve) => setTimeout(resolve, 25))
	if (!document.querySelector<HTMLIFrameElement>("iframe")?.contentDocument?.querySelector("#close"))
		throw Error("PDF reader did not restore after the reuse check")
	return {
		toolbarReopensClosedControls: true,
		contextMenuRestart: true,
		repeatedNativeSelectionReusesReader: true,
		missingReaderUrlDiscovery: true,
		navigatedReaderNotReused: true,
		nativeSelectionRepetitions: 10,
		concurrentNativeSelectionReusesReader: true,
		independentSelectionTokens: true,
		closedSelectionCleanup: true,
		closedSessionRejected: true,
		floatingControlsDoNotShiftPages: true,
		crossPageCharacters: crossPage.length,
		layoutHyphenation: true,
		compoundHighlight: true,
		abstractCharacters: text.length,
		sentenceSpacing: true,
		exactSelection: true,
		highlighted: "This",
		emptySelectionRejected: true,
		playSelection: true,
		domainPreserved: domain,
	}
}

export const checkPdfSelection = pageScript(checkPdfSelectionInBrowser)
