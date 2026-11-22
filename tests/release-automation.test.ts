import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { publishRelease } from "../scripts/github-release"
import { chromeSubmissionArgs } from "../scripts/publish-extension"

test("Chrome uses explicit WXT dry-run and live modes", () => {
	const args = chromeSubmissionArgs("0.0.0", true)
	expect(args.slice(0, 3)).toEqual(["submit", "--dry-run", "true"])
	expect(args).toContain("--chrome-zip")
	expect(() => chromeSubmissionArgs("0.0.0", false)).toThrow()
	expect(chromeSubmissionArgs("0.1.0", false).slice(0, 3)).toEqual(["submit", "--dry-run", "false"])
})

test("release retries recover after draft creation, partial upload and publication response loss", async () => {
	const temp = await mkdtemp(join(tmpdir(), "release-retry-test-"))
	const file = join(temp, "extension.zip")
	await Bun.write(file, "tested artifact")
	try {
		for (const failure of ["create", "upload", "edit"]) {
			let exists = false
			let draft = true
			let uploaded = false
			let failed = false
			let creations = 0
			const run = async (args: string[]) => {
				const command = args[1]
				if (command === "view")
					return {
						exitCode: exists ? 0 : 1,
						stdout: JSON.stringify({ isDraft: draft, assets: uploaded ? [{ name: "extension.zip" }] : [] }),
					}
				if (command === "create") {
					exists = true
					creations++
				}
				if (command === "upload") uploaded = true
				if (command === "edit") {
					expect(uploaded).toBe(true)
					draft = false
				}
				if (command === "download")
					await Bun.write(join(args[args.indexOf("--dir") + 1]!, "extension.zip"), Bun.file(file))
				if (command === failure && !failed) {
					failed = true
					return { exitCode: 1, stdout: "" }
				}
				return { exitCode: 0, stdout: "" }
			}
			await expect(publishRelease("v0.1.0", [file], run)).rejects.toThrow()
			await publishRelease("v0.1.0", [file], run)
			expect(creations).toBe(1)
			expect(draft).toBe(false)
			await publishRelease("v0.1.0", [file], run)
		}
	} finally {
		await rm(temp, { recursive: true, force: true })
	}
})

test("published releases repair missing assets but refuse to overwrite changed bytes", async () => {
	const temp = await mkdtemp(join(tmpdir(), "release-public-test-"))
	const existing = join(temp, "existing.zip")
	const missing = join(temp, "missing.zip")
	await Bun.write(existing, "immutable")
	await Bun.write(missing, "missing artifact")
	const uploads: string[][] = []
	let contents = "immutable"
	const run = async (args: string[]) => {
		if (args[1] === "view")
			return { exitCode: 0, stdout: JSON.stringify({ isDraft: false, assets: [{ name: "existing.zip" }] }) }
		if (args[1] === "download") await Bun.write(join(args[args.indexOf("--dir") + 1]!, "existing.zip"), contents)
		if (args[1] === "upload") uploads.push(args)
		return { exitCode: 0, stdout: "" }
	}
	try {
		await publishRelease("v0.1.0", [existing, missing], run)
		expect(uploads).toEqual([["release", "upload", "v0.1.0", missing]])
		contents = "different remote bytes"
		await expect(publishRelease("v0.1.0", [existing, missing], run)).rejects.toThrow("Published asset differs")
		expect(uploads.length).toBe(1)
	} finally {
		await rm(temp, { recursive: true, force: true })
	}
})
