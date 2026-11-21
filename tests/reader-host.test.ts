import { expect, test } from "bun:test"

import { isReaderRequest, isReaderResponse } from "../src/reading/host.ts"
import { readerSize, shouldScrollToWord } from "../src/reading/layout.ts"

test("reader replies must match the requested command on both reading surfaces", () => {
	expect(isReaderResponse({ command: "document" }, { text: "selected text" })).toBe(true)
	expect(isReaderResponse({ command: "selection" }, { text: null })).toBe(true)
	expect(isReaderResponse({ command: "continue" }, { text: null })).toBe(true)
	expect(isReaderResponse({ command: "continue" }, { text: "rest of the page" })).toBe(true)
	expect(isReaderResponse({ command: "document" }, { text: null })).toBe(false)
	expect(isReaderResponse({ command: "highlight", start: 0, end: 1 }, { text: "wrong reply" })).toBe(false)
	expect(isReaderResponse({ command: "close" }, { ok: true })).toBe(true)
	expect(isReaderResponse({ command: "selection" }, { ok: true })).toBe(false)
	expect(isReaderResponse({ command: "close" }, undefined)).toBe(false)
	expect(isReaderResponse({ command: "selection" }, { error: "This reading session has ended." })).toBe(true)
})

test("reader requests validate commands and reject invalid values before reaching either host", () => {
	const session = "reader-session"
	for (const command of [
		{ command: "document" },
		{ command: "selection" },
		{ command: "continue" },
		{ command: "close" },
		{ command: "highlight", start: 0, end: 0 },
		{ command: "highlight", start: 3, end: 12 },
		{ command: "resize", height: 52, width: 460 },
	])
		expect(isReaderRequest({ session, ...command })).toBe(true)
	for (const command of [
		{ command: "highlight", start: -1, end: 1 },
		{ command: "highlight", start: 2, end: 1 },
		{ command: "highlight", start: 0.5, end: 1 },
		{ command: "highlight", start: 0, end: Number.MAX_SAFE_INTEGER + 1 },
		{ command: "resize", height: Number.NaN },
		{ command: "resize", height: 52, width: Infinity },
		{ command: "resize" },
		{ command: "unknown" },
	])
		expect(isReaderRequest({ session, ...command })).toBe(false)
	expect(isReaderRequest({ session: "", command: "close" })).toBe(false)
	expect(isReaderRequest({ session: "x".repeat(81), command: "close" })).toBe(false)
})

test("both reader surfaces use the same bounded dimensions and scroll thresholds", () => {
	expect(readerSize(-2, 1000)).toEqual({ height: 44, width: 640 })
	expect(readerSize(300, 100)).toEqual({ height: 240, width: 240 })
	expect(readerSize(52)).toEqual({ height: 52 })
	expect(shouldScrollToWord(149, 180, 800)).toBe(true)
	expect(shouldScrollToWord(150, 750, 800)).toBe(false)
	expect(shouldScrollToWord(150, 751, 800)).toBe(true)
})
