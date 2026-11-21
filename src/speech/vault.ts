import { browser } from "wxt/browser"

import { localKeys } from "../extension/storage.ts"
import { getVoice } from "./catalog.ts"
import { cancelVoiceDownloads, voiceDownloadCancellation } from "./download-cancellation.ts"
import { downloadBytes } from "./download.ts"
import { SpeechError } from "./errors.ts"
import { instrumentInWorker } from "./instrument-client.ts"
import { isVoiceChange } from "./protocol.ts"
import { validateConfig, type VoiceConfig } from "./voice-config.ts"
import { type StoredVoice, voiceLock, type VoiceModel, voiceOperation } from "./voice-store.ts"

export async function installedVoices(): Promise<string[]> {
	return (await voiceOperation("readonly", (store) => store.getAllKeys())).map(String)
}

export async function readVoice(id: string): Promise<{ model: VoiceModel; config: VoiceConfig }> {
	const voice = getVoice(id)
	if (voice.unsupported) throw new SpeechError("voice", voice.unsupported)
	const stored = await voiceOperation<StoredVoice | undefined>("readonly", (store) => store.get(id))
	if (!stored || stored.sourceHash !== voice.sha256)
		throw new SpeechError("voice", "Stored voice is missing or outdated")
	try {
		const config = validateConfig(stored.config)
		const { model } = stored
		if (!(model instanceof Blob ? model.size : model instanceof ArrayBuffer && model.byteLength))
			throw new Error("Empty or invalid voice model")
		return { model, config }
	} catch {
		throw new SpeechError("voice", "Stored voice data is invalid")
	}
}

export function onVoicesChanged(callback: (id: string, deleted: boolean) => void): () => void {
	const listener: Parameters<typeof browser.storage.onChanged.addListener>[0] = (changes, area) => {
		const change: unknown = changes[localKeys.voiceChange]?.newValue
		if (area === "local" && isVoiceChange(change)) callback(change.id, change.deleted)
	}
	browser.storage.onChanged.addListener(listener)
	return () => browser.storage.onChanged.removeListener(listener)
}

export async function deleteVoice(id: string, committed: () => Promise<void>): Promise<void> {
	// A deletion request cancels concurrent downloads, but is not a committed
	// change and must not invalidate a model still used by a reader.
	cancelVoiceDownloads(id)
	await navigator.locks.request(voiceLock(id), async () => {
		await voiceOperation("readwrite", (store) => store.delete(id))
		await committed()
	})
}

/** Only a deliberate Download action may call this function. Nothing invokes it on startup. */
export async function downloadVoice(
	id: string,
	signal: AbortSignal,
	progress: (fraction: number) => void,
	committed: () => Promise<void>,
): Promise<void> {
	const voice = getVoice(id)
	if (voice.unsupported) throw new Error(voice.unsupported)
	const cancellation = voiceDownloadCancellation(id, signal)
	const abort = cancellation.signal
	try {
		// Request persistent origin storage only as part of a deliberate download.
		// Some browsers may decline or not expose this API; quota failures still
		// surface through the download action.
		if (navigator.storage?.persist) await navigator.storage.persist().catch(() => false)
		abort.throwIfAborted()
		await navigator.locks.request(voiceLock(id), { signal: abort }, async () => {
			const configBytes = await downloadBytes(voice.configUrl, {
				signal: abort,
				maxBytes: 1_000_000,
			})
			if (new Uint8Array(await crypto.subtle.digest("SHA-256", configBytes)).toHex() !== voice.configHash)
				throw new Error("Voice configuration integrity check failed")
			const config = validateConfig(JSON.parse(new TextDecoder().decode(configBytes)))
			const bytes = await downloadBytes(voice.url, {
				signal: abort,
				bytes: voice.bytes,
				maxBytes: voice.bytes,
				onProgress: (received) => progress(received / voice.bytes),
			})
			const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)).toHex()
			if (digest !== voice.sha256) throw new Error("Voice integrity check failed. Please try again.")
			abort.throwIfAborted()
			const model = await instrumentInWorker(
				bytes.buffer,
				abort,
				() => new Worker(new URL("runtime/instrument.js", browser.runtime.getURL("/")), { type: "module" }),
			)
			abort.throwIfAborted()
			await voiceOperation("readwrite", (store) =>
				store.put({ id, sourceHash: digest, model: new Blob([model]), config } satisfies StoredVoice),
			)
			await committed()
		})
	} finally {
		cancellation.close()
	}
}
