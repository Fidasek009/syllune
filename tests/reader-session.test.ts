import { expect, test } from "bun:test"

import type { ReadingDocument } from "../src/reading/document.ts"

import { createReaderDispatcher } from "../src/reading/dispatch.ts"
import { ReaderSession } from "../src/reading/session.ts"

const scope = (text: string): ReadingDocument => ({ text, runs: [] })

test("a rejected selection supersedes an article still indexing", async () => {
	const session = new ReaderSession<ReadingDocument>()
	const indexing = Promise.withResolvers<ReadingDocument>()
	const article = session.start(() => indexing.promise)
	await expect(
		session.start(() => {
			throw new Error("Select some PDF text first.")
		}),
	).rejects.toThrow("Select some PDF text first.")
	indexing.resolve(scope("entire document"))
	expect(await article).toBe(false)
	expect(session.source).toBeUndefined()
	expect(session.id).toBe("")
})

test("a selection starts before indexing finishes and survives later completion", async () => {
	const session = new ReaderSession<ReadingDocument>()
	const indexing = Promise.withResolvers<ReadingDocument>()
	const article = session.start(() => indexing.promise)
	expect(await session.start(() => scope("selected paragraph"))).toBe(true)
	indexing.resolve(scope("entire document"))
	expect(await article).toBe(false)
	expect(session.source?.text).toBe("selected paragraph")
	const id = session.id
	session.close()
	expect(session.id).toBe("")
	expect(session.replace(scope("next selection")).session).not.toBe(id)
})

test("closing a reader prevents pending preparation from reopening it", async () => {
	const session = new ReaderSession<ReadingDocument>()
	const pending = Promise.withResolvers<ReadingDocument>()
	const start = session.start(() => pending.promise)
	session.close()
	pending.resolve(scope("stale article"))
	expect(await start).toBe(false)
	expect(session.source).toBeUndefined()
})

test("a continuation that finishes after a scope replacement cannot change the session", async () => {
	const session = new ReaderSession<ReadingDocument>()
	session.replace(scope("selected text"))
	const pending = Promise.withResolvers<ReadingDocument>()
	let replaced = 0
	const host = createReaderDispatcher({
		session,
		selection: () => undefined,
		continuation: () => pending.promise,
		replaced: () => replaced++,
		close: () => session.close(),
		resize: () => {},
		highlight: () => {},
	})
	const request = host({ session: session.id, command: "continue" })
	session.replace(scope("a newer selection"))
	pending.resolve(scope("stale remainder"))
	expect(await request).toEqual({ error: "This reading session has ended." })
	expect(session.source?.text).toBe("a newer selection")
	expect(replaced).toBe(0)
})

test("both reader surfaces share selection replacement and stale-session semantics", async () => {
	const session = new ReaderSession<ReadingDocument>()
	session.replace(scope("initial scope"))
	let selection: ReadingDocument | undefined
	let continuation: ReadingDocument | undefined
	let replaced = 0
	let painted: [number, number] | undefined
	const host = createReaderDispatcher({
		session,
		selection: () => {
			const next = selection
			selection = undefined
			return next
		},
		continuation: () => {
			const next = continuation
			continuation = undefined
			return next
		},
		replaced: () => {
			replaced++
		},
		close: () => session.close(),
		resize: () => {},
		highlight: (start, end) => {
			painted = [start, end]
		},
	})
	const id = session.id
	expect(await host({ session: id, command: "selection" })).toEqual({ text: null })
	expect(session.source?.text).toBe("initial scope")
	selection = scope("new selection")
	expect(await host({ session: id, command: "selection" })).toEqual({ text: "new selection" })
	expect(replaced).toBe(1)
	expect(await host({ session: id, command: "document" })).toEqual({ text: "new selection" })
	expect(await host({ session: id, command: "continue" })).toEqual({ text: null })
	continuation = scope("text after the selection")
	expect(await host({ session: id, command: "continue" })).toEqual({ text: "text after the selection" })
	expect(session.source?.text).toBe("text after the selection")
	expect(replaced).toBe(2)
	expect(await host({ session: id, command: "highlight", start: 0, end: 3 })).toEqual({ ok: true })
	expect(painted).toEqual([0, 3])
	expect(await host({ session: id, command: "highlight", start: 3, end: 0 })).toEqual({
		error: "Invalid reading request.",
	})
	await host({ session: id, command: "close" })
	expect(await host({ session: id, command: "document" })).toEqual({ error: "This reading session has ended." })
})
