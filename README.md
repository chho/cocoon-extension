<div align="center">

<img src="icons/icon-128.png" alt="" width="96" height="96">

# Cocoon

### Quiet controls for a noisy feed.

[![CI](https://github.com/chho/cocoon-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/chho/cocoon-extension/actions/workflows/ci.yml)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/github/license/chho/cocoon-extension)](LICENSE)

Cocoon is a local-first Chrome extension that gives you quiet, precise control over who appears in the feeds you browse.

`×` &nbsp;→&nbsp; `tag` &nbsp;→&nbsp; `quiet`

[Features](#what-cocoon-does) · [Install](#install-from-source) · [Data & privacy](#data--privacy) · [Development](#development) · [License](#license)

</div>

---

## Why Cocoon

A feed is easier to live with when its controls are close to the content.

Cocoon adds one deliberately small action to each feed card supported by a bundled site plugin. Choose a tag, and Cocoon remembers the author locally, hides matching cards and comments, and continues filtering as the feed updates.

No dashboard to configure before browsing. No cloud account. No decorative noise.

<table>
  <tr>
    <td><strong>Local</strong><br>Blacklist records and preferences stay in Chrome storage.</td>
    <td><strong>Explicit</strong><br>Nothing is blocked until you choose a tag.</td>
    <td><strong>Continuous</strong><br>New feed cards and comments are filtered as they appear.</td>
  </tr>
</table>

## What Cocoon does

### In the feed

- Adds a minimal `×` control to cards supported by the active site plugin.
- Opens a compact tag drawer before taking action.
- Hides current and newly inserted cards from locally blocked authors.
- Hides comments and replies from the same authors.
- Adds the same blocking entry point to supported author surfaces.

### In the popup

- Shows whether Cocoon is running on the current page.
- Displays the exact number of cards and comments hidden during the current page session.
- Provides quick local search across authors and tags.
- Supports one-click removal with an eight-second undo window.

### In the management page

- Searches, filters, sorts, and removes locally blocked authors.
- Filters records by tag and platform source.
- Renames and deletes custom tags.
- Imports or exports a strictly validated JSON backup.
- Supports atomic merge and confirmed replace-all imports.

### Site-specific actions

The current Zhihu plugin adds two independent options to the tag drawer. Both are off by default and remember their most recently saved state.

- **Block this author on Zhihu** — also sends a same-origin request that changes the signed-in Zhihu account's real block list.
- **Hide voters of this content** — reads the answer's voters or article's likers and adds eligible users to Cocoon's local blacklist. It does **not** remotely block those voters on Zhihu.

> [!IMPORTANT]
> When **Block this author on Zhihu** is enabled, choosing a tag authorizes the account-level block immediately. Cocoon does not show a second confirmation dialog. Review the visible checkbox before choosing a tag.

## Supported sites

Cocoon uses build-time site plugins so each integration can define its own page scope, identity model, and capabilities. The current release ships one plugin, limited to this exact page:

```text
https://www.zhihu.com/
```

A platform label in imported data does not mean that platform is supported. Each additional site requires its own reviewed plugin and acceptance criteria.

## Install from source

### Requirements

- Google Chrome with Manifest V3 support
- Node.js 24 or newer
- npm

### Build

```bash
npm ci
npm run build
```

The production extension is generated in `dist/`.

### Load in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose the generated `dist/` directory—not the repository root.
5. Open or refresh a page listed under [Supported sites](#supported-sites).

After changing the Manifest or a content script, rebuild the project, reload the extension, and refresh the supported page.

## Data & privacy

Cocoon currently stores the following data in `chrome.storage.local`:

- platform identifier;
- stable author identifier and an optional verified site-specific alias;
- author display name captured at the time of blocking;
- tag association;
- block source;
- first-blocked timestamp;
- preferences for site-specific actions implemented by the active plugin.

Cocoon does not currently provide its own server, cloud sync, analytics, advertising, or telemetry. Runtime network requests are limited to origins declared by bundled site plugins and are made only for implemented identity resolution, content-related lookup, or explicitly enabled account-level actions. The current build makes such requests only to the supported page's existing origin.

Exported JSON files contain local author and tag records. Treat them as personal data: store them securely and inspect their destination before sharing.

Removing the extension clears extension-managed local storage through Chrome. Individual records can also be removed from the popup or management page.

## Permissions

Cocoon requests one Chrome extension permission:

| Permission | Why it is needed |
| --- | --- |
| `storage` | Saves the local blacklist, tags, preferences, migrations, and temporary per-tab badge state. |

Content script scope is generated from bundled site plugin descriptors. The current build is limited to the exact page listed under [Supported sites](#supported-sites). Cocoon does not request `<all_urls>`, `tabs`, `scripting`, `downloads`, or `unlimitedStorage`.

## Development

```bash
npm test          # Run the automated test suite
npm run typecheck # Check strict TypeScript types
npm run build     # Type-check and create dist/
npm run dev       # Rebuild continuously while files change
```

The implementation uses TypeScript, Vite, native DOM APIs, and Chrome Manifest V3. It does not use a frontend framework.

### Project map

```text
popup/                      Popup HTML entry
options/                    Management-page HTML entry
src/background/             Service worker and serialized storage operations
src/content/                Shared filtering and blacklist logic
src/core/plugin/            Strict plugin contracts, discovery, and registry
src/plugins/<id>/           Site descriptors, runtime wiring, and styles
src/options/                Management-page behavior and views
src/popup/                  Popup behavior and views
scripts/build/              Plugin scanning, static assets, and Manifest composition
icons/                      Extension branding assets at declared Chrome sizes
docs/blacklist-spec.md      Product behavior and delivery source of truth
public/manifest.json        Base Manifest fields
```

Site plugins are discovered at build time and bundled into a self-contained content script. Cocoon does not download or execute remote code.

## Design principles

- **Quiet by default.** The interface should recede behind the browsing task.
- **Stable identity over display text.** Author names are never used as blacklist keys.
- **Write only after intent.** Opening or cancelling the drawer does not create a record.
- **Atomic local state.** Failed validation or persistence must not leave partial changes.
- **Fail open on ambiguity.** Uncertain page identity should remain visible rather than hide the wrong person.
- **Minimal access.** New capabilities must justify every page scope and Chrome permission.

## Contributing

Contributions are welcome. Please keep changes focused, explain their user-visible effect, and include the evidence needed to review them safely.

Before proposing a change:

1. Keep the extension on Manifest V3.
2. Do not widen permissions or page scope without a documented product requirement.
3. Add regression tests for non-trivial logic and reproduced defects.
4. Run `npm test`, `npm run typecheck`, and `npm run build`.
5. Never commit real browser snapshots, credentials, exported blacklist data, or personal identifiers.

For behavior changes, consult `docs/blacklist-spec.md` before implementation.

## Known boundary

Supported websites can change their DOM and same-origin API contracts without notice. Cocoon validates the structures declared by each plugin and fails safely where possible, but a site update may require a new extension release.

Real-browser acceptance remains separate from automated tests.

## License

Cocoon is licensed under the [Apache License 2.0](LICENSE).

The license applies to the source code. It does not grant permission to use third-party trademarks beyond descriptive use permitted by law.

---

<div align="center">

**Cocoon is an independent project and is not affiliated with, endorsed by, or maintained by the platforms it supports.**

</div>
