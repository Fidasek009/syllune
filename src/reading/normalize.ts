import type { ReadingDocument, TextRun } from "./document.ts"

import { projectRun } from "./runs.ts"

/** Only explicit line breaks authorize removing a printed hyphen. */
const layoutHyphenation = /(?<=\p{L})[-\u00ad][\t ]*\r?\n[\t ]*(?=\p{Ll})|\u00ad/gu
/** PDF viewers drop every line-end hyphen when copying; speech keeps only meaningful ones. */
export const pdfHyphenation = /(?<=\p{L})[-\u2010\u2011\u00ad][\t ]*(?:\r?\n)+[\t ]*|\u00ad/gu

/** Keep a line-end hyphen before a capital or inside an already hyphenated word. */
function pdfHyphenJoin(text: string, match: RegExpExecArray) {
	if (match[0][0] === "\u00ad") return ""
	const before = text.slice(0, match.index)
	const wordStart = Math.max(
		before.lastIndexOf(" "),
		before.lastIndexOf("\t"),
		before.lastIndexOf("\n"),
		before.lastIndexOf("\r"),
	)
	const word = before.slice(wordStart + 1)
	const continuation = text[match.index + match[0].length] ?? ""
	return /[-\u2010\u2011]/u.test(word) || !/^\p{Ll}/u.test(continuation) ? "-" : ""
}

/** Remove layout hyphenation without changing the DOM offsets used for highlighting. */
export function normalizeDocument(source: ReadingDocument, pdf = false): ReadingDocument {
	const pattern = pdf ? new RegExp(`${pdfHyphenation.source}|(?<!\\n)\\n(?!\\n)`, "gu") : layoutHyphenation
	const runs: TextRun[] = []
	let text = "",
		start = 0,
		runIndex = 0
	const append = (end: number) => {
		const from = text.length
		text += source.text.slice(start, end)
		while (runIndex < source.runs.length && source.runs[runIndex]!.to <= start) runIndex++
		for (let index = runIndex; index < source.runs.length; index++) {
			const run = source.runs[index]!
			if (run.from >= end) break
			const left = Math.max(start, run.from),
				right = Math.min(end, run.to)
			if (left < right)
				runs.push(projectRun(run, from + left - start, from + right - start, run.offset + left - run.from))
		}
	}
	for (const match of source.text.matchAll(pattern)) {
		append(match.index)
		// PDF line endings are layout; blank lines/page breaks remain boundaries.
		if (match[0] === "\n") text += " "
		else if (pdf) text += pdfHyphenJoin(source.text, match)
		start = match.index + match[0].length
	}
	append(source.text.length)
	return { text, runs }
}
