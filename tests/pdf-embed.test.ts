import { expect, test } from "bun:test"

import { isEmbeddedPdfResult } from "../src/reading/messages.ts"
import { isEmbeddedPdfUrl } from "../src/reading/pdf-embed.ts"

test("embedded viewer frames resolve only to direct PDF documents", () => {
	expect(isEmbeddedPdfUrl("https://ieeexplore.ieee.org/ielx7/32/9923560/09524503.pdf?tp=&arnumber=9524503&ref=")).toBe(
		true,
	)
	expect(isEmbeddedPdfUrl("http://127.0.0.1:8080/paper.PDF")).toBe(true)
	for (const value of [
		undefined,
		"",
		"about:srcdoc",
		"blob:https://example.org/1234",
		"javascript:alert(1)",
		"https://example.org/viewer?file=paper.pdf",
		"https://example.org/paper.pdf.html",
		"invalid",
	])
		expect(isEmbeddedPdfUrl(value)).toBe(false)
})

test("only readable embedded PDF URLs are accepted as a start result", () => {
	const pdf = "https://example.org/paper.pdf"
	expect(isEmbeddedPdfResult({ pdf })).toBe(true)
	expect(isEmbeddedPdfResult({ pdf: "https://example.org/viewer" })).toBe(false)
	expect(isEmbeddedPdfResult({ error: "No readable text was found on this page." })).toBe(false)
	expect(isEmbeddedPdfResult({ pdf: 42 })).toBe(false)
})
