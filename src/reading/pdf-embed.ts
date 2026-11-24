/**
 * Publisher viewer pages sometimes wrap the document in an iframe instead of
 * serving the PDF at the top level. Only URLs that name a PDF can be promoted.
 */
export function isEmbeddedPdfUrl(value: string | undefined): boolean {
	if (!value) return false
	try {
		const url = new URL(value)
		return (url.protocol === "https:" || url.protocol === "http:") && url.pathname.toLowerCase().endsWith(".pdf")
	} catch {
		return false
	}
}
