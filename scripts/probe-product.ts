import type { browser } from "wxt/browser"

import { readingChunks, sentenceTarget } from "../src/reading/chunks.ts"
import { voices } from "../src/speech/catalog.ts"
import {
	checkLiveSpeed,
	checkSpeedFocus,
	checkSpeedPanel,
	checkVolume,
	observePlayerAudio,
} from "./check-player-controls.ts"
import { checkAbortedVoiceDeletion } from "./check-voice-deletion.ts"
import { observeContextMenu } from "./observe-context-menu.ts"
import { pageScript, readHighlightedText } from "./page-script.ts"
import {
	assert,
	chromeExtensionId,
	closeChromeProbe,
	copyProbeExtension,
	createChromeProbe,
	projectRoot,
	waitFor,
} from "./probe-helpers.ts"
import {
	recoverSelectionAfterFailure,
	recoverSelectionFromMenu,
	type RecoveryDriver,
	verifySelectionReplay,
} from "./reader-scenarios.ts"

// This copied test manifest grants only the fixture origin. Native action /
// context-menu activation and the activeTab grant are not covered by this test.
const root = projectRoot
const extension = `${root}/.cache/product-probe/chromium`
await copyProbeExtension("chrome", extension)
await observePlayerAudio(extension)
await observeContextMenu(extension)
const manifest = await Bun.file(`${extension}/manifest.json`).json()
assert(!manifest.host_permissions?.length, "The product must not request access to all sites")
manifest.host_permissions = ["http://127.0.0.1/*", "https://filipkrasa.salonek.org/*"]
await Bun.write(`${extension}/manifest.json`, JSON.stringify(manifest))
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: () =>
		new Response(
			`<!doctype html><title>Reading fixture</title><nav>Navigation should not be read</nav><main><h1>Local reading</h1><p id="selection">One <em>natural voice</em> on your device. A second sentence keeps reading while you switch tabs. Your text stays private.</p><p id="warm-selection">Fresh words start a new selection. A second sentence keeps reading while you switch tabs. Your text stays private.</p>${"<p>Good design makes listening effortless. We can pause and continue without losing our place.</p>".repeat(12)}</main>`,
			{ headers: { "Content-Type": "text/html" } },
		),
})
const view = await createChromeProbe(extension, ["--enable-unsafe-extension-debugging"])
let sequence = 0
const calls = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
view.addEventListener("Target.receivedMessageFromTarget", (event: any) => {
	const message = JSON.parse(event.data.message)
	if (message.method === "Runtime.exceptionThrown")
		console.log("Browser exception:", message.params.exceptionDetails.exception?.description?.slice(0, 1000))
	if (message.id) {
		const pending = calls.get(message.id)
		calls.delete(message.id)
		if (message.error) pending?.reject(new Error(message.error.message))
		else pending?.resolve(message.result)
	}
})
const call = async (session: string, method: string, params: object = {}): Promise<any> => {
	const id = ++sequence
	const result = new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			calls.delete(id)
			reject(new Error(`CDP ${method} did not answer`))
		}, 30_000)
		calls.set(id, {
			resolve: (value) => {
				clearTimeout(timer)
				resolve(value)
			},
			reject: (error) => {
				clearTimeout(timer)
				reject(error)
			},
		})
	})
	await view.cdp("Target.sendMessageToTarget", { sessionId: session, message: JSON.stringify({ id, method, params }) })
	return result
}
const remote = async (session: string, expression: string, userGesture = false, contextId?: number) => {
	const result = await call(session, "Runtime.evaluate", {
		expression,
		returnByValue: true,
		awaitPromise: true,
		userGesture,
		...(contextId ? { contextId } : {}),
	})
	if (result.exceptionDetails)
		throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
	return result.result.value
}

/** Self-contained: the player iframe runs this through the page driver. */
async function chromeReaderContract() {
	const api = (globalThis as unknown as { chrome: typeof browser }).chrome
	const tab = await api.tabs.getCurrent()
	if (tab?.id === undefined) return { noTab: true }
	const tabId = tab.id
	const send = (session: string, command: object) =>
		api.tabs.sendMessage(tabId, { type: "reader", session, ...command }, { frameId: 0 })
	const session = location.hash.slice(1)
	return {
		tab: tabId,
		document: await send(session, { command: "document" }),
		invalid: await send(session, { command: "highlight", start: 2, end: 1 }),
		stale: await send("stale", { command: "close" }),
	}
}

type HighlightRange = { start: number; end: number }

function observeHighlightCommands() {
	const probe = globalThis as unknown as {
		chrome: typeof browser
		probeHighlights: HighlightRange[]
	}
	probe.probeHighlights = []
	const send = probe.chrome.tabs.sendMessage.bind(probe.chrome.tabs)
	probe.chrome.tabs.sendMessage = ((...args: Parameters<typeof send>) => {
		const message: unknown = args[1]
		if (
			message &&
			typeof message === "object" &&
			"command" in message &&
			message.command === "highlight" &&
			"start" in message &&
			"end" in message &&
			typeof message.start === "number" &&
			typeof message.end === "number"
		)
			probe.probeHighlights.push({ start: message.start, end: message.end })
		return send(...args)
	}) as typeof send
}

function pauseOnFirstHighlight() {
	const probe = globalThis as unknown as {
		chrome: typeof browser
		probeWords: HighlightRange[]
		freezeOnHighlight: boolean
	}
	probe.probeWords = []
	probe.freezeOnHighlight = true
	const send = probe.chrome.tabs.sendMessage.bind(probe.chrome.tabs)
	probe.chrome.tabs.sendMessage = ((...args: Parameters<typeof send>) => {
		const message: unknown = args[1]
		if (
			message &&
			typeof message === "object" &&
			"command" in message &&
			message.command === "highlight" &&
			"start" in message &&
			"end" in message &&
			typeof message.start === "number" &&
			typeof message.end === "number" &&
			message.end > message.start
		) {
			probe.probeWords.push({ start: message.start, end: message.end })
			if (probe.freezeOnHighlight) {
				probe.freezeOnHighlight = false
				document.querySelector<HTMLButtonElement>("#play")?.click()
			}
		}
		return send(...args)
	}) as typeof send
}

function advanceWithHighlightProbe() {
	const probe = globalThis as unknown as {
		probeWords: HighlightRange[]
		freezeOnHighlight: boolean
	}
	probe.probeWords.length = 0
	probe.freezeOnHighlight = true
	document.querySelector<HTMLButtonElement>("#next")?.click()
}

try {
	await view.navigate("about:blank")
	const id = chromeExtensionId(extension)
	await view.navigate(`chrome-extension://${id}/voices.html`)
	await waitFor(
		() => view.evaluate<number>("document.querySelectorAll('section').length"),
		(value) => value === voices.length,
	)
	console.log("Voice catalog loaded; no model download requested.")
	const catalogShot = await view.cdp<{ data: string }>("Page.captureScreenshot", { format: "png" })
	await Bun.write(`${root}/.cache/product-probe/voices-compact.png`, Uint8Array.fromBase64(catalogShot.data))
	assert(
		await view.evaluate(
			"Array.from(document.querySelector('#language').options).find(option=>option.value==='cs-CZ').text==='Czech'",
		),
		"Redundant Czech region label remains",
	)
	await view.evaluate("chrome.storage.local.set({voice:'en_US-ljspeech-medium#999'})")
	const tab: any = await view.evaluate(`chrome.tabs.create({url:${JSON.stringify(server.url.href)}, active:true})`)
	const targets = await view.cdp<any>("Target.getTargets")
	const target = targets.targetInfos.find(
		(target: any) => target.type === "page" && target.url.startsWith(server.url.href),
	)
	assert(target, "Fixture tab missing")
	const { sessionId } = await view.cdp<any>("Target.attachToTarget", { targetId: target.targetId, flatten: false })
	const evaluate = (expression: string, contextId?: number) => remote(sessionId, expression, false, contextId)
	await waitFor(() => evaluate("document.readyState === 'complete' && !!document.querySelector('#selection')"), Boolean)
	await view.evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id}},files:['content-scripts/reader.js']})`)
	await evaluate("window.getSelection().selectAllChildren(document.querySelector('#selection'))")
	const contexts: { id: number; origin: string; auxData?: { isDefault?: boolean } }[] = []
	view.addEventListener("Target.receivedMessageFromTarget", (event: any) => {
		const m = JSON.parse(event.data.message)
		if (event.data.sessionId === sessionId && m.method === "Runtime.executionContextCreated")
			contexts.push(m.params.context)
	})
	await call(sessionId, "Runtime.enable")
	const started = await view.evaluate<any>(
		`chrome.runtime.sendMessage({type:'probe-context-menu',info:{menuItemId:'read-selection'},tab:{id:${tab.id}}})`,
	)
	assert(started?.ok, started?.error ?? "Reader did not start")
	const playerTarget = await waitFor<{ targetId: string } | undefined>(
		async () => {
			const targets = await view.cdp<any>("Target.getTargets")
			return targets.targetInfos.find((target: any) => target.url.startsWith(`chrome-extension://${id}/player.html`))
		},
		Boolean,
		15,
	)
	assert(playerTarget, "The embedded player target is missing")
	const playerSession = (
		await view.cdp<any>("Target.attachToTarget", { targetId: playerTarget.targetId, flatten: false })
	).sessionId
	await call(playerSession, "Runtime.enable")
	const player = (expression: string, userGesture = false) => remote(playerSession, expression, userGesture)
	await call(sessionId, "Page.bringToFront")

	await waitFor(
		() => player("document.querySelector('#bar')?.dataset.view"),
		(value) => value === "setup",
	)
	assert(
		await player("document.querySelector('#playback').hidden && !document.querySelector('#setup').hidden"),
		"No-voice state exposes empty playback controls",
	)
	await player("indexedDB.open=()=>{throw Error('Embedded frame storage is unavailable')}")
	for (const [name, width, dark] of [
		["setup-dark", 1000, true],
		["setup-narrow", 360, false],
	] as const) {
		await call(sessionId, "Emulation.setDeviceMetricsOverride", {
			width,
			height: 600,
			deviceScaleFactor: 1,
			mobile: false,
		})
		await call(playerSession, "Emulation.setEmulatedMedia", {
			features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }],
		})
		await call(sessionId, "Emulation.setEmulatedMedia", {
			features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }],
		})
		await waitFor(
			() => player("Math.abs(innerHeight-document.querySelector('#bar').getBoundingClientRect().height)<2"),
			Boolean,
		)
		const layout = await player(
			"({width:innerWidth,content:document.documentElement.scrollWidth,height:innerHeight,actions:Array.from(document.querySelectorAll('button,a,input,select')).filter(el=>el.getClientRects().length).map(el=>el.id)})",
		)
		assert(
			layout.content <= layout.width && layout.height < 100 && layout.actions.join(",") === "setup,close",
			JSON.stringify(layout),
		)
		const shot = await call(sessionId, "Page.captureScreenshot", { format: "png" })
		await Bun.write(`${root}/.cache/product-probe/${name}.png`, Uint8Array.fromBase64(shot.data))
	}
	await call(sessionId, "Emulation.clearDeviceMetricsOverride")
	await call(playerSession, "Emulation.setEmulatedMedia", {
		features: [{ name: "prefers-color-scheme", value: "light" }],
	})
	await call(sessionId, "Emulation.setEmulatedMedia", {
		features: [{ name: "prefers-color-scheme", value: "light" }],
	})
	await player("document.querySelector('#setup').focus()")
	await call(sessionId, "Input.dispatchKeyEvent", {
		type: "keyDown",
		key: "Tab",
		code: "Tab",
		windowsVirtualKeyCode: 9,
	})
	await call(sessionId, "Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 })
	assert(await player("document.activeElement.id==='close'"), "Setup does not tab directly to Close")
	console.log("No-voice layout passed in dark and narrow views; only Choose a voice and Close are visible.")
	await view.evaluate("document.querySelector('[data-voice=\"en_US-ljspeech-medium\"] .primary').click()")
	await waitFor(
		() => view.evaluate<boolean>("!!document.querySelector('[data-voice=\"en_US-ljspeech-medium\"] .danger')"),
		Boolean,
		120,
	)
	assert(
		await view.evaluate("document.querySelector('#status').textContent===''"),
		"Download added a page-level success notice",
	)
	console.log("Explicit download passed integrity check and persisted.")

	await waitFor(
		() => player("document.querySelector('#bar')?.dataset.view"),
		(value) => value === "playback",
	)
	assert(
		await player("document.querySelector('#voice').value==='en_US-ljspeech-medium'"),
		"Stale preference left the voice picker empty",
	)
	const directReader = await player(pageScript(chromeReaderContract))
	assert(
		directReader.tab === tab.id &&
			typeof directReader.document?.text === "string" &&
			directReader.invalid?.error &&
			directReader.stale?.error,
		`Direct Chrome reader contract failed: ${JSON.stringify(directReader)}`,
	)
	await player(pageScript(observeHighlightCommands))
	const status = await waitFor(
		() => player("document.querySelector('#status')?.textContent"),
		(value) => typeof value === "string" && !value.includes("Preparing") && !value.includes("Getting"),
		120,
	)
	console.log("Player status:", status)
	console.log("Visibility:", await evaluate("document.visibilityState"), await player("document.visibilityState"))
	assert(/Reading|Press Play/.test(status), `Player failed: ${status}`)
	await waitFor(
		() => player("probeHighlights.length > 1 || document.querySelector('#status').textContent.includes('Press Play')"),
		Boolean,
		5,
	)
	if ((await player("document.querySelector('#status').textContent")).includes("Press Play")) {
		console.log("Programmatic entry requires a trusted Play gesture; native context-menu autoplay is not covered.")
		await player("document.querySelector('#play').click()", true)
	}
	const highlight = await waitFor(
		() => evaluate(readHighlightedText),
		(value) => typeof value === "string" && value.length > 0,
		10,
	).catch(async (error) => {
		console.log(
			"Highlight diagnostics:",
			await player(
				"({status:document.querySelector('#status').textContent,messages:probeHighlights,visible:document.visibilityState})",
			),
			contexts,
		)
		for (const context of contexts.filter((context) => !context.auxData?.isDefault)) {
			try {
				console.log("Isolated world highlights:", await evaluate("Array.from(CSS.highlights.keys())", context.id))
			} catch {}
		}
		const shot = await call(sessionId, "Page.captureScreenshot", { format: "png" })
		await Bun.write(`${root}/.cache/product-probe/reading.png`, Uint8Array.fromBase64(shot.data))
		throw error
	})
	console.log("Highlighted source word:", highlight)
	await view.evaluate(checkAbortedVoiceDeletion("en_US-ljspeech-medium"))
	assert(
		await player(
			"document.querySelector('#voice').value==='en_US-ljspeech-medium' && document.querySelector('#status').textContent==='Reading'",
		),
		"An aborted deletion interrupted the installed voice",
	)
	console.log("Aborted voice deletion retained the voice and active reader without a committed notification.")
	// A delayed delete notification must not stop a voice that is installed again.
	await view.evaluate(
		"chrome.storage.local.set({voiceChange:{id:'en_US-ljspeech-medium',deleted:true,revision:crypto.randomUUID()}})",
	)
	await new Promise((resolve) => setTimeout(resolve, 500))
	assert(
		await player(
			"document.querySelector('#voice').value==='en_US-ljspeech-medium' && document.querySelector('#status').textContent==='Reading'",
		),
		"A stale deletion notification interrupted an installed voice",
	)
	const cold = (await view.evaluate<any>("chrome.storage.local.get('lastSpeechPerformance')")).lastSpeechPerformance
	console.log("Cold first-buffer timings:", JSON.stringify(cold))
	const volume = await player(checkVolume)
	console.log("Volume controls:", JSON.stringify(volume))
	const volumeShot = await call(sessionId, "Page.captureScreenshot", { format: "png" })
	await Bun.write(`${root}/.cache/product-probe/volume-open.png`, Uint8Array.fromBase64(volumeShot.data))
	await call(sessionId, "Input.dispatchKeyEvent", {
		type: "keyDown",
		key: "Escape",
		code: "Escape",
		windowsVirtualKeyCode: 27,
	})
	await call(sessionId, "Input.dispatchKeyEvent", {
		type: "keyUp",
		key: "Escape",
		code: "Escape",
		windowsVirtualKeyCode: 27,
	})
	assert(
		await player(
			"!document.querySelector('#volume-panel').matches(':popover-open') && !!document.querySelector('#bar')",
		),
		"Escape closed the player instead of the volume panel",
	)
	await player("document.querySelector('#sound').click()")
	await call(sessionId, "Input.dispatchMouseEvent", {
		type: "mousePressed",
		x: 10,
		y: 180,
		button: "left",
		clickCount: 1,
	})
	await call(sessionId, "Input.dispatchMouseEvent", {
		type: "mouseReleased",
		x: 10,
		y: 180,
		button: "left",
		clickCount: 1,
	})
	assert(
		await player("!document.querySelector('#volume-panel').matches(':popover-open')"),
		"Clicking the source page left the volume panel open",
	)
	await player(
		"document.querySelector('#volume').value='100';document.querySelector('#volume').dispatchEvent(new Event('input'));document.querySelector('#volume').dispatchEvent(new Event('change'))",
	)
	console.log("Speed panel:", JSON.stringify(await player(checkSpeedFocus)))
	const liveSpeed = await player(checkLiveSpeed)
	console.log("Live speed:", JSON.stringify(liveSpeed))
	await player("document.querySelector('#play').click()")
	for (const [name, width] of [
		["playback-dark", 1000],
		["playback-narrow", 360],
	] as const) {
		await call(sessionId, "Emulation.setDeviceMetricsOverride", {
			width,
			height: 600,
			deviceScaleFactor: 1,
			mobile: false,
		})
		await call(playerSession, "Emulation.setEmulatedMedia", {
			features: [{ name: "prefers-color-scheme", value: "dark" }],
		})
		await call(sessionId, "Emulation.setEmulatedMedia", {
			features: [{ name: "prefers-color-scheme", value: "dark" }],
		})
		await waitFor(
			() => player("Math.abs(innerHeight-document.querySelector('#bar').getBoundingClientRect().height)<2"),
			Boolean,
		)
		const layout = await player(
			"({width:innerWidth,content:document.documentElement.scrollWidth,height:innerHeight,quiet:document.querySelector('#message').classList.contains('quiet')})",
		)
		assert(
			layout.quiet && layout.content <= layout.width && layout.height < (width > 500 ? 55 : 120),
			JSON.stringify(layout),
		)
		const shot = await call(sessionId, "Page.captureScreenshot", { format: "png" })
		await Bun.write(`${root}/.cache/product-probe/${name}.png`, Uint8Array.fromBase64(shot.data))
		if (name === "playback-dark") {
			await player("document.querySelector('#rate').click()")
			await waitFor(
				() => player("innerHeight>document.querySelector('#bar').getBoundingClientRect().height+50"),
				Boolean,
			)
			const panelShot = await call(sessionId, "Page.captureScreenshot", { format: "png" })
			await Bun.write(`${root}/.cache/product-probe/speed-dark.png`, Uint8Array.fromBase64(panelShot.data))
			await player("document.querySelector('#speed-panel').hidePopover()")
		}
	}
	await call(sessionId, "Emulation.clearDeviceMetricsOverride")
	await call(playerSession, "Emulation.setEmulatedMedia", {
		features: [{ name: "prefers-color-scheme", value: "light" }],
	})
	await call(sessionId, "Emulation.setEmulatedMedia", {
		features: [{ name: "prefers-color-scheme", value: "light" }],
	})
	await player("document.querySelector('#play').click()")

	const paddingBefore = await evaluate("document.documentElement.style.paddingTop")
	const hostCountBefore = await evaluate("document.querySelectorAll('[data-read-aloud]').length")
	await evaluate("history.replaceState(null, '', '#section')")
	await new Promise((resolve) => setTimeout(resolve, 400))
	assert(
		(await evaluate("document.querySelectorAll('[data-read-aloud]').length")) === 1,
		"A hash change closed the reader",
	)
	await view.evaluate(`chrome.runtime.sendMessage({type:'probe-action-click',tab:{id:${tab.id}}})`)
	assert(
		(await evaluate("document.documentElement.style.paddingTop")) === paddingBefore,
		"Toolbar activation changed page padding",
	)
	assert(
		(await evaluate("document.querySelectorAll('[data-read-aloud]').length")) === hostCountBefore,
		"Toolbar activation duplicated controls",
	)
	const barSize = await player(
		"({width:document.querySelector('#rate').getBoundingClientRect().width,height:document.querySelector('#bar').getBoundingClientRect().height,viewport:innerHeight})",
	)
	assert(
		barSize.width <= 80 && barSize.viewport < 140,
		`Playback controls grew unexpectedly: ${JSON.stringify(barSize)}`,
	)
	await waitFor(() => player("!document.querySelector('#play').disabled"), Boolean)
	if ((await player("document.querySelector('#play').getAttribute('aria-label')")) === "Pause") {
		await player("document.querySelector('#play').click()")
		await waitFor(
			() => player("document.querySelector('#status').textContent"),
			(status) => status === "Paused",
		)
	}
	const recovery: RecoveryDriver = {
		player,
		source: evaluate,
		pressPlay: async () => {
			await player("document.querySelector('#play').click()", true)
		},
		readSelectionFromMenu: async () => {
			const result = await view.evaluate<{ ok?: boolean }>(
				`chrome.runtime.sendMessage({type:'probe-context-menu',tab:{id:${tab.id}},info:{menuItemId:'read-selection',pageUrl:${JSON.stringify(server.url.href)}}})`,
			)
			assert(result?.ok, `Selection menu failed: ${JSON.stringify(result)}`)
		},
	}
	const recoveredScope = await recoverSelectionAfterFailure(recovery, "#warm-selection", async () => {
		await call(sessionId, "Emulation.setDeviceMetricsOverride", {
			width: 360,
			height: 600,
			deviceScaleFactor: 1,
			mobile: false,
		})
		await waitFor(
			() =>
				player(
					"innerWidth<360 && Math.abs(innerHeight-document.querySelector('#bar').getBoundingClientRect().height)<2",
				),
			Boolean,
		)
		console.log("Narrow error-state speed panel:", JSON.stringify(await player(checkSpeedPanel)))
		await call(sessionId, "Emulation.clearDeviceMetricsOverride")
	})
	const selectedText = recoveredScope.text
	await waitFor(
		async () =>
			(await view.evaluate<any>("chrome.storage.local.get('lastSpeechPerformance')")).lastSpeechPerformance?.recordedAt,
		(value) => value !== cold.recordedAt,
	)
	const warm = (await view.evaluate<any>("chrome.storage.local.get('lastSpeechPerformance')")).lastSpeechPerformance
	console.log("Warm first-buffer timings:", JSON.stringify(warm))
	// Chrome can suspend the extension service worker while the reader is
	// paused. Its termination must not evict the offscreen speech session.
	await player("document.querySelector('#play').click()")
	await view.cdp("ServiceWorker.enable")
	const worker = (await view.cdp<any>("Target.getTargets")).targetInfos.find(
		(target: any) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${id}/`),
	)
	assert(worker, "Extension service worker was not found before the restart check")
	await view.cdp("ServiceWorker.stopAllWorkers")
	await waitFor(
		async () =>
			(await view.cdp<any>("Target.getTargets")).targetInfos.some((target: any) => target.targetId === worker.targetId),
		(exists) => !exists,
	)
	await player("document.querySelector('#next').click()")
	await waitFor(
		async () =>
			(await view.evaluate<any>("chrome.storage.local.get('lastSpeechPerformance')")).lastSpeechPerformance?.recordedAt,
		(value) => value !== warm.recordedAt,
	)
	const resumed = (await view.evaluate<any>("chrome.storage.local.get('lastSpeechPerformance')")).lastSpeechPerformance
	assert(resumed.reusedSession === true, "Worker shutdown evicted the paused reader's speech session")
	if ((await player("document.querySelector('#play').getAttribute('aria-label')")) === "Play")
		await player("document.querySelector('#play').click()")
	console.log("Paused reader retained its speech session after service-worker termination.")
	assert(
		(await player("!document.querySelector('#message').classList.contains('quiet')")) === false,
		"Recovered player retained its error",
	)
	console.log("A new selection recovered from a forced playback failure.")
	const waitWord = async (word: string) => {
		try {
			await waitFor(
				() =>
					player(
						`probeHighlights.some(word=>word.start===${selectedText.indexOf(word)}&&word.end===${selectedText.indexOf(word) + word.length})`,
					),
				Boolean,
			)
		} catch (error) {
			console.log(
				"Navigation failure:",
				word,
				await player(
					"({status:document.querySelector('#status').textContent,play:document.querySelector('#play').getAttribute('aria-label'),disabled:document.querySelector('#play').disabled,sources:window.__probeAudio.sources,elements:window.__probeAudio.elements.map(e=>({paused:e.paused,time:e.currentTime,ready:e.readyState})),highlights:probeHighlights.slice(-10)})",
				),
			)
			throw error
		}
	}
	// The worker-restart check advances playback. Start the selected passage
	// again so the following navigation assertions have a known scope and cursor.
	await evaluate("window.getSelection().selectAllChildren(document.querySelector('#warm-selection'))")
	await player("probeHighlights.length=0")
	const navigationReset = await view.evaluate<any>(
		`chrome.runtime.sendMessage({type:'probe-context-menu',tab:{id:${tab.id}},info:{menuItemId:'read-selection',pageUrl:${JSON.stringify(server.url.href)}}})`,
	)
	assert(navigationReset?.ok, `Selection restart failed: ${JSON.stringify(navigationReset)}`)
	await waitWord("Fresh")
	await player("probeHighlights.length=0;document.querySelector('#next').click()")
	await waitWord("A")

	await player("probeHighlights.length=0;document.querySelector('#next').click()")
	await waitWord("Your")
	await player("probeHighlights.length=0;document.querySelector('#previous').click()")
	await waitWord("A")
	await player("document.querySelector('#next').click()")
	await player("probeHighlights.length=0")
	await verifySelectionReplay(recovery, recoveredScope)
	await waitWord("Fresh")
	await recoverSelectionFromMenu(recovery, "#selection")
	console.log("The context-menu command recovered the existing reader from failure.")
	const shot = await call(sessionId, "Page.captureScreenshot", { format: "png" })
	await Bun.write(`${root}/.cache/product-probe/reading.png`, Uint8Array.fromBase64(shot.data))
	await player("document.querySelector('#play').click()")
	assert((await player("document.querySelector('#status').textContent")) === "Paused", "Pause state did not update")
	await player("document.querySelector('#close').click()")
	await waitFor(() => evaluate("document.querySelector('[data-read-aloud]') === null"), Boolean)
	for (let n = 0; n < 2; n++)
		await view.evaluate(
			`chrome.scripting.executeScript({target:{tabId:${tab.id}},files:['content-scripts/reader.js']})`,
		)
	await evaluate("window.getSelection().selectAllChildren(document.querySelector('#warm-selection'))")
	await view.evaluate(
		`chrome.runtime.sendMessage({type:'probe-context-menu',info:{menuItemId:'read-selection'},tab:{id:${tab.id}}})`,
	)
	assert(
		(await evaluate("document.querySelectorAll('[data-read-aloud]').length")) === 1,
		"Reinjection left stale message listeners",
	)
	// Closing the source also exercises production cleanup after reinjection.
	await view.evaluate(`chrome.tabs.remove(${tab.id})`)
	await waitFor(
		async () =>
			(await view.cdp<any>("Target.getTargets")).targetInfos.some((target: any) =>
				target.url.startsWith(`chrome-extension://${id}/player.html`),
			),
		(exists) => !exists,
	)
	console.log("Testing sentence navigation on the actual MD Dash benchmark.")
	const mdTab: any = await view.evaluate(
		`chrome.tabs.create({url:'https://filipkrasa.salonek.org/projects/md-dash/',active:true})`,
	)
	const mdTarget = await waitFor<any>(
		async () =>
			(await view.cdp<any>("Target.getTargets")).targetInfos.find(
				(target: any) => target.url === "https://filipkrasa.salonek.org/projects/md-dash/",
			),
		Boolean,
	)
	const mdSession = (await view.cdp<any>("Target.attachToTarget", { targetId: mdTarget.targetId, flatten: false }))
		.sessionId

	await waitFor(
		() =>
			remote(
				mdSession,
				"document.readyState === 'complete' && location.href === 'https://filipkrasa.salonek.org/projects/md-dash/' && !!document.querySelector('main')",
			),
		Boolean,
	)
	await view.evaluate(
		`chrome.scripting.executeScript({target:{tabId:${mdTab.id}},files:['content-scripts/reader.js']})`,
	)
	const captureStarted = performance.now()
	const mdStarted = await view.evaluate<any>(
		`chrome.runtime.sendMessage({type:'probe-context-menu',info:{menuItemId:'read-article'},tab:{id:${mdTab.id}}})`,
	)
	const mdCaptureMs = performance.now() - captureStarted
	assert(mdStarted?.ok, mdStarted?.error ?? "MD Dash article capture failed")
	console.log("MD Dash article capture and reader creation:", mdCaptureMs.toFixed(1), "ms")
	const mdPlayer = await waitFor<any>(
		async () =>
			(await view.cdp<any>("Target.getTargets")).targetInfos.find((target: any) =>
				target.url.startsWith(`chrome-extension://${id}/player.html`),
			),
		Boolean,
	)
	const mdPlayerSession = (
		await view.cdp<any>("Target.attachToTarget", { targetId: mdPlayer.targetId, flatten: false })
	).sessionId
	const mdControl = (expression: string, userGesture = false) => remote(mdPlayerSession, expression, userGesture)
	await call(mdSession, "Page.bringToFront")
	await mdControl(pageScript(pauseOnFirstHighlight))
	const mdStatus = await waitFor(
		() => mdControl("document.querySelector('#status')?.textContent ?? ''"),
		(value) => /Reading|Press Play|Paused|failed/i.test(value),
		90,
	)
	if (mdStatus.includes("Press Play")) await mdControl("document.querySelector('#play').click()", true)
	await waitFor(
		() => mdControl("document.querySelector('#status').textContent"),
		(value) => value === "Paused",
	)
	await waitFor(
		() => mdControl("window.__probeAudio.sources"),
		(value: number) => value >= 2,
		90,
	)
	const mdSource = await mdControl(
		"chrome.runtime.sendMessage({type:'reader',session:location.hash.slice(1),command:'document'})",
	)
	const mdChunks = readingChunks(mdSource.text, "en-US")
	let mdCursor = 0
	for (let n = 0; n < 5; n++) {
		mdCursor = sentenceTarget(mdChunks, mdCursor, 1)
		assert(mdCursor > 0, "MD Dash must have several sentence boundaries")
		await mdControl(pageScript(advanceWithHighlightProbe))
		await waitFor(() => mdControl("!document.querySelector('#play').disabled"), Boolean)
		await mdControl("document.querySelector('#play').click()")
		await waitFor(
			() => mdControl("probeWords.at(-1)?.start??-1"),
			(value) => value >= mdChunks[mdCursor]!.start && value < mdChunks[mdCursor]!.end,
			30,
		)
	}
	mdCursor = sentenceTarget(mdChunks, mdCursor, -1)
	assert(mdCursor > 0, "The previous MD Dash sentence should not be the article start")
	await mdControl("probeWords.length=0;freezeOnHighlight=true;document.querySelector('#previous').click()")
	await waitFor(() => mdControl("!document.querySelector('#play').disabled"), Boolean)
	await mdControl("document.querySelector('#play').click()")
	await waitFor(
		() => mdControl("probeWords.at(-1)?.start??-1"),
		(value) => value >= mdChunks[mdCursor]!.start && value < mdChunks[mdCursor]!.end,
		30,
	)
	const mdShot = await call(mdSession, "Page.captureScreenshot", { format: "png" })
	await Bun.write(`${root}/.cache/product-probe/md-dash.png`, Uint8Array.fromBase64(mdShot.data))
	console.log("MD Dash next/previous navigation passed without restarting at the article beginning.")
	await view.evaluate("document.querySelector('section .danger').click()")
	await waitFor(() => view.evaluate<boolean>("!document.querySelector('section .danger')"), Boolean)
	await waitFor(
		() => mdControl("document.querySelector('#bar')?.dataset.view"),
		(value) => value === "setup",
	)
	assert(
		await mdControl("document.querySelector('#playback').hidden && !document.querySelector('#setup').hidden"),
		"Deleting the last voice did not restore setup",
	)
	await mdControl("document.querySelector('#close').click()")
	console.log("Pause, close, and voice deletion passed.")
	await Bun.write(
		`${root}/.cache/evidence/chrome-product.json`,
		JSON.stringify(
			{
				recordedAt: new Date().toISOString(),
				browser: await view.cdp("Browser.getVersion"),
				voice: "en_US-ljspeech-medium",
				performance: {
					cold,
					warm,
					mdCaptureMs,
					liveSpeed,
					caveat:
						"Development VM first-buffer readiness, not target-hardware audible latency; warm uses a different opening sentence in the same live engine.",
				},
				passed: [
					"no-voice state hides unusable controls",
					"live voice installation and deletion transitions",
					"stale voice preference recovery",
					"extension-owned storage despite unavailable iframe storage",
					"explicit download",
					"integrity",
					"model storage",
					"compact language and voice labels",
					"volume output gain, mute, persistence, no synthesis restart, and keyboard dismissal",
					"floating speed and volume panels leave bar height unchanged",
					"Play and background context-menu commands recover from playback failure",
					"local speech",
					"word highlighting",
					"Play replaces the previous scope with the current selection",
					"selection completion and replay stay within the selection",
					"pause",
					"close",
					"delete",
					"repeat activation without padding changes or duplicate controls",
					"next/previous sentence",
					"actual MD Dash article sentence navigation",
				],
				limitations: [
					"Scripted entry with test-only localhost and MD Dash grants; native activeTab/context-menu activation not tested",
					"Trusted Play gesture supplied if autoplay is blocked",
					"GPU, Windows, target-device performance, and audio quality not tested",
				],
			},
			null,
			2,
		) + "\n",
	)
} finally {
	await closeChromeProbe(view)
	server.stop(true)
}
