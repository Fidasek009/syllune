# Known issues

## Opening an already-open local PDF may require choosing the file

Last reviewed: **2026-11-14**.

When Syllune opens its reader for a local PDF, it already knows the file URL and tries to read it directly. Knowing the file's location does not give the extension access to its bytes.

- **Chrome** reads the file directly after **Allow access to file URLs** is enabled on Syllune's extension details page and the one-time file-host grant is accepted. Fresh installs have file access off; the browser exposes no API to turn that setting on, so Syllune cannot show a permission prompt for it. Once the setting is on, the reader offers a one-click grant and later local PDFs open directly.
- **Firefox 153+** has a separate **Access local files on your computer** permission, also off by default. Requesting `file:///*` through `permissions.request()` does not grant it ([Firefox bug 2051082](https://bugzilla.mozilla.org/show_bug.cgi?id=2051082)). Tested Zen builds still blocked direct `fetch` after the permission was granted; that report remains unconfirmed, so direct reading may stay impossible there regardless of the toggle.

When direct reading is blocked, the reader offers a file choice and, in Chrome, a link to Syllune's extension settings where the switch can be enabled once. Changing that switch makes Chrome reload the extension, so reopen the PDF afterward; no browser restart is needed. Afterwards local PDFs open with a single grant click. A chosen file is provided by the browser as a readable `File` object, stays on your device, and is not uploaded. No prompt, manifest entry, or enterprise policy can grant file access up front — force-installed extensions still report `isAllowedFileSchemeAccess()` as false ([Chromium issue 577461554](https://issues.chromium.org/issues/577461554)). Firefox also prevents extensions from injecting code into its built-in PDF viewer, so the document cannot be retrieved through that viewer.

References: [Mozilla file-access issue 2085199](https://bugzilla.mozilla.org/show_bug.cgi?id=2085199), [Firefox PDF-viewer restrictions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts#limitations), [file-picker restrictions](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/file#notes), [Chrome file-access settings](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions#allow-access), and [Chrome `SetAllowFileAccess`](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/extension_util.cc).

## A native-viewer selection can take longer to start deep in a long PDF

Last reviewed: **2026-11-14**.

The browser's PDF viewer gives Syllune the selected text, not the page number or its coordinates. Syllune scans page text with PDF.js until it finds the selection, then renders that page's text layer, slices and normalizes the matched printed span, and opens the player with that same span as both the speech and highlight source. This guarantees that audio starts on the selected page with a working highlight.

If the span cannot be located or its text layer cannot be mapped, playback does not start. The reader shows a recovery message instead of starting audio without highlighting.

The scan follows reading order, so cost grows with the page distance. On the Linux Chromium test machine with a warm voice, a selection on page 400 of a 462-page synthetic PDF opened the player after 2.6 seconds; a page-1 selection opened after 1.0 second. Whole-PDF preparation for the same document took 3.5 seconds. These numbers measure page location and player readiness, not first-audio latency or target hardware.

If the selected text appears more than once, the native handoff reads the first match that does not start or end inside a printed word. Select the passage inside Syllune's reader when the exact occurrence matters; that selection maps directly and is exact.

## Firefox/Zen: first words of a new reading clip can be inaudible

Last reviewed: **2026-11-14**.

Reported on Windows/Zen with Czech voices. Firefox takes noticeably longer to start a new media resource than to continue an existing one, and the player currently creates one media element per reading chunk. The voice output itself is clean.

This remains unresolved. A continuous Web Audio stream feeding one media element avoided the per-chunk starts but failed Firefox 159 native media-control activation, so production playback keeps per-clip elements to preserve OS play/pause controls. No extension-side fix is available at this point.

## Firefox/Zen: CPU speech runs on one WebAssembly thread and has no GPU path

Last reviewed: **2026-11-21**.

Chromium extension pages are cross-origin isolated, so Syllune's speech worker gets `SharedArrayBuffer` and ONNX Runtime's four WebAssembly threads. Firefox extension pages are not cross-origin isolated: `SharedArrayBuffer` is undefined, a worker cannot receive one, and ONNX Runtime falls back to one thread when four are requested. The `cross_origin_embedder_policy` and `cross_origin_opener_policy` manifest values that isolate the Chrome build are ignored by Zen 1.24b (Firefox 159), and extension pages cannot send the COOP/COEP headers that isolation needs. Firefox 159 on Linux also does not expose `navigator.gpu`, so the WebGPU path is unavailable there too.

Syllune compensates by splitting the voice before its vocoder and decoding overlapping latent windows in separate workers, each with one WebAssembly thread. This runs only when the runtime cannot get two threads. Vocoders above 24 MB use up to four workers; smaller ones use two. Encoder and flow work stays on one thread, and every vocoder worker builds its own session, so the first clip pays startup time that later clips do not.

Measured on the Linux test machine with a 48-character first clip: Cori High's first audio fell from 7.6 s to 3.9 s and later clips from 7.4 s to 3.0 s. Cori Medium stayed at 1.8–1.9 s for the first clip and improved from 0.8 s to 0.6 s for later clips. A packaged Zen probe with a simulated GPU stall reached playback in 2.9–4.9 s against 4.8–5.6 s.

The worker pool costs memory. Against a 1.24 GB RSS Zen page with no voice loaded, a cold Cori High session added 0.34 GB steady on one thread and 1.03 GB with four vocoder workers, with a 1.66 GB peak while loading. Each extra worker keeps roughly 0.19 GB for the 55 MB High vocoder. The four-core target uses three workers. Target hardware with four cores and no GPU remains unmeasured.
