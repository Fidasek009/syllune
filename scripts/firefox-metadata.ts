import { join } from "node:path"

import { productName } from "../src/extension/brand"
import { buildVersion, parseVersion } from "./release-version"

function section(markdown: string, heading: string) {
	const value = markdown.split(`## ${heading}\n`)[1]?.split("\n## ")[0]?.trim()
	if (!value) throw new Error(`Missing store listing section: ${heading}`)
	return value
}

export async function firefoxMetadata(version: string, root = process.cwd()) {
	parseVersion(version)
	const listing = await Bun.file(join(root, "store/listing.md")).text()
	const summary = section(listing, "Short description")
	if (summary.length > 250) throw new Error("AMO summary exceeds 250 characters")
	const repository = "https://github.com/Fidasek009/syllune"
	return {
		name: { "en-US": section(listing, "Name") },
		default_locale: "en-US",
		summary: { "en-US": summary },
		description: { "en-US": section(listing, "Full description") },
		homepage: { "en-US": repository },
		support_url: { "en-US": `${repository}/issues` },
		categories: { firefox: ["other"] },
		requires_payment: false,
		version: {
			compatibility: ["firefox"],
			// AMO's predefined choices lack GPL-3.0-or-later. Preserve the actual
			// combined-distribution terms without relabeling original MIT files.
			custom_license: {
				name: { "en-US": "MIT source; GPL-3.0-or-later combined distribution" },
				text: {
					"en-US": [
						await Bun.file(join(root, "NOTICE.md")).text(),
						await Bun.file(join(root, "LICENSE")).text(),
						await Bun.file(join(root, "vendor/espeak-ng/licenses/COPYING")).text(),
					].join("\n\n"),
				},
			},
			approval_notes: `${section(listing, "Reviewer instructions")}\n\nBuild instructions: ${repository}/blob/v${version}/SOURCE_CODE_REVIEW.md. The matching reviewer source ZIP is attached automatically.`,
			release_notes: {
				"en-US": `${productName} ${version}. Changes and source: ${repository}/releases/tag/v${version}`,
			},
		},
	}
}

if (import.meta.main) {
	await firefoxMetadata(buildVersion())
	console.log("Firefox listing, reviewer instructions and separate license terms are present.")
}
