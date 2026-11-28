# CI and releases

Updated **2026-11-10**. The implementation agent owns release engineering, icons, promotional artwork, screenshots, listing/privacy copy, and the submission package. The product owner supplies product decisions and only the account/identity/credential actions that cannot be performed without their access. They are not assigned design, copywriting, building, or routine publishing work.

## Version authority and automatic publishing

The pushed **`vX.Y.Z` Git tag is the sole release-version authority**. `package.json` may retain its development placeholder; no package-version edit is required or used for a release. `scripts/release-version.ts` validates and strips the tag prefix. WXT writes that version into both browser manifests and uses it in every artifact filename. Publishing resolves that same tag, and GitHub release creation rejects artifacts named for another version. Untagged development builds use `0.0.0`; explicit `RELEASE_VERSION` is available only for local/source-review reproduction. In a tag build an override contradicting the tag fails.

Use stable SemVer: major for incompatible product-contract changes, minor for compatible features, patch for compatible fixes; 0.y.z denotes initial development. Exact three-component versions with no leading zeroes, prerelease/build suffixes or components above 65535 are supported by the stable store pipeline. All-zero versions cannot be released. The workflow checks the tag is newer than previous stable tags and its commit is on the default branch. Reviewers assess the meaning of the bump; automation cannot infer compatibility from source diffs.

Once store accounts and credentials are provisioned, the Chrome draft item exists, and the documented acceptance work is complete, the entire release instruction is:

```sh
git tag -a v0.1.0 -m 'Release 0.1.0'
git push origin v0.1.0
```

No package bump, manual ZIP build, artwork task, separate `RELEASE_READY` variable or manual GitHub release creation is required. CI verifies required license notices and pinned source materials. The concise [licensing checklist](licensing.md) separately records remaining model/output assessments; a passing material check does not establish release readiness. The tag triggers **CI → CD → published GitHub release**. Chrome is submitted with default automatic publication after approval; Firefox uses AMO's listed channel. The stores retain control of review timing and decisions. Release notes are GitHub's automatically generated notes; the body carries no store-status disclaimer.

## Workflows

- **CI:** required on PRs and main, and called by every release. Produces `extension-chrome`, `extension-firefox` and `extension-store-assets` from one commit, rebuilding the Firefox reviewer sources and comparing every packaged file byte. Gate main's rules on **CI complete**.
- **CD:** both stores authenticate before either can upload, and live jobs use the exact archives CI tested. Chrome submits for automatic publication after approval; Firefox creates or updates the AMO listing on its listed channel and attaches reviewer sources. No review bypass or cancellation of another pending review is requested.
- **Store check:** manual dispatch on the default branch that runs CI and store authentication only. It consumes no version number and creates no release, so it proves credentials and local listing materials, not store approval.
- **Release:** a `v*` push must pass strict `vX.Y.Z` validation. After CI and both submissions succeed it publishes the GitHub release with the four tag-versioned ZIPs and SHA-256 checksums; the fourth ZIP is `read-aloud-X.Y.Z-store-assets.zip`. The Firefox ZIP is unsigned, so users install Firefox from AMO.

All jobs use Ubuntu 26.04. Actions are pinned to complete hashes and Dependabot maintains Bun dependencies and GitHub Actions. Bun's toolchain version comes from packageManager; installs use the frozen text lockfile. Repository contents access is read-only except the final release job's contents:write permission. Only CD jobs and their reusable-workflow callers receive id-token:write for federated authentication. Checkout retains no Git credentials; publishing secrets never enter PR jobs. Every job has a timeout. Release submissions are serialized and never automatically cancelled. GitHub concurrency retains only one running and one pending run, so avoid pushing a burst of release tags.

## Agent-owned store package

The public brand is Syllune. Its original vector identity is in `assets/brand/syllune.svg`, with toolbar/store PNGs in `public/icons/` and `store/assets/`. The package has promotional tiles, a real selection-reading capture and English/Czech voice-page screenshots. `store/listing.md` contains listing copy, launch drafts, positioning evidence, permission explanations, links and reviewer notes; `PRIVACY.md` supplies the public policy. `bun run package:store` validates dimensions and bundles these materials. CI and every successful release attach this package automatically. Keep the permanent extension IDs, storage keys and `read-aloud` archive filenames stable. Assets contain no downloaded voice models or bundled previews.

Regenerate artwork/screenshots with `bun run assets:store` after a Chrome build. It renders original SVG/HTML and captures the production catalog before downloading anything. The selection-reading capture uses a separate disposable extension/profile, explicitly downloads LJSpeech medium and runs real local synthesis. Only that test copy has a localhost permission grant and audio/error observation. Scripted background entry does not prove native context-menu activation; the screenshot is not listening-quality or performance evidence. No samples are streamed and no playback/highlight state is fabricated. `bun run assets:store --brand-only` regenerates only icons and promotional tiles, with no model download. For an icon change, regenerate brand assets, rebuild Chrome, then run the full capture so the catalog shows the current icon. Rebuild both browser packages before packaging. Only toolbar icons ship in the installed extension; promotional assets remain in the store package.

The reading capture needs working browser audio output. This Linux VM uses `scripts/with-test-audio.ts` with the documented PulseAudio fixture. Its Unix socket path must fit the platform limit. In a long worktree path, invoke the same helper from a short checkout while keeping the child command's working directory in the worktree. Use the direct geckodriver binary rather than its Snap launcher when Snap cannot write a profile below the hidden worktree directory.

When updating store artwork, replace the existing stores' icon and screenshots using the supplied package, with `reading-selection.png` first. The current AMO publisher retains uploaded icons and existing screenshot positions; changing repository image files does not replace those server-side bytes. Do not claim the stores show Syllune's artwork until their listings are checked. Store changes need separate authorization; repository edits do not publish them.

## One-time account integration

Chrome now has a draft store item and configured publishing identity; federation and WXT credential validation passed on 2026-11-05. Firefox account/API credentials also passed GET-only authentication on 2026-11-05. WXT 0.21.5's publisher already uses AMO V5 but only supports existing listings. Our Firefox path uses Mozilla's `web-ext` 10.8.0 exported submission client under Bun, which supports creating the listing and updating it by the same permanent GUID. Account registration, publisher verification and terms acceptance still belong to the actual account holder. No manual first Firefox upload is required.

Use the permanent Firefox ID `read-aloud@fidasek009.github.io` (the default in WXT). Keep this ID for the initial AMO submission and every update; an existing registered ID may instead be supplied through repository variable FIREFOX_EXTENSION_ID. Protect main with required CI/review rules and protect v* tags against updates/deletion, allowing creation only by release maintainers. The `stores` environment must allow the protected default branch for dry-runs and version tags for publication. Required environment reviewers are optional, not built-in release steps.

| Scope | Name | Value |
| --- | --- | --- |
| Repository variable | `CHROME_EXTENSION_ID` | Existing Chrome store item ID |
| Repository variable | `CHROME_PUBLISHER_ID` | Publisher ID from Publisher → Settings |
| Repository variable | `FIREFOX_EXTENSION_ID` | Permanent manifest/AMO ID; use the default above for first submission |
| Repository variable | `CHROME_SERVICE_ACCOUNT_EMAIL` | Dedicated authorized service-account email |
| Repository variable | `CHROME_WORKLOAD_IDENTITY_PROVIDER` | Full projects/NUMBER/locations/global/workloadIdentityPools/POOL/providers/PROVIDER resource name |
| `stores` environment secret | `FIREFOX_JWT_ISSUER` | AMO API issuer/key |
| `stores` environment secret | `FIREFOX_JWT_SECRET` | AMO API secret |

Follow [Chrome federation setup](chrome-publishing-setup.md) and [Firefox credentials and first-listing automation](firefox-publishing-setup.md). No downloaded Google private key, Chrome secret, OAuth client or saved access token is needed. Each Chrome preflight/publication job obtains its own 30-minute Web Store-scoped access token immediately before using WXT. The auth action creates no credential file and exports no global credentials. Firefox secrets are entered through GitHub, never committed or printed. The source archive uses an explicit allowlist and excludes .env files.

The first live Firefox release created the listing and consumed version 0.1.1. Subsequent releases use higher tags and retain the same GUID. Do not reuse an uploaded version. Accounts, review, and store-required publisher identity declarations are not bypassed by having a CI pipeline.

## Acceptance and retries

AMO metadata requests honor `Retry-After` on HTTP 429, with at most five retries and a shared 75-minute deadline inside a 90-minute publishing job. Writes are spaced by 21 seconds, and metadata starts outside Mozilla's submission client's burst window. Unchanged listing fields, privacy policy, uploaded icon and completed screenshot captions are retained. Other failed writes are not blindly retried, and existing screenshot positions are reused so reruns do not add duplicates. These limits follow Mozilla's [submission throttle implementation](https://github.com/mozilla/addons-server/blob/master/src/olympia/api/throttling.py), checked 2026-11-06 (three writes per minute, ten per hour, twenty-four per day; production settings may change).

`bun run check:licenses` checks required notices, pinned source archive/build-recipe checksums and dependency/source version alignment. It runs in CI and standalone live publishers. Package checks verify the installed license links. There is no review JSON, routine source-file hash refresh or separate release mode. Remaining model/output assessments remain in [the licensing checklist](licensing.md); simplifying automation does not clear them or certify release readiness. Corresponding-source materials and notices are supplied, including the exact Kasandra medium grant and attribution. The agent remains responsible for addressing applicable license conditions and the separate Windows, GPU/CPU and real-browser acceptance in [feasibility status](feasibility-status.md) before publication. The owner waived performance as a first-release blocker on 2026-11-06; keep measured limitations documented and optimize afterward. Original previews are separately hosted and fetched only on Listen; see voice-previews/README.md. Use Store check for credential testing.

Stores and GitHub cannot commit an atomic transaction. If one store accepts and the other fails, the accepted submission remains and GitHub release publication is withheld. Repair the accepted submission in the store dashboard instead of repeating it, then publish the withheld release from that run's original artifacts (CI keeps them for 14 days) and keep existing tags and published artifacts immutable. Code fixes get a higher tag.

Firefox's submission client uploads the ZIP, waits for validation, creates the version, then attaches sources. Listing/privacy/artwork updates follow. A source or metadata failure fails CD and withholds the GitHub release, but cannot undo a version AMO has already accepted. Repair that version in the AMO dashboard rather than resubmitting it; Firefox submission is not claimed to be idempotent. Approval/signing is asynchronous: the job does not wait for review or download a signed XPI. Existing screenshots are retained at their assigned positions; the agent updates them when the UI changes.

The GitHub release job is independently retryable. It reuses an existing draft, replaces draft assets and publishes last. If publication succeeded despite a lost response, a retry compares existing public asset bytes and adds only missing assets. It never overwrites different published bytes or regenerates notes on every retry. Tests simulate draft/upload/publication-response failures and preservation of immutable public assets.

## Verification and primary references

`bun run typecheck`, `bun run format:check`, `bun run test`, `bun run lint:workflows`, both ZIP builds, `bun run check:source-rebuild`, and `bun run package:store` are the relevant checks. Workflow linting downloads a pinned, SHA-256-verified actionlint release on Linux x64. Reviewer reproduction exports the version shown in the submitted manifest; see `SOURCE_CODE_REVIEW.md`. File bytes, not ZIP timestamps/compression metadata, are compared. Store authentication is verified by the manual Store check workflow; dated results are kept in `docs/evidence/`.

- [WXT publishing and first-time limitations](https://wxt.dev/guide/essentials/publishing.html)
- [WXT version template semantics](https://wxt.dev/guide/resources/upgrading)
- [Chrome service-account integration](https://developer.chrome.com/docs/webstore/service-accounts)
- [Google federation setup for deployment pipelines](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines)
- [Open-source extension pipeline comparison, checked 2026-11-05](release-pipeline-references.md)
- [Chrome store imagery](https://developer.chrome.com/docs/webstore/images)
- [Chrome manifest version constraints](https://developer.chrome.com/docs/extensions/reference/manifest/version)
- [Firefox submissions and reviewer sources](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/)
- [Mozilla's supported automated initial submissions and updates](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)
- [AMO V5 create-or-update by GUID](https://mozilla.github.io/addons-server/topics/api/addons.html#put-create-or-edit)
- [GitHub Actions security](https://docs.github.com/en/actions/reference/security/secure-use)
- [Bun comment-preserving whitespace minification](https://bun.com/docs/bundler/minifier)
