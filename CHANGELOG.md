# Changelog

## 1.0.0 (unreleased)

First release.

- Publishes a new version of an existing Firefox add-on to addons.mozilla.org through the v5 API, in the listed or unlisted channel. It never creates an add-on or edits the listing.
- Checks the package before any request: the Gecko ID in `manifest.json` must equal `addon-id`, the ZIP must be within AMO's limits, and neither the package nor the source ZIP may contain the API key or secret.
- Looks the version number up first, so a re-run never submits a version twice, and resolves a lost answer by reading AMO's state before it writes again.
- Uploads the source ZIP with the version, sets release notes (`en-US`) and approval notes, and fills only fields that are missing on a re-run.
- Waits for signing on request, and downloads and verifies the signed file of an unlisted version.
- `dry-run: true` runs the local checks and every read, and reports the requests a real run would send.
- Signs a JWT for each authenticated request, masks the API key, the API secret and every token, and sends them only to addons.mozilla.org, refusing redirects.
- Written in TypeScript that Node 24 runs directly, with no bundle and no runtime dependencies.
