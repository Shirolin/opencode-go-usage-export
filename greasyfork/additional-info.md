**OpenCode Go usage dashboard & export** for the [OpenCode console](https://opencode.ai) — an in-page stats panel plus CSV/Excel export.

**In-page dashboard** (no download needed):

- Totals, last-30-day cost, and Go quota comparison (5h/$12 · 7d/$30 · 30d/$60)
- Breakdowns by model / API key / plan with bar charts
- Wide-window mode for browsing stats

**Data pipeline**:

- Network-layer capture of raw server JSON (exact timestamps, keyID, plan) — tens of times faster than DOM scraping
- Tiered storage in IndexedDB: 30-day detail + permanent aggregates by date × model × plan × key
- Full / incremental sync with timestamp early stop, resume from checkpoint, interruptible fetch, auto-sync

**Export**: CSV / Excel with date-range filtering.

**GPL-3.0, open source** — install only from the official repository:

- Official repo: https://github.com/Shirolin/opencode-go-usage-export
- Direct install: https://raw.githubusercontent.com/Shirolin/opencode-go-usage-export/main/opencode-go-usage-export.user.js
- Support / issues: https://github.com/Shirolin/opencode-go-usage-export/issues
