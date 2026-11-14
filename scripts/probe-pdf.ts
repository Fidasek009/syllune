import type { browser } from "wxt/browser"

import { $ } from "bun"

import { getVoice } from "../src/speech/catalog.ts"
import { checkPdfIndexing, observePdfIndexing } from "./check-pdf-indexing.ts"
import { checkPdfSelection } from "./check-pdf-selection.ts"
import { pdfSpeechCheck } from "./check-pdf-speech.ts"
import { checkPdfZoom, type PdfZoomResult } from "./check-pdf-zoom.ts"
import { observePlayerAudio } from "./check-player-controls.ts"
import { observeContextMenu } from "./observe-context-menu.ts"
import { pageScript } from "./page-script.ts"
import {
	highlightPdfText,
	inspectDistantPdf,
	inspectPdf,
	readCrossPageText,
	readEarlyPdfSelection,
	savePdfSelection,
} from "./pdf-page.ts"
import {
	chromeExtensionId,
	closeChromeProbe,
	copyProbeExtension,
	createChromeProbe,
	projectRoot,
	waitFor,
} from "./probe-helpers.ts"

const accessOnly = Bun.env.PDF_CHECK_ACCESS_ONLY === "1"
if (!accessOnly && Bun.env.PDF_SKIP_ACCESS_CHECK !== "1") {
	const child = Bun.spawn(["bun", import.meta.path], {
		env: { ...Bun.env, PDF_CHECK_ACCESS_ONLY: "1" },
		stdout: "inherit",
		stderr: "inherit",
	})
	if ((await child.exited) !== 0) throw new Error("PDF permission recovery check failed")
}
const speechCheck = Bun.env.PDF_CHECK_SPEECH === "1" && !accessOnly
const root = projectRoot
const extension = `${root}/.cache/pdf-probe`
await copyProbeExtension("chrome", extension)
await observeContextMenu(extension)
await observePdfIndexing(extension)
if (speechCheck) {
	await observePlayerAudio(extension)
	const built = await Bun.build({
		entrypoints: [`${root}/scripts/check-pdf-speech.ts`],
		outdir: extension,
		naming: "check-pdf-speech.js",
		target: "browser",
	})
	if (!built.success) throw new Error(`Speech probe bundle failed: ${built.logs.join("\n")}`)
}
const manifest = await Bun.file(`${extension}/manifest.json`).json()
const pdf = Bun.file(`${root}/.cache/benchmarks/muni-thesis.pdf`)
if (!(await pdf.exists()) || new TextDecoder().decode(new Uint8Array(await pdf.slice(0, 5).arrayBuffer())) !== "%PDF-")
	throw new Error("Provision the actual thesis PDF before running this benchmark")
const modelPath = getVoice("en_US-ljspeech-medium").url.split("/resolve/")[1]!
const model = Bun.file(`${root}/.cache/piper/${modelPath}`)
const config = Bun.file(`${root}/.cache/piper/${modelPath}.json`)
if (speechCheck && (!(await model.exists()) || !(await config.exists())))
	throw new Error("Provision the pinned English model/config in .cache/piper before running the speech probe")
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: (request) => {
		const path = new URL(request.url).pathname
		if (speechCheck && path === "/model") return new Response(model)
		if (speechCheck && path === "/config") return new Response(config)
		return new Response(pdf, {
			headers: {
				"Content-Type": "application/pdf",
			},
		})
	},
})
const source = Bun.env.PDF_SOURCE_URL ?? server.url.href + (Bun.env.PDF_SOURCE_PATH ?? "thesis.pdf")
if (!accessOnly) {
	const pdfUrl = new URL(source)
	manifest.host_permissions = [
		`${pdfUrl.protocol}//${pdfUrl.hostname}/*`,
		...(Bun.env.PDF_DIRECT_LOCAL === "1" ? ["file:///*"] : []),
	]
	await Bun.write(`${extension}/manifest.json`, JSON.stringify(manifest))
}
const view = await createChromeProbe(extension)
const waitForPdf = <T>(read: () => Promise<T>, accept: (value: T) => boolean) => waitFor(read, accept, 90)

function readPdfIndexingState() {
	const gate = (window as Window & { __pdfIndexingGate?: { held?: number } }).__pdfIndexingGate
	return {
		held: gate?.held ?? 0,
		spans: document.querySelectorAll(".pdf-page:first-child .textLayer span").length,
		status: document.querySelector("#status")?.textContent ?? "",
		pages: document.querySelectorAll(".pdf-page").length,
		scroll: scrollY,
	}
}

async function provisionPdfVoice(base: string) {
	const api = (globalThis as unknown as { chrome: typeof browser }).chrome
	const url = new URL("check-pdf-speech.js", api.runtime.getURL("/")).href
	const module = (await import(url)) as {
		provisionVoice: (base: string) => Promise<unknown>
	}
	return module.provisionVoice(base)
}

async function probe() {
	try {
		await view.navigate("about:blank")
		const id = chromeExtensionId(extension)
		const started = performance.now()
		await view.navigate(`chrome-extension://${id}/pdf.html?src=${encodeURIComponent(source)}`)
		if (accessOnly) {
			await waitForPdf(
				() => view.evaluate<string>("document.querySelector('#status').textContent"),
				(value) => value.startsWith("Allow access"),
			)
			const control = await view.evaluate<string>("document.querySelector('#status button')?.textContent ?? ''")
			if (control !== "Allow access and open PDF") throw new Error("The PDF access recovery control is missing")
			console.log("PDF without site access offers an explicit permission request.")
			return
		}
		const permissionRecovery = "Verified separately without a host grant"
		console.log("PDF test grant:", JSON.stringify(await view.evaluate("chrome.permissions.getAll()")))
		const navigationMs = performance.now() - started
		await view.cdp("Page.bringToFront")
		await waitForPdf(
			() => view.evaluate<string>("document.querySelector('#status').textContent"),
			(value) => value === "" || !value.startsWith("Opening PDF"),
		)
		const status = await view.evaluate<string>("document.querySelector('#status').textContent")
		if (status) throw new Error(status)
		const textReadyMs = performance.now() - started
		console.log("PDF indexed:", JSON.stringify({ textReadyMs }))
		if (Bun.env.PDF_SMOKE === "1") {
			const pages = await view.evaluate<number>("document.querySelectorAll('.pdf-page').length")
			if (pages < 1) throw new Error("The PDF has no pages")
			await waitForPdf(() => view.evaluate<boolean>("!!document.querySelector('.pdf-page[data-painted]')"), Boolean)
			const zoom = await view.evaluate<PdfZoomResult>(checkPdfZoom)
			if (
				!(zoom.button > zoom.before && zoom.level === "125%") ||
				!(zoom.wheel > zoom.button) ||
				!zoom.prevented ||
				Math.abs(zoom.reset - zoom.before) > 1
			)
				throw new Error(`PDF zoom failed: ${JSON.stringify(zoom)}`)
			console.log(JSON.stringify({ source, pages, textReadyMs, zoom }))
			return
		}
		const result = await view.evaluate<Awaited<ReturnType<typeof inspectPdf>>>(
			pageScript(inspectPdf, "Virtual Research Environment"),
		)
		if (
			result.pages !== 60 ||
			!result.content ||
			result.characters < 50_000 ||
			result.highlighted !== "Virtual Research Environment"
		)
			throw new Error(`PDF benchmark failed: ${JSON.stringify(result)}`)
		await waitForPdf(
			() => view.evaluate<number>("document.querySelectorAll('.pdf-page[data-painted]').length"),
			(value) => value > 0,
		)
		const screenshot = await view.cdp<{ data: string }>("Page.captureScreenshot", { format: "png" })
		await Bun.write(`${root}/.cache/product-probe/pdf-reading.png`, Uint8Array.fromBase64(screenshot.data))
		const distant = await view.evaluate<Awaited<ReturnType<typeof inspectDistantPdf>>>(
			pageScript(inspectDistantPdf, "Bibliography"),
		)
		if (distant.highlighted !== "Bibliography" || distant.scroll < 1000 || distant.textPages >= 60)
			throw new Error(`Lazy PDF mapping failed: ${JSON.stringify(distant)}`)
		console.log("PDF selection regressions starting.")
		const selection = await view.evaluate(checkPdfSelection)
		console.log("PDF selection regressions complete.")
		const indexingChecks = []
		for (const scenario of ["missing", "selection"] as const) {
			await view.navigate(
				`chrome-extension://${id}/pdf.html?src=${encodeURIComponent(source)}&probeIndexing=${scenario}`,
			)
			await view.cdp("Page.bringToFront")
			await view.evaluate("scrollTo(0,0)")
			await waitForPdf(
				() => view.evaluate<ReturnType<typeof readPdfIndexingState>>(pageScript(readPdfIndexingState)),
				(value) => value.held > 0 && value.spans > 0,
			)
			indexingChecks.push(await view.evaluate(checkPdfIndexing(scenario)))
			console.log("PDF indexing scenario passed:", scenario)
		}
		await view.navigate(`chrome-extension://${id}/pdf.html?src=${encodeURIComponent(source)}`)
		await waitForPdf(
			() =>
				view.evaluate<boolean>(
					"document.querySelector('#status')?.textContent === '' && !!document.querySelector('iframe')",
				),
			Boolean,
		)

		const crossPage = speechCheck ? await view.evaluate<string>(pageScript(readCrossPageText)) : undefined
		const speech = speechCheck ? await view.evaluate(pdfSpeechCheck(server.url.href)) : undefined
		if (speechCheck) console.log("Cross-page neural speech:", JSON.stringify(speech))
		if (speechCheck) await view.evaluate(pageScript(provisionPdfVoice, server.url.href))
		const articleChecksElapsedMs = performance.now() - started
		const initialText = crossPage ?? "Their day-to-day use is nev-\nertheless constrained by four limitations"
		await view.evaluate(pageScript(savePdfSelection, initialText))
		const selectionStarted = performance.now()
		await view.navigate(`chrome-extension://${id}/pdf.html?src=${encodeURIComponent(source)}&mode=selection`)
		const earlySelection = await waitFor(
			() => view.evaluate<string>(pageScript(readEarlyPdfSelection)),
			(value) => value.length > 0,
		)
		const selectionReadyMs = performance.now() - selectionStarted
		if (earlySelection !== (crossPage ?? "Their day-to-day use is nevertheless constrained by four limitations"))
			throw new Error(`Early PDF selection changed its scope: ${JSON.stringify(earlySelection)}`)
		let firstBufferMs: number | undefined
		if (speechCheck) {
			await waitFor(
				() => view.evaluate<number>("document.querySelector('iframe')?.contentWindow?.__probeAudio?.sources ?? 0"),
				(value) => value > 0,
			)
			firstBufferMs = performance.now() - selectionStarted
		}
		await waitFor(
			() => view.evaluate<string>("document.querySelector('#status').textContent"),
			(value) => value === "" || !value.startsWith("Opening PDF"),
		)
		const mapped = await view.evaluate<string>(
			pageScript(highlightPdfText, speechCheck ? "This work was supported" : "nevertheless", speechCheck ? 4 : 12),
		)
		if (mapped.replace(/[-\s]/gu, "") !== (speechCheck ? "This" : "nevertheless"))
			throw new Error(`Early selection did not acquire an exact highlight mapping: ${JSON.stringify(mapped)}`)
		const record = {
			recordedAt: new Date().toISOString(),
			browser: await view.cdp("Browser.getVersion"),
			pdfSha256: new Bun.CryptoHasher("sha256").update(await pdf.arrayBuffer()).digest("hex"),
			...result,
			permissionRecovery,
			source: Bun.env.PDF_SOURCE_URL ? "remote PDF source" : "cached MUNI bytes served without CORS",
			distant,
			selection,
			indexingChecks,
			selectionReadyMs,
			firstBufferMs,
			speech,
			navigationMs,
			textReadyMs,
			articleChecksElapsedMs,
			timingScope:
				"textReadyMs measures initial indexing; articleChecksElapsedMs includes article/selection regression checks and is not startup latency.",
			limits: speechCheck
				? "Test-only host grant, cached MUNI PDF and pinned cached English model; actual CPU worker PCM and word timing validation across the acknowledgement/abstract page boundary. Does not validate physical audio quality, hardware GPU behavior, or target-device latency."
				: "Checks missing-permission recovery, privileged fetch without CORS, rendering, text mapping, and the installed context-menu handler's close/reopen path with Tab.url omitted. Uses a test-only origin grant; native menu UI, activeTab grant, permission dialog, and speech are not covered.",
		}
		await $`mkdir -p ${root + "/.cache/evidence"}`.quiet()
		await Bun.write(
			`${root}/.cache/evidence/${speechCheck ? "pdf-cross-page-speech" : "pdf-rendering"}.json`,
			JSON.stringify(record, null, 2) + "\n",
		)
		console.log(JSON.stringify(record, null, 2))
		if (Bun.env.PDF_LOCAL === "1") {
			await view.navigate(
				`chrome-extension://${id}/pdf.html?src=${encodeURIComponent(Bun.pathToFileURL(`${root}/.cache/benchmarks/muni-thesis.pdf`).href)}`,
			)
			if (Bun.env.PDF_DIRECT_LOCAL !== "1") {
				await waitForPdf(
					() =>
						view.evaluate<boolean>(
							"Array.from(document.querySelectorAll('#status button')).some(button=>button.textContent==='Allow and open PDF'||button.textContent==='Choose PDF')",
						),
					Boolean,
				)
				// Unpacked extensions can have file access enabled; take the picker path.
				await view.evaluate(
					"Array.from(document.querySelectorAll('#status button')).find(button=>button.textContent==='Choose PDF instead')?.click()",
				)
				await waitForPdf(() => view.evaluate<boolean>("!!document.querySelector('#status input[type=file]')"), Boolean)
				const document = await view.cdp<{ root: { nodeId: number } }>("DOM.getDocument")
				const input = await view.cdp<{ nodeId: number }>("DOM.querySelector", {
					nodeId: document.root.nodeId,
					selector: "input[type=file]",
				})
				await view.cdp("DOM.setFileInputFiles", {
					nodeId: input.nodeId,
					files: [`${root}/.cache/benchmarks/muni-thesis.pdf`],
				})
			}
			await waitForPdf(
				() =>
					view.evaluate<boolean>(
						"document.querySelector('#status').textContent==='' && document.querySelectorAll('.pdf-page').length===60",
					),
				Boolean,
			)
			console.log(
				Bun.env.PDF_DIRECT_LOCAL === "1"
					? "Local PDF opened directly without a file chooser."
					: "Local PDF fallback opened from a user-selected File.",
			)
		}
	} finally {
		await closeChromeProbe(view)
		server.stop(true)
	}
}
await probe()
