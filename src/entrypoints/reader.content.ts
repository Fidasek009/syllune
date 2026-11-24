import { defineContentScript } from "#imports"
import { browser } from "wxt/browser"

import { isExtensionBackgroundSender, isExtensionPageSender } from "../extension/sender.ts"
import { createReaderDispatcher } from "../reading/dispatch.ts"
import {
	captureContinuation,
	captureDocument,
	emptyDocumentMessage,
	type ReadingDocument,
	type ReadingPoint,
	selectionPoint,
	sourceRange,
} from "../reading/document.ts"
import { currentWordHighlight, paintReaderHighlight } from "../reading/layout.ts"
import { isStartReadingMessage, readingMessages, sourceChangedMessage } from "../reading/messages.ts"
import { isEmbeddedPdfUrl } from "../reading/pdf-embed.ts"
import { ReaderSession } from "../reading/session.ts"

import currentWordStyle from "../reading/current-word.css?inline"
import frameStyle from "../reading/frame.css?inline"
import playerFrameStyle from "../reading/player-frame.css?inline"

export default defineContentScript({
	registration: "runtime",
	main(ctx) {
		const scope = globalThis as { __readAloudInstalled?: boolean }
		if (scope.__readAloudInstalled) return
		scope.__readAloudInstalled = true
		const session = new ReaderSession<ReadingDocument>()
		const playerOrigin = new URL(browser.runtime.getURL("/")).origin
		let host: HTMLDivElement | undefined
		let frame: HTMLIFrameElement | undefined
		let continuationPoint: ReadingPoint | undefined
		const pageAddress = () => `${location.origin}${location.pathname}${location.search}`
		/** A text-free wrapper page can still carry the PDF in its viewer frame. */
		const embeddedPdf = () => {
			for (const frame of document.querySelectorAll("iframe")) if (isEmbeddedPdfUrl(frame.src)) return frame.src
			return undefined
		}
		let sourceUrl = pageAddress()
		let navigationTimer: ReturnType<typeof setInterval> | undefined
		const key = currentWordHighlight
		const wordStyle = document.createElement("style")
		wordStyle.textContent = currentWordStyle
		const hostStyle = document.createElement("style")
		hostStyle.textContent = frameStyle
		const close = () => {
			clearInterval(navigationTimer)
			navigationTimer = undefined
			host?.remove()
			host = undefined
			frame = undefined
			continuationPoint = undefined
			session.close()
			CSS.highlights?.delete(key)
			wordStyle.remove()
			hostStyle.remove()
		}
		const captureSelection = () => {
			const selected = captureDocument("selection")
			const point = selectionPoint()
			window.getSelection()?.removeAllRanges()
			return { selected, point }
		}
		const dispatch = createReaderDispatcher({
			session,
			selection() {
				if (!window.getSelection()?.toString().trim()) return undefined
				const { selected, point } = captureSelection()
				continuationPoint = point
				return selected
			},
			continuation() {
				const point = continuationPoint
				if (!point) return undefined
				const next = captureContinuation(point)
				continuationPoint = undefined
				return next
			},
			replaced() {
				CSS.highlights?.delete(key)
			},
			close,
			resize(size) {
				if (!frame || !host) throw new Error("This reading session has ended.")
				frame.style.height = `${size.height}px`
				if (size.width !== undefined) host.style.setProperty("max-width", `${size.width}px`, "important")
			},
			highlight(start, end) {
				paintReaderHighlight(session.source ? sourceRange(session.source, start, end) : null)
			},
		})
		const onMessage: Parameters<typeof browser.runtime.onMessage.addListener>[0] = (message: unknown, sender) => {
			if (!message || typeof message !== "object" || !("type" in message)) return
			const background = isExtensionBackgroundSender(sender, browser.runtime.id, browser.runtime.getURL("/"))
			const player = isExtensionPageSender(sender, browser.runtime.id, browser.runtime.getURL("/"), ["/player.html"])
			if (isStartReadingMessage(message) && background) {
				try {
					if (message.reveal === true && frame?.isConnected) {
						frame.focus()
						return Promise.resolve({ ok: true })
					}
					const captured =
						message.mode === "selection"
							? captureSelection()
							: { selected: captureDocument("article"), point: undefined }
					sourceUrl = pageAddress()
					const open = frame?.isConnected
					if (!open) close()
					continuationPoint = captured.point
					session.replace(captured.selected)
					CSS.highlights?.delete(key)
					if (open) {
						frame?.contentWindow?.postMessage(sourceChangedMessage(), playerOrigin)
						return Promise.resolve({ ok: true })
					}
					host = document.createElement("div")
					host.dataset.readAloud = ""
					const shadow = host.attachShadow({ mode: "open" })
					const shadowStyle = document.createElement("style")
					shadowStyle.textContent = playerFrameStyle
					frame = document.createElement("iframe")
					frame.title = "Syllune playback controls"
					frame.src = `${browser.runtime.getURL("/player.html")}#${session.id}`
					if (import.meta.env.BROWSER !== "firefox") frame.allow = "autoplay"
					shadow.append(shadowStyle, frame)
					document.documentElement.append(host, wordStyle, hostStyle)
					navigationTimer = setInterval(() => {
						if (pageAddress() !== sourceUrl) close()
					}, 300)
					return Promise.resolve({ ok: true })
				} catch (error) {
					const pdf =
						message.mode === "article" && error instanceof Error && error.message === emptyDocumentMessage
							? embeddedPdf()
							: undefined
					if (pdf) {
						close()
						return Promise.resolve({ pdf })
					}
					return Promise.resolve({ error: error instanceof Error ? error.message : "This page could not be read." })
				}
			}
			if (message.type === readingMessages.stop && background) {
				close()
				return Promise.resolve({ ok: true })
			}
			if (message.type !== readingMessages.reader || (!background && !player)) return
			return dispatch(message)
		}
		browser.runtime.onMessage.addListener(onMessage)
		ctx.addEventListener(window, "pagehide", close)
		ctx.onInvalidated(() => {
			browser.runtime.onMessage.removeListener(onMessage)
			scope.__readAloudInstalled = false
			close()
		})
	},
})
