import { maximumReadingCharacters } from "./limits.ts"
import { normalizeDocument } from "./normalize.ts"
import { projectRun } from "./runs.ts"

export interface TextRun {
	from: number
	to: number
	readonly node: Text
	offset: number
}
export interface ReadingDocument {
	text: string
	runs: TextRun[]
}
/** A live DOM position at the end of a selection. */
export interface ReadingPoint {
	container: Node
	offset: number
}

/** Join page documents in reading order while retaining each page's live DOM binding. */
export function concatDocuments(parts: readonly ReadingDocument[]): ReadingDocument {
	let text = ""
	const runs: TextRun[] = []
	for (const part of parts) {
		const base = text.length
		for (const run of part.runs) {
			runs.push(projectRun(run, run.from + base, run.to + base, run.offset))
		}
		text += part.text
	}
	return { text, runs }
}

/** Runs are ordered by source offset, including when normalization splits a run. */
export function overlappingRuns(source: ReadingDocument, start: number, end: number): TextRun[] {
	let low = 0
	let high = source.runs.length
	while (low < high) {
		const middle = (low + high) >>> 1
		if (source.runs[middle]!.to <= start) low = middle + 1
		else high = middle
	}
	const result: TextRun[] = []
	while (low < source.runs.length && source.runs[low]!.from < end) result.push(source.runs[low++]!)
	return result
}

const pageTooLong = "This page is too long to read in one session. Select a smaller section."
const remainderTooLong =
	"The rest of this page is too long to read in one session. Select a smaller section to continue."

/** Collect text and live DOM offsets from a subtree, optionally within a range. */
function capture(
	root: Node,
	range: Range | null,
	excludeChrome: boolean,
	tooLong = pageTooLong,
): ReadingDocument | undefined {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
	const runs: TextRun[] = []
	let text = "",
		lastBlock: Element | null = null
	for (let candidate = walker.nextNode(); candidate; candidate = walker.nextNode()) {
		if (candidate instanceof HTMLBRElement) {
			if (text && (!range || range.intersectsNode(candidate))) text += "\n"
			continue
		}
		if (!(candidate instanceof Text)) continue
		const node = candidate
		const parent = node.parentElement
		if (!parent || parent.closest("script,style,noscript,template,[hidden],[aria-hidden=true],[data-read-aloud]"))
			continue
		if (
			excludeChrome &&
			parent.closest("nav,header,footer,aside,form,button,[role=navigation],[role=banner],[role=contentinfo]")
		)
			continue
		if (!parent.getClientRects().length || getComputedStyle(parent).visibility === "hidden") continue
		if (range && !range.intersectsNode(node)) continue
		const from = range?.startContainer === node ? range.startOffset : 0
		const to = range?.endContainer === node ? range.endOffset : node.length
		const value = node.data.slice(from, to)
		if (!value || (!value.trim() && !text)) continue
		const block = parent.closest("p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,td,div,section")
		if (text && block !== lastBlock) text += "\n"
		lastBlock = block
		runs.push({ from: text.length, to: text.length + value.length, node, offset: from })
		text += value
		if (text.length > maximumReadingCharacters) throw new Error(tooLong)
	}
	if (!text.trim()) return undefined
	return normalizeDocument({ text, runs })
}

function articleRoot(): Element {
	return document.querySelector("article, main, [role=main]") ?? document.body
}

export function captureDocument(mode: "selection" | "article"): ReadingDocument {
	const selection = window.getSelection()
	const range = mode === "selection" && selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null
	if (mode === "selection" && (!range || range.collapsed)) throw new Error("Select some text to read first.")
	let root: Node = range?.commonAncestorContainer ?? articleRoot()
	if (root.nodeType === Node.TEXT_NODE) root = root.parentNode!
	const captured = capture(root, range, mode === "article")
	if (!captured) throw new Error("No readable text was found on this page.")
	return captured
}

/** The end of the current selection, before the page removes it. */
export function selectionPoint(): ReadingPoint | undefined {
	const selection = window.getSelection()
	if (!selection?.rangeCount) return undefined
	const range = selection.getRangeAt(0)
	return { container: range.endContainer, offset: range.endOffset }
}

/** The article text after a previous selection; undefined when nothing readable remains. */
export function captureContinuation(point: ReadingPoint): ReadingDocument | undefined {
	if (!point.container.isConnected) return undefined
	let root = articleRoot()
	if (!root.contains(point.container)) root = document.body
	const range = document.createRange()
	try {
		range.setStart(point.container, point.offset)
		range.setEnd(root, root.childNodes.length)
	} catch {
		return undefined
	}
	// Continuation reads like article mode, so page chrome stays excluded.
	return capture(root, range, true, remainderTooLong)
}

export function sourceRange(source: ReadingDocument, start: number, end: number): Range | null {
	if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > source.text.length)
		return null
	const first = overlappingRuns(source, start, start + 1)[0]
	const last = overlappingRuns(source, end - 1, end)[0]
	if (!first?.node.isConnected || !last?.node.isConnected) return null
	for (const run of [first, last]) {
		if (run.node.data.slice(run.offset, run.offset + run.to - run.from) !== source.text.slice(run.from, run.to))
			return null
	}
	const range = document.createRange()
	try {
		range.setStart(first.node, first.offset + start - first.from)
		range.setEnd(last.node, last.offset + end - last.from)
	} catch {
		return null
	}
	return range
}
