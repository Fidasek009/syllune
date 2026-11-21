import { expect, test } from "bun:test"

import { destinationTop, externalLinkTarget, isPdfLinkAnnotation, linkRects } from "../src/reading/pdf-links.ts"

const rect = [10, 20, 110, 30]

test("PDF link annotations require a rectangle and a usable target", () => {
	expect(isPdfLinkAnnotation({ subtype: "Link", rect, url: "https://example.org/" })).toBe(true)
	expect(isPdfLinkAnnotation({ subtype: "Link", rect, dest: "chapter-2" })).toBe(true)
	expect(isPdfLinkAnnotation({ subtype: "Link", rect, dest: [3, { name: "XYZ" }, 0, 700, 1] })).toBe(true)
	expect(isPdfLinkAnnotation({ subtype: "Link", rect, hidden: true, url: "https://example.org/" })).toBe(false)
	expect(isPdfLinkAnnotation({ subtype: "Text", rect, url: "https://example.org/" })).toBe(false)
	// PDF.js exposes rejected schemes as unsafeUrl only; the guard must ignore them.
	expect(isPdfLinkAnnotation({ subtype: "Link", rect, unsafeUrl: "javascript:alert(1)" })).toBe(false)
	expect(isPdfLinkAnnotation({ subtype: "Link", url: "https://example.org/" })).toBe(false)
	expect(isPdfLinkAnnotation({ subtype: "Link", rect: [0, 0, 10], url: "https://example.org/" })).toBe(false)
	expect(isPdfLinkAnnotation({ subtype: "Link", rect: [0, 0, 10, "30"], url: "https://example.org/" })).toBe(false)
	expect(isPdfLinkAnnotation(null)).toBe(false)
})

test("wrapped PDF links use one hotspot per quadrilateral", () => {
	const rect = [0, 0, 200, 40] as const
	expect(linkRects({ rect, quadPoints: new Float32Array([0, 40, 100, 40, 0, 30, 100, 30]) })).toEqual([
		[0, 30, 100, 40],
	])
	expect(
		linkRects({
			rect,
			quadPoints: new Float32Array([0, 40, 100, 40, 0, 30, 100, 30, 0, 20, 50, 20, 0, 10, 50, 10]),
		}),
	).toEqual([
		[0, 30, 100, 40],
		[0, 10, 50, 20],
	])
	expect(linkRects({ rect })).toEqual([rect])
	expect(linkRects({ rect, quadPoints: [0, 40, 100] })).toEqual([rect])
})

test("external PDF links open only through browser-safe protocols", () => {
	for (const url of ["https://example.org/", "http://example.org/", "mailto:a@example.org"])
		expect(externalLinkTarget(url)?.protocol).toBe(new URL(url).protocol)
	expect(externalLinkTarget("tel:+420123456789")?.protocol).toBe("tel:")
	for (const url of [
		"javascript:alert(1)",
		"data:text/html,hi",
		"file:///etc/passwd",
		"ftp://example.org/",
		"/relative",
		"",
	])
		expect(externalLinkTarget(url)).toBeUndefined()
})

test("destination anchors read the top coordinate from each destination mode", () => {
	const ref = { num: 4, gen: 0 }
	expect(destinationTop([ref, { name: "XYZ" }, 12, 700, 2])).toBe(700)
	expect(destinationTop([ref, { name: "XYZ" }, 12, null, 2])).toBeUndefined()
	expect(destinationTop([ref, { name: "FitH" }, 640])).toBe(640)
	expect(destinationTop([ref, { name: "FitBH" }, 640])).toBe(640)
	expect(destinationTop([ref, { name: "FitR" }, 0, 120, 600, 720])).toBe(720)
	expect(destinationTop([ref, { name: "Fit" }])).toBeUndefined()
	expect(destinationTop([ref, { name: "FitV" }, 0])).toBeUndefined()
	expect(destinationTop([ref, "FitH", 640])).toBeUndefined()
	expect(destinationTop([ref, { name: "FitH" }, "640"])).toBeUndefined()
})
