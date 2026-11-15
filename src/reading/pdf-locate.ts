import { matchText } from "./selection.ts"

export interface LocatedPdfText {
	/** Zero-based index of the page that supplied the selection's first character. */
	startPage: number
	/** Raw offset inside that page's text. */
	start: number
	/** Zero-based index of the page that supplied the selection's last character. */
	endPage: number
	/** Raw offset inside that page's text. */
	end: number
}

interface Segment {
	index: number
	base: number
	positions: number[]
	ends: number[]
	text: string
}

const wordCharacter = /[\p{L}\p{N}]/u

/**
 * Locate a native-viewer selection while paginated text arrives one page at a time.
 * The match key grows only by newly indexed pages, so a selection near the
 * front never pays for reading the rest of a long PDF.
 */
export class PdfSelectionSearch {
	private readonly needle: string
	private text = ""
	private searchFrom = 0
	private readonly segments: Segment[] = []

	constructor(selection: string) {
		this.needle = matchText(selection).value
		if (!this.needle) throw new Error("Select some PDF text first.")
	}

	push(pageText: string): LocatedPdfText | undefined {
		const page = matchText(pageText)
		const base = this.text.length
		const index = this.segments.length
		this.segments.push({ index, base, positions: page.positions, ends: page.ends, text: pageText })
		this.text += page.value
		let match = this.text.indexOf(this.needle, this.searchFrom)
		while (match >= 0) {
			const located = this.locate(match)
			if (located) return located
			match = this.text.indexOf(this.needle, match + 1)
		}
		this.searchFrom = Math.max(0, this.text.length - this.needle.length + 1)
		return undefined
	}

	private locate(match: number): LocatedPdfText | undefined {
		const first = this.segmentAt(match)
		const last = this.segmentAt(match + this.needle.length - 1)
		if (first === undefined || last === undefined)
			throw new Error("The selection could not be mapped to the printed text.")
		const start = first.positions[match - first.base]
		const end = last.ends[match + this.needle.length - 1 - last.base]
		if (start === undefined || end === undefined)
			throw new Error("The selection could not be mapped to the printed text.")
		return this.wordBoundary(first, start) && this.wordBoundary(last, end)
			? { startPage: first.index, start, endPage: last.index, end }
			: undefined
	}

	/** Reject a match that begins or ends inside a printed word. */
	private wordBoundary(segment: Segment, offset: number) {
		const previous = segment.text[offset - 1]
		const next = segment.text[offset]
		return !previous || !next || !wordCharacter.test(previous) || !wordCharacter.test(next)
	}

	private segmentAt(position: number): Segment | undefined {
		let low = 0,
			high = this.segments.length - 1,
			found: Segment | undefined
		while (low <= high) {
			const middle = (low + high) >>> 1
			const segment = this.segments[middle]!
			if (segment.base <= position) {
				found = segment
				low = middle + 1
			} else high = middle - 1
		}
		return found
	}
}
