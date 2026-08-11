// ==UserScript==
// @name         OpenCode Go 用量导出 CSV
// @namespace    opencode.go-usage-export
// @version      5.6.0
// @run-at       document-start
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
  const CONC = 1 // 顺序拉页，避免短时间大量 /_server 请求
  const AUTO_GAP_MS = 6 * 3600e3
  const STALE_MS = 30 * 24 * 3600e3
  const WINDOW_MS = 30 * 24 * 3600e3 // 明细保留窗口
  const SET_KEY = "oc-go-usage-auto"
  const SETTINGS_KEY = "oc-go-export-settings-v1"
  const PANEL_OPEN_KEY = "oc-go-export-open"
  const DEFAULT_SETTINGS = {
    displayMode: "compact",
    autoSync: true,
    clickOutsideClose: true,
    exportPresetDays: 30,
    exportSectionOpen: true,
    overviewOpen: true,
    dimensionsOpen: true,
    pageGapMs: 350,
    topKeyCount: 5,
    topModelCount: 6,
  }
  const API_KEYS_SERVER_ID = "c22cd964237ba79f2f9b95faa2a14b804f870d1bab49279463379cc6a0fd0c85"
  const API_KEYS_SERVER_INSTANCE = "server-fn:4"
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
  let settingsCache = null

  function loadSettings() {
    if (settingsCache) return settingsCache
    const s = { ...DEFAULT_SETTINGS }
    try {
      const raw = localStorage.getItem(SETTINGS_KEY)
      if (raw) Object.assign(s, JSON.parse(raw))
    } catch {}
    if (!localStorage.getItem(SETTINGS_KEY)) {
      const oldAuto = localStorage.getItem(SET_KEY)
      if (oldAuto !== null) s.autoSync = oldAuto !== "0"
    }
    settingsCache = s
    return s
  }

  function saveSettings(partial) {
    settingsCache = { ...loadSettings(), ...partial }
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settingsCache))
    localStorage.setItem(SET_KEY, settingsCache.autoSync ? "1" : "0")
    return settingsCache
  }

  function getPageGapMs() {
    const ms = loadSettings().pageGapMs
    return ms === 250 || ms === 350 || ms === 500 ? ms : DEFAULT_SETTINGS.pageGapMs
  }

  const autoEnabled = () => loadSettings().autoSync
  const setAuto = (v) => saveSettings({ autoSync: v })
  const panelOpen = () => localStorage.getItem(PANEL_OPEN_KEY) === "1"
  const setPanelOpen = (v) => localStorage.setItem(PANEL_OPEN_KEY, v ? "1" : "0")

  function applyDisplayMode(mode) {
    const root = document.getElementById("oc-go-export-root")
    const backdrop = document.getElementById("oc-go-export-backdrop")
    const btnExpand = document.getElementById("oc-go-export-expand")
    if (!root) return
    const m = mode || loadSettings().displayMode
    root.classList.toggle("oc-mode-large", m === "large")
    root.classList.toggle("oc-mode-compact", m !== "large")
    if (backdrop) backdrop.hidden = m !== "large" || !root.classList.contains("oc-open")
    if (btnExpand) {
      btnExpand.textContent = m === "large" ? "⤡" : "⤢"
      btnExpand.title = m === "large" ? "切换紧凑模式" : "切换大窗口"
    }
    syncSettingsUI()
  }

  function syncSettingsUI() {
    const s = loadSettings()
    const setVal = (sel, val) => {
      const el = $q(sel)
      if (!el) return
      if (el.type === "checkbox") el.checked = !!val
      else el.value = String(val)
    }
    const setRadio = (name, val) => {
      const el = $q(`input[name="${name}"][value="${val}"]`)
      if (el) el.checked = true
    }
    setRadio("oc-display-mode", s.displayMode)
    setVal("#oc-set-click-outside", s.clickOutsideClose)
    setVal("#oc-set-auto-sync", s.autoSync)
    setRadio("oc-export-preset", String(s.exportPresetDays))
    setVal("#oc-set-export-open", s.exportSectionOpen)
    setVal("#oc-set-overview-open", s.overviewOpen)
    setVal("#oc-set-dimensions-open", s.dimensionsOpen)
    setVal("#oc-set-page-gap", s.pageGapMs)
    setVal("#oc-set-top-model", s.topModelCount)
    setVal("#oc-set-top-key", s.topKeyCount)
    const meta = $q("#oc-set-meta")
    if (meta) {
      getWorkspaceData()
        .then((ws) => {
          const last = ws.lastSync ? new Date(ws.lastSync).toLocaleString() : "无"
          meta.textContent = `Workspace: ${WS_ID} · 上次同步: ${last}`
        })
        .catch(() => {
          meta.textContent = `Workspace: ${WS_ID}`
        })
    }
  }

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

  const emptyRec = () => ({ id: WS_ID, detail: [], summary: [], keyNames: {}, lastSync: null, lastAccess: null, lastKeySync: null })

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
    return { ...emptyRec(), ...rec, keyNames: rec.keyNames || {} }
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

  // ---------- 网络层拦截（SolidStart /_server + 旧版路径） ----------
  let observed = null

  function headerObj(h) {
    const headers = {}
    if (h instanceof Headers) h.forEach((v, k) => (headers[k] = v))
    else if (h && typeof h === "object") Object.assign(headers, h)
    return headers
  }

  function serovalWireToArray(parsed) {
    const node = parsed?.t
    if (!node || node.t !== 9 || !Array.isArray(node.a)) return null
    return node.a.map((item) => (item && typeof item === "object" && "s" in item ? item.s : item))
  }

  function decodeArgs(raw) {
    if (raw == null || raw === "") return null
    let text = String(raw)
    try {
      text = decodeURIComponent(text)
    } catch {}
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) return parsed
      const fromWire = serovalWireToArray(parsed)
      if (fromWire) return fromWire
    } catch {}
    const m = text.match(/\$R\[\d+\]=(.+)$/)
    if (m) {
      try {
        return Function(`"use strict"; return (${m[1]})`)()
      } catch {}
    }
    return null
  }

  function usageArgs(args) {
    // usage.list(workspaceID, page) — 仅 2 个参数；4 参数是图表 getCosts，应忽略
    if (!Array.isArray(args) || args.length !== 2) return null
    const [ws, page] = args
    if (typeof ws !== "string" || !/^wrk_/.test(ws) || ws !== WS_ID) return null
    if (typeof page !== "number" || !Number.isInteger(page) || page < 0) return null
    return { ws, page }
  }

  function maybeCapture(method, url, headers, body) {
    if (!url || observed) return
    const u = String(url)
    const isServer = /\/_server(?:\?|$)/.test(u)
    const isLegacy = /workspace\/.+\/usage/.test(u)
    if (!isServer && !isLegacy) return

    let args = null
    if (isServer) {
      if (method === "GET") {
        try {
          const q = new URL(u, location.origin)
          args = decodeArgs(q.searchParams.get("args"))
        } catch {}
      } else if (body != null) {
        args = decodeArgs(body)
      }
      if (!usageArgs(args)) return
      observed = { kind: "server", method, url: u, headers, body: body == null ? null : String(body), args }
      return
    }

    if (method === "POST") {
      observed = { kind: "legacy", method, url: u, headers, body: body == null ? null : String(body), args: null }
    }
  }

  const origFetch = window.fetch.bind(window)
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : input?.url
    const method = (init?.method || input?.method || "GET").toUpperCase()
    let body = null
    try {
      if (init?.body != null) body = String(init.body)
      else if (input instanceof Request && method !== "GET" && method !== "HEAD") body = await input.clone().text()
    } catch {}
    maybeCapture(method, url, headerObj(init?.headers || input?.headers), body)
    return origFetch(input, init)
  }

  const origXHROpen = XMLHttpRequest.prototype.open
  const origXHRSend = XMLHttpRequest.prototype.send
  const origXHRSetHeader = XMLHttpRequest.prototype.setRequestHeader
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__ocMethod = String(method || "GET").toUpperCase()
    this.__ocUrl = String(url)
    this.__ocHeaders = {}
    return origXHROpen.call(this, method, url, ...rest)
  }
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    this.__ocHeaders = this.__ocHeaders || {}
    this.__ocHeaders[name] = value
    return origXHRSetHeader.call(this, name, value)
  }
  XMLHttpRequest.prototype.send = function (body) {
    maybeCapture(this.__ocMethod || "GET", this.__ocUrl, this.__ocHeaders || {}, body == null ? null : String(body))
    return origXHRSend.call(this, body)
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
  function patchPageArg(raw, page) {
    if (raw == null) return null
    let text = String(raw)
    try {
      text = decodeURIComponent(text)
    } catch {}
    try {
      const parsed = JSON.parse(text)
      if (parsed?.t?.t === 9 && Array.isArray(parsed.t.a) && parsed.t.a.length >= 2) {
        const last = parsed.t.a[parsed.t.a.length - 1]
        if (last?.t === 0 && typeof last.s === "number") {
          last.s = page
          return JSON.stringify(parsed)
        }
      }
      if (Array.isArray(parsed) && parsed.length >= 2 && typeof parsed[0] === "string") {
        parsed[parsed.length - 1] = page
        return JSON.stringify(parsed)
      }
    } catch {}
    const m = text.match(/^(\$R\[\d+\]=\["wrk_[^"]+",)\d+(\])/)
    if (m) return text.replace(m[0], `${m[1]}${page}${m[2]}`)
    return null
  }

  function pageBody(body, page) {
    return patchPageArg(body, page)
  }

  function pageUrl(url, page) {
    const u = new URL(url, location.origin)
    const argsRaw = u.searchParams.get("args")
    if (!argsRaw) return null
    let decoded = argsRaw
    try {
      decoded = decodeURIComponent(argsRaw)
    } catch {}
    const patched = patchPageArg(decoded, page)
    if (!patched) return null
    u.searchParams.set("args", encodeURIComponent(patched))
    return u.toString()
  }

  function parsePayload(text) {
    if (!text) return null
    try {
      const json = JSON.parse(text)
      if (json && typeof json === "object") return json
    } catch {}
    const src = String(text).trim()
    if (src.includes("$R")) {
      try {
        const self = { $R: {} }
        const code = src.replace(/^;[0-9a-fA-Fx]+;/, "")
        Function("self", "$R", code)(self, self.$R)
        return self.$R
      } catch {}
      const m = src.match(/\$R\[0\]=(.+)$/)
      if (m) {
        try {
          return Function(`"use strict"; return (${m[1]})`)()
        } catch {}
      }
    }
    return null
  }

  function apiKeyQueryArgs(workspaceID) {
    return encodeURIComponent(
      JSON.stringify({
        t: { t: 9, i: 0, l: 1, a: [{ t: 1, s: workspaceID }], o: 0 },
        f: 31,
        m: [],
      }),
    )
  }

  function collectKnownKeyIDs(detail, summary) {
    return [...new Set([...detail.map((r) => r.keyID), ...summary.map((r) => r.keyID)].filter(Boolean))]
  }

  function keyDisplayName(keyID, keyNames) {
    return keyID ? keyNames?.[keyID] || "" : ""
  }

  function keyLabel(keyID, plan = "", keyNames = {}) {
    if (!keyID) return "未标识(dom)"
    const name = keyDisplayName(keyID, keyNames)
    const suffix = keyID.slice(-6)
    const base = name ? `${name} · ${suffix}` : suffix
    return plan ? `${base} (${plan})` : base
  }

  function extractApiKeyNames(payload, knownIDs = []) {
    const known = new Set(knownIDs)
    const names = {}
    const seen = new Set()
    const stack = [payload]

    while (stack.length) {
      const cur = stack.pop()
      if (!cur || typeof cur !== "object" || seen.has(cur)) continue
      seen.add(cur)

      if (Array.isArray(cur)) {
        for (const item of cur) stack.push(item)
        continue
      }

      const candidateID =
        (typeof cur.id === "string" && cur.id) ||
        (typeof cur.keyID === "string" && cur.keyID) ||
        (typeof cur.keyId === "string" && cur.keyId) ||
        (typeof cur.apiKeyID === "string" && cur.apiKeyID) ||
        (typeof cur.apiKeyId === "string" && cur.apiKeyId)
      const candidateName =
        (typeof cur.name === "string" && cur.name) ||
        (typeof cur.label === "string" && cur.label) ||
        (typeof cur.title === "string" && cur.title)

      if (candidateID && candidateName && known.has(candidateID)) {
        names[candidateID] = candidateName.trim()
      }
      for (const value of Object.values(cur)) stack.push(value)
    }
    return names
  }

  async function fetchApiKeyNames(knownIDs) {
    if (!knownIDs.length) return {}
    const url = `${location.origin}/_server?id=${API_KEYS_SERVER_ID}&args=${apiKeyQueryArgs(WS_ID)}`
    const res = await origFetch(url, {
      method: "GET",
      headers: {
        accept: "*/*",
        "x-server-id": API_KEYS_SERVER_ID,
        "x-server-instance": API_KEYS_SERVER_INSTANCE,
      },
      credentials: "include",
    })
    if (!res.ok) throw new Error("获取 key 名称失败: HTTP " + res.status)
    const payload = parsePayload(await res.text())
    const names = extractApiKeyNames(payload, knownIDs)
    if (!Object.keys(names).length) throw new Error("接口已返回，但未解析到 API key 名称")
    return names
  }

  async function refreshApiKeyNames() {
    const wsData = await getWorkspaceData()
    const knownIDs = collectKnownKeyIDs(wsData.detail, wsData.summary)
    if (!knownIDs.length) {
      setStatus(null, "暂无带 keyID 的数据，请先抓取 network 明细")
      return
    }
    setStatus(null, "更新 API key 名称中…")
    const names = await fetchApiKeyNames(knownIDs)
    const next = { ...wsData, keyNames: { ...(wsData.keyNames || {}), ...names }, lastKeySync: Date.now(), lastAccess: Date.now() }
    await saveWorkspaceData(next)
    renderPanel(next.detail, next.summary, next.keyNames)
    setStatus(null, `已更新 ${Object.keys(names).length} 个 API key 名称`)
  }

  let fetchGate = Promise.resolve()
  let lastFetchAt = 0
  function throttleFetch() {
    fetchGate = fetchGate.then(async () => {
      const wait = getPageGapMs() - (Date.now() - lastFetchAt)
      if (wait > 0) await sleep(wait)
      lastFetchAt = Date.now()
    })
    return fetchGate
  }

  async function fetchPage(page) {
    await throttleFetch()
    if (!observed) throw new Error("未捕获到服务端请求")
    const headers = {}
    for (const [k, v] of Object.entries(observed.headers || {})) {
      if (/^(content-length|host|connection|transfer-encoding)$/i.test(k)) continue
      headers[k] = v
    }

    let url = observed.url
    let method = observed.method || "POST"
    let body = observed.body

    if (observed.kind === "server") {
      if (observed.method === "GET") {
        url = pageUrl(observed.url, page) || observed.url
        method = "GET"
        body = null
      } else {
        method = "POST"
        body = pageBody(observed.body, page)
        if (!body) throw new Error("无法构造分页请求")
      }
    } else {
      let args
      try {
        const parsed = JSON.parse(observed.body || "")
        args = Array.isArray(parsed) ? parsed : parsed.args
      } catch {
        args = null
      }
      if (!Array.isArray(args)) throw new Error("无法解析请求参数")
      method = "POST"
      body = JSON.stringify({ args: [args[0], page] })
    }

    const res = await origFetch(url, { method, headers, body: body ?? undefined })
    if (!res.ok) throw new Error("HTTP " + res.status)
    const json = parsePayload(await res.text())
    const rows = extractRows(json)
    return (rows || []).map(norm)
  }

  async function ensureObserved() {
    if (observed) return true
    await waitFor(() => observed, 1500)
    if (observed) return true

    const clickNext = async () => {
      const btns = $qa('[data-slot="pagination"] button')
      if (btns.length < 2 || btns[1].disabled) return false
      const first = $q('[data-slot="usage-table-element"] tbody tr')?.textContent ?? ""
      btns[1].click()
      await waitFor(() => observed || $q('[data-slot="usage-table-element"] tbody tr')?.textContent !== first, 5000)
      return !!observed
    }

    if (await clickNext()) return true

    const btns = $qa('[data-slot="pagination"] button')
    if (btns.length >= 2 && !btns[0].disabled) {
      btns[0].click()
      await sleep(400)
      if (await clickNext()) return true
    }

    await waitFor(() => observed, 3000)
    return !!observed
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
    const concurrency = minTime > 0 ? 1 : CONC
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

  function rawRows(rows, keyNames = {}) {
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
        keyName: keyDisplayName(r.keyID, keyNames),
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
  function exportXLSX(detail, summary, tag = "", keyNames = {}) {
    if (typeof XLSX === "undefined") return false
    const wb = XLSX.utils.book_new()
    const add = (name, data, cols) => {
      const ws = XLSX.utils.aoa_to_sheet([cols, ...data.map((r) => cols.map((c) => r[c]))])
      XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31))
    }
    const raw = rawRows(detail, keyNames)
    add("raw", raw, Object.keys(raw[0] || {}))
    add("by-model", mergedAggs(detail, summary, (s) => s.model, (r) => r.model), AGG_COLS)
    add("by-date", mergedAggs(detail, summary, (s) => s.date, dateKey), AGG_COLS)
    add("by-key", mergedAggs(detail, summary, (s) => keyLabel(s.keyID, s.plan, keyNames), (r) => keyLabel(r.keyID, r.plan, keyNames)), AGG_COLS)
    add("by-plan", mergedAggs(detail, summary, (s) => s.plan || "pay-as-you-go", (r) => r.plan || "pay-as-you-go"), AGG_COLS)
    XLSX.writeFile(wb, `go-usage${tag}-${new Date().toISOString().slice(0, 10)}.xlsx`)
    return true
  }

  function isoDateLocal(d) {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, "0")
    const day = String(d.getDate()).padStart(2, "0")
    return `${y}-${m}-${day}`
  }

  function parseDateInput(val, endOfDay = false) {
    if (!val) return null
    const d = new Date(`${val}T00:00:00`)
    if (endOfDay) d.setHours(23, 59, 59, 999)
    return d.getTime()
  }

  function filterByRange(detail, summary, fromMs, toMs) {
    const fd = detail.filter((r) => {
      if (!r.timeCreated) return !fromMs && !toMs
      if (fromMs && r.timeCreated < fromMs) return false
      if (toMs && r.timeCreated > toMs) return false
      return true
    })
    const fs = summary.filter((s) => {
      const t = Date.parse(s.date)
      if (Number.isNaN(t)) return !fromMs && !toMs
      if (fromMs && t < fromMs) return false
      if (toMs && t > toMs) return false
      return true
    })
    return { detail: fd, summary: fs }
  }

  function exportTag(fromVal, toVal) {
    if (fromVal && toVal) return `_${fromVal}_${toVal}`
    if (fromVal) return `_from-${fromVal}`
    if (toVal) return `_to-${toVal}`
    return "_all"
  }

  async function doExport(format = "csv") {
    const fromEl = $q("#oc-export-from")
    const toEl = $q("#oc-export-to")
    const fromVal = fromEl?.value || ""
    const toVal = toEl?.value || ""
    const fromMs = parseDateInput(fromVal)
    const toMs = parseDateInput(toVal, true)
    const wsData = await getWorkspaceData()
    const keyNames = wsData.keyNames || {}
    const { detail, summary } = filterByRange(wsData.detail, wsData.summary || [], fromMs, toMs)
    if (!detail.length && !summary.length) {
      setStatus(null, "所选区间无数据")
      return
    }
    const tag = exportTag(fromVal, toVal)
    const ts = new Date().toISOString().slice(0, 10)
    if (format === "xlsx") {
      if (!exportXLSX(detail, summary, tag, keyNames)) {
        setStatus(null, "SheetJS 未加载，请用 CSV")
        return
      }
    } else {
      const raw = rawRows(detail, keyNames)
      download(`go-usage-raw${tag}-${ts}.csv`, toCSV(raw, Object.keys(raw[0] || {})))
      download(`go-usage-by-model${tag}-${ts}.csv`, toCSV(mergedAggs(detail, summary, (s) => s.model, (r) => r.model), AGG_COLS))
      download(`go-usage-by-date${tag}-${ts}.csv`, toCSV(mergedAggs(detail, summary, (s) => s.date, dateKey), AGG_COLS))
      download(`go-usage-by-key${tag}-${ts}.csv`, toCSV(mergedAggs(detail, summary, (s) => keyLabel(s.keyID, s.plan, keyNames), (r) => keyLabel(r.keyID, r.plan, keyNames)), AGG_COLS))
      download(`go-usage-by-plan${tag}-${ts}.csv`, toCSV(mergedAggs(detail, summary, (s) => s.plan || "pay-as-you-go", (r) => r.plan || "pay-as-you-go"), AGG_COLS))
    }
    setStatus(null, `已导出：明细 ${detail.length} 条 · 汇总 ${summary.length} 组 · ${fromVal || "…"} ~ ${toVal || "…"}`)
  }

  function setExportRange(days) {
    const to = new Date()
    const from = new Date()
    if (days === "all") {
      from.setFullYear(2000, 0, 1)
    } else {
      from.setDate(from.getDate() - Number(days))
    }
    const fromEl = $q("#oc-export-from")
    const toEl = $q("#oc-export-to")
    if (fromEl) fromEl.value = isoDateLocal(from)
    if (toEl) toEl.value = isoDateLocal(to)
    $qa(".oc-export-presets button").forEach((b) => b.classList.toggle("oc-active", b.dataset.range === String(days)))
  }
  const mergedAggs = (detail, summary, sumKey, detKey) => mergeAgg(sumAggregate(summary, sumKey), aggregate(detail, detKey))

  // ---------- 主流程 ----------
  async function run(mode, btn, opts = {}) {
    const { downloadFiles = false } = opts
    const wsData = await getWorkspaceData()
    const now = Date.now()
    const cutoff = now - WINDOW_MS
    const maxStored = Math.max(0, ...wsData.detail.map((r) => r.timeCreated || 0))
    const mergedMap = new Map(wsData.detail.map((r) => [keyOf(r), r]))

    let rows, source
    let fetchAll = null
    try {
      if (await ensureObserved()) fetchAll = (onP) => fetchPages(onP, mode === "incremental" ? maxStored : 0)
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
    await saveWorkspaceData({ ...wsData, id: WS_ID, detail, summary, lastSync: now, lastAccess: now })
    renderPanel(detail, summary, wsData.keyNames || {})

    if (downloadFiles) await doExport("csv")

    const btns = $qa('[data-slot="pagination"] button')
    if (btns.length >= 2 && !btns[0].disabled) btns[0].click()

    setStatus(
      btn,
      `${mode === "incremental" ? "增量" : "全量"}完成：${source} 源 · 新增 ${added} 条 · 明细 ${detail.length} / 汇总 ${summary.length}` +
        (dupTotal > 0 ? ` · 去重 ${dupTotal} 条` : ""),
    )
  }

  // ---------- 面板 ----------
  function renderPanel(detail, summary, keyNames = {}) {
    const panel = $q("#oc-go-export-panel")
    const body = $q("#oc-go-export-body")
    if (!panel) return

    const settings = loadSettings()
    const foldState = {}
    panel.querySelectorAll("details.oc-fold").forEach((el, i) => {
      foldState[el.querySelector("summary")?.textContent?.trim() || i] = el.open
    })
    const scrollTop = body?.scrollTop ?? 0

    const now = Date.now()
    const sumF = (list, f) => list.reduce((a, r) => a + (r[f] ?? 0), 0)
    const sumCost = (list) => list.reduce((a, r) => a + (r.costUSD ?? 0), 0)
    const cost5h = sumCost(detail.filter((r) => r.timeCreated && now - r.timeCreated < 5 * 3600e3))
    const cost7d = sumCost(detail.filter((r) => r.timeCreated && now - r.timeCreated < 7 * 24 * 3600e3))
    const cost30d = sumCost(detail)

    const total = {
      requests: detail.length + sumF(summary, "requests"),
      inputTokens: sumF(detail, "inputTokens") + sumF(summary, "inputTokens"),
      cacheReadTokens: sumF(detail, "cacheReadTokens") + sumF(summary, "cacheReadTokens"),
      outputTokens: sumF(detail, "outputTokens") + sumF(summary, "outputTokens"),
    }
    const byModel = mergedAggs(detail, summary, (s) => s.model, (r) => r.model).slice(0, settings.topModelCount)
    const byKey = mergedAggs(detail, summary, (s) => keyLabel(s.keyID, s.plan, keyNames), (r) => keyLabel(r.keyID, r.plan, keyNames)).slice(0, settings.topKeyCount)
    const byPlan = mergedAggs(detail, summary, (s) => s.plan || "pay-as-you-go", (r) => r.plan || "pay-as-you-go")

    const fmtT = (n) => {
      if (n == null) return "-"
      if (n >= 1e6) return (n / 1e6).toFixed(2) + "M"
      if (n >= 1e3) return (n / 1e3).toFixed(1) + "k"
      return String(n)
    }
    const fmtD = (t) => (t ? new Date(t).toLocaleDateString() : "-")
    const minTC = detail.some((r) => r.timeCreated) ? Math.min(...detail.map((r) => r.timeCreated)) : null
    const maxTC = detail.some((r) => r.timeCreated) ? Math.max(...detail.map((r) => r.timeCreated)) : null
    const winStart = now - WINDOW_MS

    const barRow = (label, metric, max, cost, unit = "") =>
      `<div class="oc-bar-row">
        <div class="oc-bar-meta">
          <span class="oc-bar-label" title="${String(label).replace(/"/g, "&quot;")}">${label}</span>
          <span class="oc-bar-cost">${cost != null ? "$" + cost.toFixed(2) : ""}</span>
        </div>
        <div class="oc-bar-body">
          <div class="oc-bar-track"><div class="oc-bar-fill" style="width:${max ? Math.max(4, (metric / max) * 100) : 0}%"></div></div>
          <span class="oc-bar-val">${fmtT(metric)}${unit}</span>
        </div>
      </div>`

    const quotaRow = (label, spent, limit) => {
      const pct = limit ? Math.min(100, (spent / limit) * 100) : 0
      const cls = pct >= 90 ? "oc-quota-warn" : pct >= 70 ? "oc-quota-mid" : ""
      return `<div class="oc-quota-row">
        <div class="oc-quota-meta"><span>${label}</span><span class="oc-quota-num">$${spent.toFixed(2)} / $${limit}</span></div>
        <div class="oc-quota-track"><div class="oc-quota-fill ${cls}" style="width:${Math.max(2, pct)}%"></div></div>
      </div>`
    }

    const dimFolds = []
    const dimOpen = settings.dimensionsOpen ? " open" : ""
    if (byModel.length) {
      const maxTok = byModel[0].inputTokens + byModel[0].cacheReadTokens + byModel[0].outputTokens
      dimFolds.push(`<details class="oc-fold oc-dim-fold"${dimOpen}>
        <summary>按模型 · ${byModel.length}</summary>
        <div class="oc-fold-body">${byModel.map((m) => barRow(m.key, m.inputTokens + m.cacheReadTokens + m.outputTokens, maxTok, m.costUSD, " tok")).join("")}</div>
      </details>`)
    }
    if (byKey.length) {
      const keyMax = Math.max(...byKey.map((m) => m.requests))
      dimFolds.push(`<details class="oc-fold oc-dim-fold"${dimOpen}>
        <summary>按 API key · ${byKey.length}</summary>
        <div class="oc-fold-body">${byKey.map((m) => barRow(m.key, m.requests, keyMax, m.costUSD, " 次")).join("")}</div>
      </details>`)
    }
    if (byPlan.length) {
      dimFolds.push(`<details class="oc-fold oc-dim-fold"${dimOpen}>
        <summary>按 plan · ${byPlan.length}</summary>
        <div class="oc-fold-body">${byPlan.map((m) => `<div class="oc-plan-row">${m.key}: ${m.requests} 次 · $${m.costUSD.toFixed(2)} · ${fmtT(m.inputTokens + m.cacheReadTokens + m.outputTokens)} tok</div>`).join("")}</div>
      </details>`)
    }

    const overviewOpen = settings.overviewOpen ? " open" : ""
    panel.innerHTML = `
      <details class="oc-fold"${overviewOpen}>
        <summary>概览</summary>
        <div class="oc-fold-body">
          <div class="oc-period">
            <div class="oc-period-line"><span class="oc-period-k">统计窗口</span>${fmtD(winStart)} ~ ${fmtD(now)}（近 30 天明细）</div>
            <div class="oc-period-line"><span class="oc-period-k">数据范围</span>${minTC ? `${fmtD(minTC)} ~ ${fmtD(maxTC)}` : "暂无明细"}${summary.length ? ` · 汇总 ${summary.length} 组` : ""}</div>
          </div>
          <div class="oc-panel-head">
            <span class="oc-muted">共 ${total.requests.toLocaleString()} 次请求</span>
          </div>
          <div class="oc-stat-grid">
            <div class="oc-stat"><div class="oc-stat-k">Input</div><div class="oc-stat-v">${fmtT(total.inputTokens)}</div></div>
            <div class="oc-stat"><div class="oc-stat-k">Cache Read</div><div class="oc-stat-v">${fmtT(total.cacheReadTokens)}</div></div>
            <div class="oc-stat"><div class="oc-stat-k">Output</div><div class="oc-stat-v">${fmtT(total.outputTokens)}</div></div>
            <div class="oc-stat"><div class="oc-stat-k">成本(近30天)</div><div class="oc-stat-v">$${cost30d.toFixed(2)}</div></div>
          </div>
          <div class="oc-quota-block">
            <div class="oc-section-label">Go 限额（近 30 天明细）</div>
            ${quotaRow("5 小时", cost5h, 12)}
            ${quotaRow("7 天", cost7d, 30)}
            ${quotaRow("30 天", cost30d, 60)}
          </div>
          <div class="oc-panel-foot">
            <span>明细 ${detail.length.toLocaleString()} 条 + 汇总 ${summary.length.toLocaleString()} 组</span>
            <span>已命名 key ${Object.keys(keyNames || {}).length} 个</span>
          </div>
        </div>
      </details>
      <div class="oc-dim-grid">${dimFolds.join("") || '<div class="oc-muted oc-empty">暂无维度数据，请先抓取</div>'}</div>`

    panel.querySelectorAll("details.oc-fold").forEach((el, i) => {
      const key = el.querySelector("summary")?.textContent?.trim() || i
      if (key in foldState) el.open = foldState[key]
      else if (key.startsWith("概览")) el.open = settings.overviewOpen
      else if (el.classList.contains("oc-dim-fold")) el.open = settings.dimensionsOpen
    })
    if (body) body.scrollTop = scrollTop
  }

  // ---------- UI ----------
  function injectStyles() {
    let s = document.getElementById("oc-go-export-style")
    if (!s) {
      s = document.createElement("style")
      s.id = "oc-go-export-style"
      document.head.appendChild(s)
    }
    s.textContent = `
#oc-go-export-root{position:fixed;bottom:20px;right:20px;z-index:9000;font-family:inherit;font-size:13px;line-height:1.4}
#oc-go-export-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:8999;opacity:0;pointer-events:none;transition:opacity .18s}
#oc-go-export-root.oc-mode-large.oc-open #oc-go-export-backdrop{opacity:1;pointer-events:auto}
#oc-go-export-toggle{width:46px;height:46px;border-radius:23px;background:#e84c3d;color:#fff;border:1px solid rgba(255,255,255,.15);cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.35);font-weight:700;font-size:11px;letter-spacing:.02em;transition:transform .15s,background .15s}
#oc-go-export-toggle:hover{background:#d44335;transform:scale(1.04)}
#oc-go-export-root.oc-open #oc-go-export-toggle{background:#333;border-color:rgba(255,255,255,.2);font-size:18px;line-height:1}
#oc-go-export-drawer{position:absolute;bottom:54px;right:0;width:min(340px,calc(100vw - 40px));background:#141414;border:1px solid rgba(255,255,255,.12);border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.5);overflow:hidden;opacity:0;pointer-events:none;transform:translateY(8px) scale(.98);transform-origin:bottom right;transition:opacity .18s,transform .18s}
#oc-go-export-root.oc-mode-compact.oc-open #oc-go-export-drawer{opacity:1;pointer-events:auto;transform:none;max-height:min(88vh,680px);display:flex;flex-direction:column}
#oc-go-export-root.oc-mode-large #oc-go-export-drawer{position:fixed;top:50%;left:50%;bottom:auto;right:auto;width:min(720px,calc(100vw - 24px));max-height:90vh;transform:translate(-50%,-50%) scale(.98);transform-origin:center;z-index:9001}
#oc-go-export-root.oc-mode-large.oc-open #oc-go-export-drawer{opacity:1;pointer-events:auto;transform:translate(-50%,-50%);display:flex;flex-direction:column}
#oc-go-export-root.oc-busy #oc-go-export-info{color:#e84c3d}
.oc-drawer-head,.oc-actions,#oc-go-export-info,.oc-export-block,.oc-settings-block{flex-shrink:0}
#oc-go-export-body{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.25) rgba(255,255,255,.06)}
#oc-go-export-body::-webkit-scrollbar{width:6px}
#oc-go-export-body::-webkit-scrollbar-track{background:rgba(255,255,255,.06);border-radius:99px;margin:4px 0}
#oc-go-export-body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.28);border-radius:99px}
#oc-go-export-body::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.4)}
.oc-export-block{padding:0 12px;border-top:1px solid rgba(255,255,255,.08);border-bottom:1px solid rgba(255,255,255,.08)}
.oc-export-block.oc-fold>summary{padding:10px 0}
.oc-export-inner{padding-bottom:10px}
.oc-export-title{display:none}
.oc-export-presets{display:flex;gap:4px;margin-bottom:6px}
.oc-export-presets button{flex:1;padding:4px 0;font-size:10px;color:#ccc;background:#222;border:1px solid rgba(255,255,255,.08);border-radius:5px;cursor:pointer;font-family:inherit}
.oc-export-presets button.oc-active{color:#fff;background:#333;border-color:rgba(232,76,61,.5)}
.oc-export-dates{display:flex;align-items:center;gap:4px;margin-bottom:6px}
.oc-export-dates input{flex:1;min-width:0;padding:4px 6px;font-size:10px;color:#eee;background:#1a1a1a;border:1px solid rgba(255,255,255,.12);border-radius:5px;font-family:inherit}
.oc-export-dates span{color:#666;font-size:10px}
.oc-export-actions{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.oc-export-actions button{padding:6px 8px;font-size:11px;font-weight:600;color:#fff;background:#2a2a2a;border:1px solid rgba(255,255,255,.08);border-radius:6px;cursor:pointer;font-family:inherit}
.oc-export-actions button:hover{background:#363636}
.oc-export-actions button.oc-primary{background:#e84c3d;border-color:transparent}
.oc-export-actions button.oc-primary:hover{background:#d44335}
#oc-go-export-panel{padding:0 12px 10px;font-size:12px}
.oc-fold{border-top:1px solid rgba(255,255,255,.06)}
.oc-fold>summary{padding:10px 0;min-height:36px;font-size:12px;color:#ccc;cursor:pointer;user-select:none;list-style:none;display:flex;align-items:center;justify-content:space-between;gap:8px;font-weight:600}
.oc-fold>summary::-webkit-details-marker{display:none}
.oc-fold>summary::after{content:"▾";flex-shrink:0;display:flex;align-items:center;justify-content:center;width:32px;height:32px;font-size:16px;line-height:1;color:#bbb;background:rgba(255,255,255,.08);border-radius:8px;transition:transform .15s,background .15s,color .15s}
.oc-fold>summary:hover::after{background:rgba(255,255,255,.14);color:#fff}
.oc-fold:not([open])>summary::after{transform:rotate(-90deg)}
.oc-fold-body{padding-bottom:8px}
.oc-drawer-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px 8px;border-bottom:1px solid rgba(255,255,255,.08);gap:8px}
.oc-drawer-head b{font-size:13px;color:#fff;font-weight:600;flex:1;min-width:0}
.oc-head-actions{display:flex;align-items:center;gap:2px;flex-shrink:0}
.oc-head-btn{background:none;border:none;color:#888;cursor:pointer;font-size:16px;line-height:1;padding:4px 7px;border-radius:6px;min-width:32px;min-height:32px;display:flex;align-items:center;justify-content:center}
.oc-head-btn:hover{color:#fff;background:rgba(255,255,255,.08)}
.oc-drawer-close{font-size:18px}
.oc-settings-block{padding:0 12px;border-bottom:1px solid rgba(255,255,255,.08)}
.oc-settings-block.oc-fold>summary{padding:10px 0}
.oc-settings-inner{padding-bottom:10px;max-height:240px;overflow-y:auto}
.oc-settings-group{margin-bottom:10px}
.oc-settings-label{font-size:10px;color:#888;font-weight:600;margin-bottom:5px;text-transform:uppercase;letter-spacing:.03em}
.oc-settings-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:4px 0;font-size:11px;color:#ccc}
.oc-settings-radios{display:flex;gap:4px;flex-wrap:wrap}
.oc-settings-radios label{display:flex;align-items:center;gap:3px;font-size:10px;color:#bbb;cursor:pointer;padding:3px 6px;background:#222;border:1px solid rgba(255,255,255,.08);border-radius:5px}
.oc-settings-radios label:has(input:checked){color:#fff;background:#333;border-color:rgba(232,76,61,.4)}
.oc-settings-radios input{margin:0}
.oc-settings-row select,.oc-settings-row input[type=number]{padding:3px 6px;font-size:10px;color:#eee;background:#1a1a1a;border:1px solid rgba(255,255,255,.12);border-radius:5px;font-family:inherit;min-width:64px}
.oc-settings-row input[type=checkbox]{width:14px;height:14px;accent-color:#e84c3d;cursor:pointer}
.oc-settings-meta{font-size:10px;color:#666;line-height:1.45;margin-top:6px;word-break:break-all}
.oc-settings-advanced>summary{font-size:10px;color:#777;cursor:pointer;padding:4px 0;list-style:none}
.oc-settings-advanced>summary::-webkit-details-marker{display:none}
.oc-mode-large .oc-stat-grid{grid-template-columns:repeat(4,1fr)}
.oc-dim-grid{display:block}
.oc-mode-large .oc-dim-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start}
.oc-mode-large .oc-dim-grid .oc-empty{grid-column:1/-1}
.oc-mode-large .oc-actions{grid-template-columns:repeat(3,1fr)}
.oc-actions{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:10px 12px 8px}
.oc-actions button{padding:8px 10px;font-size:12px;font-weight:600;color:#fff;background:#2a2a2a;border:1px solid rgba(255,255,255,.08);border-radius:7px;cursor:pointer;font-family:inherit;transition:background .12s}
.oc-actions button.oc-danger{color:#f88;background:#2a1818;border-color:rgba(232,76,61,.25)}
.oc-actions button.oc-danger:hover:not(:disabled){background:#3a2020}
.oc-actions .oc-span2{grid-column:1/-1}
.oc-actions button:hover:not(:disabled){background:#363636}
.oc-actions button:disabled{opacity:.45;cursor:not-allowed}
.oc-actions button.oc-primary{background:#e84c3d;border-color:transparent}
.oc-actions button.oc-primary:hover:not(:disabled){background:#d44335}
#oc-go-export-info{padding:0 12px 8px;color:#999;font-size:11px;line-height:1.45;min-height:1.2em;word-break:break-word}
.oc-period{margin-bottom:8px;padding:8px;background:#1a1a1a;border:1px solid rgba(255,255,255,.06);border-radius:8px;font-size:10px;color:#aaa;line-height:1.5}
.oc-period-line{display:flex;gap:6px;align-items:baseline}
.oc-period-line+.oc-period-line{margin-top:3px}
.oc-period-k{color:#777;flex-shrink:0;min-width:52px}
.oc-panel-head{display:flex;align-items:center;justify-content:flex-end;margin-bottom:6px}
.oc-muted{font-size:10px;color:#888}
.oc-empty{padding:12px 0;text-align:center}
.oc-quota-block{margin-bottom:6px}
.oc-quota-row{margin:5px 0}
.oc-quota-meta{display:flex;justify-content:space-between;gap:8px;font-size:10px;color:#888;margin-bottom:3px}
.oc-quota-num{font-variant-numeric:tabular-nums;color:#aaa}
.oc-quota-track{height:5px;background:#2a2a2a;border-radius:99px;overflow:hidden}
.oc-quota-fill{height:100%;background:#4caf82;border-radius:99px;transition:width .2s}
.oc-quota-fill.oc-quota-mid{background:#e6a817}
.oc-quota-fill.oc-quota-warn{background:#e84c3d}
.oc-stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:6px}
.oc-stat{background:#1f1f1f;padding:6px 8px;border-radius:6px;border:1px solid rgba(255,255,255,.05)}
.oc-stat-k{font-size:10px;color:#888;margin-bottom:2px}
.oc-stat-v{font-size:12px;color:#fff;font-weight:600;font-variant-numeric:tabular-nums}
.oc-section-label{font-size:10px;color:#888;margin:4px 0 6px}
.oc-bar-row{margin:6px 0 8px}
.oc-bar-meta{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:4px;min-width:0}
.oc-bar-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#ddd;font-size:11px}
.oc-bar-cost{flex-shrink:0;color:#aaa;font-size:10px;font-variant-numeric:tabular-nums}
.oc-bar-body{display:flex;align-items:center;gap:8px}
.oc-bar-track{flex:1;height:6px;background:#2a2a2a;border-radius:99px;overflow:hidden;min-width:0}
.oc-bar-fill{height:100%;background:#e84c3d;border-radius:99px}
.oc-bar-val{flex-shrink:0;min-width:52px;text-align:right;color:#ccc;font-size:10px;font-variant-numeric:tabular-nums;white-space:nowrap}
.oc-plan-row{font-size:11px;color:#ddd;margin:2px 0}
.oc-panel-foot{display:flex;flex-wrap:wrap;gap:6px 10px;margin-top:6px;font-size:10px;color:#777}
@media(max-width:640px){#oc-go-export-root{bottom:14px;right:14px}#oc-go-export-root.oc-mode-compact #oc-go-export-drawer{width:min(300px,calc(100vw - 28px))}#oc-go-export-root.oc-mode-large #oc-go-export-drawer{width:min(720px,calc(100vw - 24px))}.oc-mode-large .oc-stat-grid{grid-template-columns:1fr 1fr}.oc-mode-large .oc-dim-grid{grid-template-columns:1fr}}`
  }

  function setDrawerOpen(open) {
    const root = document.getElementById("oc-go-export-root")
    const toggle = document.getElementById("oc-go-export-toggle")
    const backdrop = document.getElementById("oc-go-export-backdrop")
    if (!root || !toggle) return
    root.classList.toggle("oc-open", open)
    toggle.textContent = open ? "×" : "Go"
    toggle.title = open ? "收起面板" : "展开 Go 用量导出"
    if (backdrop) backdrop.hidden = loadSettings().displayMode !== "large" || !open
    setPanelOpen(open)
  }
  async function setStatus(btn, text) {
    const info = $q("#oc-go-export-info")
    const isProgress = text && /抓取中|同步中|页面抓取/.test(text)
    if (info && text) info.textContent = text
    if (btn && text && /出错|完成|抓取|同步|刷新|清空|就绪|失败|页面|导出|区间/.test(text)) {
      // 进度/结果写入 info，按钮标签保持不变
    } else if (btn && text) {
      btn.textContent = text
    }
    if (info && !isProgress) {
      const wsData = await getWorkspaceData().catch(() => emptyRec())
      if (!text || /就绪|已刷新/.test(text)) {
        const last = wsData.lastSync ? new Date(wsData.lastSync).toLocaleString() : "无"
        info.textContent = `明细 ${wsData.detail.length.toLocaleString()} / 汇总 ${wsData.summary.length.toLocaleString()} 组 · 上次同步：${last}`
      }
      renderPanel(wsData.detail, wsData.summary, wsData.keyNames || {})
    }
  }

  function inject() {
    if (document.getElementById("oc-go-export-root")) return
    pruneStale()
    loadSettings()
    injectStyles()

    const root = document.createElement("div")
    root.id = "oc-go-export-root"
    root.classList.add(loadSettings().displayMode === "large" ? "oc-mode-large" : "oc-mode-compact")

    const backdrop = document.createElement("div")
    backdrop.id = "oc-go-export-backdrop"
    backdrop.hidden = true

    const toggle = document.createElement("button")
    toggle.id = "oc-go-export-toggle"
    toggle.type = "button"
    toggle.textContent = "Go"
    toggle.title = "展开 Go 用量导出"

    const drawer = document.createElement("div")
    drawer.id = "oc-go-export-drawer"

    const head = document.createElement("div")
    head.className = "oc-drawer-head"
    head.innerHTML = `<b>Go 用量导出</b>`
    const headActions = document.createElement("div")
    headActions.className = "oc-head-actions"
    const btnExpand = document.createElement("button")
    btnExpand.id = "oc-go-export-expand"
    btnExpand.type = "button"
    btnExpand.className = "oc-head-btn"
    btnExpand.textContent = "⤢"
    btnExpand.title = "切换大窗口"
    const btnSettings = document.createElement("button")
    btnSettings.id = "oc-go-export-settings-btn"
    btnSettings.type = "button"
    btnSettings.className = "oc-head-btn"
    btnSettings.textContent = "⚙"
    btnSettings.title = "设置"
    const btnClose = document.createElement("button")
    btnClose.className = "oc-head-btn oc-drawer-close"
    btnClose.type = "button"
    btnClose.textContent = "×"
    btnClose.title = "收起"
    headActions.append(btnExpand, btnSettings, btnClose)
    head.appendChild(headActions)

    const settingsBlock = document.createElement("details")
    settingsBlock.id = "oc-go-export-settings"
    settingsBlock.className = "oc-settings-block oc-fold"
    settingsBlock.innerHTML = `
      <summary>设置</summary>
      <div class="oc-settings-inner">
        <div class="oc-settings-group">
          <div class="oc-settings-label">显示</div>
          <div class="oc-settings-row">
            <span>显示模式</span>
            <div class="oc-settings-radios">
              <label><input type="radio" name="oc-display-mode" value="compact" /> 紧凑</label>
              <label><input type="radio" name="oc-display-mode" value="large" /> 大窗口</label>
            </div>
          </div>
          <label class="oc-settings-row"><span>点击外部关闭</span><input type="checkbox" id="oc-set-click-outside" /></label>
        </div>
        <div class="oc-settings-group">
          <div class="oc-settings-label">同步</div>
          <label class="oc-settings-row"><span>自动同步（&gt;6h）</span><input type="checkbox" id="oc-set-auto-sync" /></label>
        </div>
        <div class="oc-settings-group">
          <div class="oc-settings-label">导出</div>
          <div class="oc-settings-row">
            <span>默认日期</span>
            <div class="oc-settings-radios">
              <label><input type="radio" name="oc-export-preset" value="7" /> 近7天</label>
              <label><input type="radio" name="oc-export-preset" value="30" /> 近30天</label>
              <label><input type="radio" name="oc-export-preset" value="all" /> 全部</label>
            </div>
          </div>
          <label class="oc-settings-row"><span>导出区默认展开</span><input type="checkbox" id="oc-set-export-open" /></label>
        </div>
        <div class="oc-settings-group">
          <div class="oc-settings-label">面板</div>
          <label class="oc-settings-row"><span>概览默认展开</span><input type="checkbox" id="oc-set-overview-open" /></label>
          <label class="oc-settings-row"><span>维度分析默认展开</span><input type="checkbox" id="oc-set-dimensions-open" /></label>
        </div>
        <details class="oc-settings-advanced">
          <summary>高级</summary>
          <label class="oc-settings-row"><span>拉页间隔</span>
            <select id="oc-set-page-gap"><option value="250">250 ms</option><option value="350">350 ms</option><option value="500">500 ms</option></select>
          </label>
          <label class="oc-settings-row"><span>模型排行数</span><input type="number" id="oc-set-top-model" min="3" max="20" /></label>
          <label class="oc-settings-row"><span>Key 排行数</span><input type="number" id="oc-set-top-key" min="3" max="20" /></label>
        </details>
        <div class="oc-settings-meta" id="oc-set-meta"></div>
      </div>`

    const mkBtn = (label, primary) => {
      const b = document.createElement("button")
      b.type = "button"
      b.textContent = label
      if (primary) b.className = "oc-primary"
      return b
    }

    const actions = document.createElement("div")
    actions.className = "oc-actions"
    const btnFull = mkBtn("全量抓取", true)
    const btnInc = mkBtn("增量抓取", false)
    const btnRefresh = mkBtn("刷新面板", false)
    const btnNames = mkBtn("更新 key 名称", false)
    const btnClear = mkBtn("清空缓存", false)
    btnClear.classList.add("oc-danger", "oc-span2")
    actions.append(btnFull, btnInc, btnRefresh, btnNames, btnClear)

    const info = document.createElement("div")
    info.id = "oc-go-export-info"

    const exportBlock = document.createElement("details")
    exportBlock.className = "oc-export-block oc-fold"
    exportBlock.open = loadSettings().exportSectionOpen
    exportBlock.innerHTML = `
      <summary>导出数据</summary>
      <div class="oc-export-inner">
        <div class="oc-export-presets">
          <button type="button" data-range="7">近7天</button>
          <button type="button" data-range="30" class="oc-active">近30天</button>
          <button type="button" data-range="all">全部</button>
        </div>
        <div class="oc-export-dates">
          <input type="date" id="oc-export-from" />
          <span>~</span>
          <input type="date" id="oc-export-to" />
        </div>
        <div class="oc-export-actions">
          <button type="button" id="oc-export-csv" class="oc-primary">导出 CSV</button>
          <button type="button" id="oc-export-xlsx">导出 Excel</button>
        </div>
      </div>`

    const body = document.createElement("div")
    body.id = "oc-go-export-body"
    const panel = document.createElement("div")
    panel.id = "oc-go-export-panel"
    body.appendChild(panel)

    drawer.append(head, settingsBlock, actions, info, exportBlock, body)
    root.append(backdrop, drawer, toggle)
    document.body.appendChild(root)

    const openDrawer = () => setDrawerOpen(true)
    const closeDrawer = () => setDrawerOpen(false)
    toggle.addEventListener("click", () => setDrawerOpen(!root.classList.contains("oc-open")))
    btnClose.addEventListener("click", closeDrawer)
    backdrop.addEventListener("click", () => {
      if (loadSettings().clickOutsideClose) closeDrawer()
    })
    document.addEventListener("click", (e) => {
      if (!root.classList.contains("oc-open")) return
      if (loadSettings().displayMode === "large") return
      if (!loadSettings().clickOutsideClose) return
      if (root.contains(e.target)) return
      closeDrawer()
    })
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && root.classList.contains("oc-open")) closeDrawer()
    })

    btnExpand.addEventListener("click", () => {
      const next = loadSettings().displayMode === "large" ? "compact" : "large"
      saveSettings({ displayMode: next })
      applyDisplayMode(next)
      if (!root.classList.contains("oc-open")) setDrawerOpen(true)
      else setDrawerOpen(true)
    })
    btnSettings.addEventListener("click", () => {
      settingsBlock.open = !settingsBlock.open
    })

    const bindSetting = (sel, key, transform = (v) => v) => {
      const el = $q(sel)
      if (!el) return
      const handler = () => {
        let val = el.type === "checkbox" ? el.checked : el.value
        if (el.type === "number") val = Math.min(20, Math.max(3, parseInt(val, 10) || DEFAULT_SETTINGS[key]))
        if (key === "pageGapMs") val = parseInt(val, 10)
        if (key === "exportPresetDays") val = val === "all" ? "all" : parseInt(val, 10)
        saveSettings({ [key]: transform(val) })
        if (key === "displayMode") applyDisplayMode(val)
        if (key === "exportPresetDays") setExportRange(val)
        if (key === "exportSectionOpen") exportBlock.open = val
        if (key === "overviewOpen" || key === "dimensionsOpen" || key === "topModelCount" || key === "topKeyCount") {
          getWorkspaceData().then((ws) => renderPanel(ws.detail, ws.summary, ws.keyNames || {})).catch(() => {})
        }
      }
      el.addEventListener("change", handler)
      if (el.type === "number") el.addEventListener("input", handler)
    }

    $qa('input[name="oc-display-mode"]').forEach((el) => {
      el.addEventListener("change", () => {
        if (!el.checked) return
        saveSettings({ displayMode: el.value })
        applyDisplayMode(el.value)
      })
    })
    $qa('input[name="oc-export-preset"]').forEach((el) => {
      el.addEventListener("change", () => {
        if (!el.checked) return
        const val = el.value === "all" ? "all" : parseInt(el.value, 10)
        saveSettings({ exportPresetDays: val })
        setExportRange(val)
      })
    })
    bindSetting("#oc-set-click-outside", "clickOutsideClose")
    bindSetting("#oc-set-auto-sync", "autoSync")
    bindSetting("#oc-set-export-open", "exportSectionOpen")
    bindSetting("#oc-set-overview-open", "overviewOpen")
    bindSetting("#oc-set-dimensions-open", "dimensionsOpen")
    bindSetting("#oc-set-page-gap", "pageGapMs", (v) => parseInt(v, 10))
    bindSetting("#oc-set-top-model", "topModelCount")
    bindSetting("#oc-set-top-key", "topKeyCount")

    settingsBlock.querySelectorAll("input, select, label").forEach((el) => {
      el.addEventListener("click", (e) => e.stopPropagation())
    })

    const guard = (fn) => () => {
      openDrawer()
      root.classList.add("oc-busy")
      const buttons = [btnFull, btnInc, btnRefresh, btnNames, btnClear]
      buttons.forEach((b) => (b.disabled = true))
      Promise.race([fn(), new Promise((res) => setTimeout(() => res("timeout"), 10 * 60 * 1000))])
        .catch((e) => {
          setStatus(null, "出错: " + e.message)
          console.error(e)
        })
        .finally(() => {
          root.classList.remove("oc-busy")
          buttons.forEach((b) => (b.disabled = false))
        })
    }

    btnFull.addEventListener("click", guard(() => run("full", btnFull)))
    btnInc.addEventListener("click", guard(() => run("incremental", btnInc)))
    btnRefresh.addEventListener("click", guard(async () => setStatus(null, "已刷新")))
    btnClear.addEventListener("click", guard(async () => {
      await idbDelete(WS_ID)
      setStatus(null, "已清空")
      syncSettingsUI()
    }))
    btnNames.addEventListener("click", guard(() => refreshApiKeyNames()))

    exportBlock.querySelectorAll(".oc-export-presets button").forEach((b) => {
      b.addEventListener("click", (e) => {
        e.stopPropagation()
        setExportRange(b.dataset.range)
      })
    })
    exportBlock.querySelectorAll(".oc-export-actions button, .oc-export-dates input").forEach((el) => {
      el.addEventListener("click", (e) => e.stopPropagation())
    })
    $q("#oc-export-from")?.addEventListener("change", () => $qa(".oc-export-presets button").forEach((b) => b.classList.remove("oc-active")))
    $q("#oc-export-to")?.addEventListener("change", () => $qa(".oc-export-presets button").forEach((b) => b.classList.remove("oc-active")))
    $q("#oc-export-csv")?.addEventListener("click", () => doExport("csv"))
    $q("#oc-export-xlsx")?.addEventListener("click", () => doExport("xlsx"))

    applyDisplayMode()
    syncSettingsUI()
    setExportRange(loadSettings().exportPresetDays)
    setDrawerOpen(panelOpen())
    setStatus(null, "就绪")

    if (autoEnabled()) {
      waitFor(() => !!$q('[data-slot="usage-table"]'), 15000).then(async () => {
        const wsData = await getWorkspaceData()
        if (!wsData.lastSync || Date.now() - wsData.lastSync > AUTO_GAP_MS) {
          openDrawer()
          setStatus(null, "自动增量同步中…")
          run("incremental", btnInc, { silent: true, downloadFiles: false }).catch(() => {}).finally(() => touch())
        } else touch()
      })
    } else touch()
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", inject)
  else inject()
})()
