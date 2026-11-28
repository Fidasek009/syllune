# Finish the Chrome listing

For the existing **0.1.1** draft. Do not upload another ZIP or create another item.

1. Open [this item's Developer Dashboard](https://chrome.google.com/webstore/devconsole/3d51579d-68ea-43dd-8ab5-be9bbaff6b53/nelfckaimfchkkkdbndhohiaiobljkdk/edit).
2. Complete **Store listing** using the table below and save.
3. Complete **Privacy practices** using the supplied answers below and save.
4. In **Distribution**, choose **Public** and your intended countries. Save. Complete any publisher identity/trader-status questions using your actual circumstances.
5. Click **Why can't I publish?** beside the submission button. Resolve any remaining listed errors. Share their exact wording with the agent if needed.
6. Once there are no errors, click **Submit for review** for the existing **0.1.1** draft and choose **automatic publication after approval**. This one-time dashboard submission is necessary when establishing the item's distribution settings. Do not select deferred/manual publication.
7. Tell the agent it is submitted. Future release tags use the automatic pipeline.

## Store listing

| Field | Value |
| --- | --- |
| Name | Syllune: Offline Text to Speech |
| Summary, if editable | Copy the **Short description** section of [listing.md](listing.md). |
| Description | Copy only the **Full description** section of [listing.md](listing.md). |
| Category | Productivity; choose its accessibility category/subcategory if the dashboard provides one. |
| Language | English |
| Icon | [icon-128.png](assets/icon-128.png) |
| Screenshots, in order | [reading-selection.png](assets/reading-selection.png), [voices-english.png](assets/voices-english.png), [voices-czech.png](assets/voices-czech.png) |
| Small promotional tile | [promo-small.png](assets/promo-small.png) |
| Marquee, if requested | [promo-marquee.png](assets/promo-marquee.png) |
| Homepage | `https://github.com/Fidasek009/syllune` |
| Support | `https://github.com/Fidasek009/syllune/issues` |

## Privacy practices

**Single purpose description:**

> Read user-requested web articles, selected text and PDFs aloud using speech synthesis inside the browser on the user's device, with synchronized highlighting and playback controls.

**Permission justifications** — paste each answer into its corresponding field:

| Permission | Answer |
| --- | --- |
| activeTab | Access the current page only after the user invokes Syllune, to read their selected text or the requested article and display synchronized highlighting and playback controls. |
| scripting | Inject the packaged page reader and playback controls into the user-requested tab to extract the requested text, highlight spoken words and scroll with playback. |
| contextMenus | Provide Read selection and Read page commands in the browser's right-click menu. |
| storage | Store voice choices and playback preferences locally, together with local model-management and limited technical diagnostic information. Reading text is not logged or uploaded. |
| unlimitedStorage | Store large voice-model files explicitly downloaded by the user for on-device speech. Users can delete downloaded models through voice management. |
| offscreen | Run local speech synthesis and audio playback in a Chrome offscreen document so reading continues independently of popup lifetime and tab switches. |
| Host permissions / optional hosts | Request access to a specific source site only when needed to fetch a PDF the user explicitly asks to read. Optional file access supports user-requested local PDFs where Chrome permits it. Access is not used to collect unrelated browsing activity. |

**Remote code:** choose **No, I am not using remote code**. JavaScript, WebAssembly and PDF runtime code ship inside the extension. Downloaded voice weights/configuration are speech data; Listen streams prerecorded audio. Neither loads remote JavaScript or WebAssembly.

**Data usage:** disclose **Website content** and **Web history** (the requested page/PDF URL, not a collected browsing-history database). These are handled locally for the requested reading feature. Check the three limited-use certifications: no sale or unrelated transfers, no unrelated purposes, and no use for creditworthiness/lending. Do not claim the extension handles no user data merely because synthesis is local. It has no advertising or analytics, and does not transmit reading text/audio to the developer or a speech service.

**Privacy policy URL:**

```text
https://github.com/Fidasek009/syllune/blob/main/PRIVACY.md
```

## Official guidance

Checked 2026-11-06: [listing](https://developer.chrome.com/docs/webstore/cws-dashboard-listing), [privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy), [local-data disclosures](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), [distribution](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution), [API publishing and first visibility change](https://developer.chrome.com/docs/webstore/using-api).
