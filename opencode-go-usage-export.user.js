// ==UserScript==
// @name         OpenCode Go 用量导出 CSV
// @namespace    opencode.go-usage-export
// @version      5.0.0
// @description  导出 OpenCode 控制台 Usage 的 token 统计。拦截服务端请求拿原始 JSON；分层存储（30 天明细 + 永久聚合），全量/增量、并发拉页+重试、断点续传、自动同步、按 keyID/plan 维度、面板、CSV+Excel 导出
// @match        https://opencode.ai/workspace/*/usage
// @match        https://opencode.ai/*/workspace/*/usage
// @require      https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js
// @grant        none
// ==/UserScript==

;(function () {
  "use strict"

  const IDB_NAME = "oc-go-usage-export-v5"
  const IDB_STORE = "workspaces"
  const PAGE_SIZE = 50
  const CONC = 3
  const AUTO_GAP_MS = 6 * 3600e3
  const STALE_MS = 30 * 24 * 3600e3
  const WINDOW_MS = 30 * 24 * 3600e3 // 明细保留窗口
  const SET_KEY = "oc-go-usage-auto"
  const AGG_FIELDS = ["requests", "inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens", "costUSD"]
  const AGG_COLS = ["key", ...AGG_FIELDS]
  const WS_ID = (() => {
    const m = location.pathname.match(/workspace\/([^/]+)/)
    return m ? m[1] : "unknown"
  })()

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const $q = (sel, el = document) => el.querySelector(sel)
  const $qa = (sel, el = document) => Array.from(el.querySelectorAll(sel))
  const NUM = (s) => {
    const m = String(s ?? "").replace(/[^\d.]/g, "")
    return m ? parseFloat(m) : 0
  }
  const autoEnabled = () => localStorage.getItem(SET_KEY) !== "0"
  const setAuto = (v) => localStorage.setItem(SET_KEY, v ? "1" : "0")

  function waitFor(fn, timeout = 3000) {
    return new Promise((resolve) => {
      const start = Date.now()
      const t = setInterval(() => {
        if (fn() || Date.now() - start > timeout) {
          clearInterval(t)
          resolve()
        }
      }, 80)
    })
  }

  // ---------- IndexedDB ----------
  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE, { keyPath: "id" })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  function idbRequest(mode, fn) {
    return idbOpen().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(IDB_STORE, mode)
          const store = tx.objectStore(IDB_STORE)
          const req = fn(store)
          req.onerror = () => reject(req.error)
          tx.onerror = () => reject(tx.error)
          if (mode === "readwrite") tx.oncomplete = () => resolve(req.result)
          else req.onsuccess = () => resolve(req.result)
        }),
    )
  }
  const idbGet = (id) => idbRequest("readonly", (s) => s.get(id))
  const idbPut = (rec) => idbRequest("readwrite", (s) => s.put(rec))
  const idbGetAll = () => idbRequest("readonly", (s) => s.getAll())
  const idbDelete = (id) => idbRequest("readwrite", (s) => s.delete(id))

  const emptyRec = () => ({ id: WS_ID, detail: [], summary: [], lastSync: null, lastAccess: null })

  async function getWorkspaceData() {
    const rec = await idbGet(WS_ID)
    if (!rec) return emptyRec()
    if (Array.isArray(rec.rows)) {
      // 迁移 v4 缓存 → 分层存储
      const cutoff = Date.now() - WINDOW_MS
      const { detail, summary } = rollup(rec.rows, [], cutoff)
      const migrated = { id: WS_ID, detail, summary, lastSync: rec.lastSync, lastAccess: rec.lastAccess }
      await saveWorkspaceData(migrated)
      return migrated
    }
    return rec
  }
  const saveWorkspaceData = (rec) => idbPut(rec)

  async function pruneStale() {
    try {
      const now = Date.now()
      for (const rec of await idbGetAll()) {
        const last = rec.lastAccess || rec.lastSync
        if (last && now - last > STALE_MS) await idbDelete(rec.id)
      }
    } catch {}
  }
  async function touch() {
    try {
      const rec = await getWorkspaceData()
      rec.lastAccess = Date.now()
      await saveWorkspaceData(rec)
    } catch {}
  }

  // ---------- 网络层拦截 ----------
  let observed = null
  const origFetch = window.fetch.bind(window)
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : input?.url
    const method = (init?.method || input?.method || "GET").toUpperCase()
    if (method === "POST" && url && /workspace\/.+\/usage/.test(url) && !observed) {
      let body = null
      try {
        if (init?.body != null) body = String(init.body)
        else if (input instanceof Request) body = await input.clone().text()
      } catch {}
      const headers = {}
      const h = init?.headers || input?.headers
      if (h instanceof Headers) h.forEach((v, k) => (headers[k] = v))
      else if (h && typeof h === "object") Object.assign(headers, h)
      observed = { url, headers, body }
    }
    return origFetch(input, init)
  }

  function looksLikeUsage(v) {
    return Array.isArray(v) && v.length > 0 && "inputTokens" in v[0] && "model" in v[0] && "timeCreated" in v[0]
  }
  function extractRows(json) {
    if (looksLikeUsage(json)) return json
    const stack = [json]
    while (stack.length) {
      const cur = stack.pop()
      if (!cur || typeof cur !== "object") continue
      if (looksLikeUsage(cur)) return cur
      for (const v of Object.values(cur)) stack.push(v)
    }
    return null
  }
  const norm = (r) => {
    let plan = r.enrichment
    if (typeof plan === "string") {
      try {
        plan = JSON.parse(plan).plan
      } catch {
        plan = null
      }
    } else if (plan && typeof plan === "object") plan = plan.plan
    return {
      timeCreated: r.timeCreated ?? null,
      sessionID: r.sessionID ?? null,
      model: r.model ?? "(unknown)",
      inputTokens: r.inputTokens ?? 0,
      cacheReadTokens: r.cacheReadTokens ?? 0,
      cacheWriteTokens: (r.cacheWrite5mTokens ?? 0) + (r.cacheWrite1hTokens ?? 0),
      outputTokens: r.outputTokens ?? 0,
      reasoningTokens: r.reasoningTokens ?? 0,
      costUSD: r.cost != null ? r.cost / 1e8 : null,
      plan,
      keyID: r.keyID ?? null,
      source: "network",
    }
  }
  async function fetchPage(page) {
    if (!observed) throw new Error("未捕获到服务端请求")
    let args
    try {
      const parsed = JSON.parse(observed.body)
      args = Array.isArray(parsed) ? parsed : parsed.args
    } catch {
      args = null
    }
    if (!Array.isArray(args)) throw new Error("无法解析请求参数")
    const headers = {}
    for (const [k, v] of Object.entries(observed.headers)) {
      if (/^(content-length|host|connection|transfer-encoding)$/i.test(k)) continue
      headers[k] = v
    }
    const res = await origFetch(observed.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ args: [args[0], page] }),
    })
    if (!res.ok) throw new Error("HTTP " + res.status)
    const json = await res.json()
    const rows = extractRows(json)
    return (rows || []).map(norm)
  }
  async function fetchWithRetry(page, tries = 3) {
    for (let i = 0; i < tries; i++) {
      try {
        return await fetchPage(page)
      } catch (e) {
        if (i === tries - 1) throw e
        await sleep(400 * (i + 1))
      }
    }
  }

  // ---------- DOM 兜底 ----------
  const domKey = (r) => (r.timeCreated ? `t:${r.timeCreated}:${r.sessionID || ""}` : `c:${r.date}|${r.model}|${r.inputTotal}|${r.outputTotal}`)
  async function readCell(cell) {
    const wrap = cell ? $q('[data-slot="tokens-with-breakdown"]', cell) : null
    if (!wrap) return { total: 0, comps: [] }
    const totalSpan = $q(":scope > span", wrap)
    const total = NUM(totalSpan?.textContent)
    const btn = $q('[data-slot="breakdown-button"]', wrap)
    if (!btn) return { total, comps: [] }
    btn.click()
    await waitFor(() => !!$q('[data-slot="breakdown-popup"]', wrap), 1500)
    const comps = $qa('[data-slot="breakdown-row"]', wrap).map((r) => ({
      label: $q('[data-slot="breakdown-label"]', r)?.textContent?.trim() ?? "",
      value: NUM($q('[data-slot="breakdown-value"]', r)?.textContent),
    }))
    totalSpan?.click()
    await sleep(30)
    return { total, comps }
  }
  async function domScrapePage() {
    const rows = []
    for (const tr of $qa('[data-slot="usage-table-element"] tbody tr')) {
      const dateEl = $q('[data-slot="usage-date"]', tr)
      let timeCreated = null
      const t = Date.parse(dateEl?.getAttribute("title") || "")
      if (!Number.isNaN(t)) timeCreated = t
      const model = $q('[data-slot="usage-model"]', tr)?.textContent?.trim() ?? ""
      const sessionID = $q('[data-slot="usage-session"]', tr)?.textContent?.trim() ?? ""
      const costText = $q('[data-slot="usage-cost"]', tr)?.textContent?.trim() ?? ""
      const cells = $qa('[data-slot="usage-tokens"]', tr)
      const input = await readCell(cells[0])
      const output = await readCell(cells[1])
      const ip = input.comps, op = output.comps
      const r = {
        timeCreated,
        sessionID,
        model,
        inputTokens: ip[0]?.value ?? 0,
        cacheReadTokens: ip[1]?.value ?? 0,
        cacheWriteTokens: ip[2]?.value ?? 0,
        outputTokens: op[0]?.value ?? 0,
        reasoningTokens: op[1]?.value ?? 0,
        costUSD: (() => {
          const m = costText.match(/-?\$?([\d.]+)/)
          return m ? parseFloat(m[1]) : null
        })(),
        plan: /\(go\)|subscription|sub/i.test(costText) ? "lite" : null,
        keyID: null,
        source: "dom",
      }
      r.key = domKey(r)
      rows.push(r)
    }
    return rows
  }
  async function domScrapeAll(onProgress) {
    const all = []
    let pageNo = 0
    let staleRounds = 0
    for (;;) {
      all.push(...(await domScrapePage()))
      onProgress?.(all.length)
      const btns = $qa('[data-slot="pagination"] button')
      if (btns.length < 2 || btns[1].disabled) break
      const first = $q('[data-slot="usage-table-element"] tbody tr')?.textContent ?? ""
      btns[1].click()
      await waitFor(() => {
        const t = $q('[data-slot="usage-table-element"] tbody tr')?.textContent ?? ""
        return t !== first
      }, 3000)
      if ($q('[data-slot="usage-table-element"] tbody tr')?.textContent === first) staleRounds++
      else staleRounds = 0
      pageNo++
      if (pageNo > 10000 || staleRounds > 3) break
    }
    return all
  }

  // ---------- 并发拉页 ----------
  async function fetchPages(onProgress, minTime) {
    const concurrency = minTime > 0 ? 2 : CONC
    const results = []
    let next = 0
    let end = false
    let stalled = 0
    async function worker() {
      while (!end) {
        const p = next++
        let rows
        try {
          rows = await fetchWithRetry(p)
        } catch {
          rows = null
        }
        if (!rows || rows.length === 0) {
          end = true
          continue
        }
        if (rows.length < PAGE_SIZE) end = true
        const before = results.length
        if (minTime > 0) {
          const fresh = rows.filter((r) => !(r.timeCreated && r.timeCreated <= minTime))
          if (fresh.length) results.push(...fresh)
          if (rows[0]?.timeCreated && rows[0].timeCreated <= minTime) end = true
        } else {
          results.push(...rows)
        }
        if (results.length === before) {
          if (++stalled > 5) end = true
        } else stalled = 0
        onProgress?.(results.length)
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker))
    return results
  }

  // ---------- 聚合 / 分层 ----------
  const keyOf = (r) => (r.timeCreated ? `t:${r.timeCreated}:${r.sessionID || ""}` : domKey(r))
  const dateKey = (r) => (r.timeCreated ? new Date(r.timeCreated).toISOString().slice(0, 10) : "未知")
  const summaryKey = (r) => `${dateKey(r)}|${r.model || ""}|${r.plan || ""}|${r.keyID || ""}`

  // 明细 → 汇总（超过窗口的折叠进 summary）
  function rollup(rows, summary, cutoff) {
    const sumMap = new Map(summary.map((s) => [s.key, s]))
    const detail = []
    for (const r of rows) {
      if (r.timeCreated && r.timeCreated < cutoff) {
        const k = summaryKey(r)
        let a = sumMap.get(k)
        if (!a) {
          a = { key: k, date: dateKey(r), model: r.model, plan: r.plan || "", keyID: r.keyID || "", requests: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, costUSD: 0 }
          sumMap.set(k, a)
        }
        a.requests++
        a.inputTokens += r.inputTokens
        a.cacheReadTokens += r.cacheReadTokens
        a.cacheWriteTokens += r.cacheWriteTokens
        a.outputTokens += r.outputTokens
        a.reasoningTokens += r.reasoningTokens
        a.costUSD += r.costUSD ?? 0
      } else detail.push(r)
    }
    return { detail, summary: [...sumMap.values()] }
  }

  function aggregate(rows, keyOf2) {
    const map = new Map()
    for (const r of rows) {
      const k = keyOf2(r) || "(unknown)"
      if (!map.has(k)) {
        const o = { key: k }
        for (const f of AGG_FIELDS) o[f] = 0
        map.set(k, o)
      }
      const a = map.get(k)
      a.requests++
      for (const f of AGG_FIELDS.slice(1)) a[f] += r[f]
    }
    return [...map.values()].sort((a, b) => b.inputTokens + b.cacheReadTokens + b.outputTokens - (a.inputTokens + a.cacheReadTokens + a.outputTokens))
  }
  // 汇总条目直接累加（已带 requests 计数）
  function sumAggregate(summary, keyOf2) {
    const map = new Map()
    for (const s of summary) {
      const k = keyOf2(s) || "(unknown)"
      if (!map.has(k)) {
        const o = { key: k }
        for (const f of AGG_FIELDS) o[f] = 0
        map.set(k, o)
      }
      const a = map.get(k)
      for (const f of AGG_FIELDS) a[f] += s[f] ?? 0
    }
    return [...map.values()].sort((a, b) => b.inputTokens + b.cacheReadTokens + b.outputTokens - (a.inputTokens + a.cacheReadTokens + a.outputTokens))
  }
  function mergeAgg(a, b) {
    const m = new Map(a.map((x) => [x.key, x]))
    for (const x of b) {
      const cur = m.get(x.key)
      if (cur) for (const f of AGG_FIELDS) cur[f] += x[f] ?? 0
      else m.set(x.key, { ...x })
    }
    return [...m.values()].sort((p, q) => q.inputTokens + q.cacheReadTokens + q.outputTokens - (p.inputTokens + p.cacheReadTokens + p.outputTokens))
  }

  function rawRows(rows) {
    const fmt = (t) => (t ? new Date(t).toISOString() : "")
    return rows
      .map((r) => ({
        timeUTC: fmt(r.timeCreated),
        date: r.timeCreated ? fmt(r.timeCreated).slice(0, 10) : "",
        sessionID: r.sessionID,
        model: r.model,
        inputTokens: r.inputTokens,
        cacheReadTokens: r.cacheReadTokens,
        cacheWriteTokens: r.cacheWriteTokens,
        outputTokens: r.outputTokens,
        reasoningTokens: r.reasoningTokens,
        costUSD: r.costUSD?.toFixed(6) ?? "",
        plan: r.plan ?? "",
        keyID: r.keyID ?? "",
        source: r.source,
      }))
      .sort((a, b) => (a.timeUTC < b.timeUTC ? 1 : -1))
  }

  function toCSV(rows, cols) {
    if (!rows.length) return ""
    const esc = (v) => {
      v = String(v ?? "")
      return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
    }
    return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n")
  }
  function download(name, content) {
    const blob = new Blob(["\ufeff" + content], { type: "text/csv;charset=utf-8" })
    const a = document.createElement("a")
    a.href = URL.createObjectURL(blob)
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }
  function exportXLSX(detail, summary) {
    if (typeof XLSX === "undefined") return false
    const wb = XLSX.utils.book_new()
    const add = (name, data, cols) => {
      const ws = XLSX.utils.aoa_to_sheet([cols, ...data.map((r) => cols.map((c) => r[c]))])
      XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31))
    }
    const raw = rawRows(detail)
    add("raw-30d", raw, Object.keys(raw[0] || {}))
    add("by-model", mergedAggs(detail, summary, (s) => s.model, (r) => r.model), AGG_COLS)
    add("by-date", mergedAggs(detail, summary, (s) => s.date, dateKey), AGG_COLS)
    add("by-key", mergedAggs(detail, summary, (s) => s.keyID || "未标识(dom)", (r) => r.keyID || "未标识(dom)"), AGG_COLS)
    add("by-plan", mergedAggs(detail, summary, (s) => s.plan || "pay-as-you-go", (r) => r.plan || "pay-as-you-go"), AGG_COLS)
    XLSX.writeFile(wb, `go-usage-${new Date().toISOString().slice(0, 10)}.xlsx`)
    return true
  }
  const mergedAggs = (detail, summary, sumKey, detKey) => mergeAgg(sumAggregate(summary, sumKey), aggregate(detail, detKey))

  // ---------- 主流程 ----------
  async function run(mode, btn, opts = {}) {
    const { silent = false, downloadFiles = true } = opts
    const wsData = await getWorkspaceData()
    const now = Date.now()
    const cutoff = now - WINDOW_MS
    const maxStored = Math.max(0, ...wsData.detail.map((r) => r.timeCreated || 0))
    const mergedMap = new Map(wsData.detail.map((r) => [keyOf(r), r]))

    let rows, source
    let fetchAll = null
    try {
      const btns = $qa('[data-slot="pagination"] button')
      if (btns.length >= 2 && !btns[1].disabled) {
        const first = $q('[data-slot="usage-table-element"] tbody tr')?.textContent ?? ""
        btns[1].click()
        await waitFor(() => observed && $q('[data-slot="usage-table-element"] tbody tr')?.textContent !== first, 5000)
      }
      if (observed) fetchAll = (onP) => fetchPages(onP, mode === "incremental" ? maxStored : 0)
    } catch {}

    if (fetchAll) {
      source = "network"
      rows = await fetchAll((n) => setStatus(btn, `${mode === "incremental" ? "增量" : "全量"}抓取中… 已拉 ${n} 条`))
    } else {
      source = "dom"
      setStatus(btn, "网络捕获失败，改用页面抓取（较慢）…")
      rows = await domScrapeAll((n) => setStatus(btn, `页面抓取中… ${n} 条`))
    }

    let added = 0
    for (const r of rows) {
      const k = keyOf(r)
      if (!mergedMap.has(k)) {
        mergedMap.set(k, r)
        added++
      }
    }
    const merged = [...mergedMap.values()].sort((a, b) => (b.timeCreated || 0) - (a.timeCreated || 0))
    const dupTotal = rows.length - added

    // 分层：窗口内保留明细，窗口外折叠进汇总
    const { detail, summary } = rollup(merged, wsData.summary || [], cutoff)
    await saveWorkspaceData({ id: WS_ID, detail, summary, lastSync: now, lastAccess: now })
    renderPanel(detail, summary)

    if (downloadFiles) {
      const raw = rawRows(detail)
      const ts = new Date().toISOString().slice(0, 10)
      download(`go-usage-raw-30d-${ts}.csv`, toCSV(raw, Object.keys(raw[0] || {})))
      download(`go-usage-by-model-${ts}.csv`, toCSV(mergedAggs(detail, summary, (s) => s.model, (r) => r.model), AGG_COLS))
      download(`go-usage-by-date-${ts}.csv`, toCSV(mergedAggs(detail, summary, (s) => s.date, dateKey), AGG_COLS))
      download(`go-usage-by-key-${ts}.csv`, toCSV(mergedAggs(detail, summary, (s) => s.keyID || "未标识(dom)", (r) => r.keyID || "未标识(dom)"), AGG_COLS))
      download(`go-usage-by-plan-${ts}.csv`, toCSV(mergedAggs(detail, summary, (s) => s.plan || "pay-as-you-go", (r) => r.plan || "pay-as-you-go"), AGG_COLS))
      if (!exportXLSX(detail, summary)) setStatus(btn, "（SheetJS 未加载，仅导出 CSV）")
    }

    const btns = $qa('[data-slot="pagination"] button')
    if (btns.length >= 2 && !btns[0].disabled) btns[0].click()

    setStatus(
      btn,
      `${mode === "incremental" ? "增量" : "全量"}完成：${source} 源 · 新增 ${added} 条 · 明细 ${detail.length} / 汇总 ${summary.length}` +
        (dupTotal > 0 ? ` · 去重 ${dupTotal} 条` : "") +
        (downloadFiles ? " · 已导出 CSV+Excel" : ""),
    )
  }

  // ---------- 面板 ----------
  function renderPanel(detail, summary) {
    const panel = $q("#oc-go-export-panel")
    if (!panel) return
    const now = Date.now()
    const sumF = (list, f) => list.reduce((a, r) => a + (r[f] ?? 0), 0)
    const sumCost = (list) => list.reduce((a, r) => a + (r.costUSD ?? 0), 0)
    const cost24h = sumCost(detail.filter((r) => r.timeCreated && now - r.timeCreated < 24 * 3600e3))
    const cost7d = sumCost(detail.filter((r) => r.timeCreated && now - r.timeCreated < 7 * 24 * 3600e3))
    const cost30d = sumCost(detail)

    const total = {
      requests: detail.length + sumF(summary, "requests"),
      inputTokens: sumF(detail, "inputTokens") + sumF(summary, "inputTokens"),
      cacheReadTokens: sumF(detail, "cacheReadTokens") + sumF(summary, "cacheReadTokens"),
      outputTokens: sumF(detail, "outputTokens") + sumF(summary, "outputTokens"),
    }
    const byModel = mergedAggs(detail, summary, (s) => s.model, (r) => r.model).slice(0, 6)
    const byKey = mergedAggs(detail, summary, (s) => s.keyID ? `${s.keyID.slice(-6)} ${s.plan ? "(" + s.plan + ")" : ""}` : "未标识(dom)", (r) => (r.keyID ? `${r.keyID.slice(-6)} ${r.plan ? "(" + r.plan + ")" : ""}` : "未标识(dom)")).slice(0, 5)
    const byPlan = mergedAggs(detail, summary, (s) => s.plan || "pay-as-you-go", (r) => r.plan || "pay-as-you-go")

    const fmtT = (n) => {
      if (n == null) return "-"
      if (n >= 1e6) return (n / 1e6).toFixed(2) + "M"
      if (n >= 1e3) return (n / 1e3).toFixed(1) + "k"
      return String(n)
    }
    const barRow = (label, v, max, cost) =>
      `<div style="display:flex;align-items:center;gap:6px;font-size:11px;margin:2px 0">
        <span style="width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#ddd">${label}</span>
        <span style="width:56px;text-align:right;color:#fff">${fmtT(v)}</span>
        <div style="flex:1;height:8px;background:#333;border-radius:4px;overflow:hidden"><div style="width:${max ? Math.max(2, (v / max) * 100) : 0}%;height:100%;background:#e84c3d"></div></div>
        <span style="width:52px;text-align:right;color:#aaa">${cost != null ? "$" + cost.toFixed(2) : ""}</span>
      </div>`

    const sections = []
    if (byModel.length)
      sections.push(`<div style="font-size:10px;color:#aaa;margin:4px 0 2px">按模型（前 6）</div>` + byModel.map((m) => barRow(m.key, m.inputTokens + m.cacheReadTokens, byModel[0].inputTokens + byModel[0].cacheReadTokens, m.costUSD)).join(""))
    if (byKey.length)
      sections.push(`<div style="font-size:10px;color:#aaa;margin:4px 0 2px">按 API key（前 5）</div>` + byKey.map((m) => barRow(m.key, m.costUSD, byKey[0].costUSD, m.costUSD)).join(""))
    if (byPlan.length)
      sections.push(
        `<div style="font-size:10px;color:#aaa;margin:4px 0 2px">按 plan</div>` +
          byPlan.map((m) => `<div style="font-size:11px;color:#ddd;margin:2px 0">${m.key}: ${m.requests} 次 · $${m.costUSD.toFixed(2)} · ${fmtT(m.inputTokens + m.cacheReadTokens + m.outputTokens)} tok</div>`).join(""),
      )

    const maxTC = detail.some((r) => r.timeCreated) ? Math.max(...detail.map((r) => r.timeCreated)) : null
    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <b style="font-size:12px;color:#fff">Go 用量面板</b>
        <span style="font-size:10px;color:#888">共 ${total.requests} 次请求</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:11px;margin-bottom:6px">
        <div style="background:#2a2a2a;padding:6px;border-radius:6px"><div style="color:#888">Input</div><div style="color:#fff">${fmtT(total.inputTokens)}</div></div>
        <div style="background:#2a2a2a;padding:6px;border-radius:6px"><div style="color:#888">Cache Read</div><div style="color:#fff">${fmtT(total.cacheReadTokens)}</div></div>
        <div style="background:#2a2a2a;padding:6px;border-radius:6px"><div style="color:#888">Output</div><div style="color:#fff">${fmtT(total.outputTokens)}</div></div>
        <div style="background:#2a2a2a;padding:6px;border-radius:6px"><div style="color:#888">成本(近30天)</div><div style="color:#fff">$${cost30d.toFixed(2)}</div></div>
      </div>
      <div style="font-size:10px;color:#888;margin-bottom:4px">Go 限额对比（仅明细 30d）· 5h $${cost24h.toFixed(2)}/$12 · 7d $${cost7d.toFixed(2)}/$30 · 30d $${cost30d.toFixed(2)}/$60</div>
      ${sections.join("")}
      <div style="display:flex;gap:8px;margin-top:6px;font-size:10px;color:#888">
        <span>明细 ${detail.length} 条(30d) + 汇总 ${summary.length} 条</span>
        <span>截至: ${maxTC ? new Date(maxTC).toLocaleDateString() : "-"}</span>
      </div>`
  }

  // ---------- UI ----------
  async function setStatus(btn, text) {
    if (btn) btn.textContent = text
    const info = $q("#oc-go-export-info")
    if (info) {
      const wsData = await getWorkspaceData().catch(() => emptyRec())
      const last = wsData.lastSync ? new Date(wsData.lastSync).toLocaleString() : "无"
      info.textContent = `明细 ${wsData.detail.length} / 汇总 ${wsData.summary.length} 条 · 上次同步：${last}`
      renderPanel(wsData.detail, wsData.summary)
    }
  }

  function inject() {
    if (document.getElementById("oc-go-export")) return
    pruneStale()

    const bar = document.createElement("div")
    bar.id = "oc-go-export"
    Object.assign(bar.style, {
      position: "fixed",
      top: "12px",
      right: "12px",
      zIndex: 999999,
      display: "flex",
      flexDirection: "column",
      gap: "6px",
      padding: "10px",
      background: "#1e1e1e",
      border: "1px solid rgba(255,255,255,.15)",
      borderRadius: "10px",
      boxShadow: "0 4px 16px rgba(0,0,0,.3)",
      maxWidth: "340px",
    })

    const mkBtn = (label, primary) => {
      const b = document.createElement("button")
      b.textContent = label
      Object.assign(b.style, {
        padding: "8px 12px",
        fontSize: "13px",
        fontWeight: 600,
        color: "#fff",
        background: primary ? "#e84c3d" : "#333",
        border: "none",
        borderRadius: "7px",
        cursor: "pointer",
        fontFamily: "inherit",
      })
      return b
    }

    const btnFull = mkBtn("全量抓取", true)
    const btnInc = mkBtn("增量抓取", false)
    const btnRefresh = mkBtn("刷新面板", false)
    const btnAuto = mkBtn("自动同步: 开", false)
    const btnClear = mkBtn("清空缓存", false)
    btnAuto.textContent = `自动同步: ${autoEnabled() ? "开" : "关"}`
    const info = document.createElement("div")
    info.id = "oc-go-export-info"
    Object.assign(info.style, { color: "#aaa", fontSize: "12px", lineHeight: "1.4" })

    const panel = document.createElement("div")
    panel.id = "oc-go-export-panel"
    Object.assign(panel.style, {
      maxHeight: "460px",
      overflowY: "auto",
      borderTop: "1px solid rgba(255,255,255,.1)",
      paddingTop: "6px",
      fontSize: "12px",
    })

    const guard = (fn) => () => {
      const buttons = [btnFull, btnInc, btnRefresh, btnAuto, btnClear]
      buttons.forEach((b) => (b.disabled = true))
      Promise.race([
        fn(),
        new Promise((res) => setTimeout(() => res("timeout"), 10 * 60 * 1000)),
      ])
        .catch((e) => {
          setStatus(btnFull, "出错: " + e.message)
          console.error(e)
        })
        .finally(() => buttons.forEach((b) => (b.disabled = false)))
    }

    btnFull.addEventListener("click", guard(() => run("full", btnFull)))
    btnInc.addEventListener("click", guard(() => run("incremental", btnInc)))
    btnRefresh.addEventListener("click", guard(async () => setStatus(btnRefresh, "已刷新")))
    btnAuto.addEventListener("click", () => {
      setAuto(!autoEnabled())
      btnAuto.textContent = `自动同步: ${autoEnabled() ? "开" : "关"}`
    })
    btnClear.addEventListener("click", guard(async () => {
      await idbDelete(WS_ID)
      setStatus(btnClear, "已清空")
    }))

    bar.append(btnFull, btnInc, btnRefresh, btnAuto, btnClear, info, panel)
    document.body.appendChild(bar)
    setStatus(null, "就绪")

    if (autoEnabled()) {
      waitFor(() => !!$q('[data-slot="usage-table-element"] tbody tr'), 15000).then(async () => {
        const wsData = await getWorkspaceData()
        if (!wsData.lastSync || Date.now() - wsData.lastSync > AUTO_GAP_MS) {
          setStatus(btnInc, "自动增量同步中…")
          run("incremental", btnInc, { silent: true, downloadFiles: false }).catch(() => {}).finally(() => touch())
        } else touch()
      })
    } else touch()
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", inject)
  else inject()
})()
