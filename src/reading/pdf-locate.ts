import { canonicalText } from "./selection.ts"

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
}

/**
 * Locate a native-viewer selection while paginated text arrives one page at a time.
 * The canonical string grows only by newly indexed pages, so a selection near the
 * front never pays for canonicalizing the rest of a long PDF.
 */
export class PdfSelectionSearch {
	private readonly needle: string
	private text = ""
	private searchFrom = 0
	private readonly segments: Segment[] = []

	constructor(selection: string) {
		this.needle = canonicalText(selection).value.trim()
		if (!this.needle) throw new Error("Select some PDF text first.")
	}

	push(pageText: string): LocatedPdfText | undefined {
		const page = canonicalText(pageText)
		// A layout hyphen at a page break continues the word when the next page does.
		let joined = false
		if (this.text.endsWith("- ") && /^\p{Ll}/u.test(page.value) && /\p{L}$/u.test(this.text.slice(0, -2))) {
			this.text = this.text.slice(0, -2)
			this.searchFrom = Math.max(0, this.searchFrom - 2)
			joined = true
		}
		let base = this.text.length
		// canonicalText keeps one trailing layout space; add a separator only when
		// the page itself does not already provide one.
		if (!joined && base && page.value && !this.text.endsWith(" ") && !page.value.startsWith(" ")) {
			this.text += " "
			base++
		}
		const index = this.segments.length
		this.segments.push({ index, base, positions: page.positions, ends: page.ends })
		this.text += page.value
		const match = this.text.indexOf(this.needle, this.searchFrom)
		this.searchFrom = Math.max(0, this.text.length - this.needle.length + 1)
		if (match < 0) return undefined
		const first = this.segmentAt(match)
		const last = this.segmentAt(match + this.needle.length - 1)
		if (first === undefined || last === undefined)
			throw new Error("The selection could not be mapped to the printed text.")
		const start = first.positions[match - first.base]
		const end = last.ends[match + this.needle.length - 1 - last.base]
		if (start === undefined || end === undefined)
			throw new Error("The selection could not be mapped to the printed text.")
		return { startPage: first.index, start, endPage: last.index, end }
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
