import { expect, test } from "bun:test"

import { concatDocuments, overlappingRuns } from "../src/reading/document.ts"
import { pdfHyphenation } from "../src/reading/normalize.ts"
import { canonicalText } from "../src/reading/selection.ts"

test("offset lookup skips unrelated pages while including split runs and layout gaps", () => {
	const node = {} as Text
	const runs = Array.from({ length: 1000 }, (_, i) => ({ from: i * 4, to: i * 4 + 3, node, offset: 0 }))
	const source = { text: "a".repeat(4000), runs }
	expect(overlappingRuns(source, 2001, 2009)).toEqual(runs.slice(500, 503))
	expect(overlappingRuns(source, 2003, 2004)).toEqual([])
	expect(overlappingRuns(source, 3999, 4000)).toEqual([])
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

test("canonical text keeps printed offsets for ligatures, collapsed whitespace and accents", () => {
	const raw = "The oﬃce   cafe\u0301\nFooter"
	const canonical = canonicalText(raw)
	expect(canonical.value).toBe("The office café Footer")
	expect(raw.slice(canonical.positions[4]!, canonical.ends[9]!)).toBe("oﬃce")
	expect(raw.slice(canonical.positions[11]!, canonical.ends[14]!)).toBe("cafe\u0301")
})

test("PDF hyphenation removes markers without deleting the continuation", () => {
	expect("nev-\nertheless".replace(pdfHyphenation, "")).toBe("nevertheless")
	expect("nev-\n\nertheless".replace(pdfHyphenation, "")).toBe("nevertheless")
	expect("day-to-day".replace(pdfHyphenation, "")).toBe("day-to-day")
})
