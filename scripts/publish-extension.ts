import { assertLicenseMaterials } from "./check-licenses"
import { buildVersion, parseVersion } from "./release-version"

// Chrome uses WXT; Firefox uses Mozilla's client for first listings and updates.
export function chromeSubmissionArgs(version: string, dryRun: boolean) {
	parseVersion(version, !dryRun)
	return [
		"submit",
		"--dry-run",
		String(dryRun),
		"--chrome-zip",
		`.output/read-aloud-${version}-chrome.zip`,
		"--chrome-skip-submit-review",
		"false",
		"--chrome-api-version",
		"v2",
		"--chrome-cancel-pending",
		"false",
		"--chrome-publish-type",
		"DEFAULT_PUBLISH",
	]
}

if (import.meta.main) {
	const [browser = "", mode] = process.argv.slice(2)
	if (mode !== "--dry-run" && mode !== "--publish") throw new Error("Explicit --dry-run or --publish is required")
	const dryRun = mode === "--dry-run"
	const version = buildVersion()
	if (browser !== "chrome" && browser !== "firefox") throw new Error("Expected chrome or firefox")
	if (!dryRun) {
		await assertLicenseMaterials()
		if (process.env.GITHUB_REF_TYPE !== "tag" || process.env.GITHUB_REF_NAME !== `v${version}`)
			throw new Error("Publishing requires the matching release tag")
	}
	if (browser === "firefox") {
		const { publishFirefox } = await import("./firefox-publishing")
		await publishFirefox({
			version,
			dryRun,
			extensionId: process.env.FIREFOX_EXTENSION_ID ?? "",
			issuer: process.env.FIREFOX_JWT_ISSUER ?? "",
			secret: process.env.FIREFOX_JWT_SECRET ?? "",
		})
		process.exit(0)
	}
	const args = chromeSubmissionArgs(version, dryRun)
	const child = Bun.spawn([process.execPath, "--bun", "run", "wxt", ...args], { stdout: "inherit", stderr: "inherit" })
	process.exit(await child.exited)
}
