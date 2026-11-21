# Catalog and preview scope

Updated **2026-11-11**. This is the factual scope of our integration and remaining model questions, not a declaration that all hosted files are unrestricted or that every uncertainty proves a violation.

## What is and is not conveyed

The extension/release archives contain the speech runtime, pronunciation data, first-party code and pinned discovery/configuration metadata. They do **not** contain Piper voice weights, training recordings or prerecorded preview audio. The extension makes no model request until you press a voice's download icon and no audio-sample request until you press its play icon. Models come from their pinned upstream host; original previews come from this repository's separate `voice-previews` branch, pinned by commit. No reading text or synthesized reading audio is sent to either host.

This distinction matters: GPL source duties for our shipped runtime are actual distributor duties. It would be incorrect to describe all upstream model/recording/sample files as bundled components, or to infer that permission to redistribute weights is required for an archive that does not redistribute them. Equally, direct hosting does not establish that every intended use, local modification, generated output or later redistribution is permitted.

The user-facing catalog links each exact pinned model card through its License link before download. The voice-page footer states that models have separate licenses and samples stream when you press a voice's play icon. Those links are source information, not a grant from Syllune. Syllune exposes acoustic durations and merges duplicate operations in the local ONNX graph while preserving the original weights. Where applicable, attribution and change disclosure still need to be respected. Kasandra's owner/source/license/change notice is supplied in the installed notices page; its exact owner-issued grant is independently substantiated in the main audit.

## Complete metadata inventory

[The pinned inventory](evidence/catalog-license-inventory-2026-11-05.json) records every one of the **178 MODEL_CARD files**, their HTTP result and content hash, model checkpoint identity, author/license fields, explicit License sections and relevant training statements. All 178 cards were retrieved successfully. It also fingerprints 177 per-voice sample.txt files. Lithuanian ingute has no preview path in our catalog; no missing preview was invented. No model weights or audio were downloaded for this audit.

A heading/field parser is not a license decision. For example, Polish bass declares Apache-2.0 in a License section, while Swedish alma expressly describes its model weights as CC BY 4.0; neither should be mislabeled "no license" merely because it lacks a `License:` field. Conversely, a license under a Dataset heading does not independently prove the model's grant or the original trainer's authority.

The cards report CC0/public-domain, CC BY, share-alike, noncommercial, Apache, GPL/AGPL, OpenRAIL, referenced external terms, and unknown statements. In particular, four cards literally report Unknown; ald x-low and Swedish lisa have neither a License field nor License section. That describes missing evidence, not a court finding. Jirka and other Lessac-fine-tuned checkpoints retain the specific lineage questions described in the main audit. For locally downloaded copyleft models, private use/local modification must not be conflated with later conveying them or running a network service; we do not claim a blanket model/software license conflict merely from a GPL/AGPL label.

The inventory completes the factual catalog pass. Open work is now narrower: establish the scope of the owner grants where labels/lineage are ambiguous, and finish the distributor-versus-recipient and attribution/change-disclosure assessment for the offered flow. No language or voice was removed to hide that work; there is no claim of unrestricted commercial rights for the entire catalog.

## Original preview delivery

All 171 available models use Syllune's own locally synthesized recordings and original native-language passages. The [delivery collection](https://github.com/Fidasek009/syllune/tree/voice-previews) includes exact audio/model/config hashes, source text, speaker zero, speed and renderer provenance. The extension uses one commit-pinned URL per model, requests it only when you press the voice's play icon and never downloads a voice model for auditioning. No preview audio enters the extension or AMO reviewer archive.

The former Piper Samples/Wikipedia integration is removed, including its URLs, discovery lookup and installed transcript attribution. The dated 2026-11-05 metadata inventory remains historical evidence of that earlier integration. No permission to copy or stream those upstream recordings is needed by the replacement path. Original contributions are MIT; applicable model/output terms remain separate.

## Release review

The [licensing checklist](licensing.md) separates supplied notices/source materials from remaining model/lineage and output assessments. CI verifies the materials directly; there is no separate hash-bound approval record. Those questions are not established findings of illegality, and passing material checks does not resolve them. No third-party contact is planned.
