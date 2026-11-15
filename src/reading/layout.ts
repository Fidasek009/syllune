export const currentWordHighlight = "read-aloud-current-word"

/** The overlay stops growing here, so the player fits popovers inside it. */
export const readerMaxHeight = 240

export function readerSize(height: number, width?: number) {
	return {
		height: Math.min(readerMaxHeight, Math.max(44, height)),
		...(width === undefined ? {} : { width: Math.min(640, Math.max(240, width)) }),
	}
}

export function shouldScrollToWord(top: number, bottom: number, viewportHeight: number) {
	return top < 150 || bottom > viewportHeight - 50
}

export function paintReaderHighlight(range: Range | null) {
	if (!range || !CSS.highlights) {
		CSS.highlights?.delete(currentWordHighlight)
		return
	}
	CSS.highlights.set(currentWordHighlight, new Highlight(range))
	const rect = range.getBoundingClientRect()
	if (shouldScrollToWord(rect.top, rect.bottom, innerHeight))
		window.scrollBy({ top: rect.top - innerHeight * 0.4, behavior: "instant" })
}
