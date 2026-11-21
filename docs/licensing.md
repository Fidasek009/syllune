# Licenses and release checklist

Updated **2026-11-11**. Original Syllune source and artwork are **MIT**. Third-party components retain their own terms. This document is the current checklist; the supporting inventories are reference evidence, not another approval process.

## What we distribute

| Component | Terms | What we supply |
| --- | --- | --- |
| Original code and artwork | MIT | Copyright and license text |
| Spellophone 0.2.1 / eSpeak NG 1.52.0 | GPL-3.0-or-later, plus component notices | Full pinned sources, build instructions, notices and recipient source access; the combined extension is GPL-covered |
| ONNX Runtime 1.31.1 / WXT runtime 0.21.5 | MIT and upstream notices | License/copyright notices and pinned source directions |
| PDF.js 6.5.438 / ONNX schema | Apache-2.0 and component notices | License texts, font/decoder/runtime notices and pinned source directions |
| Compiler/runtime code embedded in WASM | Component-specific terms | Emscripten, musl, libc++, Rust and other applicable texts and source directions |

Original files remain MIT; the combined package must not be described as MIT-only. Mozilla's listing uses a custom license containing the MIT/GPL texts and notices. web-ext is MPL-2.0 development/publishing tooling, not shipped extension code.

## Release checklist

- Preserve the license/copyright and modification notices in [NOTICE.md](../NOTICE.md) and the installed notices page.
- Keep the [pinned archives and supplier build recipes](../vendor/source/README.md) and [public source-access directions](../vendor/source/SOURCE-ACCESS.md) available to recipients at the release tag. Private AMO reviewer sources alone are insufficient.
- When shipped dependencies change, update their notices, source versions and build materials together.
- Assess model/preview conditions for the actual integration described below. Do not claim unrestricted rights for the whole catalog.

Run **bun run check:licenses** to verify the required files, source/archive checksums and dependency/source version alignment. CI runs it, and standalone live publishers run it before publishing. Package checks also verify that the installed notices page and its linked local license texts are included. Routine application/documentation edits require no hash refresh or approval label. There is no separate release mode, review JSON or owner-operated ready switch.

This automated check verifies supplied materials. It does not grant permission, decide model terms or establish product/store acceptance. There is no blanket model/preview approval record to maintain.

## Models and previews: exact scope and open questions

No model weights, training recordings or preview audio are bundled. Model weights remain on their source host and download only when you press a voice's download icon. Syllune hosts its own preview recordings separately; a voice's play icon streams only its recording. Syllune exposes word timings and merges duplicate operations in the local ONNX graph while preserving the original weights. Each catalog entry links its pinned model card.

**Established grants:** the [public-source model review](model-permissions-2026-11-06.md) now identifies model-level terms for 14 variants across English, Czech, Swedish, Ukrainian and Urdu. All three Ukrainian high-quality author-hosted files match our exact pinned SHA-256 values. LJSpeech medium has an [original-trainer public-domain model grant](https://brycebeattie.com/files/tts/). Kasandra medium has an owner-issued **CC BY 4.0** grant from Ondřej Šimek in [Piper PR #93](https://huggingface.co/rhasspy/piper-voices/discussions/93), tied to our exact checkpoint (SHA-256 09d08aa23691ed2d53fb3db242cfe82b189adf9c1812dd5fe928b5789ed76df7). Its author/source/license credit and graph-change notice are supplied. The separate paid-package README does not revoke that grant. The new review does not reduce the available catalog or establish blanket permission for it.

**Upstream sample dependency removed:** all 171 available models now have original Syllune recordings of our own native-language passages. The files and provenance are hosted on the repository's [voice-previews branch](https://github.com/Fidasek009/syllune/tree/voice-previews); production URLs pin the published commit. No Piper Samples recording or Wikipedia passage is played, copied or rehosted. The previous question about permission to stream those upstream samples no longer applies to the current integration. Original texts and our contributions are MIT; we do not claim to relicense underlying models.

**Remaining model assessment:** Jirka/other Lessac-fine-tuned checkpoints have unresolved grant/lineage scope; some catalog cards declare unknown or absent model terms. Applicable model/output restrictions and attribution/change conditions still need individual assessment. A dataset license is not automatically a model grant, and a training contract does not automatically apply to resulting weights. Creating original recordings removes the upstream-recording/transcript dependency; it does not answer every underlying model/output question.

[Public-source follow-up](preview-model-research-2026-11-05.md) records the private CC BY modification/attribution distinction. The [original preview collection](../voice-previews/README.md) uses one catalog-driven generation and delivery path. The 171 recordings match every available model; seven unsupported engines remain excluded. Playback stays inside the extension and audio stays outside its package.

These are specific evidence questions, not established findings that all models or previews are unlawful. No third party has been contacted, and contacting one is not a required workflow step. Known restrictions must be respected; uncertain scope must be assessed without inventing either a grant or a prohibition. Product acceptance remains tracked separately in [feasibility status](feasibility-status.md).

## Supporting evidence and primary terms

- [Catalog and preview facts](catalog-and-preview-scope.md), including the [178-card inventory](evidence/catalog-license-inventory-2026-11-05.json).
- [Runtime/license audit](evidence/license-audit-2026-11-05.json), [source-access evidence](evidence/source-access-2026-11-05.json) and [source provenance](../vendor/source/provenance.json). Supplier native rebuild/attestation limits remain recorded; source delivery does not universally require byte-identical compiler output.
- [GPLv3 sections 1 and 4–6](https://www.gnu.org/licenses/gpl-3.0.html), [CC BY 4.0 conditions](https://creativecommons.org/licenses/by/4.0/legalcode.en).
- [Chrome developer agreement](https://developer.chrome.com/docs/webstore/program-policies/terms) and [Mozilla distribution agreement](https://extensionworkshop.com/documentation/publish/firefox-add-on-distribution-agreement/): appropriate rights are required; our former JSON/hash approval process was not. Recheck applicable store terms before submission; Mozilla's announced December 1, 2026 changes are not yet effective on this review date.
