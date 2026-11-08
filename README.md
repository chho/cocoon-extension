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
    <td><strong>Local</strong><br>Blacklist records and preferences stay in extension-owned local storage.</td>
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
- Shows the first associated post's saved title and link when available.
- Renames and deletes custom tags in a full-width maintenance list.
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

On supported Zhihu author hover cards, Cocoon also saves the member ID from the matching answer, article, and follower statistics links. If an older blocked author's comments remain visible because that ID is missing, open their Cocoon drawer again and choose a tag to fill it in without removing the record or repeating the account-level block. This requires an unambiguous supported hover card; it does not automatically repair all older records or resolve member API access failures.

After choosing a tag, the drawer briefly stays in place and shows “处理中…” while local saving and filtering finish. Its controls are temporarily disabled to prevent accidental underlying author hovers. Mouse selections also wait for existing filtering work on the comment underneath the click point and its parent comments; this does not infer author identities or wait for the whole page. Keyboard submissions and unavailable hit-test contexts retain the author-based confirmation path. Remote account blocking and voter processing do not delay dismissal. If local processing or the page update cannot be confirmed within 10 seconds, the drawer is released without cancelling an already-submitted operation; check the result before submitting again.

All drawer tags share one continuous row layout and wrap from the left edge when space runs out. Custom tags can be reordered within the visible tag list. The built-in `default` stays first; dropping on it or outside the visible list cancels. A normal click still blocks the author, while a drag never selects or deletes a tag. With a custom tag focused, use **Alt+Left/Right** to reorder by keyboard. The drawer order is saved locally and restored after refresh; new tags append, renames keep their position, and deleted tags are ignored. This display preference does not reorder the management page or change backup files, and production/Dev installations keep separate preferences. Unconfirmed saves restore the last known order and show a warning; a later successful storage notification can still update it.

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

The production extension is generated in `dist/`. Its name and summary have English and Simplified Chinese metadata; the extension UI currently remains in Chinese.

### Dev diagnostic build

`npm run build:dev` creates **Cocoon Dev** in `dist-dev/`; `npm run build:all` builds both directories without overwriting the other. Dev uses the same icon and numeric version, with a different extension name. Production builds exclude the additional diagnostic implementation, listeners and storage protocol; build guards check the actual output.

Load `dist-dev/` instead of `dist/` for daily testing. Keep its install path unchanged and update by rebuilding/reloading, not uninstalling. Different extension IDs have independent blacklist/preferences storage: use existing import/export if needed; there is no automatic sharing. **Enable only one version, then refresh existing Zhihu pages** to remove the disabled version's injected code. Dev still operates on your real signed-in Zhihu account.

Dev automatically keeps a five-minute/1,000-event in-memory history of drawer submissions, local filtering and related native hover activity. It can include real author names, IDs, member aliases and profile links, but not cookies, credentials, input text, unrelated content, HTML or network payloads. Suspected hover incidents save an immediate fragment and a best-effort five-second follow-up locally; each fragment is at most 128 KiB and only the newest three incidents are retained. Seven-day expiry is cleaned on diagnostic startup or requests, not by a guaranteed timer while Chrome is closed. Nothing is automatically uploaded.

Voter batches also save an automatic start, coalesced five-second checkpoints when progress changes, and a final summary. Each batch updates one fragment and shares the same three-fragment/128-KiB/seven-day storage limits with hover diagnostics. Per-page traces retain at most five minutes/1,000 events; truncation is reported and cumulative batch counts survive trace truncation. Summaries distinguish API rows, duplicate/invalid entries, unique users, self/direct-author exclusions, existing/concurrent skips, additions, failures, undispatched users and unconfirmed in-flight work. Page vote totals currently remain **unknown** because no verified DOM counter is used; compare them manually, without assuming displayed votes equal enumerable users. Checkpoint saving is best effort: missing completion means unknown/possibly interrupted, not proof of a crash or of no database write. Page departure ends observation; BFCache restoration does not imply the old task resumed. No voter names, identifiers, post titles/URLs, response bodies or raw errors are added to these batch fragments.

There is no diagnostic management UI. Through the existing Chrome CDP connection, select **Cocoon Dev's isolated-world execution context** on the supported page (not the website's MAIN world):

- `globalThis.__cocoonDevDiagnostics.snapshot()`: current in-memory history and active/save status.
- `globalThis.__cocoonDevDiagnostics.batches()`: up to three current-page batch fragments, Chinese count/phase analysis, truncation and save-acknowledgement status.
- `globalThis.__cocoonDevDiagnostics.analyzeBatch(fragment)`: validate and explain a saved `reason: "voter-batch"` fragment; `null` means it is not a valid batch fragment.
- `await globalThis.__cocoonDevDiagnostics.save()`: explicitly retain a bounded local fragment; `false` means no confirmation, not guaranteed rollback.
- `await globalThis.__cocoonDevDiagnostics.clear()`: clear saved diagnostic fragments and, on success, this page's memory history.

To read saved fragments after a page refresh, evaluate `await chrome.storage.local.get("cocoonDevDiagnostics")` in the Dev service worker. Records have `savedAt`; discard expired records when inspecting storage directly. Diagnostic expiry is otherwise pruned when the worker starts or a diagnostic request runs. A page's memory history disappears on navigation; already saved fragments survive worker restarts. Other open Dev pages may later save new incidents after a clear. Do not commit or publicly share real diagnostic dumps. Missing/changed Zhihu structures or scan limits can prevent detection, and diagnostics are not proof that the intermittent hover issue is fixed.

### Load in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose the generated `dist/` directory—not the repository root.
5. Open or refresh a page listed under [Supported sites](#supported-sites).

After changing the Manifest or a content script, rebuild the project, reload the extension, and refresh the supported page.

## Data & privacy

Read the [Privacy Policy](PRIVACY.md) for data handling, Zhihu session usage, and deletion details.

Cocoon stores blacklist authors, tags, and shared post references in extension-owned IndexedDB. Each record may include:

- platform identifier;
- stable author identifier and an optional verified site-specific alias;
- author display name captured at the time of blocking;
- tag association;
- block source;
- first-blocked timestamp;
- an optional reference to the post associated with the first block.

For supported feed cards, Cocoon saves the post's title and permanent answer/article URL once, then shares that record across the directly blocked author and newly blocked voters. The post is saved before users are processed; individual user failures do not roll back successful users. Existing authors keep their first reference. Supported hover-card actions can also save the triggering feed post, including a post containing an inline comment; this does not imply that the blocked user wrote the post. Attribution requires a fresh, uniquely matching hover card and valid trigger context. Reused or ambiguous windows, conflicting pointer/focus, and the same identity encountered on different posts during a page session can leave the reference empty without preventing blocking. Hover entries still cannot process content voters. Old records are not backfilled, and cards without a trustworthy title/link have no post reference. Titles are local snapshots; original links can later become unavailable. No post body or screenshot is saved.

Site-specific preferences, the drawer’s custom-tag display order, a payload-free blacklist revision notification, and temporary per-tab badge state remain in Chrome extension storage. Existing schema v1–v5 blacklist data and the previous IndexedDB database are automatically and fail-safely migrated to schema v6 on first access, with empty post references for older authors.

Cocoon does not currently provide its own server, cloud sync, analytics, advertising, or telemetry. Runtime network requests are limited to origins declared by bundled site plugins and are made only for implemented identity resolution, content-related lookup, or explicitly enabled account-level actions. The current build makes such requests only to the supported page's existing origin.

Cocoon does not impose an author-count limit on its IndexedDB blacklist; usable capacity depends on Chrome's dynamic storage quota and the device. Popup, management, and page filtering use bounded queries instead of loading the complete author list into one message.

Exported JSON files contain local authors, tags, and the shared posts referenced by those authors. New backups use format v2/schema v6; imports also accept old format v1/schema v5 files. Older extension versions cannot read the new backup format. A near-limit old backup can still be imported, but its expanded format-v2 export may exceed the unchanged 32 MiB export limit. Import and export use revision-bound pages and persistent staging, and a single transfer file is limited to 32 MiB. This file limit is an operation safety boundary, not a blacklist capacity limit. Treat exports as personal data: store them securely and inspect their destination before sharing.

Removing the extension clears extension-managed local storage through Chrome. Individual author records can also be removed from the popup or management page. Removing an author retains shared post records for other users, in-flight operations, and undo; unreferenced posts are not automatically purged or exported. A replace-all import atomically replaces the dataset, including posts.

## Permissions

Cocoon requests one Chrome extension permission:

| Permission | Why it is needed |
| --- | --- |
| `storage` | Saves site preferences, the temporary per-tab badge state, a payload-free blacklist revision notification, and supports one-time migration of legacy blacklist data into IndexedDB. Dev additionally stores bounded local diagnostic fragments. |

Content script scope is generated from bundled site plugin descriptors. The current build is limited to the exact page listed under [Supported sites](#supported-sites). Cocoon does not request `<all_urls>`, `tabs`, `scripting`, `downloads`, or `unlimitedStorage`.

## Development

```bash
npm test          # Run the automated test suite
npm run typecheck # Check strict TypeScript types
npm run build     # Type-check and create dist/
npm run dev       # Rebuild production continuously while files change
npm run build:dev # Type-check and create dist-dev/
npm run build:all # Build production and Dev
npm run dev:diagnostic # Rebuild Dev continuously while files change
npm run benchmark:blacklist-scale # Run synthetic 33,524/100,000 scale checks
```

The implementation uses TypeScript, Vite, native DOM APIs, and Chrome Manifest V3. It does not use a frontend framework.

### Project map

```text
popup/                      Popup HTML entry
options/                    Management-page HTML entry
src/background/             Service worker, IndexedDB repository, and serialized transactions
src/content/                Shared filtering and blacklist logic
src/core/plugin/            Strict plugin contracts, discovery, and registry
src/diagnostics/            Dev-only local diagnostics; excluded from production
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
5. Never commit real browser snapshots, diagnostic dumps, credentials, exported blacklist data, or personal identifiers.

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
