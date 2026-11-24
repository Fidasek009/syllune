import { expect, test } from "bun:test"

import { normalizeDocument } from "../src/reading/normalize.ts"
import { selectionBounds, sliceDocument } from "../src/reading/selection.ts"

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
	const canonicalSelection = selectionBounds(canonical, range)
	expect(sliceDocument(canonical, canonicalSelection.start, canonicalSelection.end).text).toBe("nevertheless")
	const scopeSelection = selectionBounds(scope, range)
	expect(sliceDocument(scope, scopeSelection.start, scopeSelection.end).text).toBe("nevertheless")
	expect(scope.runs[0]!.node).toBe(nodes[0]!)
	expect(scope.runs[1]!.node).toBe(nodes[1]!)
})

test("a PDF span preserves inline compounds and joins line-end hyphenation", () => {
	const raw =
		"Their day-to-day use is nev-\nertheless constrained by four limitations: the absence of systematic\nperformance tuning, the command-line nature of the dominant sim-\nulation engines, the lack of standardized data stewardship, and the\ndisconnection of analysis from the rest of the workflow."
	const expected =
		"Their day-to-day use is nevertheless constrained by four limitations: the absence of systematic performance tuning, the command-line nature of the dominant simulation engines, the lack of standardized data stewardship, and the disconnection of analysis from the rest of the workflow."
	const node = { data: raw } as Text
	const source = { text: raw, runs: [{ node, from: 0, to: raw.length, offset: 0 }] }
	const scope = normalizeDocument(sliceDocument(source, 0, raw.length), true)
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
	const from = raw.indexOf("in-")
	const to = raw.indexOf("pre-exascale") + "pre-exascale".length
	const scope = normalizeDocument(sliceDocument(source, from, to), true)
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
	expect(normalizeDocument({ text: "in-\n\nFrance", runs: [] }, true).text).toBe("in-France")
	expect(normalizeDocument({ text: "Jupyter-\nHub", runs: [] }, true).text).toBe("Jupyter-Hub")
	expect(normalizeDocument({ text: "state-of-the-\nart", runs: [] }, true).text).toBe("state-of-the-art")
	expect(normalizeDocument({ text: "in\u2010\n\nfrastructure", runs: [] }, true).text).toBe("infrastructure")
})
