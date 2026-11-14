# Chrome Web Store — Cocoon

Last updated: 2026-11-12. **0.8.2 submitted; Pending review. Automatic publication after approval is enabled.** The currently published version observed before submission was 0.7.4.

## Distribution boundary

- Store candidate: production `npm run build` output in `dist/` only.
- Local testing: `npm run build:dev` output in `dist-dev/`, named **Cocoon Dev**, same icon.
- Production build guards reject included diagnostic modules and protocol/storage markers. Never upload `dist-dev/`, local diagnostics, browser data, `.git/`, dependencies, source docs or credentials as the store package.
- Use the same numeric version, 0.8.2. Dev has a separate version label and installation/data; it is not a second store listing in this task.

## Listing reference

The existing English and Simplified Chinese descriptions were updated with a 0.8.2 What's New section: tag deletion confirmation, management-list focus/scroll correction, and optional voter platform blocking introduced since 0.7.4. The previous claim that voters could never be blocked on the platform was corrected. Both saved descriptions were reloaded and compared exactly before submission (6,271 / 2,278 characters); the following is a concise reference, not the full submitted copy.

**Name:** Cocoon

**Short description:** Filter unwanted authors and organize your local blocklist with tags. Currently supports the Zhihu home feed.

**Detailed description:**

Cocoon helps you hide unwanted authors from the Zhihu home feed and organize your local blocklist with tags. Choose a tag to hide matching feed cards and supported comments. Search and manage saved authors, remove blocks, and import or export a local backup. Drag custom tags within the blocking drawer to arrange them, or use Alt+Left/Right; your drawer order is remembered locally and the built-in default remains first.

When available, the management page shows the saved title and link of the post associated with an author's first block. Bulk voter records share that post rather than duplicating it.

Deleting a tag in the drawer or management page asks for confirmation. Its authors move to default and remain blocked.

Optional Zhihu actions use your existing signed-in account. Direct-author account blocking has its own authorization. Content voters are blocked locally by default; a separate default-off global setting lets supporting plugins also block newly added voters from newly started batches on their corresponding platform. Currently the Zhihu plugin supports this. Existing records are not backfilled, and remote failures do not undo local blocking.

Cocoon has no developer-operated server, analytics or automatic telemetry. Read the privacy policy for local records and necessary Zhihu requests.

**Single purpose:** Author-based filtering and local blocklist management for the Zhihu home feed.

**Category / listing languages / visibility / regions:** Tools; English (default) and Simplified Chinese; Public; all available regions. Free of charge. Existing distribution settings were checked and retained; the extension UI remains Chinese.

## Assets

- Existing local PNG icons: `icons/icon-16.png`, `icon-32.png`, `icon-48.png`, `icon-128.png`.
- Retained the three previously approved screenshots and two promotional tiles. Existing screenshot thumbnails were inspected and all six store images, including the icon, loaded successfully; no replacement images or new personal screenshots were uploaded.
- Dev does not require new icons.

## Permission and page-scope justification

| Item | Purpose |
| --- | --- |
| `storage` | Remember optional action preferences, the default-off global voter platform-blocking preference and page counts; coordinate local data changes and migrate legacy blacklist data. |
| Content script: exact `https://www.zhihu.com/` | Add author controls and hide matching feed cards/comments; same-origin identity/voter lookups and independently authorized direct-author or new-voter platform blocking. |

No `tabs`, `scripting`, `downloads`, `management`, `<all_urls>` or new host permissions. Dev uses the same permission set for its local bounded diagnostic fragments; those fragments and their recording implementation are excluded from the production package.

## Privacy and data-use disclosure

Source of truth: [PRIVACY.md](PRIVACY.md). Do not claim that no personal data is processed merely because storage is local.

- Author names, profile links, member identifiers, tags and timestamps support author filtering and local management.
- Optional user-authorized Zhihu account actions and identity/voter lookups use the existing same-origin session, including applicable cookies and an anti-forgery token where needed. No credentials are retained in diagnostic records or blacklist exports.
- Submitted feed-card blocks and reliably associated hover-card blocks can retain shared post titles, content identifiers and permanent links; related authors/voters reference them. Backups include referenced posts, while unreferenced local posts are retained until replacement or uninstall.
- Local backups contain personal records. There is no developer-operated upload service, advertising or analytics.
- Dev-only diagnostics can retain real author identities, related interaction times and geometry; they are local, bounded and not automatically uploaded. They must not be confused with the store production data flow.
- Existing Personally identifiable information, Authentication information and Website content disclosures and all three limited-use certifications were checked and retained. No new legal or data-use certification was selected. Storage and host-scope justifications were updated for the global preference and authorized voter blocking, saved and verified after reload. No permissions were added; production code remains bundled locally.

**Privacy-policy URL:** https://github.com/chho/cocoon-extension/blob/main/PRIVACY.md — opened successfully before submission and checked for post data, credentials, retention and production diagnostic exclusions. Its version note remains 0.8.0 and already covers the separate default-off voter platform-blocking preference, newly added voters and no historical backfill; 0.8.1/0.8.2 fixes do not change those data practices. The public GitHub policy was opened successfully in the existing Chrome during this submission.

## Publisher details

- Existing publisher/contact settings were retained; no legal/account fields were changed or private account details copied here.
- Source/homepage: https://github.com/chho/cocoon-extension
- Support: https://github.com/chho/cocoon-extension/issues
- Existing developer dashboard was accessible. The final submission confirmation had automatic publication enabled; Google acknowledged submission and the Status page showed Pending review.

## Next local release — 0.8.3 (not submitted)

Popup quick search is removed. The popup retains page status, exact hidden count, local totals, the five most recent blocks, removal/undo and the management entry. Search and filters remain on the full management page. Initial and successful-undo focus moves to the management entry.

Before a future store submission, update both listing languages to remove claims that the toolbar popup offers quick search. The existing 0.8.2 submission and its descriptions above are unchanged; this local change has not been uploaded or published.

## Version history and readiness

| Version | Status | Change |
| --- | --- | --- |
| 0.8.2 | Submitted 2026-11-12; Pending review; auto-publish enabled | Confirm tag deletion; retain blocked authors under default. Also includes 0.8.1 management-list focus/scroll correction and 0.8.0 optional voter platform blocking with a separate default-off global setting. |
| 0.7.4 | Published; verified in dashboard 2026-11-12 | Keep the drawer pending while filtering finishes for comments exposed beneath a mouse submission, without guessing author identities or delaying on unrelated comments. |
| 0.7.3 | Reviewed, not submitted | Fix article voter pagination stopping after the first page when Zhihu returns an HTTP next link; requests remain HTTPS-only. |
| 0.7.2 | Reviewed, not submitted | Complete Dev voter-batch diagnostics with bounded page evidence and count reconciliation; production excludes the recorder. |
| 0.7.1 | Reviewed, not submitted | Complete 0.7 post provenance for reliably associated author hover cards; voter operations remain disabled for hover entries. |
| 0.7.0 | Reviewed, not submitted | Shared first-block post references; management links, schema v6 and versioned backup migration. |
| 0.6.2 | Draft, not submitted | Restore continuous tag rows with full-width wrapping and protected default drag boundaries. |
| 0.6.1 | Draft, not submitted | Restore the default tag’s compact height beside wrapped custom tags. |
| 0.6.0 | Draft, not submitted | Custom-tag drawer sorting with locally remembered order; default remains fixed. |
| 0.5.0 | Draft, not submitted | Separate production and local Dev builds; bounded local diagnostics only in Dev. |

Release evidence: production artifact `13934199692` from successful [CI run 43200464649](https://github.com/chho/cocoon-extension/actions/runs/43200464649), commit `4dc9e61cde7e1a75acde2e0faecef138f1332650`. Uploaded the original 125,040-byte ZIP after verifying SHA-256 `828c9949137374fef06fe8f1e9e5c14e3ceb6ef3447b80255099f6898b85ecac` against GitHub's artifact digest, CRC, 17 runtime files, MV3/version, locales, six HTML/module references, permissions/page scope, self-contained content/background entries and diagnostic-marker exclusions. The dashboard identified draft 0.8.2 and published 0.7.4 before submission. The final auto-publication checkbox was checked before one submit click; Pending review was verified again after refresh. Submission is not publication.

Browser acceptance: BUG-022's supported mouse-submission path has an automated fix in 0.7.4, but real-browser geometry and intermittent native hover behavior remain user acceptance boundaries. Unknown/keyboard contexts retain their fallback behavior; this release does not claim to eliminate every native hover recurrence. Native confirmation Escape/dismissal and focus restoration in 0.8.2 also remain user browser acceptance boundaries; only stubbed confirmation and event/data effects were automated. No product version bump was needed for publishing the existing 0.8.2.
