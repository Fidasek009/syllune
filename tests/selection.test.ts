import { expect, test } from "bun:test"

import { concatDocuments, overlappingRuns } from "../src/reading/document.ts"
import { locateSelection, mapNativeSelection, nativeSelectionMapping } from "../src/reading/selection.ts"

test("native PDF selection normalizes layout whitespace while retaining exact source offsets", () => {
	const node = {} as Text
	const source = { text: "Header\nDobrý   den.\nFooter", runs: [{ from: 7, to: 19, node, offset: 0 }] }
	const selected = locateSelection(source, "Dobrý den.")
	expect(selected.text).toBe("Dobrý   den.")
	expect(selected.runs).toEqual([{ from: 0, to: 12, node, offset: 0 }])
})

test("selection rejects ambiguous and missing matches instead of reading the whole document", () => {
	expect(() => locateSelection({ text: "Repeated. Repeated.", runs: [] }, "Repeated.")).toThrow("more than once")
	expect(() => locateSelection({ text: "Original", runs: [] }, "Missing")).toThrow("could not be located")
})

test("PDF ligatures and supplementary Unicode retain source character boundaries", () => {
	expect(locateSelection({ text: "The oﬃce 😀.", runs: [] }, "office 😀").text).toBe("oﬃce 😀")
})

test("offset lookup skips unrelated pages while including split runs and layout gaps", () => {
	const node = {} as Text
	const runs = Array.from({ length: 1000 }, (_, i) => ({ from: i * 4, to: i * 4 + 3, node, offset: 0 }))
	const source = { text: "a".repeat(4000), runs }
	expect(overlappingRuns(source, 2001, 2009)).toEqual(runs.slice(500, 503))
	expect(overlappingRuns(source, 2003, 2004)).toEqual([])
	expect(overlappingRuns(source, 3999, 4000)).toEqual([])
})

test("native speech offsets map through PDF whitespace, ligatures and composed accents", () => {
	const printed = { text: "Header\nThe oﬃce   café\nFooter", runs: [] }
	const native = "The office cafe\u0301"
	const mapping = mapNativeSelection(printed, native)
	expect(mapping.document.text).toBe("The oﬃce   café")
	const office = mapping.range(4, 10)!
	expect(mapping.document.text.slice(office.start, office.end)).toBe("oﬃce")
	const cafe = mapping.range(11, native.length)!
	expect(mapping.document.text.slice(cafe.start, cafe.end)).toBe("café")
	expect(mapping.range(0, 0)).toBeNull()
	expect(mapping.range(-1, 2)).toBeNull()
})

test("native selection mapping preserves decomposed printed accents and line-wrap joins", () => {
	const mapping = mapNativeSelection(
		{ text: "Read in-\nfrastructure at the cafe\u0301.", runs: [] },
		"Read infrastructure at the café.",
	)
	const start = "Read infrastructure at the ".length
	const word = mapping.range(start, start + 4)!
	expect(mapping.document.text.slice(word.start, word.end)).toBe("cafe\u0301")
	expect(() => mapNativeSelection({ text: "Same. Same.", runs: [] }, "Same.")).toThrow("more than once")
})

test("native selection maps onto an already-located scope", () => {
	const scope = { text: "Header\nThe oﬃce   café\nFooter", runs: [] }
	const mapping = nativeSelectionMapping(scope, "The office cafe\u0301")
	expect(mapping.document).toBe(scope)
	const office = mapping.range(4, 10)!
	expect(scope.text.slice(office.start, office.end)).toBe("oﬃce")
	const cafe = mapping.range(11, "The office cafe\u0301".length)!
	expect(scope.text.slice(cafe.start, cafe.end)).toBe("café")
	expect(mapping.range(0, 0)).toBeNull()
})

test("concatenated page documents shift offsets while keeping live text bindings", () => {
	const first = { data: "One" } as Text
	const second = { data: "Two" } as Text
	const secondRun = { node: second, from: 0, to: 3, offset: 0 }
	const document = concatDocuments([
		{ text: "One ", runs: [{ node: first, from: 0, to: 3, offset: 0 }] },
		{ text: "Two", runs: [secondRun] },
	])
	expect(document.text).toBe("One Two")
	expect(document.runs.map((run) => [run.from, run.to])).toEqual([
		[0, 3],
		[4, 7],
	])
	const rebound = { data: "Two" } as Text
	secondRun.node = rebound
	expect(document.runs[1]!.node).toBe(rebound)
})

test("native mapping resolves hyphenation inside a located PDF scope", () => {
	const scope = {
		text: "Their day-to-day use is nev-\nertheless constrained by four limitations.",
		runs: [],
	}
	const native = "Their day-to-day use is nevertheless constrained by four limitations."
	const mapping = nativeSelectionMapping(scope, native)
	const start = native.indexOf("nevertheless")
	const word = mapping.range(start, start + "nevertheless".length)!
	expect(scope.text.slice(word.start, word.end).replace(/[-\s]/gu, "")).toBe("nevertheless")
})
