import { maximumSessionIdLength } from "./limits.ts"

export type ReaderCommand =
	| { command: "document" }
	| { command: "selection" }
	| { command: "continue" }
	| { command: "close" }
	| { command: "highlight"; start: number; end: number }
	| { command: "resize"; height: number; width?: number }

export type ReaderRequest = ReaderCommand & { session: string }
export type ReaderResponse = { text: string | null } | { error: string } | { ok: boolean }
export type ReaderHost = (message: ReaderRequest) => Promise<ReaderResponse>

/** Match a reply to its command; a text reply is never valid for a control command. */
export function isReaderResponse(command: ReaderCommand, value: unknown): value is ReaderResponse {
	if (!value || typeof value !== "object") return false
	if ("error" in value) return typeof value.error === "string"
	if (command.command === "document") return "text" in value && typeof value.text === "string"
	if (command.command === "selection" || command.command === "continue")
		return "text" in value && (value.text === null || typeof value.text === "string")
	return "ok" in value && typeof value.ok === "boolean"
}

/** Validate messages at the boundary before acting on untrusted values. */
export function isReaderRequest(value: unknown): value is ReaderRequest {
	if (
		!value ||
		typeof value !== "object" ||
		!("session" in value) ||
		typeof value.session !== "string" ||
		!value.session ||
		value.session.length > maximumSessionIdLength ||
		!("command" in value)
	)
		return false
	if (
		value.command === "document" ||
		value.command === "selection" ||
		value.command === "continue" ||
		value.command === "close"
	)
		return true
	if (value.command === "highlight")
		return (
			"start" in value &&
			typeof value.start === "number" &&
			Number.isSafeInteger(value.start) &&
			value.start >= 0 &&
			"end" in value &&
			typeof value.end === "number" &&
			Number.isSafeInteger(value.end) &&
			value.end >= value.start
		)
	if (value.command === "resize")
		return (
			"height" in value &&
			typeof value.height === "number" &&
			Number.isFinite(value.height) &&
			(!("width" in value) || (typeof value.width === "number" && Number.isFinite(value.width)))
		)
	return false
}
