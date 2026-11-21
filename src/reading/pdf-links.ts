/** A PDF.js link annotation reduced to the fields the reader acts on. */
export interface PdfLinkAnnotation {
	rect: readonly [number, number, number, number]
	url?: string
	dest?: unknown
}

const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "ftp:", "mailto:", "tel:"])

export function isPdfLinkAnnotation(value: unknown): value is PdfLinkAnnotation {
	if (typeof value !== "object" || value === null) return false
	const data = value as Record<string, unknown>
	if (data.subtype !== "Link" || data.hidden === true) return false
	const rect = data.rect
	if (!Array.isArray(rect) || rect.length !== 4 || !rect.every((value) => Number.isFinite(value))) return false
	if (typeof data.url === "string") return true
	return typeof data.dest === "string" || (Array.isArray(data.dest) && data.dest.length > 0)
}

/** Accept only absolute external addresses the browser can open safely. */
export function externalLinkTarget(value: string): URL | undefined {
	try {
		const url = new URL(value)
		return EXTERNAL_PROTOCOLS.has(url.protocol) ? url : undefined
	} catch {
		return undefined
	}
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function destinationMode(dest: readonly unknown[]): unknown {
	const mode = dest[1]
	return typeof mode === "object" && mode !== null && "name" in mode ? (mode as { name?: unknown }).name : undefined
}

/** PDF user-space y of the view top, or undefined when the destination page starts at the top. */
export function destinationTop(dest: readonly unknown[]): number | undefined {
	switch (destinationMode(dest)) {
		case "XYZ":
			return finite(dest[3])
		case "FitH":
		case "FitBH":
			return finite(dest[2])
		// FitR carries [left, bottom, right, top]; anchor the visible rectangle's top edge.
		case "FitR":
			return finite(dest[5])
		default:
			return undefined
	}
}
