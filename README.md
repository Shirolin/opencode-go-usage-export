[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [繁體中文](README.zh-TW.md)

# OpenCode Go Usage Export

![License](https://img.shields.io/github/license/Shirolin/opencode-go-usage-export) ![Version](https://img.shields.io/badge/version-1.0.4-3fb950.svg) ![Tampermonkey](https://img.shields.io/badge/Tampermonkey-userscript-00485b.svg)

A Tampermonkey userscript that exports Go subscription usage statistics from the [OpenCode console](https://opencode.ai) Usage page — token breakdown (cache read / reasoning), aggregated by model / API key / plan / date, with CSV + Excel export.

## Features

- **Network-layer capture**: intercepts and replays the console's server requests to get raw JSON (exact timestamps, keyID, plan) — tens of times faster than DOM scraping
- **Tiered storage (IndexedDB)**: detail rows kept for the last 30 days; older data aggregated by date × model × plan × key and retained long-term — no unbounded growth
- **Full / incremental sync**: incremental sync early-stops at the exact timestamp, fetching only new requests
- **Resume from checkpoint**: every page is persisted as it is fetched; an interrupted sync can continue where it left off
- **Sequential paging + retry**: default 350 ms gap, automatic retries, stall detection to avoid infinite loops
- **Interruptible sync**: a "Stop" button / timeout aborts the running sync immediately and saves what was already fetched; full sync has a hard page cap (2000 pages) as a safety net
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

**Option 1: Greasy Fork (recommended)** — visit the script page and click install: <https://greasyfork.org/scripts/591009-opencode-go-usage-export>

**Option 2: Direct from GitHub** — open [opencode-go-usage-export.user.js](https://raw.githubusercontent.com/Shirolin/opencode-go-usage-export/main/opencode-go-usage-export.user.js) in your browser; Tampermonkey will show the install confirmation.

**Option 3: Manual** — create a new script, paste the contents of [opencode-go-usage-export.user.js](./opencode-go-usage-export.user.js), and save.

After installing, open `https://opencode.ai/workspace/<workspace-id>/usage` (must be signed in) and click the **Go** button at the bottom-right.

## Usage

| Button / feature | Behavior |
|---|---|
| Full sync | Fetch all pages from the start, merge and deduplicate, write to cache |
| Sync new | Fetch only new requests (early stop), merge and deduplicate |
| Refresh | Re-render the stats panel from cache |
| Update key names | Pull key names from the API-key endpoint and cache them |
| Export CSV / Excel | Manual export for the selected date range |
| Clear data | Delete the current workspace cache |
| Stop | Abort the running sync, keeping data fetched so far (resume from checkpoint) |
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

- **v1.0.4**: panel date display format is now configurable (auto / ISO / YMD / DMY / MDY) via the settings panel.
- **v1.0.3**: `@description` now highlights the stats dashboard & export; English-first wording.
- **v1.0.2**: `@description` trimmed to a concise English single line; Chinese text moved to the Greasy Fork localization block.
- **v1.0.1**: script renamed to English "OpenCode Go Usage Export"; `@description` English-first.

- **v1.0.0**: first public release. Network-layer raw JSON capture, tiered storage (30-day detail + permanent aggregates), full/incremental sync, resume from checkpoint, interruptible sync (Stop button / timeout / page-cap safety net), auto-sync, stats panel, CSV/Excel export; security notice (official-source-only), unified UTC day boundaries, dedupe/XSS/CSV robustness fixes. (Pre-release v5.x history condensed.)

## License

[GNU General Public License v3.0](LICENSE) — free software: you may redistribute and modify it, but modified versions must also be open-sourced under GPL-3.0. See [LICENSE](./LICENSE) for details.

Copyright (C) 2026 Shirolin

## Sponsorship & Support

If this project improves your OpenCode usage tracking experience, consider supporting the developer's continued maintenance:

- ❤️ **Afdian (爱发电)**: <https://ifdian.net/a/shirolin>
- ☕ **Ko-fi**: <https://ko-fi.com/shirolin>
