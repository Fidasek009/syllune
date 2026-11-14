# Product brief

Started **2026-10-29**, updated **2026-11-13**. Product answers below are confirmed by the user. The current implementation and open acceptance gates are described in [engineering](engineering.md) and [status](feasibility-status.md).

## Confirmed experience

A brutally simple, premium Firefox and Chrome extension for Windows and Linux. It reads web articles, selected text, and the user's PDF benchmark, entirely inside the browser extension with no separate helper application. US English and Czech are mandatory; expose all additional languages that the vetted models/runtime support.

## Marketing direction

Lead with a distinct Syllune identity, offline speech and a premium listening experience. Use the unslop skill for all writing.

The implementation uses **Syllune** as the public brand and **Syllune: Offline Text to Speech** as its store title. This name and the orange S artwork are implementation choices under that direction, not a claim that the owner selected the name or that trademark clearance is complete. The repository is `Fidasek009/syllune`. Public copy must omit obsolete product names and naming history. Keep permanent extension IDs, storage keys and release archive names unchanged.

Lead with **Natural-sounding voices. On your computer.** The owner explicitly confirmed that voice naturalness must appear in the marketing, beside offline speech. Use it in the headline, opening description and promotional artwork. "Computer" reflects the desktop target; supporting copy must state that speech works offline after an explicit voice download and reading text never goes to a speech service. Make voice quality audible through samples from the same voice models and local engine used for reading. Show the actual playback bar and word highlighting. "Natural-sounding" is a product description, not a ranking; no comparative listening study currently supports "most natural sounding" or calling competitors robotic. Quality still varies by model, and listening acceptance remains separate. Premium means fewer interruptions and clear controls, not a paid tier or more settings. The [store materials](../store/listing.md) record positioning evidence, launch copy and promotion constraints.

## Reading behavior

The primary flow is **select text → right-click → read the selection nearly instantly**. Reading only that selection is the defined behavior; continuing into the rest of the article would be a different action. Article reading is available from the browser action or page context menu.

The user considers Piper's medium-quality voices decent and values choosing a lower-quality model for better speed. They dislike missing highlighting, broken model deletion, and playback speed changes that raise voice pitch. A pitch-preserving speed slider is mandatory.

The user explicitly selected a playback bar, word-by-word highlighting, and automatic scrolling. **These are first-release requirements**, superseding their earlier optional-highlighting preference. Follow Edge closely, with play/pause, previous/next sentence, speed, volume, close/stop, and voice choice in the same surface. Sentence clicking is excluded from the first release.

The latest clarification is authoritative: **continue on tab switch; stop on source-page navigation or source-tab closure**. This supersedes the user's earlier continue-everywhere answer. The visible surface is a small in-page playback bar. Playback must be independent of toolbar-popup lifetime, but stopped sessions must not be restarted by late inference results.

## Model ownership and setup

- No automatic model downloads. The user must consciously choose a model and start its download.
- Download size itself does not constrain the design; explain the actual size before downloading.
- Installed models must be removable through a reliable, simple action.
- Users must be able to audition voices through on-demand prerecorded samples without downloading the whole model. Keep previews out of the extension package to minimize its size; never prefetch them.
- Model selection and management are justified product UI. Avoid exposing engine names, execution providers, worker counts, and other implementation settings.
- Reading is local/offline once its model and required assets are installed. A deliberate preview may need network access if its sample is not cached; this must never send the selected/page text to a server.

## Supported machines and licensing

- Windows and Linux; Firefox and Chrome are equally important.
- Baseline: 4 CPU cores, 8 GB RAM.
- Optional GPU: 4 GB VRAM. CPU-only operation must be usable.
- Original application source: MIT, open source. Audit third-party executable code, model weights, datasets, and preview assets independently before distribution.
- Separately licensed dependencies may be considered; explain their obligations before choosing them. Do not represent bundled GPL code or separately licensed model weights as MIT.
- Public Chrome Web Store and listed Firefox AMO distribution are confirmed (2026-11-05). No monetization or account system is requested.

## Confirmed engineering direction

- WXT following its official extension project structure, with explicit Manifest V3 builds for Firefox and Chrome.
- Strict TypeScript for first-party application, worker, and tooling code.
- Bun throughout: runtime, package management, tests, native type checking/formatting, and standalone bundling. Run WXT under Bun; no project Node runtime requirement or npm toolchain.
- Bun configuration follows the user's `~/projects/talqo/bunfig.toml` preferences: isolated/global-store installs, a one-day minimum release age, and tabs/double quotes/no semicolons with import sorting. Ignore patterns are adapted to this repository.

## Mandatory first-release reading benchmarks

- Easy: <https://filipkrasa.salonek.org/projects/md-dash/>
- Medium: <https://artificialanalysis.ai/articles/artificial-analysis-intelligence-index-v5>
- Hard: <https://is.muni.cz/th/wdhgd/bc.pdf>

All three must work in the first release; the PDF is not deferred. Define extraction order, selected-text behavior, sentence navigation, word highlighting, and auto-scroll for each. Do not mark a benchmark passed merely because its URL fetches or some text is extracted.

Initial inspection: both HTML benchmarks provide a `main` element in their server responses. The PDF URL returned an HTML JavaScript interstitial to the command-line fetch on 2026-10-29, not PDF bytes. Browser-context access and an integrated PDF text/rendering path must be investigated. These are observations, not passed reading tests.

## Minimal interface

One selection context-menu action and one compact, Edge-like playback bar containing all confirmed controls. Keep voice choice in the bar. Provide explicit model downloads, preview, and delete through a small secondary view reachable from that choice, without turning playback into a model-management dashboard.

Do not auto-install a default voice. If reading is invoked without a suitable installed model, show the shortest clear path to selecting/downloading one. Once ready, remember the user's chosen voice and speed locally. Compute backend selection is automatic.

Word highlighting requires a proven timing and live-text mapping strategy. Auto-scroll should follow playback without fighting deliberate user scrolling. No sentence-click interaction.

The user likes the idea of multiple workers. Treat this as architectural interest, not a requirement for a worker count or a setting: test one synthesis worker plus bounded read-ahead first, and measure any additional workers against CPU contention, model-memory duplication, and the 4-core/8-GB baseline.

## Remaining questions

1. What extraction behavior is expected for captions, citations, headers/footers, bibliography, tables, and formulas in the thesis PDF? Correct reading order and no dropped prose remain fundamental.
2. What playback-speed range does the user actually need? Performance must be measured at those speeds.
3. Should model deletion stop an active reading session using that model? The current implementation invalidates the loaded model.
4. Public Chrome Web Store/listed AMO distribution is confirmed; private-browsing behavior remains open.
5. Is offline reading after deliberate provisioning sufficient, or must models also be provisionable without internet access?

Previously asked questions on setup, reading scope, hardware, downloads, Piper's UX, languages, original-source licensing, playback controls, highlighting, auto-scroll, session continuity, and sentence clicking are answered and should not be repeated.

## Immediate work

1. Track cold startup and PDF readiness against the 1-second warm / 2-second cold optimization goal. On 2026-11-06 the owner explicitly waived performance as a first-release blocker; retain measured limitations without delaying that release for the latency goal.
2. Validate CPU fallback, GPU inference, Windows, voice quality, pitch, accessibility, and complete benchmark reading behavior.
3. Resolve licensing and distribution obligations for the extension's dependencies and voices.

## Product-owner feedback — 2026-10-30

- Keep the speed control visibly distinct from a playback timeline. Compact, familiar playback icons with accessible names are appropriate. The original request to retain explicit Download/Delete text was superseded by the owner's 2026-11-10 request for icon-only download/delete and listen/pause buttons. Voice actions use tooltips, voice-specific accessible names and visible focus. Delete stays red.
- Expose the entire available model catalog and its quality variants at launch, not just US-English/Czech samples. Do not equate catalog inclusion with working phonemizer support or license clearance.
- The in-page bar must not add overscroll space. Repeated toolbar activation should reveal existing controls without creating another overlay or changing the reading position. Voices/settings are accessible from the bar; the browser's Options entry remains acceptable.
- Fix Previous on the actual MD Dash article, not just prose fixtures.
- The reported PDF failure is the MUNI thesis in latest-stable Zen. The user's test machine has a 20-core CPU and an 8-GB-VRAM GPU, using the US medium voice. Those are diagnostic details, not replacements for the 4-core/8-GB baseline. The precise Zen version and GPU model are unknown.
- The agent owns implementation decisions and may refactor first-party code autonomously. The user is the product owner; keep the agreed requirements intact and report evidence honestly.

## Voice-list filters — 2026-10-30

Provide separate, visible **Language** and **Quality** dropdowns alongside search. All three filters combine; default to all languages and qualities. Quality choices are Extra low, Low, Medium, and High. Keep filtering entirely local and show clear feedback for an empty result.

Per-model license information belongs behind a compact **License** link. Keep full URLs and extended provenance text out of the model cards.

## Playback readiness — 2026-10-30

An empty or disabled playback bar is not an acceptable setup screen. With no usable downloaded voice, show only a compact explanation, **Choose a voice**, and Close. Once a voice is available, show the compact playback controls with a populated voice choice. Routine Reading/Paused status belongs in accessible announcements, not a permanent second row; show visible feedback when preparation, a playback gesture, or an error needs attention. Size the embedded surface to its actual content, including narrow layouts and dark mode.

## Slow and failed voice downloads — 2026-10-30

A progressing download must not stop merely because it takes a long time. Report stalls and network failures on the affected model card, keep the error visible through filtering, and let the user retry explicitly. Distinguish cancellation from failure. Partial or unverified files must never appear installed.

## Play respects the current selection — 2026-10-30

If text is selected when the user presses Play in the existing overlay, read only that selection, replacing the previous article or selection. Preserve exact selection boundaries and highlighting on web pages and in our PDF reader. With no fresh selection, resume or replay the current reading scope. Previous/next and playback completion stay within that scope. Pause keeps its usual behavior.

Preserve meaningful dots in domains such as `consensus.app`, where “dot” should be spoken. Sentence-ending periods should remain natural pauses. Correct PDF whitespace mapping rather than stripping periods or inserting spaces indiscriminately after them.


## Reading polish and recovery — 2026-11-01

- Shorten redundant language-region labels. Preserve the region when it distinguishes available catalog locales, including English. Keep the overlay voice picker compact.
- Include volume in the listening controls with a clear hierarchy. Reveal its native slider from a speaker button; persist the setting and apply it to playback without changing speech or pitch.
- Speed and volume should use consistent floating adjustments, keeping the playback bar compact. Download/delete completion needs no separate success message anywhere: the card's button/progress is the feedback. Keep failures beside the affected card. A failed or closed reader must accept a fresh selection without reloading the source page.
- Join explicitly line-hyphenated words such as `in-\nfrastructure`, preserving real compounds such as `pre-exascale` and domain dots. Highlight all printed fragments of the spoken word.
- Prevent avoidable phonemizer annotation failures. For source-specific pronunciation failures, isolate the problematic passage, preserve usable speech, and tell the user if any text was skipped. Cancellation and runtime failures must remain distinguishable from content failures.

## Release ownership confirmed 2026-11-05

The product owner does not create artwork, screenshots, listing copy, privacy materials or build packages. The implementation agent owns these and routine release engineering. A pushed vX.Y.Z tag is the sole release-version authority and triggers automated CI, store publication submissions and GitHub release publication. No package-version bump or separate manual ready toggle is required. Public Chrome Web Store and listed Firefox AMO distribution are selected. Account/credential access, store review and the recorded product/license acceptance obligations remain external constraints; the agent must report their actual state without shifting design or engineering tasks back to the product owner.

## Catalog-wide management confirmed 2026-11-06

The managed product scope is the full voice catalog: currently 178 models across 53 languages, including all quality variants. There is no two-model delivery requirement or separate English/Czech implementation path. Use one catalog-driven workflow for model management, original preview generation, provenance, and coverage reporting. English and Czech remain mandatory language coverage, not a limit on the catalog. Original previews play inside the extension and are hosted separately; no third-party contact is authorized. Runtime limitations and unresolved model/output terms must remain explicit per model.

## Catalog availability confirmed 2026-11-06

Manage all upstream candidates through one catalog workflow, but offer only models compatible with the current runtime. Exclude unsupported pronunciation engines and demonstrated model/runtime incompatibilities from download and reading choices. Diagnose and fix our own integration errors before excluding models. Retain unavailable metadata for maintenance and allow deletion of older downloads. The current inventory is 178 upstream candidates with 171 available models; seven need unsupported engines. Runtime compatibility does not establish license or acoustic-quality acceptance. See [the compatibility correction](piper-compatibility-2026-11-06.md).

### Live playback speed (2026-11-14)

Speed changes apply to generated audio while it plays. Generate reading clips at normal model speed, retain buffered clips, and update active and preloaded media elements as the slider moves. Keep pitch preservation enabled. Highlighting uses the media position in the original clip, so changing speed does not require retiming word boundaries. Voice changes still restart synthesis.

This supersedes the preference for model duration control when changing reading speed. Browser pitch preservation is defined in the [HTML media specification](https://html.spec.whatwg.org/multipage/media.html#dom-media-preservespitch). Controller regression tests cover changes while playing, paused and generating; listening quality and underruns at faster speeds still need representative hardware measurements.
