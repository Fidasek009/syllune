import { browser } from "wxt/browser"

import type { GpuFallbackReason, SpeechDiagnostics } from "./diagnostics.ts"
import type { SpeechClip } from "./protocol.ts"
import type { VoiceConfig } from "./voice-config.ts"
import type { VoiceModel } from "./voice-store.ts"

import { SPEECH_REQUEST_TIMEOUT_MS, speechFailure, speechFailureCode, SpeechTextError } from "./errors.ts"
import { sendSpeechHost, SPEECH_GPU_FAILURE_KEY } from "./host-protocol.ts"
import { readVoice } from "./vault.ts"
import { isWorkerResponse, type WorkerCommand, type WorkerRequest, type WorkerSuccess } from "./worker-protocol.ts"

export interface SpeechWorker {
	onmessage: ((event: MessageEvent<unknown>) => unknown) | null
	onerror: ((event: ErrorEvent) => unknown) | null
	postMessage(message: WorkerRequest, transfer: Transferable[]): void
	terminate(): void
}

export interface SpeechEngineRuntime {
	readVoice: typeof readVoice
	createWorker(backend: "cpu" | "gpu"): SpeechWorker
	gpuAvailable(): Promise<boolean>
	disableGpu(): void
}

type VoiceData = { model: VoiceModel; config: VoiceConfig; modelReadMs: number }

const GPU_STARTUP_TIMEOUT_MS = 3_000

let gpuUnavailable = false
const defaultRuntime: SpeechEngineRuntime = {
	readVoice,
	createWorker: (backend) => new Worker(browser.runtime.getURL(`/runtime/${backend}/speech.js`), { type: "module" }),
	async gpuAvailable() {
		if (gpuUnavailable || !("gpu" in navigator)) return false
		// Chrome offscreen documents expose runtime only, not storage APIs.
		if (import.meta.env.BROWSER !== "firefox") return (await sendSpeechHost({ type: "speech-gpu-available" })).ok
		const remembered = await browser.storage.session.get(SPEECH_GPU_FAILURE_KEY)
		return remembered[SPEECH_GPU_FAILURE_KEY] !== true
	},
	disableGpu() {
		gpuUnavailable = true
		if (import.meta.env.BROWSER === "firefox")
			void browser.storage.session.set({ [SPEECH_GPU_FAILURE_KEY]: true }).catch(() => {})
		else void sendSpeechHost({ type: "speech-gpu-failed" }).catch(() => {})
	},
}

class WorkerFailure extends Error {
	constructor(
		message: string,
		readonly model: ArrayBuffer | undefined,
	) {
		super(message)
	}
}

class SpeechSession {
	diagnostics: SpeechDiagnostics = {}
	private rejectPending: ((error: Error) => void) | undefined
	get closed() {
		return this.closedWith !== undefined
	}
	private closedWith: Error | undefined
	private sequence = 0

	constructor(
		private worker: SpeechWorker,
		readonly backend: "cpu" | "gpu",
	) {
		worker.onerror = () => this.close(new Error("The speech worker stopped unexpectedly"))
	}

	async request(
		message: Extract<WorkerCommand, { type: "load" }>,
		timeout?: number,
	): Promise<Extract<WorkerSuccess, { type: "load" }>>
	async request(
		message: Extract<WorkerCommand, { type: "synthesize" }>,
		timeout?: number,
	): Promise<Extract<WorkerSuccess, { type: "synthesize" }>>
	async request(message: WorkerCommand, timeout = SPEECH_REQUEST_TIMEOUT_MS): Promise<WorkerSuccess> {
		if (this.closedWith) throw this.closedWith
		if (this.rejectPending) throw new Error("Speech worker is busy")
		const id = ++this.sequence
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => this.close(speechFailure("timeout")), timeout)
			const finish = () => {
				clearTimeout(timer)
				this.rejectPending = undefined
				this.worker.onmessage = null
			}
			const fail = (error: Error) => {
				finish()
				reject(error)
			}
			this.rejectPending = fail
			this.worker.onmessage = ({ data }: MessageEvent<unknown>) => {
				if (!data || typeof data !== "object" || !("id" in data) || data.id !== id) return
				if (!isWorkerResponse(data) || (data.ok && data.type !== message.type)) {
					fail(new Error("Invalid speech response"))
					return
				}
				if (!data.ok) {
					fail(
						data.code === "unreadable-text"
							? new SpeechTextError(data.error)
							: new WorkerFailure(data.error, data.model),
					)
					return
				}
				finish()
				resolve(data)
			}
			try {
				this.worker.postMessage(
					{ ...message, id } satisfies WorkerRequest,
					message.type === "load" && message.model instanceof ArrayBuffer ? [message.model] : [],
				)
			} catch (error) {
				finish()
				reject(error)
			}
		})
	}

	close(error: Error = speechFailure("cancelled")) {
		if (this.closed) return
		this.closedWith = error
		this.worker.terminate()
		this.rejectPending?.(error)
	}
}

type Candidate = {
	session: SpeechSession
	ready: Promise<SpeechSession>
}

export class SpeechEngine {
	diagnostics: SpeechDiagnostics = {}
	private primary: SpeechSession | undefined
	private candidates: Candidate[] = []
	private loadedConfig: VoiceConfig | undefined
	private loadedBlob: Blob | undefined
	private modelReadMs = 0
	private cpuFallback: { recovered: VoiceData | undefined; reason: GpuFallbackReason } | undefined
	private recovering: Promise<SpeechSession> | undefined
	private voice = ""
	private epoch = 0
	private serial: Promise<unknown> = Promise.resolve()
	private generation = 0
	private cacheEpoch = 0
	private clips = new Map<string, SpeechClip>()
	private clipBytes = 0
	private loading: { voice: string; promise: Promise<void> } | undefined

	constructor(
		private runtime: SpeechEngineRuntime = defaultRuntime,
		private gpuStartupTimeoutMs = GPU_STARTUP_TIMEOUT_MS,
	) {}

	load(voice: string): Promise<void> {
		if (this.loading?.voice === voice) return this.loading.promise
		const promise = this.loadVoice(voice)
		this.loading = { voice, promise }
		void promise
			.finally(() => {
				if (this.loading?.promise === promise) this.loading = undefined
			})
			.catch(() => {})
		return promise
	}

	private async loadVoice(voice: string): Promise<void> {
		const sameVoice = this.voice === voice
		if (sameVoice && this.cpuFallback) {
			await this.recoverCpu(this.epoch, performance.now())
			return
		}
		if (
			sameVoice &&
			((this.primary && !this.primary.closed) || this.candidates.some(({ session }) => !session.closed))
		) {
			if (this.primary) this.diagnostics = { backend: this.primary.backend, voice, reusedSession: true }
			return
		}
		this.dispose()
		const started = performance.now()
		const epoch = this.epoch
		const cpu = new SpeechSession(this.runtime.createWorker("cpu"), "cpu")
		this.primary = cpu
		let gpuAvailable = false
		const availability = this.runtime.gpuAvailable().then(
			(available) => (gpuAvailable = available),
			() => false,
		)
		try {
			const { model, config } = await this.runtime.readVoice(voice)
			if (epoch !== this.epoch) throw speechFailure("cancelled")
			this.loadedConfig = config
			this.loadedBlob = model instanceof Blob ? model : undefined
			this.modelReadMs = performance.now() - started
			const data = { model, config, modelReadMs: this.modelReadMs }

			const startGpu = (): Candidate | undefined => {
				try {
					const gpuModel = model instanceof ArrayBuffer ? model.slice(0) : model
					const session = new SpeechSession(this.runtime.createWorker("gpu"), "gpu")
					return { session, ready: this.prepare(session, voice, { ...data, model: gpuModel }, started) }
				} catch {
					this.runtime.disableGpu()
				}
			}
			// Copy legacy buffers before sending them to the CPU. An immutable Blob
			// remains available if GPU discovery finishes during CPU preparation.
			const gpu = gpuAvailable ? startGpu() : undefined
			const cpuReady = this.prepare(cpu, voice, data, started)
			this.primary = undefined
			this.candidates = [{ session: cpu, ready: cpuReady }]
			const pending = [cpuReady]
			if (gpu) {
				this.candidates.push(gpu)
				pending.push(gpu.ready)
			} else if (model instanceof Blob && !gpuAvailable) {
				const cpuFinished = cpuReady.then(
					() => false,
					() => false,
				)
				pending.push(
					Promise.race([availability, cpuFinished]).then((available) => {
						const candidate = available && epoch === this.epoch && !this.primary && startGpu()
						if (!candidate) throw speechFailure("cancelled")
						this.candidates.push(candidate)
						return candidate.ready
					}),
				)
			}
			const ready = await Promise.any(pending)
			if (epoch !== this.epoch) throw speechFailure("cancelled")
			this.voice = voice
			if (this.candidates.length === 1) this.select(cpu)
			else this.diagnostics = { ...ready.diagnostics }
		} catch (error) {
			if (epoch !== this.epoch) throw speechFailure("cancelled")
			this.dispose()
			if (error instanceof AggregateError && error.errors.length) throw error.errors[0]
			throw error
		}
	}

	private async prepare(
		session: SpeechSession,
		voice: string,
		{ model, config, modelReadMs }: VoiceData,
		started: number,
	): Promise<SpeechSession> {
		try {
			const loaded = await session.request(
				{ type: "load", voice, config, model },
				session.backend === "gpu" ? this.gpuStartupTimeoutMs : undefined,
			)
			session.diagnostics = {
				backend: session.backend,
				voice,
				modelReadMs,
				loadMs: performance.now() - started,
				...loaded.timings,
			}
			return session
		} catch (error) {
			session.close()
			throw error
		}
	}

	private select(session: SpeechSession) {
		for (const candidate of this.candidates) if (candidate.session !== session) candidate.session.close()
		this.candidates = []
		this.primary = session
		this.diagnostics = { ...session.diagnostics }
	}

	synthesize(text: string, speed: number): Promise<SpeechClip> {
		const epoch = this.epoch
		const generation = this.generation
		const cacheEpoch = this.cacheEpoch
		const key = `${this.voice}\u0000${speed}\u0000${text}`
		const job = this.serial
			.catch(() => {})
			.then(() => {
				if (epoch !== this.epoch || generation !== this.generation) throw speechFailure("cancelled")
				return (
					this.clips.get(key) ??
					this.generate(text, speed, generation).then((clip) => {
						// Completed work can be reused after Next/Previous, but never
						// across model disposal or a change in reading ownership.
						if (epoch === this.epoch && cacheEpoch === this.cacheEpoch && clip.pcm.byteLength <= 4_000_000) {
							this.clips.set(key, clip)
							this.clipBytes += clip.pcm.byteLength
							while (this.clips.size > 12 || this.clipBytes > 8_000_000) {
								const oldest = this.clips.keys().next().value!
								this.clipBytes -= this.clips.get(oldest)!.pcm.byteLength
								this.clips.delete(oldest)
							}
						}
						if (epoch !== this.epoch || generation !== this.generation) throw speechFailure("cancelled")
						return clip
					})
				)
			})
		this.serial = job
		return job
	}

	private async generate(text: string, speed: number, generation: number): Promise<SpeechClip> {
		const epoch = this.epoch
		const started = performance.now()
		const message = { type: "synthesize", text, speed } as const
		if (this.cpuFallback) await this.recoverCpu(epoch, started)
		if (epoch !== this.epoch || generation !== this.generation) throw speechFailure("cancelled")
		if (!this.primary) {
			const candidates = this.candidates
			const gpu = candidates.find(({ session }) => session.backend === "gpu")
			let gpuFailure: GpuFallbackReason | undefined
			let result
			try {
				result = await Promise.any(
					candidates.map(async ({ ready, session }) => {
						let loaded = false
						try {
							await ready
							if (epoch !== this.epoch || generation !== this.generation) throw speechFailure("cancelled")
							loaded = true
							const synthesisStarted = performance.now()
							const value = await session.request(
								message,
								session.backend === "gpu" ? this.gpuStartupTimeoutMs : undefined,
							)
							return { session, value, synthesisMs: performance.now() - synthesisStarted }
						} catch (error) {
							const code = speechFailureCode(error)
							if (code !== "cancelled" && code !== "text") session.close()
							if (session.backend === "gpu" && code !== "cancelled" && code !== "text") {
								this.runtime.disableGpu()
								gpuFailure = `gpu-${loaded ? "inference" : "initialization"}-${code === "timeout" ? "timeout" : "failed"}`
							}
							throw error
						}
					}),
				)
			} catch (error) {
				if (epoch !== this.epoch || generation !== this.generation) throw speechFailure("cancelled")
				if (error instanceof AggregateError && error.errors.length) throw error.errors[0]
				throw error
			}
			if (epoch !== this.epoch) throw speechFailure("cancelled")
			this.select(result.session)
			if (result.session.backend === "cpu" && gpu) this.diagnostics.gpuFallbackReason = gpuFailure ?? "cpu-first-clip"
			this.diagnostics.synthesisMs = result.synthesisMs
			return result.value
		}
		const session = this.primary
		try {
			const value = await session.request(message)
			if (epoch !== this.epoch) throw speechFailure("cancelled")
			this.diagnostics.synthesisMs = performance.now() - started
			return value
		} catch (error) {
			if (epoch !== this.epoch) throw speechFailure("cancelled")
			if (session.backend === "cpu" || error instanceof SpeechTextError) throw error
			session.close()
			const model = this.loadedBlob ?? (error instanceof WorkerFailure ? error.model : undefined)
			const recovered =
				model && this.loadedConfig ? { model, config: this.loadedConfig, modelReadMs: this.modelReadMs } : undefined
			this.runtime.disableGpu()
			const reason = speechFailureCode(error) === "timeout" ? "gpu-inference-timeout" : "gpu-inference-failed"
			this.cpuFallback = { recovered, reason }
			if (generation !== this.generation) throw speechFailure("cancelled")
			const cpu = await this.recoverCpu(epoch, started)
			if (generation !== this.generation) throw speechFailure("cancelled")
			const value = await cpu.request(message)
			if (epoch !== this.epoch) throw speechFailure("cancelled")
			this.diagnostics.synthesisMs = performance.now() - started
			return value
		}
	}

	private async recoverCpu(epoch: number, started: number): Promise<SpeechSession> {
		if (this.recovering) return this.recovering
		const fallback = this.cpuFallback
		if (!fallback) throw speechFailure("unavailable")
		const voice = this.voice
		const cpu = new SpeechSession(this.runtime.createWorker("cpu"), "cpu")
		this.primary?.close()
		this.primary = cpu
		const model = fallback.recovered
			? Promise.resolve(fallback.recovered)
			: this.runtime.readVoice(voice).then((data) => ({
					...data,
					modelReadMs: performance.now() - started,
				}))
		this.cpuFallback = { recovered: undefined, reason: fallback.reason }
		const recovering = model
			.then((data) => this.prepare(cpu, voice, data, started))
			.then(() => {
				if (epoch !== this.epoch) throw speechFailure("cancelled")
				this.cpuFallback = undefined
				this.select(cpu)
				this.diagnostics.gpuFallbackReason = fallback.reason
				if (fallback.recovered) this.diagnostics.modelReusedOnFallback = true
				return cpu
			})
		this.recovering = recovering
		try {
			return await recovering
		} catch (error) {
			cpu.close()
			throw error
		} finally {
			if (this.recovering === recovering) this.recovering = undefined
		}
	}

	cancelQueued() {
		this.generation++
	}
	clearClips() {
		this.cancelQueued()
		// Do not allow an already-running clip to repopulate source-text caches
		// after the reader closed or a different client claimed ownership.
		this.cacheEpoch++
		this.clips.clear()
		this.clipBytes = 0
	}

	dispose() {
		this.loading = undefined
		this.diagnostics = {}
		this.epoch++
		this.cacheEpoch++
		this.voice = ""
		this.serial = Promise.resolve()
		this.loadedConfig = undefined
		this.loadedBlob = undefined
		this.cpuFallback = undefined
		this.recovering = undefined
		this.primary?.close()
		this.primary = undefined
		for (const candidate of this.candidates) candidate.session.close()
		this.candidates = []
		this.generation++
		this.clips.clear()
		this.clipBytes = 0
	}
}
