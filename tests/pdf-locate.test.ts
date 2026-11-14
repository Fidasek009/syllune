import { expect, test } from "bun:test"

import { PdfSelectionSearch } from "../src/reading/pdf-locate.ts"

test("paginated selection search stops on the page that contains the selection", () => {
	const search = new PdfSelectionSearch("Dobrý den.")
	expect(search.push("Header\n")).toBeUndefined()
	expect(search.push("Dobrý   den.\n")).toEqual({ startPage: 1, start: 0, endPage: 1, end: 12 })
})

test("paginated selection search maps a selection that crosses a page break", () => {
	const search = new PdfSelectionSearch("supported by a grant.")
	expect(search.push("This work was supported by")).toBeUndefined()
	expect(search.push("a grant.\nThis thesis")).toEqual({
		startPage: 0,
		start: "This work was ".length,
		endPage: 1,
		end: "a grant.".length,
	})
})

test("paginated selection search can find a selection after many unrelated pages", () => {
	const search = new PdfSelectionSearch("Unique closing remark.")
	for (let page = 0; page < 50; page++) expect(search.push(`Page ${page} has ordinary body text.\n`)).toBeUndefined()
	expect(search.push("Unique closing remark.\n")).toMatchObject({ startPage: 50, start: 0 })
})

test("paginated selection search matches canonical ligatures and whitespace", () => {
	const search = new PdfSelectionSearch("The office café")
	expect(search.push("The oﬃce   café\n")).toEqual({ startPage: 0, start: 0, endPage: 0, end: 15 })
})

test("paginated selection search joins a word hyphenated across a page break", () => {
	const search = new PdfSelectionSearch("Their day-to-day use is nevertheless constrained by four limitations.")
	expect(search.push("Their day-to-day use is nev-\n\n")).toBeUndefined()
	const continuation = "ertheless constrained by four limitations."
	expect(search.push(continuation + "\n")).toEqual({
		startPage: 0,
		start: 0,
		endPage: 1,
		end: continuation.length,
	})
})

test("paginated selection search never invents a match", () => {
	const search = new PdfSelectionSearch("Missing paragraph.")
	expect(search.push("Only this paragraph exists.\n")).toBeUndefined()
	expect(() => new PdfSelectionSearch("   ")).toThrow("Select some PDF text first.")
})
