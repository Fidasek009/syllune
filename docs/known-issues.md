# Known issues

## Opening an already-open local PDF may require choosing the file

Last reviewed: **2026-11-14**.

When Syllune opens its reader for a local PDF, it already knows the file URL and tries to read it directly. Knowing the file's location does not give the extension access to its bytes.

- **Chrome** reads the file directly after **Allow access to file URLs** is enabled on Syllune's extension details page and the one-time file-host grant is accepted. Fresh installs have file access off; the browser exposes no API to turn that setting on, so Syllune cannot show a permission prompt for it. Once the setting is on, the reader offers a one-click grant and later local PDFs open directly.
- **Firefox 153+** has a separate **Access local files on your computer** permission, also off by default. Requesting `file:///*` through `permissions.request()` does not grant it ([Firefox bug 2051082](https://bugzilla.mozilla.org/show_bug.cgi?id=2051082)). Tested Zen builds still blocked direct `fetch` after the permission was granted; that report remains unconfirmed, so direct reading may stay impossible there regardless of the toggle.

When direct reading is blocked, the reader offers a file choice and, in Chrome, a link to Syllune's extension settings where the switch can be enabled once. Chrome applies that change after a restart; afterwards local PDFs open with a single grant click. A chosen file is provided by the browser as a readable `File` object, stays on your device, and is not uploaded. No prompt, manifest entry, or enterprise policy can grant file access up front — force-installed extensions still report `isAllowedFileSchemeAccess()` as false ([Chromium issue 577461554](https://issues.chromium.org/issues/577461554)). Firefox also prevents extensions from injecting code into its built-in PDF viewer, so the document cannot be retrieved through that viewer.

References: [Mozilla file-access issue 2085199](https://bugzilla.mozilla.org/show_bug.cgi?id=2085199), [Firefox PDF-viewer restrictions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts#limitations), [file-picker restrictions](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/file#notes), and [Chrome file-access settings](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions#allow-access).

## Firefox/Zen: first words of a new reading clip can be inaudible

Last reviewed: **2026-11-14**.

Reported on Windows/Zen with Czech voices. Firefox takes noticeably longer to start a new media resource than to continue an existing one, and the player currently creates one media element per reading chunk. The voice output itself is clean.

This remains unresolved. A continuous Web Audio stream feeding one media element avoided the per-chunk starts but failed Firefox 159 native media-control activation, so production playback keeps per-clip elements to preserve OS play/pause controls. No extension-side fix is available at this point.
