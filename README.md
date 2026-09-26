# Publish to Firefox Add-ons

[![CI](https://github.com/hamzahamidi/publish-to-firefox-add-ons/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/hamzahamidi/publish-to-firefox-add-ons/actions/workflows/ci.yml)
[![CodeQL](https://github.com/hamzahamidi/publish-to-firefox-add-ons/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/hamzahamidi/publish-to-firefox-add-ons/actions/workflows/codeql.yml)
[![codecov](https://codecov.io/gh/hamzahamidi/publish-to-firefox-add-ons/branch/main/graph/badge.svg)](https://codecov.io/gh/hamzahamidi/publish-to-firefox-add-ons)
[![GitHub Marketplace](https://img.shields.io/github/v/release/hamzahamidi/publish-to-firefox-add-ons?label=Marketplace&logo=github)](https://github.com/marketplace/actions/publish-to-firefox-add-ons)
[![runtime deps](https://img.shields.io/badge/runtime%20deps-0-2ea44f)](package.json)
[![license](https://img.shields.io/github/license/hamzahamidi/publish-to-firefox-add-ons)](LICENSE)

Publish a new version of an existing Firefox add-on to addons.mozilla.org (AMO) from GitHub Actions, listed or unlisted, with safe re-runs and no runtime dependencies.

- **Safe to re-run.** The action looks the version number up on AMO before it uploads, so a re-run never submits a version twice, and it fills in the release notes or source code that an interrupted run left out.
- **Checks before it writes.** The Gecko ID in `manifest.json` must match `addon-id`, the package and the source ZIP are scanned for the API key and secret, and the add-on's state and the account's author role are read before anything is uploaded.
- **Honest about review.** Mozilla reviews listed versions, which can take a day or more. The action reports `unreviewed` and hands over the version id and its Developer Hub page instead of holding the job. For an unlisted version it can wait for signing and write the verified signed XPI.
- **Auditable.** About 1,800 lines of TypeScript with no runtime dependencies and no build step, sending the credential to one host, addons.mozilla.org.
- **Source code and notes in the same run.** A source ZIP for reviewers, release notes and approval notes, each set once and never overwritten by a re-run.

## Quick start

After the [one-time setup](#the-credential) of a publishing account and two environment secrets, add this job to a workflow that runs when you push a release tag:

```yaml
firefox:
  needs: build
  runs-on: ubuntu-latest
  environment: firefox-add-ons
  permissions: {}
  concurrency:
    group: firefox-add-ons
    cancel-in-progress: false
  steps:
    - uses: actions/download-artifact@v8
      with:
        name: extension
    - uses: hamzahamidi/publish-to-firefox-add-ons@v1
      with:
        api-key: ${{ secrets.AMO_API_KEY }}
        api-secret: ${{ secrets.AMO_API_SECRET }}
        addon-id: my-extension@example.com
        zip: extension.zip
        channel: listed
```

The ZIP comes from a `build` job that never sees the AMO secrets, shown in full under [Usage](#listed). Add `dry-run: true` to the last step for a first run that uploads nothing.

## Why this action

- **AMO's API leaves the checks to you.** An upload can be used for one version, a version number can never be used again on the add-on, deleted versions included, and AMO keeps no hash of the bytes you sent. The action reads AMO's state before every write and after any lost answer, so a retried job cannot burn a version number or submit twice. See [What it does](#what-it-does).
- **It never creates a listing.** `web-ext sign` submits with `PUT /api/v5/addons/addon/{guid}/`, which creates a new add-on when the ID is unknown, so a typo can create a listing. This action only adds versions to an add-on it has read, after checking the Gecko ID inside the package.
- **The credential cannot be short-lived, so the action contains it.** It masks the key, the secret and every token it signs, refuses to upload a package that contains the key or secret, and sends them only to addons.mozilla.org.

For Chrome, the sister action [hamzahamidi/publish-to-chrome-web-store](https://github.com/hamzahamidi/publish-to-chrome-web-store) publishes with a short-lived token. The two run side by side in one workflow: see [Next to the Chrome action](#next-to-the-chrome-action).

Not affiliated with or endorsed by Mozilla. Firefox is a trademark of the Mozilla Foundation.

## The credential

AMO offers one kind of API credential: an API key (the JWT issuer, such as `user:12345:678`) and an API secret, from the [API Credentials page](https://addons.mozilla.org/en-US/developers/addon/api/key/) of the Developer Hub. Plainly:

- **It belongs to a Mozilla account, not to an add-on.** It works on every add-on that account authors, with everything the account's author role allows. It cannot be scoped to one add-on.
- **It never expires.** AMO has no OIDC federation, no trusted publishing and no short-lived or scoped key, so this action needs the key and the secret stored as GitHub secrets. The Chrome action can avoid a stored secret through Workload Identity Federation; Firefox has no such route.
- **Rotation has no overlap window.** An account has one active key. Generating a new one revokes the old one in the same step, so publishing fails until both secrets hold the new pair. AMO allows at most 4 key changes per account per day.
- **AMO revokes a key it finds in an upload.** Every uploaded package is scanned for the API secrets of the add-on's authors. This action scans the package and the source ZIP first and refuses to upload either when it contains the key or the secret. It searches the raw archive, the bytes of every entry, and every entry decoded as UTF-8 with invalid bytes dropped, which is how AMO reads an entry before its own search.

Recommended setup:

1. Create a Mozilla account used only for publishing. The API Credentials page requires two-factor authentication on it, and it must accept the Firefox Add-on Distribution Agreement. This README has not confirmed that AMO's policies allow a separate account for this purpose; check them for your case.
2. From an owner's account, add it under Manage Authors on each add-on it publishes, with the **developer** role, then accept the invitation from the new account. The developer role can create and edit versions but cannot delete the add-on or change its authors. The account also gets its own [rate limit](#rate-limits) buckets.
3. Signed in as that account, generate a key on the API Credentials page. The secret is shown once.
4. In the repository settings, create an environment named `firefox-add-ons` with a required reviewer and a deployment rule that allows only your release tags, such as `v*`. Store the two values as environment secrets, never together in one JSON secret, because GitHub cannot reliably mask values taken out of a structured secret. Each command prompts for the value:

   ```bash
   gh secret set AMO_API_KEY --env firefox-add-ons --repo OWNER/REPO
   gh secret set AMO_API_SECRET --env firefox-add-ons --repo OWNER/REPO
   ```

   Use environment secrets rather than repository secrets: anyone with write access can read repository secrets from a workflow on any branch, while environment secrets reach only jobs in that environment, after its protection rules pass. Only the Firefox job uses the environment; the build job never sees the secrets. Environments on private repositories depend on your GitHub plan.

To rotate, generate a new pair on the API Credentials page, then update both secrets straight away, between releases.

## Before you start

- The add-on must already exist on AMO. The action adds versions to it and never creates an add-on; submit the first version in the Developer Hub.
- `manifest.json` must have `browser_specific_settings.gecko.id`, equal to `addon-id` letter for letter. The action refuses a package with no Gecko ID (`applications.gecko.id` is also read when `browser_specific_settings` is absent, as AMO does), because AMO attaches a package without an ID to whatever add-on the request names. Manifest V3 requires the ID for signing; for Manifest V2, adding the ID the add-on already has changes nothing on AMO.
- A listed version needs a name, summary, categories and license on the add-on. Set them in the Developer Hub; the action does not edit the listing.
- Every release needs a new version number. AMO accepts each number once per add-on, across both channels and forever, deleted versions included. A listed version must also be greater than the latest signed listed version.
- A new listed version disables older listed versions that are still awaiting review.
- One writer per add-on. Two runs at the same time still end with one version, and the second reports `skipped`, but each run spends upload quota. The concurrency group in the examples keeps releases one at a time.
- The ZIP holds the contents of your extension folder, with `manifest.json` at its root, not the folder itself. A `.xpi` file works too.
- Keep the secret out of the build output. AMO revokes a key it finds in an uploaded package.

## Usage

### Listed

```yaml
on:
  push:
    tags: ['v*']

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      # ... build your extension into dist/ ...
      - run: cd dist && zip -qr ../extension.zip .
      - uses: actions/upload-artifact@v7
        with:
          name: extension
          path: extension.zip

  firefox:
    needs: build
    runs-on: ubuntu-latest
    environment: firefox-add-ons
    permissions: {}
    concurrency:
      group: firefox-add-ons
      cancel-in-progress: false
    steps:
      - uses: actions/download-artifact@v8
        with:
          name: extension
      - uses: hamzahamidi/publish-to-firefox-add-ons@v1
        with:
          api-key: ${{ secrets.AMO_API_KEY }}
          api-secret: ${{ secrets.AMO_API_SECRET }}
          addon-id: my-extension@example.com
          zip: extension.zip
          channel: listed
```

The build runs in its own job, so your build tools and their dependencies never run next to the AMO secrets. The Firefox job needs no token permissions: it only downloads the ZIP and runs this action. It waits for approval in the `firefox-add-ons` environment, and the concurrency group keeps two releases from uploading at the same time.

`channel` has no default, because the two channels lead to different outcomes: `listed` makes the version public on addons.mozilla.org once Mozilla approves it, and `unlisted` gets it signed for you to distribute yourself.

### Unlisted, with the signed file

```yaml
  firefox:
    needs: build
    runs-on: ubuntu-latest
    environment: firefox-add-ons
    permissions: {}
    concurrency:
      group: firefox-add-ons
      cancel-in-progress: false
    steps:
      - uses: actions/download-artifact@v8
        with:
          name: extension
      - id: amo
        uses: hamzahamidi/publish-to-firefox-add-ons@v1
        with:
          api-key: ${{ secrets.AMO_API_KEY }}
          api-secret: ${{ secrets.AMO_API_SECRET }}
          addon-id: my-extension@example.com
          zip: extension.zip
          channel: unlisted
          signed-xpi: signed/my-extension.xpi
      - uses: actions/upload-artifact@v7
        with:
          name: signed-xpi
          path: ${{ steps.amo.outputs.signed-xpi }}

  release:
    needs: firefox
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/download-artifact@v8
        with:
          name: signed-xpi
      - env:
          GH_TOKEN: ${{ github.token }}
          TAG: ${{ github.ref_name }}
        run: gh release create "$TAG" my-extension.xpi --repo "$GITHUB_REPOSITORY" --verify-tag
```

Setting `signed-xpi` makes the action wait until AMO signs the version, up to `wait-timeout` minutes (15 when omitted). It then downloads the file, checks its SHA-256 and size against AMO's values, checks that it holds Mozilla's signature files and a `manifest.json` with your Gecko ID and version, and only then moves it into place, so the path never holds a partial or unchecked file. The `release` job can write to the repository but holds no AMO secret, so no job holds both. Use `gh release upload` instead when the release already exists.

When signing takes longer than `wait-timeout`, the run fails with `state` set to `unreviewed`. The version stays submitted: re-run the job later and the action finds it, waits again and downloads it.

### Source code and notes

```yaml
      - uses: hamzahamidi/publish-to-firefox-add-ons@v1
        with:
          api-key: ${{ secrets.AMO_API_KEY }}
          api-secret: ${{ secrets.AMO_API_SECRET }}
          addon-id: my-extension@example.com
          zip: extension.zip
          channel: listed
          source: source.zip
          release-notes: ${{ github.event.release.body }}
          approval-notes: |
            Build with Node 24 and npm 11: npm ci && npm run build.
            The package is the content of dist/.
```

`source.zip` comes from your build job, for example `git archive --format=zip -o source.zip HEAD`; the action never builds or infers it. Mozilla asks for source code when the package holds minified, bundled or templated code, and its reviewers rebuild on Ubuntu 24.04.4 ARM64 with Node 24.14.0 and npm 11.9.0 unless the approval notes say otherwise.

The source ZIP and the approval notes go in the same request that creates the version. AMO does not accept release notes in that request, so they follow in a second one. On a re-run, the action sends only what the version still lacks and never replaces a value that is there, so an edit made in the Developer Hub stays.

`github.event.release.body` is set only when the workflow runs `on: release: types: [published]`. With the tag push of the other examples it is empty and no release notes are sent, so pass the notes another way, such as a file written by the build job.

Passing `github.event.release.body` through `with:` is safe. Do not place it inside a `run:` script, where it would run as shell code.

### Trying it first

Add `dry-run: true` to the step. The run checks the inputs and the package, scans for the credentials, reads the site status, the add-on, the author role, the version and the upload list, then prints what a real run would send. It sends no POST or PATCH request, so it proves that the credentials work and that the account is an author of the add-on without uploading anything. To start a dry run by hand, give the workflow a `workflow_dispatch` trigger and pick a release tag under "Use workflow from", because the environment admits only tag runs.

### Next to the Chrome action

The sister action [publish-to-chrome-web-store](https://github.com/hamzahamidi/publish-to-chrome-web-store) publishes the Chrome build. Give each store its own job and environment:

```yaml
on:
  push:
    tags: ['v*']

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      # ... build dist/chrome/ and dist/firefox/ ...
      - run: |
          (cd dist/chrome && zip -qr ../../chrome.zip .)
          (cd dist/firefox && zip -qr ../../firefox.zip .)
      - uses: actions/upload-artifact@v7
        with:
          name: extension
          path: |
            chrome.zip
            firefox.zip

  chrome:
    needs: build
    runs-on: ubuntu-latest
    environment: chrome-web-store
    permissions:
      id-token: write
    concurrency:
      group: chrome-web-store
      cancel-in-progress: false
    steps:
      - uses: actions/download-artifact@v8
        with:
          name: extension
      - id: auth
        uses: google-github-actions/auth@v3
        with:
          workload_identity_provider: ${{ vars.CWS_WIF_PROVIDER }}
          service_account: ${{ vars.CWS_SERVICE_ACCOUNT }}
          token_format: access_token
          access_token_scopes: https://www.googleapis.com/auth/chromewebstore
          access_token_lifetime: 1800s
          create_credentials_file: false
          export_environment_variables: false
      - uses: hamzahamidi/publish-to-chrome-web-store@v1
        with:
          access-token: ${{ steps.auth.outputs.access_token }}
          publisher-id: your-publisher-id
          item-id: abcdefghijklmnopabcdefghijklmnop
          zip: chrome.zip

  firefox:
    needs: build
    runs-on: ubuntu-latest
    environment: firefox-add-ons
    permissions: {}
    concurrency:
      group: firefox-add-ons
      cancel-in-progress: false
    steps:
      - uses: actions/download-artifact@v8
        with:
          name: extension
      - uses: hamzahamidi/publish-to-firefox-add-ons@v1
        with:
          api-key: ${{ secrets.AMO_API_KEY }}
          api-secret: ${{ secrets.AMO_API_SECRET }}
          addon-id: my-extension@example.com
          zip: firefox.zip
          channel: listed
```

The Google token exists only in the `chrome` job and the AMO secret only in the `firefox` job, and a failure in one store does not stop the other. The Chrome job's one-time Google Cloud setup is in the Chrome action's README, under [Setting up Workload Identity Federation](https://github.com/hamzahamidi/publish-to-chrome-web-store#setting-up-workload-identity-federation). The example builds one ZIP per browser. When one ZIP suits both browsers, pass the same file to both steps; this action needs only `browser_specific_settings.gecko.id` in its manifest.

### After a listed submission

A listed version usually ends the run as `unreviewed`. The outputs let a later step or job follow it:

```yaml
      - id: amo
        uses: hamzahamidi/publish-to-firefox-add-ons@v1
        with:
          api-key: ${{ secrets.AMO_API_KEY }}
          api-secret: ${{ secrets.AMO_API_SECRET }}
          addon-id: my-extension@example.com
          zip: extension.zip
          channel: listed
      - if: always() && steps.amo.outputs.version-id != ''
        env:
          VERSION: ${{ steps.amo.outputs.version }}
          STATE: ${{ steps.amo.outputs.state }}
          EDIT_URL: ${{ steps.amo.outputs.edit-url }}
        run: echo "Firefox $VERSION is $STATE on AMO: $EDIT_URL" >> "$GITHUB_STEP_SUMMARY"
```

To wait for the review, run the same job again later with `wait: true` and a `wait-timeout` of up to 360 minutes. The action finds the version, reports `skipped` and waits until AMO signs or rejects it.

### Coming from the Chrome action

| Chrome action | This action | Why |
| --- | --- | --- |
| `access-token`, or `client-id`, `client-secret` and `refresh-token` | `api-key` and `api-secret` | AMO accepts only a JWT signed with the account's key and secret |
| `publisher-id` | none | The key identifies the account |
| `item-id` | `addon-id` | The Gecko ID from `manifest.json` |
| `zip` | `zip` | Same meaning; a `.xpi` works too |
| `crx` | none | AMO signs the package itself |
| `publish` | none | AMO has no drafts: creating the version submits it |
| `dry-run` | `dry-run` | Same meaning |
| `deploy-percentage`, `rollout-only`, `skip-review`, `block-on-warnings`, `publish-type` | none | AMO has no equivalent |
| none | `channel`, `source`, `release-notes`, `approval-notes`, `wait`, `wait-timeout`, `signed-xpi` | AMO concepts |
| outputs `result`, `state`, `version` | `result`, `state`, `version` | Same names; the values are AMO's |
| none | outputs `version-id`, `edit-url`, `signed-xpi` | Let a later step follow the version |

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `api-key` | yes | | The API key (JWT issuer) from the API Credentials page, `user:12345:678`. Store it as its own secret |
| `api-secret` | yes | | The API secret from the same page. Store it as its own secret, never inside a JSON secret |
| `addon-id` | yes | | The add-on's Gecko ID, such as `name@example.com` or `{UUID}`. It must equal `browser_specific_settings.gecko.id` in the package, and the add-on must exist on AMO |
| `zip` | yes | | Path to the package, `.zip` or `.xpi`, with `manifest.json` at its root. At most 200,000,000 bytes |
| `channel` | yes | | `listed` (public on addons.mozilla.org after Mozilla's review) or `unlisted` (signed for you to distribute) |
| `source` | no | | Path to a `.zip` of the source code, sent with the version. It must be a different file from `zip` |
| `release-notes` | no | | Release notes, sent as English (`en-US`) |
| `approval-notes` | no | | Notes for Mozilla's reviewers, such as build instructions, at most 3,000 characters. Only Mozilla and the add-on's authors see them |
| `wait` | no | `false` | `true` waits until AMO signs the version, or rejects it, before the step ends |
| `signed-xpi` | no | | Unlisted only. Waits for signing, then writes the verified signed XPI to this path, creating its folders |
| `wait-timeout` | no | 15, applied by the action | Minutes to wait, 1 to 360. Needs `wait: true` or `signed-xpi` |
| `dry-run` | no | `false` | `true` runs every local check and every read, then reports what would happen without uploading or changing anything |

The action refuses inputs that would do nothing, before any request: `wait-timeout` without `wait: true` or `signed-xpi`, and `signed-xpi` with `channel: listed`.

## Outputs

| Output | Description |
| --- | --- |
| `result` | `submitted` (this run created the version), `skipped` (the version already existed in this channel) or `dry-run` (a dry run for a new version) |
| `state` | AMO's file status when the action finished: `unreviewed`, `public` or `disabled`. Empty for a dry run of a new version |
| `version` | The version from `manifest.json` |
| `version-id` | AMO's numeric version id, once the version exists |
| `edit-url` | The version's page in the Developer Hub |
| `signed-xpi` | The path of the verified signed XPI, after a successful download |

Each output is written as soon as it is known. A run that fails while waiting, setting notes or downloading still passes `result`, `state`, `version-id` and `edit-url` to steps with `if: always()`.

## What it does

1. Masks `api-key` and `api-secret` before the first log line, checks every input, and reads `manifest.json` from the ZIP the way AMO reads it: comments and a byte order mark are removed, and `browser_specific_settings` wins over `applications`. It stops when the Gecko ID differs from `addon-id`, when the ZIP or the source ZIP breaks one of AMO's archive rules, or when either contains the API key or secret. Nothing has been sent at this point.
2. Reads AMO's site status. It stops when AMO is read-only for maintenance, and shows AMO's notices as warnings.
3. Reads the add-on and this account's author role. It stops when the add-on does not exist, when Mozilla disabled it, when a listed version cannot be submitted (a rejected listing, or an add-on disabled by its developer), or when the account is not an author.
4. Looks the version number up:

   | AMO has | What the action does |
   | --- | --- |
   | No version with this number | Continues. `result` becomes `submitted` once the version is created |
   | This number in this channel, `unreviewed` or `public` | Uploads nothing and completes missing fields (step 8). `result` is `skipped` |
   | This number in the other channel | Fails: a number is unique across channels |
   | This number, rejected, disabled, or disabled by a developer | Fails: release a new version |

5. For a new version, reads the upload list and reports unsubmitted uploads of this version that earlier runs left behind. They are never reused (see [Limits](#limits)). A dry run stops here and reports what it would send.
6. Uploads the package to the channel, checks validation every 5 seconds for up to 10 minutes, shows up to 20 validation warnings as warning annotations, and stops on validation errors. When the upload's answer is lost, it adopts the upload only when AMO's list proves it is this run's, and otherwise uploads once more.
7. Creates the version, with the source ZIP and approval notes in the same request when `source` is given. When the answer is lost, it reads the upload and the version before deciding, and sends the create again only when AMO shows it never happened.
8. Completes the version:

   | Input | On AMO | What the action does |
   | --- | --- | --- |
   | `release-notes` | Empty | Sets them |
   | `release-notes` | Different text | Warns and leaves AMO's text |
   | `approval-notes` | Empty, version `unreviewed` | Sets them |
   | `approval-notes` | Version already `public` | Nothing: review is over |
   | `source` | None, version `unreviewed` | Adds it |
   | `source` | None, version `public` | Warns: AMO refuses source after a human review, and adding it notifies Mozilla's reviewers and the other authors |
   | `source` | Present | Leaves it |

9. With `wait: true` or `signed-xpi`, checks the version every 15 seconds until AMO signs or rejects it, up to `wait-timeout` minutes. With `signed-xpi`, downloads and verifies the signed file. A listed version without `wait` ends here with a link to its Developer Hub page.

AMO errors are reported with the HTTP status, AMO's message and a hint for the common causes, such as a revoked key, a secret from another key, a runner clock that is off, an unaccepted developer agreement, a missing author role, throttling, a regional restriction or a network blocked at AMO's edge.

### What a re-run does

| Where the earlier run stopped | What the next run with the same inputs does |
| --- | --- |
| Before the upload | Starts over |
| After the upload, before the create | Uploads again. AMO deletes the unused upload after 15 days |
| Create sent, answer lost | Finds the version, reports `skipped` and completes missing notes |
| After the create, before the notes | Reports `skipped` and sets the notes |
| While waiting for signing | Reports `skipped`, and waits again when asked |
| During the download | Reports `skipped` and downloads again. No partial file was left |
| Rebuilt package with the same version number | Reports `skipped`. AMO keeps no hash of uploaded bytes, so the action cannot tell builds apart: increase the version to publish different code |
| Same version number, other channel | Fails: a number is unique across channels |
| Version rejected | Fails: release a new version |

## How it compares

Recorded on 26 September 2026 from each project's repository and, for web-ext, its npm entry.

| Tool | What runs | Notes |
| --- | --- | --- |
| This action | The TypeScript source in `src/`, no runtime packages | Adds versions with `POST .../versions/` to an add-on it has read; never creates an add-on |
| [web-ext sign](https://github.com/mozilla/web-ext) | Mozilla's official CLI, 10.7.0 with 26 runtime dependencies | Submits with `PUT /api/v5/addons/addon/{guid}/`, which creates an add-on when the ID is unknown. Caches the upload with a checksum of the package, so a re-run does not upload again |
| [kewisch/action-web-ext](https://github.com/kewisch/action-web-ext) | `node24`, wraps web-ext | v2.0, April 2026 |
| [wdzeng/firefox-addon](https://github.com/wdzeng/firefox-addon) | A bundled `index.cjs` | v1.2.1, June 2026 |
| [browser-actions/release-firefox-addon](https://github.com/browser-actions/release-firefox-addon) | | Latest release v0.2.1, July 2024 |
| [cardinalby/webext-buildtools-firefox-addons-action](https://github.com/cardinalby/webext-buildtools-firefox-addons-action) | `node20` | Latest release 1.0.10, March 2024 |
| [PlasmoHQ/bpp](https://github.com/PlasmoHQ/bpp) | Multi-store | Last push February 2025 |

All of them take the AMO key and secret, because AMO offers no other route. A search of the mozilla organization on GitHub found no official Mozilla action.

## Trust and security

### Every request the action makes

All requests go to `https://addons.mozilla.org`. `{addon-id}` is percent-encoded, `{id}` is the numeric add-on id AMO returned after its `guid` was checked against `addon-id`, `{account}` is the number in `api-key`, and `{version}` is the manifest version, percent-encoded.

| # | When | Request | Token lifetime |
| --- | --- | --- | --- |
| 1 | Always | `GET /api/v5/site/?disable_caching=1` | none, no credential |
| 2 | Always | `GET /api/v5/addons/addon/{addon-id}/` | 90 s |
| 3 | Always | `GET /api/v5/addons/addon/{id}/authors/{account}/` | 90 s |
| 4 | Always | `GET /api/v5/addons/addon/{id}/versions/v{version}/` | 90 s |
| 5 | New version | `GET /api/v5/addons/upload/?page_size=50&page={n}`, at most 20 pages | 90 s |
| | | A dry run stops here | |
| 6 | New version | `POST /api/v5/addons/upload/`, multipart with `channel` and the package as `upload` | 300 s |
| 7 | After 6 | `GET /api/v5/addons/upload/{uuid}/` every 5 seconds, up to 10 minutes | 90 s |
| 8 | Valid upload | `POST /api/v5/addons/addon/{id}/versions/`: JSON with `upload` and the notes, or with `source` given, multipart with `upload`, `source` and `approval_notes` | 90 s, or 300 s with `source` |
| 9 | Notes the version lacks | `PATCH /api/v5/addons/addon/{id}/versions/{version id}/` with JSON `release_notes` and `approval_notes`, only the missing ones | 90 s |
| 10 | Existing `unreviewed` version without source, `source` given | `PATCH .../versions/{version id}/`, multipart with `source`, and `approval_notes` when missing | 300 s |
| 11 | Upload answer lost | The upload list again, then at most one more upload | 90 s for the list, 300 s for the repeated upload (as row 6) |
| 12 | Create answer lost | `GET /api/v5/addons/upload/{uuid}/` and request 4 again, then at most one more create | 90 s for the reads; the repeated create as row 8 |
| 13 | PATCH answer lost | `GET /api/v5/addons/addon/{id}/versions/{version id}/`, then at most one more PATCH, only when the field is still missing | 90 s, or 300 s for the source PATCH |
| 14 | `wait` or `signed-xpi`, version `unreviewed` | `GET .../versions/{version id}/` every 15 seconds, up to `wait-timeout` | 90 s |
| 15 | `signed-xpi`, version `public` | `GET` the file URL AMO reports, only when it is on `https://addons.mozilla.org` | 300 s |

The action never calls `PUT /api/v5/addons/addon/{guid}/`, `POST /api/v5/addons/addon/`, any `DELETE`, the rollback endpoint or the frozen v4 signing API.

The host is fixed in the code. There is no input to change it, redirects are refused rather than followed, and the test setting described under [Development](#development) accepts only loopback addresses. `addon-id` is checked against the Gecko ID formats before it enters a URL, and the upload `uuid` and version id AMO returns are validated before use. Reads retry twice, 5 seconds apart, after a network error, HTTP 500, 502, 503 or 504, or an answer that is not JSON. Writes are never retried blindly: after an unclear answer the action reads AMO's state first. Each request has a timeout: 60 seconds for a read, 120 seconds for a JSON write, 10 minutes for a request that carries a file and for the download.

### Tokens

Each authenticated request carries a new HS256 JWT signed with `api-secret`: `iss` is `api-key`, `iat` is 30 seconds in the past so a runner clock up to 35 seconds ahead still passes, `exp` is 90 seconds later (300 seconds, AMO's maximum, for requests that carry a file and for the download), and `jti` is a random UUID. Every token is masked before its request is sent. When the `Date` header of the site status shows the runner clock more than 10 seconds off AMO's, the action adjusts the token times and says so in the log.

### What it does not do

- It does not print credentials. `api-key` and `api-secret` are masked before the first log line, and every token before the request that uses it. The secret itself never leaves the process.
- It does not return credentials. The outputs are `result`, `state`, `version`, `version-id`, `edit-url` and `signed-xpi`, and `edit-url` is set only when it points to addons.mozilla.org.
- It does not read or log the author name and email that AMO returns with the role.
- It writes no file other than `signed-xpi`, through a temporary file in the same folder, and its step outputs. It starts no process and sends no telemetry.
- It has no runtime dependencies. TypeScript and `@types/node` are development dependencies that type-check the code in CI; the runner never installs them.

### The code

| File | Lines | Role |
| --- | --- | --- |
| [`src/main.ts`](src/main.ts) | ~170 | Reads, masks and validates inputs, reads the files, runs the local checks and the scan, sets outputs |
| [`src/amo.ts`](src/amo.ts) | ~690 | The request sequence and its decisions: preflight, upload, create and its resolution, completion, wait |
| [`src/client.ts`](src/client.ts) | ~280 | One request function: a token per request, headers, timeouts, redirect refusal, `Retry-After`, error text and hints |
| [`src/decode.ts`](src/decode.ts) | ~230 | Checks every field the action reads from AMO and stops on values it does not know |
| [`src/zip.ts`](src/zip.ts) | ~150 | Reads the ZIP with checksum verification and AMO's archive limits |
| [`src/manifest.ts`](src/manifest.ts) | ~100 | Reads `manifest.json` as AMO does, and the Gecko ID and version rules |
| [`src/download.ts`](src/download.ts) | ~70 | Downloads and verifies the signed file, then moves it into place |
| [`src/runner.ts`](src/runner.ts) | ~50 | GitHub Actions inputs, outputs, masking and annotations |
| [`src/scan.ts`](src/scan.ts) | ~35 | Searches the raw archive, every entry and its decoded text for the key and the secret |
| [`src/jwt.ts`](src/jwt.ts) | ~30 | Signs the HS256 token and computes the clock offset |
| [`src/errors.ts`](src/errors.ts) | ~20 | The error type for failures shown as an error annotation, and network error wording |

### How it is checked

- Every pull request type-checks the code and runs the tests on Linux, Windows and macOS with coverage floors of 95% of lines and 85% of branches and functions. The tests start the action's entry point against a stateful mock of AMO that verifies each token the way AMO does, and three separate jobs run the action from `action.yml` against that mock: a listed release with source and notes, an unlisted release that downloads the signed file, and a re-run after a lost create answer. See [ci.yml](.github/workflows/ci.yml). No test contacts addons.mozilla.org. The Linux run reports coverage to Codecov with GitHub's short-lived OIDC token, not a stored upload token.
- [OpenSSF Scorecard](.github/workflows/scorecard.yml) checks the repository's security practices on every push to `main` and weekly, and publishes the result.
- [CodeQL](.github/workflows/codeql.yml) scans the TypeScript and the workflows on every pull request, every push to `main` and weekly. Dependabot keeps the workflow actions and development dependencies current.
- Releases are immutable: once `v1.0.0` is published, its tag and contents cannot change. `v1` points at the newest `1.x` release. [The workflow that moves it](.github/workflows/major-tag.yml) always points `v1` at the highest `1.x.y` release, refuses one that is not immutable, and runs one release at a time. If your organization requires full commit SHAs, pin the commit of a release.

### Your side

The key can do whatever its account can do on every add-on the account authors. Use a dedicated account with the developer role, keep the key in an environment only the Firefox job uses, and keep the secret out of your build output.

Report a vulnerability as described in [SECURITY.md](SECURITY.md).

## Rate limits

AMO throttles writes per account: uploads at 6 per minute, 20 per hour and 48 per day, and submissions (version creates and edits) at 3 per minute, 10 per hour and 24 per day. Each also has a per IP limit of 6 per minute and 50 per hour. Every add-on and job that uses the account shares these buckets. Reads are not throttled, so checking validation and signing costs nothing.

| Run | Uploads | Submissions |
| --- | --- | --- |
| New version, no `source` | 1 | 1 |
| New version with `source` | 1 | 1, or 2 with release notes, which need their own request. Approval notes take a second one when AMO does not keep them from the request that carries the source |
| Re-run, nothing missing | 0 | 0 |
| Re-run, notes missing | 0 | 1 |
| Re-run, unreviewed version missing source and release notes | 0 | 2 |
| Upload answer lost, not adopted | 2 | as above |
| Dry run | 0 | 0 |

On HTTP 429, the action waits for `Retry-After` when it is 120 seconds or less, at most twice per run. A longer wait means an hourly or daily bucket is empty, and the run stops with the limits above.

## Limits

What this action does not do:

- It does not create add-ons or edit the listing: name, summary, categories, or the license of a first listed version. Use the Developer Hub.
- It does not use the `enterprise` channel, and does not delete, disable or roll back versions.
- It accepts the source code as a `.zip` only, although AMO also accepts `.tar.gz`, `.tgz` and `.tar.bz2`. It never builds the source ZIP.
- It sends release notes in English (`en-US`) only.
- It downloads the signed file of unlisted versions only. addons.mozilla.org distributes listed ones.
- It never reuses an upload from an earlier run. AMO's upload list has no hash, no add-on and no order, and AMO repacks every upload, so the action cannot prove that an old upload holds this build, and a wrong guess would burn the version number. A run interrupted between upload and create costs one extra upload.
- It does not add source code to a version Mozilla has approved.
- It refuses a manifest without a Gecko ID, ZIP64 archives, an archive whose end record disagrees with its central directory, encrypted entries and compression methods other than stored and deflated. It does not open archives nested inside the package when scanning for the credentials, as AMO's own scan does not.

What AMO imposes on any publishing tool:

- One kind of credential: an account-wide key and secret that never expire. See [The credential](#the-credential).
- A version number can be used once per add-on, across channels and after deletion, and a listed version must be greater than the latest signed listed one.
- Packages and source archives up to 200,000,000 bytes, less than 250 MiB once uncompressed and at most 100 MiB per entry, with stored or deflated entries only.
- Each request carries a token that lives at most 5 minutes, so a 200 MB package needs about 6 Mbit/s of upload bandwidth to finish in time.
- Mozilla reviews listed versions, and signing can take 24 hours or longer. Any version, unlisted ones included, can be reviewed later and disabled.
- The rate limits above, shared by everything that uses the account.
- AMO documents the v5 API as not frozen. The action checks the type of every field it reads and stops on a value it does not know rather than guessing.
- AMO blocks some networks at its edge with an empty HTTP 406, which matters for self-hosted runners.

## FAQ

### Can it run without a stored secret?

No. AMO's API accepts only a JWT signed with an account's API secret, and AMO has no OIDC federation, trusted publishing or short-lived key. The Chrome action avoids a stored secret through Workload Identity Federation; there is no equivalent for Firefox. [The credential](#the-credential) describes how to limit what the key can reach.

### Is it safe to re-run a release?

Yes. The action looks the version number up first. A version that already exists in the channel is skipped and completed, a version number AMO would refuse stops the run, and a lost answer is resolved by reading AMO's state. See [What a re-run does](#what-a-re-run-does).

### Why does it not reuse my earlier upload?

AMO keeps no hash of an upload and records neither the add-on nor the time, so nothing proves an old upload holds the current build. Submitting the wrong one would use up the version number for good. The action reports earlier uploads of the same version and uploads again; AMO deletes unused uploads after 15 days.

### Can it create my add-on?

No. Create it in the Developer Hub with its first version, name, summary, categories and license. The action refuses to guess: it only adds versions to an add-on it has read.

### Why did AMO revoke my key?

AMO scans every upload for its authors' API secrets and revokes a key it finds, including uploads made by other tools or by hand. This action refuses to upload a package or source ZIP that contains the key or secret, and when AMO's validation reports a secret, it says so. Generate a new key, update both secrets, and find how the secret reached the build output.

### Does it work with the Chrome action's ZIP?

Yes, when its `manifest.json` has `browser_specific_settings.gecko.id` equal to `addon-id` and the ZIP meets AMO's limits.

### Is it made by Mozilla?

No. It is an independent open source project and calls AMO's public API.

## Development

Node.js 24 or later:

```bash
npm ci
npm run typecheck
npm test
```

The tests run the action against a local, stateful mock of AMO. `AMO_API_BASE` points the action at that mock, and the action refuses it unless it is a loopback `http` address. `node test/self-test.ts` starts the same mock for the CI jobs that run the action from `action.yml`.

## License

[MIT](LICENSE)
