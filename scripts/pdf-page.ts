import type {} from "../src/reading/bridge.ts"

import { pageScript } from "./page-script.ts"

export type PdfReaderState = { status: string; player: boolean }

/** Self-contained readiness sample shared by both browser probes. */
export function pdfReaderState(): PdfReaderState {
	return {
		status: document.querySelector("#status")?.textContent ?? "",
		player: !!document.querySelector("iframe"),
	}
}

export const readPdfReaderState = pageScript(pdfReaderState)

export function pdfReaderReady({ status, player }: PdfReaderState) {
	return (player && status === "") || (status.length > 0 && !/^(?:Opening PDF|Preparing text)/u.test(status))
}

// Self-contained PDF reader checks, serialized into the extension page by pageScript.
// Each function must define its own helpers: only the function body crosses the boundary.

export async function inspectPdf(target: string) {
	const frame = document.querySelector<HTMLIFrameElement>("iframe")
	const host = window.readAloudHost
	if (!frame || !host) throw Error("PDF reading host is unavailable")
	const session = new URL(frame.src).hash.slice(1)
	const response = await host({ session, command: "document" })
	if (!("text" in response) || typeof response.text !== "string") throw Error("PDF document text is unavailable")
	const start = response.text.indexOf(target)
	if (start < 0) throw Error("PDF fixture target is missing: " + target)
	await host({ session, command: "highlight", start, end: start + target.length })
	return {
		pages: document.querySelectorAll(".pdf-page").length,
		characters: response.text.length,
		highlighted: [...(CSS.highlights?.get("read-aloud-current-word") ?? [])].map((range) => range.toString()).join(""),
		content: response.text.includes("Molecular Dynamics") && response.text.includes("Declaration"),
	}
}

export async function inspectDistantPdf(target: string) {
	const frame = document.querySelector<HTMLIFrameElement>("iframe")
	const host = window.readAloudHost
	if (!frame || !host) throw Error("PDF reading host is unavailable")
	const session = new URL(frame.src).hash.slice(1)
	const response = await host({ session, command: "document" })
	if (!("text" in response) || typeof response.text !== "string") throw Error("PDF document text is unavailable")
	const start = response.text.lastIndexOf(target)
	if (start < 10000) throw Error("Distant-page fixture missing")
	await host({ session, command: "highlight", start, end: start + target.length })
	return {
		highlighted: [...(CSS.highlights?.get("read-aloud-current-word") ?? [])].map((range) => range.toString()).join(""),
		scroll: scrollY,
		textPages: [...document.querySelectorAll(".textLayer")].filter((layer) => layer.childNodes.length).length,
	}
}

export async function readCrossPageText() {
	const frame = document.querySelector<HTMLIFrameElement>("iframe")
	const host = window.readAloudHost
	if (!frame || !host) throw Error("PDF reading host is unavailable")
	const response = await host({ session: new URL(frame.src).hash.slice(1), command: "document" })
	if (!("text" in response) || typeof response.text !== "string") throw Error("PDF document text is unavailable")
	const start = response.text.indexOf("This work was supported", response.text.indexOf("Acknowledgements"))
	const end = response.text.slice(0, response.text.indexOf("This thesis", start)).trimEnd().length
	if (start < 0 || end <= start) throw Error("Cross-page fixture missing")
	return response.text.slice(start, end)
}
