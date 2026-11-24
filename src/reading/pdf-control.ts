export type PdfAction = { action: "stop" } | { action: "read"; mode: "article" | "selection"; reveal: boolean }
export type PdfCommand = PdfAction & { type: "pdf-command"; tabId: number }
export type PdfCommandResult = { ok: true } | { ok: false; error: string }

export function isPdfCommandResult(value: unknown): value is PdfCommandResult {
	return (
		!!value &&
		typeof value === "object" &&
		"ok" in value &&
		(value.ok === true || (value.ok === false && "error" in value && typeof value.error === "string"))
	)
}

export function isPdfCommand(value: unknown): value is PdfCommand {
	if (
		!value ||
		typeof value !== "object" ||
		!("type" in value) ||
		value.type !== "pdf-command" ||
		!("tabId" in value) ||
		typeof value.tabId !== "number" ||
		!Number.isSafeInteger(value.tabId) ||
		value.tabId < 0 ||
		!("action" in value)
	)
		return false
	return (
		value.action === "stop" ||
		(value.action === "read" &&
			"mode" in value &&
			(value.mode === "article" || value.mode === "selection") &&
			"reveal" in value &&
			typeof value.reveal === "boolean")
	)
}
