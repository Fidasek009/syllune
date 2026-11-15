import { productName, productTagline } from "../src/extension/brand"
import { captureStoreReading } from "./capture-store-reading"
import { pageScript } from "./page-script"
import { chromeExtensionId, closeChromeProbe, createChromeProbe, projectRoot, waitFor } from "./probe-helpers"

const logo = await Bun.file(`${projectRoot}/assets/brand/syllune.svg`).text()
const page = (body: string, style = "") =>
	`<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}body{font-family:Arial,sans-serif}${style}</style>${body}`
let html = ""
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: () => new Response(html, { headers: { "Content-Type": "text/html" } }),
})
const extension = `${projectRoot}/.output/chrome-mv3`
const view = await createChromeProbe(extension, ["--headless=new", "--no-sandbox"])

/** Self-contained: runs on the extension's voice catalog page. */
function selectLanguage(language: string) {
	const trigger = document.querySelector<HTMLButtonElement>("#language")
	const option = document.querySelector<HTMLElement>(`#language-menu [role=option][data-value="${language}"]`)
	if (!trigger || !option) throw Error("Language filter is missing")
	trigger.click()
	option.click()
}

async function screenshot(path: string, width: number, height: number, transparent = false) {
	await view.cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false })
	await view.cdp("Emulation.setDefaultBackgroundColorOverride", {
		color: { r: 255, g: 255, b: 255, a: transparent ? 0 : 1 },
	})
	const shot = await view.cdp<{ data: string }>("Page.captureScreenshot", {
		format: "png",
		captureBeyondViewport: false,
	})
	await Bun.write(`${projectRoot}/${path}`, Uint8Array.fromBase64(shot.data))
}
try {
	for (const size of [16, 32, 48, 64, 96, 128]) {
		html = page(logo, "svg{display:block;width:100%;height:100%}")
		await view.navigate(server.url.href)
		await screenshot(`public/icons/icon-${size}.png`, size, size, true)
	}
	await Bun.write(`${projectRoot}/store/assets/icon-128.png`, Bun.file(`${projectRoot}/public/icons/icon-128.png`))
	for (const [width, height, file] of [
		[440, 280, "promo-small.png"],
		[1400, 560, "promo-marquee.png"],
	] as const) {
		const large = width > 500
		html = page(
			`<div class="brand">${logo}<b>${productName}</b></div><div class="copy"><h1>${productTagline.replace(". ", ".<br>")}</h1><p>Download a voice once. Speech runs offline.</p><span>Text to speech for Chrome &amp; Firefox</span></div>${large ? `<div class="mark" aria-hidden="true">${logo}</div>` : ""}`,
			`body{background:#f5efe4;color:#24211e;padding:${large ? "40px 64px" : "22px 26px"}}.brand{display:flex;align-items:center;gap:10px;font-size:${large ? 30 : 22}px;letter-spacing:-.8px}.brand svg{width:${large ? 56 : 40}px;height:${large ? 56 : 40}px}.copy{margin-top:${large ? 64 : 28}px;position:relative;z-index:1}h1{font-family:Georgia,serif;font-size:${large ? 80 : 34}px;font-weight:400;letter-spacing:${large ? -3 : -1.1}px;line-height:1.12;margin:0 0 ${large ? 40 : 26}px}p{font-size:${large ? 23 : 13}px;margin:0 0 ${large ? 16 : 10}px}span{font-size:${large ? 16 : 11}px;color:#62594e}.mark{position:absolute;right:70px;top:108px;width:350px;transform:rotate(-8deg)}.mark svg{width:100%;height:100%}`,
		)
		await view.navigate(server.url.href)
		await screenshot(`store/assets/${file}`, width, height)
	}
	if (!process.argv.includes("--brand-only")) {
		await view.cdp("Emulation.setDeviceMetricsOverride", {
			width: 1280,
			height: 800,
			deviceScaleFactor: 1,
			mobile: false,
		})
		await view.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] })
		await view.navigate(`chrome-extension://${chromeExtensionId(extension)}/voices.html`)
		await waitFor(
			() => view.evaluate<number>("document.querySelectorAll('#voices section').length"),
			(count) => count > 0,
		)
		for (const [language, file] of [
			["en-US", "voices-english.png"],
			["cs-CZ", "voices-czech.png"],
		] as const) {
			await view.evaluate(pageScript(selectLanguage, language))
			await view.evaluate("document.fonts.ready.then(() => true)")
			await screenshot(`store/assets/${file}`, 1280, 800)
		}
		console.log("Captured actual voice management UI; no voices or samples downloaded.")
	}
} finally {
	await closeChromeProbe(view)
	await server.stop(true)
}
if (!process.argv.includes("--brand-only")) await captureStoreReading()
