import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

import { assertLicenseMaterials } from "./check-licenses"
import { versionFromTag } from "./release-version"

interface Result {
	exitCode: number
	stdout: string
}
type Run = (args: string[]) => Promise<Result>
const runGh: Run = async (args) => {
	const child = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "inherit" })
	const stdout = await new Response(child.stdout).text()
	return { exitCode: await child.exited, stdout }
}

export async function publishRelease(tag: string, files: string[], run: Run = runGh) {
	async function checked(args: string[]) {
		const result = await run(args)
		if (result.exitCode !== 0) throw new Error(`GitHub release command failed: ${args.slice(0, 2).join(" ")}`)
		return result.stdout
	}
	const view = await run(["release", "view", tag, "--json", "isDraft,assets"])
	let json = view.exitCode === 0 ? view.stdout : ""
	if (!json) {
		// Notes generation happens before assets/publication. A failed creation is safe to retry.
		await checked(["release", "create", tag, "--draft", "--verify-tag", "--generate-notes"])
		json = await checked(["release", "view", tag, "--json", "isDraft,assets"])
	}
	const release = JSON.parse(json) as { isDraft: boolean; assets: { name: string }[] }
	if (release.isDraft) {
		await checked(["release", "upload", tag, ...files, "--clobber"])
		await checked(["release", "edit", tag, "--draft=false", "--latest"])
		return
	}
	// A previous publication may have succeeded despite a lost response. Never overwrite
	// published assets: verify existing bytes and repair only missing uploads.
	const temp = await mkdtemp(join(tmpdir(), "read-aloud-release-"))
	try {
		for (const file of files) {
			if (!release.assets.some((asset) => asset.name === basename(file))) {
				await checked(["release", "upload", tag, file])
				continue
			}
			await checked(["release", "download", tag, "--pattern", basename(file), "--dir", temp])
			const downloaded = await Bun.file(join(temp, basename(file))).arrayBuffer()
			const expected = await Bun.file(file).arrayBuffer()
			if (!Buffer.from(downloaded).equals(Buffer.from(expected)))
				throw new Error(`Published asset differs: ${basename(file)}`)
		}
	} finally {
		await rm(temp, { recursive: true, force: true })
	}
}

if (import.meta.main) {
	await assertLicenseMaterials()
	const tag = process.env.RELEASE_TAG
	if (!tag) throw new Error("RELEASE_TAG is required")
	const version = versionFromTag(tag)
	const zips = (await Array.fromAsync(new Bun.Glob("*.zip").scan({ cwd: "artifacts" })))
		.sort()
		.map((file) => `artifacts/${file}`)
	const expected = ["chrome", "firefox", "sources", "store-assets"]
		.map((kind) => `artifacts/read-aloud-${version}-${kind}.zip`)
		.sort()
	if (JSON.stringify(zips) !== JSON.stringify(expected))
		throw new Error("Release artifacts do not match the tag version")
	const sums = await Promise.all(
		zips.map(
			async (file) =>
				`${new Bun.CryptoHasher("sha256").update(await Bun.file(file).arrayBuffer()).digest("hex")}  ${basename(file)}`,
		),
	)
	await Bun.write("artifacts/SHA256SUMS", `${sums.join("\n")}\n`)
	await publishRelease(tag, [...zips, "artifacts/SHA256SUMS"])
}
