# Chrome Web Store preparation — Cocoon

Last updated: 2026-11-01. **Draft; this task does not submit or publish an extension.**

## Distribution boundary

- Store candidate: production `npm run build` output in `dist/` only.
- Local testing: `npm run build:dev` output in `dist-dev/`, named **Cocoon Dev**, same icon.
- Production build guards reject included diagnostic modules and protocol/storage markers. Never upload `dist-dev/`, local diagnostics, browser data, `.git/`, dependencies, source docs or credentials as the store package.
- Use the same numeric version, 0.7.4. Dev has a separate version label and installation/data; it is not a second store listing in this task.

## Listing draft

**Name:** Cocoon

**Short description:** Filter unwanted authors and organize your local blocklist with tags. Currently supports the Zhihu home feed.

**Detailed description:**

Cocoon helps you hide unwanted authors from the Zhihu home feed and organize your local blocklist with tags. Choose a tag to hide matching feed cards and supported comments. Search and manage saved authors, remove blocks, and import or export a local backup. Drag custom tags within the blocking drawer to arrange them, or use Alt+Left/Right; your drawer order is remembered locally and the built-in default remains first.

When available, the management page shows the saved title and link of the post associated with an author's first block. Bulk voter records share that post rather than duplicating it.

Optional Zhihu actions use your existing signed-in account. Account-level blocking applies only to the directly selected author; content voters are added only to Cocoon's local blocklist. These actions remain off unless enabled by you.

Cocoon has no developer-operated server, analytics or automatic telemetry. Read the privacy policy for local records and necessary Zhihu requests.

**Single purpose:** Author-based filtering and local blocklist management for the Zhihu home feed.

**Category / primary listing language / visibility / regions:** Publisher confirmation required before submission. English and Simplified Chinese extension metadata exist; the extension UI is currently Chinese.

## Assets

- Existing local PNG icons: `icons/icon-16.png`, `icon-32.png`, `icon-48.png`, `icon-128.png`.
- Store screenshots (1280×800 or 640×400): not prepared or verified in this task. Use synthetic data only.
- Dev does not require new icons.

## Permission and page-scope justification

| Item | Purpose |
| --- | --- |
| `storage` | Remember optional action preferences and page counts; coordinate local data changes and migrate legacy blacklist data. |
| Content script: exact `https://www.zhihu.com/` | Add author controls and hide matching feed cards/comments on the supported homepage. |

No `tabs`, `scripting`, `downloads`, `management`, `<all_urls>` or new host permissions. Dev uses the same permission set for its local bounded diagnostic fragments; those fragments and their recording implementation are excluded from the production package.

## Privacy and data-use disclosure

Source of truth: [PRIVACY.md](PRIVACY.md). Do not claim that no personal data is processed merely because storage is local.

- Author names, profile links, member identifiers, tags and timestamps support author filtering and local management.
- Optional user-authorized Zhihu account actions and identity/voter lookups use the existing same-origin session, including applicable cookies and an anti-forgery token where needed. No credentials are retained in diagnostic records or blacklist exports.
- Submitted feed-card blocks and reliably associated hover-card blocks can retain shared post titles, content identifiers and permanent links; related authors/voters reference them. Backups include referenced posts, while unreferenced local posts are retained until replacement or uninstall.
- Local backups contain personal records. There is no developer-operated upload service, advertising or analytics.
- Dev-only diagnostics can retain real author identities, related interaction times and geometry; they are local, bounded and not automatically uploaded. They must not be confused with the store production data flow.
- The publisher must review current store disclosure categories against the final production package before submission. No disclosure form has been submitted in this task.

**Privacy-policy URL:** A public, reachable URL must be confirmed before submission; this task updates the local policy but does not verify hosting.

## Publisher details

- Publisher name/contact email: must be supplied/confirmed by the publisher; do not infer private account details.
- Source/homepage: https://github.com/chho/cocoon-extension
- Support: https://github.com/chho/cocoon-extension/issues
- Remote availability, store account and store listing status were not checked in this task.

## Version history and readiness

| Version | Status | Change |
| --- | --- | --- |
| 0.7.4 | Reviewed, not submitted | Keep the drawer pending while filtering finishes for comments exposed beneath a mouse submission, without guessing author identities or delaying on unrelated comments. |
| 0.7.3 | Reviewed, not submitted | Fix article voter pagination stopping after the first page when Zhihu returns an HTTP next link; requests remain HTTPS-only. |
| 0.7.2 | Reviewed, not submitted | Complete Dev voter-batch diagnostics with bounded page evidence and count reconciliation; production excludes the recorder. |
| 0.7.1 | Reviewed, not submitted | Complete 0.7 post provenance for reliably associated author hover cards; voter operations remain disabled for hover entries. |
| 0.7.0 | Reviewed, not submitted | Shared first-block post references; management links, schema v6 and versioned backup migration. |
| 0.6.2 | Draft, not submitted | Restore continuous tag rows with full-width wrapping and protected default drag boundaries. |
| 0.6.1 | Draft, not submitted | Restore the default tag’s compact height beside wrapped custom tags. |
| 0.6.0 | Draft, not submitted | Custom-tag drawer sorting with locally remembered order; default remains fixed. |
| 0.5.0 | Draft, not submitted | Separate production and local Dev builds; bounded local diagnostics only in Dev. |

Known issue: intermittent native Zhihu hover-card recurrence is still under investigation (BUG-022). Diagnostic delivery does not establish that it is fixed. Real-browser acceptance and store submission review remain separate steps.
