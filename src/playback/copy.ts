/** Shared recovery and status wording; diagnostics never become user-facing copy. */
export const playbackCopy = {
	failed: "Reading could not continue. Press Play to try again.",
	selectionUnavailable: "This selection could not be read. Select it again and press Play.",
	continuationUnavailable: "Reading could not continue from here. Select where to read next.",
	skipped: "Some text could not be read.",
	preparing: "Preparing voice…",
} as const
