import type { ReadingDocument } from "./document.ts"
import type { ReaderSession } from "./session.ts"

import { isReaderRequest, type ReaderHost } from "./host.ts"
import { readerSize } from "./layout.ts"

interface ReaderSurface {
	session: ReaderSession<ReadingDocument>
	selection(): ReadingDocument | undefined | Promise<ReadingDocument | undefined>
	replaced(): void
	close(): void
	resize(size: ReturnType<typeof readerSize>): void
	highlight(start: number, end: number): void | Promise<void>
}

/** One command contract and scope-replacement rule for web pages and PDF pages. */
export function createReaderDispatcher(surface: ReaderSurface): (message: unknown) => ReturnType<ReaderHost> {
	return async (message) => {
		if (!isReaderRequest(message)) return { error: "Invalid reading request." }
		const session = surface.session
		if (!session.id || message.session !== session.id) return { error: "This reading session has ended." }
		try {
			switch (message.command) {
				case "document":
					if (!session.source) throw new Error("This reading session has no text.")
					return { text: session.source.text }
				case "selection": {
					const selected = await surface.selection()
					if (!session.id || message.session !== session.id) return { error: "This reading session has ended." }
					if (!selected) return { text: null }
					session.replace(selected)
					surface.replaced()
					return { text: selected.text }
				}
				case "close":
					surface.close()
					break
				case "resize":
					surface.resize(readerSize(message.height, message.width))
					break
				case "highlight":
					await surface.highlight(message.start, message.end)
					break
			}
			return { ok: true }
		} catch (error) {
			return { error: error instanceof Error ? error.message : "This reading request could not be completed." }
		}
	}
}
