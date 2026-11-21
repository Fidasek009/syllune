import { overlappingRuns, type ReadingDocument } from "./document.ts"
import { projectRun } from "./runs.ts"

const nodeIndexes = new WeakMap<ReadingDocument, WeakMap<Text, { first: number; last: number }>>()

function selectionRuns(source: ReadingDocument, range: Range) {
	if (typeof Text === "undefined" || !(range.startContainer instanceof Text) || !(range.endContainer instanceof Text))
		return source.runs
	let index = nodeIndexes.get(source)
	if (!index) {
		index = new WeakMap()
		for (let i = 0; i < source.runs.length; i++) {
			const node = source.runs[i]!.node
			const entry = index.get(node)
			if (entry) entry.last = i
			else index.set(node, { first: i, last: i })
		}
		nodeIndexes.set(source, index)
	}
	const first = index.get(range.startContainer)
	const last = index.get(range.endContainer)
	return first && last && first.first <= last.last ? source.runs.slice(first.first, last.last + 1) : source.runs
}

export function sliceDocument(source: ReadingDocument, start: number, end: number): ReadingDocument {
	return {
		text: source.text.slice(start, end),
		runs: overlappingRuns(source, start, end).map((run) =>
			projectRun(
				run,
				Math.max(run.from, start) - start,
				Math.min(run.to, end) - start,
				run.offset + Math.max(0, start - run.from),
			),
		),
	}
}

/** PDF text spans omit layout spaces; select from the mapped text, not DOM textContent. */
export function selectionBounds(source: ReadingDocument, range: Range | null): { start: number; end: number } {
	if (!range || range.collapsed) throw new Error("Select some PDF text first.")
	let start: number | undefined
	let end: number | undefined
	for (const run of selectionRuns(source, range)) {
		if (!run.node.isConnected || !range.intersectsNode(run.node)) continue
		const from = Math.max(run.offset, range.startContainer === run.node ? range.startOffset : run.offset)
		const to = Math.min(
			run.offset + run.to - run.from,
			range.endContainer === run.node ? range.endOffset : run.offset + run.to - run.from,
		)
		if (to <= from) continue
		start ??= run.from + from - run.offset
		end = run.from + to - run.offset
	}
	if (start === undefined || end === undefined) throw new Error("Select some PDF text first.")
	return { start, end }
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const hyphen = /[-\u2010\u2011\u00ad]/u

/**
 * Browser PDF viewers copy spacing, hyphens and Unicode forms differently from
 * PDF.js. Match only the remaining characters; each key character keeps the raw
 * offset of the grapheme it came from.
 */
export function matchText(text: string) {
	let value = "",
		offset = 0
	const positions: number[] = []
	const ends: number[] = []
	for (const { segment: character } of graphemes.segment(text)) {
		if (!/\s/u.test(character))
			for (const unit of character.normalize("NFKC").split("")) {
				if (hyphen.test(unit)) continue
				positions.push(offset)
				ends.push(offset + character.length)
				value += unit
			}
		offset += character.length
	}
	return { value, positions, ends }
}
