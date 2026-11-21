import type { VoiceConfig } from "./voice-config.ts"

export type VoiceModel = Blob | ArrayBuffer

export interface StoredVoice {
	id: string
	sourceHash: string
	model: VoiceModel
	config: VoiceConfig
}

export const voiceStore = {
	database: "read-aloud-voices",
	databaseVersion: 1,
	store: "voices",
	keyPath: "id",
} as const

export const voiceLock = (id: string) => `voice:${id}`

let database: Promise<IDBDatabase> | undefined
const opening = () =>
	(database ??= new Promise((resolve, reject) => {
		const request = indexedDB.open(voiceStore.database, voiceStore.databaseVersion)
		request.onupgradeneeded = () => request.result.createObjectStore(voiceStore.store, { keyPath: voiceStore.keyPath })
		request.onsuccess = () => resolve(request.result)
		request.onerror = () => {
			database = undefined
			reject(request.error)
		}
	}))

/** Resolve only after commit, including for writes whose request succeeds before abort. */
export async function voiceOperation<T>(
	mode: IDBTransactionMode,
	run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
	const db = await opening()
	return new Promise((resolve, reject) => {
		const transaction = db.transaction(voiceStore.store, mode)
		const request = run(transaction.objectStore(voiceStore.store))
		transaction.oncomplete = () => resolve(request.result)
		transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error("Voice storage failed"))
	})
}
