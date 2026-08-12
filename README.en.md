[简体中文](README.md) · [English](README.en.md) · [日本語](README.ja.md) · [繁體中文](README.zh-TW.md)

# OpenCode Go Usage Export

![License](https://img.shields.io/github/license/Shirolin/opencode-go-usage-export) ![Version](https://img.shields.io/badge/version-5.10.0-3fb950.svg) ![Tampermonkey](https://img.shields.io/badge/Tampermonkey-userscript-00485b.svg)

A Tampermonkey userscript that exports Go subscription usage statistics from the [OpenCode console](https://opencode.ai) Usage page — token breakdown (cache read / reasoning), aggregated by model / API key / plan / date, with CSV + Excel export.

## Features

- **Network-layer capture**: intercepts and replays the console's server requests to get raw JSON (exact timestamps, keyID, plan) — tens of times faster than DOM scraping
- **Tiered storage (IndexedDB)**: detail rows kept for the last 30 days; older data aggregated by date × model × plan × key and retained long-term — no unbounded growth
- **Full / incremental sync**: incremental sync early-stops at the exact timestamp, fetching only new requests
- **Resume from checkpoint**: every page is persisted as it is fetched; an interrupted sync can continue where it left off
- **Sequential paging + retry**: default 350 ms gap, automatic retries, stall detection to avoid infinite loops
- **Auto-sync**: automatically runs an incremental sync when the page is opened more than 6 h after the last sync (no file download); toggleable in settings
- **In-page stats panel**: totals, last-30-day cost, Go quota comparison (5h/$12 · 7d/$30 · 30d/$60), bar charts by model / key / plan
- **Wide-window mode**: centered dialog (720px), better for browsing statistics and breakdowns
- **Settings panel**: display mode, auto-sync, export defaults, panel folding, paging interval, top-N counts, etc.
- **API key names**: manually refresh key names; friendly labels in the panel and in exports
- **Export**: manual CSV / Excel export with date-range filtering
- **Automatic cache cleanup**: workspace records not accessed for 30 days are deleted automatically

## Security notice

> **Install this script only from the official repository**: <https://github.com/Shirolin/opencode-go-usage-export> (public, open source, auditable).

This script directly accesses OpenCode backend APIs, including your signed-in session and API-key related data. Tampermonkey shows the full script code on the install page — **verify the source before installing**. Modified copies from unknown sources may steal your API keys, usage data, or account session.

- The panel shows a one-time security notice on first open (dismissible; never shown again), and a persistent source reminder at the bottom of the settings
- Verify the version: compare the script's `@version` in Tampermonkey with the latest version in this repository

## Installation

1. Install Tampermonkey in your browser
2. Create a new script, paste the contents of [opencode-go-usage-export.user.js](./opencode-go-usage-export.user.js), and save
3. Open `https://opencode.ai/workspace/<workspace-id>/usage` (must be signed in)
4. Click the **Go** button at the bottom-right to open the panel

## Usage

| Button / feature | Behavior |
|---|---|
| Full sync | Fetch all pages from the start, merge and deduplicate, write to cache |
| Sync new | Fetch only new requests (early stop), merge and deduplicate |
| Refresh | Re-render the stats panel from cache |
| Update key names | Pull key names from the API-key endpoint and cache them |
| Export CSV / Excel | Manual export for the selected date range |
| Clear data | Delete the current workspace cache |
| ⤢ Wide window | Toggle between compact drawer / centered dialog |
| ⚙ Settings | Expand settings: display, sync, export, etc. |

Data source: prefers raw network JSON (`source=network`); falls back to DOM scraping automatically if interception fails (`source=dom`, slower, no keyID/plan).

## Settings

Stored in `localStorage` (`oc-go-export-settings-v1`):

- **Display mode**: compact (bottom-right drawer) / wide (centered dialog)
- **Click outside to close**: on / off
- **Auto-sync**: incremental sync after >6 h
- **Default export range**: last 7 days / last 30 days / all
- **Panel sections open by default**: overview, breakdowns, export
- **Advanced**: paging interval (250/350/500 ms), top-N model/key counts

## Data storage

- IndexedDB: database `oc-go-usage-export-v5`, table `workspaces` keyed by workspace ID
- detail: raw requests from the last 30 days
- summary: aggregated data outside the window, retained long-term
- keyNames: API key ID → display name mapping

## Notes

- The script depends on the console's **undocumented** internal APIs; they may change at any time — it falls back to DOM scraping automatically
- Quota comparison in the panel is based only on cached detail (last 30 days), not authoritative
- For accurate audits, run a manual "Full sync" regularly and keep the downloaded CSVs

## Changelog

- **v5.10**: security notice — install page/README state official-source-only; one-time panel warning on first open (dismissible); persistent source reminder in settings; UTC day boundaries for range filtering; fixed dedupe collapse (silent data loss), panel XSS, CSV CR line breaks, and spread stack overflow on large datasets
- **v5.9.1**: renamed to `opencode-go-usage-export`; unified OpenCode prefix in panel titles
- **v5.6**: wide-window centered dialog; unified settings panel
- **v5.5**: API key name updates; manual export date-range filtering
- **v5**: tiered storage (30-day detail + permanent aggregates); stall/timeout guards; automatic v4 cache migration
- **v4**: concurrent paging + retry; auto-sync; keyID/plan dimensions; Excel export; pagination state restore
- **v3**: network-layer raw JSON interception; incremental timestamp early stop; resume from checkpoint; IndexedDB storage
- **v2**: incremental sync; localStorage cache deduplication
- **v1**: DOM-scraping CSV export

## License

[GNU General Public License v3.0](LICENSE) — free software: you may redistribute and modify it, but modified versions must also be open-sourced under GPL-3.0. See [LICENSE](./LICENSE) for details.

Copyright (C) 2026 Shirolin
