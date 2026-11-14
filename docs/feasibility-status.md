# Implementation and acceptance status

The extension is implemented; product acceptance is **not complete**. The evidence and outstanding acceptance work are recorded below.

## Implemented

- WXT Manifest V3 packages, strict TypeScript, and Bun-only installs, builds, native checks, formatting, and tests.
- Explicit voice download, hash verification, cancellation, deletion, and on-demand remote prerecorded previews. No voice model is included in the package or downloaded on startup.
- Selection/article capture with DOM offsets, an in-page playback bar, sentence controls, voice choice, pitch-preserving playback speed control, acoustic word timing, highlighting, and scrolling.
- Browser-local Piper inference with Spellophone/eSpeak NG phonemes, separate GPU/CPU workers, and CPU retry after an acceleration failure. A reusable extension-owned host preserves a loaded model across reader lifetimes; Chrome uses an isolated offscreen document, Firefox its background page. The pinned catalog contains 178 models across 58 locale codes, including quality variants and multispeaker models. Seven require missing pronunciation engines and are visibly unavailable. Supported-format models still need broad inference/quality/license acceptance; catalog inclusion is not clearance.
- A new-tab PDF reader using bundled PDF.js, keeping the original tab. Visible page canvases are bounded; text layers are created as needed, including when playback highlights a distant page. Selection matching preserves source offsets and refuses ambiguous/missing matches instead of reading the whole PDF.

## Verification in this environment

The Chrome product probe exercises explicit download, storage, local synthesis, source-word highlighting, pause, close, deletion, selection recovery, and PDF/word mapping. Programmatic entry required a trusted Play gesture. The Firefox product probe passes the equivalent Czech flow with a private virtual audio sink and normal autoplay settings. This VM has no hardware audio output; without the sink Firefox's audio clock remained at zero. The sink is test infrastructure, not an end-user helper.

Product probes use isolated profiles and narrow test-only origin grants (localhost plus MD Dash or MUNI as appropriate). They **do not prove native context-menu/action activation or activeTab behavior**. No product reading text is logged.

Separate [native entry probes](native-entry-2026-11-06.md) now pass in Chrome 156 and Firefox 159 with the production permissions and default autoplay policy. Fresh profiles for English and Czech used the actual browser-owned Read selection menu, started native audio without a second Play click, and preserved the exact selected scope. These tests use no source-origin grant or simulated extension listener. Their Linux/audio-fixture limits are recorded with the evidence.

The supplied thesis has been fetched from the live MUNI URL in browser tests with an explicit test-origin grant: **60 pages**, SHA-256 `30b7977a1a52b029a691ad75b4b425162cf3570f5c94de9858ece7464f494c32`. The PDF probes verify missing-site-access recovery, fetching without CORS, mapping, highlighting, and cross-page local synthesis; product probes also exercise playback from a simulated native-viewer selection. They do not prove native menu activation, every paragraph's reading order, tables, citations, or accessibility.

Local checks on 2026-11-10 used the Syllune-branded packages and a private virtual audio sink. The full Chrome product probe passed. Firefox passed Czech download/synthesis, word highlighting, keyboard/media controls, speed/volume focus, recovery, close and deletion, then failed while the PDF probe tried to highlight the thesis range at offsets 2120 to 3600. This failure is undiagnosed; fixture readiness and product behavior have not been distinguished. Do not report a complete Firefox probe pass. The store reading capture uses a foreground Chrome tab, a localhost-only test grant and scripted background entry. It verifies real audio-clock movement and word highlighting, not native activation, voice quality or an offline-disconnection test.

The 2026-11-10 catalog preview sweep did not finish. Repeated `net::ERR_NETWORK_CHANGED` failures stopped playback of `eu_ES-maider-medium`, including its explicit retry. Focused preview play/stop and download/cancel checks passed; this run does not establish complete catalog preview coverage. The earlier 2026-11-06 delivery evidence remains a separate dated result.

The 2026-11-11 review follow-up checked loading icons in a real Chrome page with `audio.play()` held pending at the media boundary. Light/dark 320px layouts retained focus and 44px targets; the spinner animated only without a reduced-motion preference. A PDF text-layer style fixture resolved the shared orange selection color. These are UI checks, not audio-playback evidence. The updated capture script now requires visible playback, but a fresh capture stopped at a failed voice download; the full artwork generator also timed out. The existing screenshot is retained. Both builds and all 162 tests passed on sequential runs; an earlier concurrent run hit the download test's idle timeout and a runtime-preparation build failure. Complete Firefox and catalog-preview checks were not rerun.

## Acceptance still open

- **Performance follow-up, waived for the first release:** on 2026-11-06 the owner explicitly removed performance as a first-release blocker. The **1 second warm / 2 seconds cold** medium-model goal remains an optimization target. Measured cold startup exceeds it; do not claim that target has passed.
- **All three benchmarks:** MD Dash now passes actual-page sentence navigation, including Previous after several Next operations. Full listening/extraction acceptance on both HTML articles and the complete thesis remains open.
- **Lifecycle:** verify tab switching, navigation/closure, cross-tab replacement, interrupted model loading, speed/voice changes, source mutations, and stale-work cancellation. Implemented handlers alone are insufficient evidence.
- **GPU/CPU and platforms:** no physical GPU or Windows machine has been tested. Verify GPU correctness, device loss, CPU fallback, memory, and the 4-core/8-GB baseline.
- **Speech and catalog:** listen to speed/quality variants, validate pitch, test normalized numbers/abbreviations and mixed scripts, and clear additional supported languages/voice variants. The catalog-wide CPU run exposed 18 failures in our own pronunciation adapter; all now synthesize after [correcting the adapter](piper-compatibility-2026-11-06.md). Seven models still need unsupported pronunciation engines. Synthesis evidence for tested passages does not establish acoustic quality, exact word alignment or target-device acceptance.
- **UI/accessibility:** visual checks and some keyboard interaction exist; complete keyboard, focus, contrast, assistive-technology, responsive layout, and recovery checks remain.
- **Licensing/distribution:** original source remains MIT. Spellophone/eSpeak NG impose GPL obligations on the combined distribution; pinned source materials, source-access directions and notices are supplied. Own recordings replace upstream samples; model grant/lineage and applicable output terms remain separate assessments. See [licensing.md](licensing.md) and [NOTICE.md](../NOTICE.md); passing the materials check does not resolve these questions.

Keep these gates open until evidence covers the actual requirement. Do not equate a build, a scripted smoke test, or a rendered PDF with the finished product.

## Catalog availability — 2026-11-06

The extension offers 171 of the 178 upstream candidates. Seven require unsupported pronunciation engines and remain excluded from new downloads and reading choices. Their metadata remains for maintenance and deletion of existing downloads. The 18 pronunciation-map failures came from our adapter and have been corrected; they do not justify excluding those models. Original preview audio remains outside both installed packages and reviewer-source archives.

Verification before the adapter correction reproduced the 18 errors. That established reproducibility, not model damage. The [compatibility evidence](piper-compatibility-2026-11-06.md) records the corrected upstream behavior and subsequent validation scope.

After the correction, the complete Chrome CPU run synthesized all 171 available models across 49 languages with zero failures. Firefox 159.0 synthesized the 18 previously failing voices plus the required English/Czech references. All 171 local recordings passed source/recording identity and numerical signal checks without clipping. The full test, type-check, formatting, workflow-lint and package-validation suite passed, and the reviewer rebuild matched the installed files. No preview audio is bundled. See the [dated results](evidence/piper-compatibility-2026-11-06.json) for test-entry permissions and limitations.

## Original preview delivery — 2026-11-06

All 171 available models now use our own separately hosted recordings and original text. Chrome 156 and Firefox 159 played every recording with advancing audio clocks, no preview prefetch, no model requests and no uncaught script errors. Chrome needed two explicit retries after VM network-change notifications; Firefox needed none. Switching and stop passed in both browsers; Chrome also passed offline recovery. Both packages contain no preview audio, and the reviewer rebuild matches all 380 installed files. Re-running generation reused all 171 recordings without producing new audio. See the [delivery evidence](evidence/original-preview-delivery-2026-11-06.json). The virtual audio sink verifies playback transport; it does not establish physical-device or listening-quality acceptance.
