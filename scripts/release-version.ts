// Stable SemVer maps directly to both browsers' manifest version fields.
export function parseVersion(version: string, release = false): number[] {
	if (/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version)?.[0] !== version)
		throw new Error(`Expected stable semantic version X.Y.Z, received ${version}`)
	const parts = version.split(".").map(Number)
	if (parts.some((part) => part > 65535)) throw new Error("Browser version components cannot exceed 65535")
	if (release && parts.every((part) => part === 0)) throw new Error("0.0.0 is a development placeholder, not a release")
	return parts
}

export function versionFromTag(tag: string): string {
	if (!tag.startsWith("v")) throw new Error("Release tags must use vX.Y.Z")
	const version = tag.slice(1)
	parseVersion(version, true)
	return version
}

export function buildVersion(env: Record<string, string | undefined> = process.env): string {
	if (env.GITHUB_REF_TYPE === "tag") {
		const version = versionFromTag(env.GITHUB_REF_NAME ?? "")
		if (env.RELEASE_VERSION && env.RELEASE_VERSION !== version) throw new Error("Build version contradicts release tag")
		return version
	}
	// Explicit build input is for source review/local reproduction. Package version
	// is deliberately irrelevant; untagged development builds use a fixed sentinel.
	const version = env.RELEASE_VERSION || "0.0.0"
	parseVersion(version)
	return version
}

export function validateRelease(tag: string, previousTags: string[]): string {
	const version = versionFromTag(tag)
	const current = parseVersion(version, true)
	for (const previousTag of previousTags) {
		if (previousTag === tag) continue
		let previous: number[]
		try {
			previous = parseVersion(versionFromTag(previousTag))
		} catch {
			continue // Not a stable release tag.
		}
		const difference = current.findIndex((part, index) => part !== previous[index])
		if (difference < 0 || current[difference]! < previous[difference]!)
			throw new Error(`Release ${tag} must be newer than ${previousTag}`)
	}
	return version
}

if (import.meta.main) {
	const version = buildVersion()
	if (process.argv[2] === "--release") {
		const tag = process.env.GITHUB_REF_NAME ?? ""
		const tags = await Bun.$`git tag --list`.text()
		validateRelease(tag, tags.trim().split("\n"))
		const branch = process.env.DEFAULT_BRANCH
		if (!branch) throw new Error("DEFAULT_BRANCH is required")
		await Bun.$`git merge-base --is-ancestor HEAD ${`origin/${branch}`}`.quiet()
	}
	console.log(
		`Validated ${process.env.GITHUB_REF_TYPE === "tag" ? "tag-derived release" : "development"} version ${version}`,
	)
}
