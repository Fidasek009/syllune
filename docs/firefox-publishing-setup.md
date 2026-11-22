# Firefox publishing setup

Checked **2026-11-05** against Mozilla's documentation and the installed WXT 0.21.5 / `web-ext` 10.8.0 clients. WXT still builds and packages the Firefox extension. Its publisher supports V5 updates but expects an existing listing, so Firefox submission uses Mozilla's exported `web-ext/util/submit-addon` client under Bun. It uploads the exact CI ZIP and reviewer-source ZIP, without repacking or rebuilding. Chrome continues through WXT.

## One-time account and credentials

1. Sign in at the [AMO Developer Hub](https://addons.mozilla.org/developers/). Complete the account's verification and accept Mozilla's developer agreement. Do not upload an extension just to obtain credentials.
2. Open [API credentials](https://addons.mozilla.org/developers/addon/api/key/) and generate credentials if needed. The issuer/API key usually looks like `user:123456:78`. Keep the issuer and secret private.
3. Open [GitHub environments](https://github.com/Fidasek009/syllune/settings/environments), select **stores**, then add these **environment secrets**:

   | Name | Mozilla value |
   | --- | --- |
   | `FIREFOX_JWT_ISSUER` | JWT issuer / API key |
   | `FIREFOX_JWT_SECRET` | JWT secret / API secret |

4. Under [repository Actions variables](https://github.com/Fidasek009/syllune/settings/variables/actions), keep `FIREFOX_EXTENSION_ID` set to `read-aloud@fidasek009.github.io`. It is already configured. This permanent manifest/AMO GUID is unrelated to the listing's eventual URL slug.

No other Firefox variable, saved JWT, local `.env` file, manual listing upload or artwork task is required. The pipeline generates short-lived JWTs using Mozilla's authentication implementation. Credentials stay in the `stores` environment; PR jobs receive none.

## Safe verification

When credential setup is complete, **Actions → Store check → Run workflow → main → firefox** checks CI and Firefox credentials. It uses only GET requests to AMO: the account profile, then the add-on's GUID. A first-listing 404 after successful account authentication is expected and passes. Authentication errors, missing agreement acceptance, service failures and inaccessible existing listings fail. A public add-on lookup alone is not treated as proof of authentication.

The check also verifies the local package's version/GUID, source ZIP presence and prepared listing materials. It neither uploads an extension nor creates a listing, submits a review, consumes a version, or publishes a GitHub release. Server-side package validation happens only during a real submission. Run the check only when requested; credential setup itself starts no workflow.

AMO currently returns `read_dev_agreement` as an acceptance timestamp or null, matching its nullable DateTimeField, although its account API documentation describes a boolean. The preflight validates the timestamp without printing account details. See Mozilla's [account serializer](https://github.com/mozilla/addons-server/blob/master/src/olympia/accounts/serializers.py) and [user model](https://github.com/mozilla/addons-server/blob/master/src/olympia/users/models.py).

## Automatic publication

Once the existing license/product acceptance work is complete, a pushed `vX.Y.Z` tag runs CI and both stores' preflight checks before live uploads. Firefox uses AMO V5's **PUT by permanent GUID** to create the first listing or add a new version to the same listing. It supplies the tag-versioned package, listing description/categories, reviewer instructions and license terms, and attaches matching reviewer sources. It then updates listing/privacy copy and icon and fills missing screenshot positions from committed artwork. There is no package-version bump or manual first Firefox release.

The current combined-distribution declaration retains GPL-3.0-or-later and original-source MIT terms through AMO's custom-license field, including full GPL/MIT texts and notices. AMO's predefined choices lack GPL-3.0-or-later; selecting MIT alone would misdescribe this package. `web-ext` itself is MPL-2.0 development/publishing tooling, downloaded from the pinned lockfile and not included in the installed extension. The two open model/preview assessments are tracked in [the licensing checklist](licensing.md); the materials check does not resolve them.

AMO controls review and signing; successful submission does not guarantee approval. The pipeline does not wait days for review or download a signed XPI. After both stores accept their submissions, it publishes the GitHub release automatically. If AMO accepts a version and a later source/listing update fails, CD fails; repair the accepted version in the AMO dashboard rather than resubmitting it. See [acceptance and retries](releasing.md#acceptance-and-retries).

## Evidence and verification

Integration tests run the installed Mozilla client against a local mock AMO service under Bun. They verify JWT signatures/expiry, first listing and update requests, exact archive bytes, source attachment, privacy/artwork requests, GET-only dry-runs before a listing exists, and failure propagation for credentials, access, validation and source upload. [Firefox Store check](https://github.com/Fidasek009/syllune/actions/runs/42119491832) passed CI, packaging and live GET-only authentication on 2026-11-05, including the expected absent listing. No extension was uploaded or submitted; live AMO package acceptance remains unverified.

- [Mozilla's supported submission methods](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)
- [Mozilla JWT authentication](https://mozilla.github.io/addons-server/topics/api/auth.html)
- [AMO V5 create-or-update](https://mozilla.github.io/addons-server/topics/api/addons.html#put-create-or-edit)
- [Metadata, source and review options](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/#web-ext-sign)
- [AMO license choices](https://mozilla.github.io/addons-server/topics/api/licenses.html)
- [WXT publishing limitations](https://wxt.dev/guide/essentials/publishing.html#first-time-publishing)
- [Mozilla's exported submission module](https://github.com/mozilla/web-ext/blob/10.8.0/src/util/submit-addon.js)
