import { defineBackground } from "#imports"
import { type Browser, browser } from "wxt/browser"

import { isExtensionPageSender } from "../extension/sender.ts"
import { isEmbeddedPdfResult, isReaderMessage, readingMessages, startReadingMessage } from "../reading/messages.ts"
import { isPdfReaderContext, isPdfReaderUrl } from "../reading/pdf-reader.ts"
import { commandPdf } from "../reading/pdf-transport.ts"
import { parsePdfReaders, parseReadingState, readingKeys, readingLocks } from "../reading/state.ts"
import { installSpeechBroker } from "../speech/broker.ts"

type StartReading = {
	tabId: number
	mode: "selection" | "article"
	reveal?: boolean
	pageUrl?: string | undefined
}

export default defineBackground(() => {
	const extensionRoot = browser.runtime.getURL("/")
	const pdfContext = async (tabId: number, sourceUrl?: string, sourceTab?: number) => {
		const contexts = await browser.runtime.getContexts({ contextTypes: ["TAB"], tabIds: [tabId], frameIds: [0] })
		return contexts.find((context) => isPdfReaderContext(context, tabId, extensionRoot, sourceUrl, sourceTab))
	}
	const pdfReader = async (tabId: number, sourceUrl: string, sourceTab: number, expectedUrl?: string) => {
		const deadline = performance.now() + 3_000
		do {
			const tab = await browser.tabs.get(tabId).catch(() => undefined)
			if (!tab) return undefined
			// A loading tab can still expose its old committed URL/context. Wait before
			// deciding whether it is our pending reader or a page the user navigated to.
			if (tab.status !== "loading") {
				const advertised = tab.pendingUrl ?? tab.url
				if (advertised && !isPdfReaderUrl(advertised, extensionRoot, sourceUrl, sourceTab)) {
					if (!expectedUrl) return undefined
				} else {
					const context = await pdfContext(tabId, sourceUrl, sourceTab)
					if (context && (!expectedUrl || context.documentUrl === expectedUrl)) return tab
					if (!expectedUrl) return undefined
				}
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 25))
		} while (performance.now() < deadline)
		throw new Error("The PDF reader is still opening. Try again when it finishes.")
	}
	const openPdf = async ({ tabId, sourceUrl }: { tabId: number; sourceUrl: string }) => {
		// The native viewer exposes the selected string but never where it is,
		// so any PDF is read in Syllune's reader, where selections map exactly.
		const url = new URL(browser.runtime.getURL("/pdf.html"))
		url.searchParams.set("src", sourceUrl)
		url.searchParams.set("source", String(tabId))
		await navigator.locks.request(readingLocks.pdfReaders, async () => {
			const stored = await browser.storage.session.get(readingKeys.pdfReaders)
			const readers = parsePdfReaders(stored[readingKeys.pdfReaders])
			let reader: Browser.tabs.Tab | undefined
			for (const [id, source] of Object.entries(readers)) {
				if (source !== tabId) continue
				const candidate = await pdfReader(Number(id), sourceUrl, tabId)
				if (candidate) {
					reader = candidate
					break
				}
				delete readers[id]
			}
			if (reader?.id !== undefined) {
				await browser.storage.session.set({
					[readingKeys.currentTab]: reader.id,
					[readingKeys.pdfReaders]: readers,
				})
				await commandPdf(reader.id, { action: "read", mode: "article", reveal: true })
				await browser.tabs.update(reader.id, { active: true })
				return
			}
			reader = await browser.tabs.create({ url: "about:blank", active: false })
			if (reader.id === undefined) return
			await browser.storage.session.set({
				[readingKeys.pdfReaders]: { ...readers, [reader.id]: tabId },
				[readingKeys.currentTab]: reader.id,
			})
			await browser.tabs.update(reader.id, { url: url.href, active: true })
			// tabs.update resolves before the new document necessarily commits.
			// Keep the registry lock until discovery can identify our actual page.
			if (!(await pdfReader(reader.id, sourceUrl, tabId, url.href)))
				throw new Error("The PDF reader changed or closed before it could open. Try again.")
		})
	}
	installSpeechBroker()
	browser.runtime.onInstalled.addListener(async (details) => {
		await browser.contextMenus.removeAll()
		browser.contextMenus.create({ id: "read-selection", title: "Read selection", contexts: ["selection"] })
		browser.contextMenus.create({ id: "read-page", title: "Read this page", contexts: ["page"] })
		if (details.reason === "install") await browser.tabs.create({ url: browser.runtime.getURL("/voices.html") })
	})
	const start = async ({ tabId, mode, reveal = false, pageUrl }: StartReading) =>
		navigator.locks.request(readingLocks.session, async () => {
			try {
				const tab = await browser.tabs.get(tabId)
				// Own extension tabs can omit Tab.url without the broad tabs permission.
				// The native context-menu event supplies the invoking document URL.
				const documentUrl = isPdfReaderUrl(pageUrl, extensionRoot)
					? pageUrl
					: (tab.url ?? pageUrl ?? (await pdfContext(tabId))?.documentUrl)
				await browser.action.setBadgeText({ tabId, text: "" })
				await browser.action.setTitle({ tabId, title: "Read this page" })
				const previous = parseReadingState(
					await browser.storage.session.get([readingKeys.currentTab, readingKeys.pdfReaders]),
				)
				const revealsPreviousPdf =
					reveal && previous.currentTab !== undefined && previous.pdfReaders[previous.currentTab] === tabId
				if (previous.currentTab !== undefined && previous.currentTab !== tabId && !revealsPreviousPdf) {
					if (previous.pdfReaders[previous.currentTab] !== undefined) {
						if (await pdfContext(previous.currentTab))
							await commandPdf(previous.currentTab, { action: "stop" }).catch(() => {})
					} else
						await browser.tabs
							.sendMessage(previous.currentTab, { type: readingMessages.stop }, { frameId: 0 })
							.catch(() => {})
					await browser.storage.session.remove(readingKeys.currentTab)
				}
				if (isPdfReaderUrl(documentUrl, extensionRoot)) {
					await commandPdf(tabId, { action: "read", mode, reveal })
					await browser.storage.session.set({ [readingKeys.currentTab]: tabId })
					return
				}
				// Inspect the loaded document, never its filename. Native PDF viewers
				// block injection; the reader verifies bytes after explicit site access.
				const supportedDocumentUrl = !!documentUrl && /^(?:https?|file):/u.test(documentUrl)
				let documentType: string | undefined
				if (supportedDocumentUrl) {
					try {
						const [result] = await browser.scripting.executeScript({
							target: { tabId },
							func: () => document.contentType,
						})
						if (typeof result?.result === "string") documentType = result.result
					} catch {
						/* Protected viewers require extension-owned document access. */
					}
				}
				if (supportedDocumentUrl && (documentType === undefined || documentType === "application/pdf")) {
					await openPdf({ tabId, sourceUrl: documentUrl })
					return
				}
				const message = startReadingMessage(mode, reveal)
				let result
				try {
					result = await browser.tabs.sendMessage(tabId, message, { frameId: 0 })
				} catch {
					await browser.scripting.executeScript({ target: { tabId }, files: ["/content-scripts/reader.js"] })
					result = await browser.tabs.sendMessage(tabId, message, { frameId: 0 })
				}
				if (isEmbeddedPdfResult(result)) {
					await openPdf({ tabId, sourceUrl: result.pdf })
					return
				}
				if (result?.error) throw new Error(String(result.error))
				await browser.storage.session.set({ [readingKeys.currentTab]: tabId })
			} catch (error) {
				await browser.action.setBadgeText({ tabId, text: "!" })
				await browser.action.setTitle({
					tabId,
					title: error instanceof Error ? error.message : "This page cannot be read here.",
				})
			}
		})
	browser.contextMenus.onClicked.addListener((info, tab) => {
		if (tab?.id !== undefined)
			return start({
				tabId: tab.id,
				mode: info.menuItemId === "read-selection" ? "selection" : "article",
				pageUrl: info.pageUrl,
			})
	})
	browser.action.onClicked.addListener((tab) => {
		if (tab.id !== undefined) void start({ tabId: tab.id, mode: "article", reveal: true, pageUrl: tab.url })
	})
	// Lock order is always reading session -> PDF registry -> individual PDF command.
	// Starts and cleanup share the outer lock, so cleanup cannot erase a newer start.
	const cleanReadingTab = (tabId: number, reason: "removed" | "loading" | "complete") =>
		navigator.locks.request(readingLocks.session, () =>
			navigator.locks.request(readingLocks.pdfReaders, async () => {
				const state = parseReadingState(
					await browser.storage.session.get([readingKeys.currentTab, readingKeys.pdfReaders]),
				)
				const readers = state.pdfReaders
				const wasReader = readers[tabId] !== undefined
				const stopped = new Set<number>()
				let changed = false
				for (const [reader, source] of Object.entries(readers)) {
					const readerId = Number(reader)
					if ((reason === "removed" || reason === "loading") && source === tabId) {
						if (await pdfContext(readerId)) await commandPdf(readerId, { action: "stop" }).catch(() => {})
						delete readers[reader]
						stopped.add(readerId)
						changed = true
					} else if (
						readerId === tabId &&
						(reason === "removed" || (reason === "complete" && !(await pdfContext(tabId, undefined, source))))
					) {
						// A controlled PDF reload retains its mapping. A committed web
						// navigation has no matching extension context and gives the tab up.
						delete readers[reader]
						stopped.add(readerId)
						changed = true
					}
				}
				if (changed) await browser.storage.session.set({ [readingKeys.pdfReaders]: readers })
				if (
					state.currentTab !== undefined &&
					(stopped.has(state.currentTab) ||
						(state.currentTab === tabId && (reason === "removed" || (reason === "loading" && !wasReader))))
				)
					await browser.storage.session.remove(readingKeys.currentTab)
			}),
		)
	browser.tabs.onRemoved.addListener((tabId) => {
		void cleanReadingTab(tabId, "removed")
	})
	browser.tabs.onUpdated.addListener((tabId, change) => {
		if (change.status === "loading" || change.status === "complete") void cleanReadingTab(tabId, change.status)
	})
	browser.runtime.onMessage.addListener((message: unknown, sender) => {
		if (
			!isExtensionPageSender(sender, browser.runtime.id, browser.runtime.getURL("/"), ["/player.html"]) ||
			!message ||
			typeof message !== "object" ||
			!("type" in message) ||
			message.type !== readingMessages.reader ||
			sender.tab?.id === undefined
		)
			return
		if (!isReaderMessage(message)) return Promise.resolve({ error: "Invalid reading request." })
		return browser.tabs.sendMessage(sender.tab.id, message, { frameId: 0 })
	})
})
