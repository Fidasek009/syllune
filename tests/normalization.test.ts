import { expect, test } from "bun:test"

import { normalizeDocument } from "../src/reading/normalize.ts"
import { PdfSelectionSearch } from "../src/reading/pdf-locate.ts"
import { selectRange, sliceDocument } from "../src/reading/selection.ts"

test("PDF selection follows late text-layer binding through normalization and slicing", () => {
	const values = ["nev-", "ertheless"]
	const runs = values.map((data, index) => ({
		node: { data, isConnected: false } as Text,
		from: index ? 5 : 0,
		to: index ? 14 : 4,
		offset: 0,
	}))
	const canonical = normalizeDocument({ text: "nev-\nertheless", runs }, true)
	const scope = sliceDocument(canonical, 0, canonical.text.length)
	const nodes = values.map((data) => ({ data, isConnected: true }) as Text)
	for (let index = 0; index < runs.length; index++) runs[index]!.node = nodes[index]!
	const range = {
		collapsed: false,
		startContainer: nodes[0],
		startOffset: 0,
		endContainer: nodes[1],
		endOffset: 9,
		intersectsNode: (node: Node) => nodes.includes(node as Text),
	} as unknown as Range
	expect(selectRange(canonical, range).text).toBe("nevertheless")
	expect(selectRange(scope, range).text).toBe("nevertheless")
	expect(scope.runs[0]!.node).toBe(nodes[0]!)
	expect(scope.runs[1]!.node).toBe(nodes[1]!)
})

test("a located PDF span preserves inline compounds and joins line-end hyphenation", () => {
	const raw =
		"Their day-to-day use is nev-\nertheless constrained by four limitations: the absence of systematic\nperformance tuning, the command-line nature of the dominant sim-\nulation engines, the lack of standardized data stewardship, and the\ndisconnection of analysis from the rest of the workflow."
	const expected =
		"Their day-to-day use is nevertheless constrained by four limitations: the absence of systematic performance tuning, the command-line nature of the dominant simulation engines, the lack of standardized data stewardship, and the disconnection of analysis from the rest of the workflow."
	const node = { data: raw } as Text
	const source = { text: raw, runs: [{ node, from: 0, to: raw.length, offset: 0 }] }
	const match = new PdfSelectionSearch(expected).push(raw)
	if (!match) throw new Error("The native selection was not located")
	const scope = normalizeDocument(sliceDocument(source, match.start, match.end), true)
	expect(scope.text).toBe(expected)
	for (const run of scope.runs)
		expect(scope.text.slice(run.from, run.to)).toBe(node.data.slice(run.offset, run.offset + run.to - run.from))
})

test("line-end hyphenation joins speech while source runs retain exact DOM characters", () => {
	const values = ["Read in-", "frastructure and pre-exascale. co\u00adoperate.\nNext paragraph."]
	const nodes = values.map((data) => ({ data }) as Text)
	const raw = values.join("\n")
	const source = {
		text: raw,
		runs: [
			{ node: nodes[0]!, from: 0, to: values[0]!.length, offset: 0 },
			{ node: nodes[1]!, from: values[0]!.length + 1, to: raw.length, offset: 0 },
		],
	}
	const normalized = normalizeDocument(source)
	expect(normalized.text).toBe("Read infrastructure and pre-exascale. cooperate.\nNext paragraph.")
	for (const run of normalized.runs)
		expect(normalized.text.slice(run.from, run.to)).toBe(
			run.node.data.slice(run.offset, run.offset + run.to - run.from),
		)
	const match = new PdfSelectionSearch("infrastructure and pre-exascale").push(raw)
	if (!match) throw new Error("The native selection was not located")
	const scope = normalizeDocument(sliceDocument(source, match.start, match.end), true)
	expect(scope.text).toBe("infrastructure and pre-exascale")
	expect(scope.runs[0]?.offset).toBe(5)
	expect(scope.runs.at(-1)?.node).toBe(nodes[1]!)
})

test("PDF layout line breaks become spaces, with page breaks, genuine hyphens and domain dots intact", () => {
	const normalized = normalizeDocument(
		{ text: "in-\nfrastructure.\nUse consensus.app and pre-exascale.\n\nSecond page.", runs: [] },
		true,
	)
	expect(normalized.text).toBe("infrastructure. Use consensus.app and pre-exascale.\n\nSecond page.")
	for (const text of ["pre-exascale", "in- frastructure", "in-\nFrance"])
		expect(normalizeDocument({ text, runs: [] }).text).toBe(text)
})

test("PDF page breaks join hyphenated words like the native viewer", () => {
	expect(normalizeDocument({ text: "in-\n\nfrastructure", runs: [] }, true).text).toBe("infrastructure")
	expect(normalizeDocument({ text: "in-\n\nfrastructure", runs: [] }).text).toBe("in-\n\nfrastructure")
	expect(normalizeDocument({ text: "in-\n\nFrance", runs: [] }, true).text).toBe("inFrance")
	expect(normalizeDocument({ text: "Jupyter-\nHub", runs: [] }, true).text).toBe("JupyterHub")
	expect(normalizeDocument({ text: "in\u2010\n\nfrastructure", runs: [] }, true).text).toBe("infrastructure")
})
