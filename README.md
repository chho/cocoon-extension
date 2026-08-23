<div align="center">

# Cocoon

### Quiet controls for a noisy feed.

Cocoon is a local-first Chrome extension for shaping the Zhihu home feed around the people you choose to see—or stop seeing.

`×` &nbsp;→&nbsp; `tag` &nbsp;→&nbsp; `quiet`

[Features](#what-cocoon-does) · [Install](#install-from-source) · [Data & privacy](#data--privacy) · [Development](#development) · [License](#license)

</div>

---

## Why Cocoon

A feed is easier to live with when its controls are close to the content.

Cocoon adds one deliberately small action to each supported Zhihu feed card. Choose a tag, and Cocoon remembers the author locally, hides matching cards and comments, and continues filtering as the feed updates.

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

- Adds a minimal `×` control to supported cards on the Zhihu home feed.
- Opens a compact tag drawer before taking action.
- Hides current and newly inserted cards from locally blocked authors.
- Hides comments and replies from the same authors.
- Adds the same blocking entry point to supported Zhihu author hover cards.

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

### Optional Zhihu actions

The tag drawer contains two independent options. Both are off by default and remember their most recently saved state.

- **Block this author on Zhihu** — also sends a same-origin request that changes the signed-in Zhihu account's real block list.
- **Hide voters of this content** — reads the answer's voters or article's likers and adds eligible users to Cocoon's local blacklist. It does **not** remotely block those voters on Zhihu.

> [!IMPORTANT]
> When **Block this author on Zhihu** is enabled, choosing a tag authorizes the account-level block immediately. Cocoon does not show a second confirmation dialog. Review the visible checkbox before choosing a tag.

## Supported pages

Cocoon currently runs only on the exact Zhihu home page:

```text
https://www.zhihu.com/
```

Platform-aware records in imported data do not imply support for YouTube or any other website. Additional sites require their own reviewed plugin, page scope, identity model, and acceptance criteria.

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
5. Open or refresh `https://www.zhihu.com/`.

After changing the Manifest or a content script, rebuild the project, reload the extension, and refresh the Zhihu page.

## Data & privacy

Cocoon currently stores the following data in `chrome.storage.local`:

- platform identifier;
- stable author identifier and an optional verified Zhihu alias;
- author display name captured at the time of blocking;
- tag association;
- block source;
- first-blocked timestamp;
- the two optional Zhihu-action preferences.

Cocoon does not currently provide its own server, cloud sync, analytics, advertising, or telemetry. Runtime network requests are limited to the existing Zhihu origin and are made only for implemented identity resolution, voter lookup, or explicitly enabled account-level actions.

Exported JSON files contain local author and tag records. Treat them as personal data: store them securely and inspect their destination before sharing.

Removing the extension clears extension-managed local storage through Chrome. Individual records can also be removed from the popup or management page.

## Permissions

Cocoon requests one Chrome extension permission:

| Permission | Why it is needed |
| --- | --- |
| `storage` | Saves the local blacklist, tags, preferences, migrations, and temporary per-tab badge state. |

The content script scope is generated from the bundled Zhihu plugin descriptor and is limited to `https://www.zhihu.com/`. Cocoon does not request `<all_urls>`, `tabs`, `scripting`, `downloads`, or `unlimitedStorage`.

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
src/plugins/zhihu/          Zhihu descriptor, runtime wiring, and styles
src/options/                Management-page behavior and views
src/popup/                  Popup behavior and views
scripts/build/              Plugin scanning and Manifest composition
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

Zhihu's DOM and same-origin API contracts can change without notice. Cocoon validates known structures and fails safely where possible, but a future Zhihu update may require a new extension release.

Real-browser acceptance remains separate from automated tests.

## License

Cocoon is licensed under the [Apache License 2.0](LICENSE).

The license applies to the source code. It does not grant permission to use third-party trademarks, including the Zhihu name or branding, beyond descriptive use permitted by law.

---

<div align="center">

**Cocoon is an independent project and is not affiliated with, endorsed by, or maintained by Zhihu.**

</div>
