import { overlappingRuns, type ReadingDocument } from "./document.ts"
import { layoutHyphenation, normalizeDocument } from "./normalize.ts"
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
export function selectRange(source: ReadingDocument, range: Range | null): ReadingDocument {
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
	return sliceDocument(source, start, end)
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })
/** Canonical selection text plus the printed offsets behind every canonical character. */
export function canonicalText(text: string) {
	let value = "",
		offset = 0
	const positions: number[] = []
	const ends: number[] = []
	const removed = [...text.matchAll(layoutHyphenation)]
	let removal = 0
	for (const { segment: character } of graphemes.segment(text)) {
		while (removed[removal] && offset >= removed[removal]!.index + removed[removal]![0].length) removal++
		const deletion = removed[removal]
		if (deletion && offset >= deletion.index) {
			offset += character.length
			continue
		}
		if (/\s/u.test(character)) {
			if (value && !value.endsWith(" ")) {
				positions.push(offset)
				ends.push(offset + character.length)
				value += " "
			}
		} else {
			for (const unit of character.normalize("NFKC").split("")) {
				positions.push(offset)
				ends.push(offset + character.length)
				value += unit
			}
		}
		offset += character.length
	}
	positions.push(text.length)
	return { value, positions, ends }
}

/** Match a native PDF selection without reading beyond it or losing DOM offsets. */
export function locateSelection(source: ReadingDocument, selection: string): ReadingDocument {
	// Matching normalized text must also return normalized speech, not a raw slice.
	source = normalizeDocument(source, true)
	const haystack = canonicalText(source.text)
	const needle = canonicalText(selection).value.trim()
	if (!needle) throw new Error("Select some PDF text first.")
	const match = haystack.value.indexOf(needle)
	if (match < 0)
		throw new Error("This selection could not be located in the PDF. Select it in this reader and try again.")
	if (haystack.value.indexOf(needle, match + 1) >= 0)
		throw new Error("This selection appears more than once. Select it in this reader to choose its exact location.")
	const start = haystack.positions[match]!
	const end = haystack.ends[match + needle.length - 1]!
	return sliceDocument(source, start, end)
}

/**
 * Map native-viewer selection offsets onto a located printed scope.
 * Callers locate the selection first; this only translates native offsets to printed ones.
 */
export function nativeSelectionMapping(printedSource: ReadingDocument, selection: string) {
	const native = canonicalText(selection)
	const printed = canonicalText(printedSource.text)
	const needle = native.value.trim()
	if (!needle) throw new Error("Select some PDF text first.")
	const match = printed.value.indexOf(needle)
	if (match < 0) throw new Error("The selection could not be mapped to the printed text.")
	const boundary = (offset: number) => {
		let low = 0,
			high = native.positions.length
		while (low < high) {
			const middle = (low + high) >>> 1
			if (native.positions[middle]! < offset) low = middle + 1
			else high = middle
		}
		return Math.min(low, needle.length)
	}
	return {
		document: printedSource,
		range(start: number, end: number): { start: number; end: number } | null {
			if (
				!Number.isSafeInteger(start) ||
				!Number.isSafeInteger(end) ||
				start < 0 ||
				end <= start ||
				end > selection.length
			)
				return null
			const first = boundary(start),
				last = boundary(end) - 1
			if (first > last || first >= needle.length) return null
			return { start: printed.positions[match + first]!, end: printed.ends[match + last]! }
		},
	}
}

/** Map a native-viewer selection onto the full document, rejecting ambiguity. */
export function mapNativeSelection(source: ReadingDocument, selection: string) {
	return nativeSelectionMapping(locateSelection(source, selection), selection)
}
