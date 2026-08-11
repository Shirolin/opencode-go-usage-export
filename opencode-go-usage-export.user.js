// ==UserScript==
// @name         OpenCode Go 用量导出 CSV
// @namespace    opencode.go-usage-export
// @version      5.8.1
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
    lang: "",
  }

  const LOCALES = {
    zh: {
      // panel / head
      panelTitle: "Go 用量导出",
      toggleOpen: "展开 Go 用量导出",
      toggleClose: "收起面板",
      btnExpandCompact: "切换紧凑模式",
      btnExpandLarge: "切换大窗口",
      btnSettings: "设置",
      btnClose: "收起",
      // action buttons
      btnFull: "全量抓取",
      btnInc: "增量抓取",
      btnRefresh: "刷新面板",
      btnNames: "更新 key 名称",
      btnClear: "清空缓存",
      btnClearConfirm: "确认清空？（点击确认）",
      // settings
      settingsTitle: "设置",
      settingGroupDisplay: "显示",
      settingGroupSync: "同步",
      settingGroupExport: "导出",
      settingGroupPanel: "面板",
      settingGroupAdvanced: "高级选项",
      settingDisplayMode: "显示模式",
      settingDisplayCompact: "紧凑",
      settingDisplayLarge: "大窗口",
      settingClickOutside: "点击外部关闭",
      settingAutoSync: "自动同步",
      settingAutoSyncNote: "（>6h 增量）",
      settingExportPreset: "默认日期区间",
      settingExportOpen: "导出区默认展开",
      settingOverviewOpen: "概览默认展开",
      settingDimensionsOpen: "维度分析默认展开",
      settingPageGap: "拉页间隔",
      settingTopModel: "模型排行数",
      settingTopKey: "Key 排行数",
      settingLang: "语言",
      settingLangAuto: "自动",
      // export block
      exportTitle: "导出数据",
      exportPreset7: "近7天",
      exportPreset30: "近30天",
      exportPresetAll: "全部",
      exportCsv: "导出 CSV",
      exportExcel: "导出 Excel",
      // stats / overview
      statOverview: "概览",
      statWindowLabel: "统计窗口",
      statRangeLabel: "数据范围",
      statWindow30d: "近 30 天明细",
      statTotalRequests: "共 {0} 次请求",
      statCost30d: "成本(近30天)",
      statQuotaTitle: "Go 限额（近 30 天明细）",
      statQuota5h: "5 小时",
      statQuota7d: "7 天",
      statQuota30d: "30 天",
      statFootDetail: "明细 {0} 条 + 汇总 {1} 组",
      statFootKeys: "已命名 key {0} 个",
      statEmptyDim: "暂无维度数据，请先抓取",
      statEmptyDetail: "暂无明细",
      statSummaryGroups: "汇总 {0} 组",
      dimByModel: "按模型 · {0}",
      dimByKey: "按 API key · {0}",
      dimByPlan: "按 plan · {0}",
      unitTok: " tok",
      unitReqs: " 次",
      unitReqsPlain: "次",
      // key labels
      keyUnknown: "未标识(dom)",
      dateUnknown: "未知",
      // status / info messages
      msgReady: "就绪",
      msgRefreshed: "已刷新",
      msgCleared: "已清空",
      msgAutoSync: "自动增量同步中…",
      msgFetchProgressInc: "增量抓取中… 已拉 {0} 条",
      msgFetchProgressFull: "全量抓取中… 已拉 {0} 条",
      msgDomFallback: "网络捕获失败，改用页面抓取（较慢）…",
      msgDomProgress: "页面抓取中… {0} 条",
      msgDoneInc: "增量完成：{0} 源 · 新增 {1} 条 · 明细 {2} / 汇总 {3}",
      msgDoneFull: "全量完成：{0} 源 · 新增 {1} 条 · 明细 {2} / 汇总 {3}",
      msgDedup: " · 去重 {0} 条",
      msgInfoBar: "明细 {0} / 汇总 {1} 组 · 上次同步：{2}",
      msgLastSync: "上次同步: {0}",
      msgNoKeys: "暂无带 keyID 的数据，请先抓取 network 明细",
      msgKeyRefreshing: "更新 API key 名称中…",
      msgKeyRefreshed: "已更新 {0} 个 API key 名称",
      msgExportEmpty: "所选区间无数据",
      msgNoSheetjs: "SheetJS 未加载，请用 CSV",
      msgExportDone: "已导出：明细 {0} 条 · 汇总 {1} 组 · {2} ~ {3}",
      msgError: "出错: {0}",
      msgTimeout: "操作超时（10 分钟）",
      msgNone: "无",
    },
    en: {
      panelTitle: "Go Usage",
      toggleOpen: "Open Go Usage",
      toggleClose: "Hide panel",
      btnExpandCompact: "Compact view",
      btnExpandLarge: "Expanded view",
      btnSettings: "Settings",
      btnClose: "Close",
      btnFull: "Full sync",
      btnInc: "Sync new",
      btnRefresh: "Refresh",
      btnNames: "Refresh key names",
      btnClear: "Clear data",
      btnClearConfirm: "Confirm clear? (click again)",
      settingsTitle: "Settings",
      settingGroupDisplay: "Appearance",
      settingGroupSync: "Sync",
      settingGroupExport: "Export",
      settingGroupPanel: "Panel",
      settingGroupAdvanced: "Advanced",
      settingDisplayMode: "Layout",
      settingDisplayCompact: "Compact",
      settingDisplayLarge: "Wide",
      settingClickOutside: "Click outside to dismiss",
      settingAutoSync: "Auto-sync",
      settingAutoSyncNote: "(incremental, >6h)",
      settingExportPreset: "Default date range",
      settingExportOpen: "Show export section by default",
      settingOverviewOpen: "Show overview by default",
      settingDimensionsOpen: "Show breakdowns by default",
      settingPageGap: "Request delay",
      settingTopModel: "Models to show",
      settingTopKey: "Keys to show",
      settingLang: "Language",
      settingLangAuto: "Auto",
      exportTitle: "Export",
      exportPreset7: "Last 7 days",
      exportPreset30: "Last 30 days",
      exportPresetAll: "All time",
      exportCsv: "Export CSV",
      exportExcel: "Export Excel",
      statOverview: "Overview",
      statWindowLabel: "Window",
      statRangeLabel: "Date range",
      statWindow30d: "30-day rolling window",
      statTotalRequests: "{0} requests",
      statCost30d: "Cost (30d)",
      statQuotaTitle: "Go quota (last 30d)",
      statQuota5h: "5-hour",
      statQuota7d: "7-day",
      statQuota30d: "30-day",
      statFootDetail: "{0} records · {1} aggregates",
      statFootKeys: "{0} named keys",
      statEmptyDim: "No data yet — run a sync first",
      statEmptyDetail: "No records",
      statSummaryGroups: "{0} aggregates",
      dimByModel: "Model · {0}",
      dimByKey: "API key · {0}",
      dimByPlan: "Plan · {0}",
      unitTok: " tok",
      unitReqs: " req",
      unitReqsPlain: "req",
      keyUnknown: "unknown (dom)",
      dateUnknown: "unknown",
      msgReady: "Ready",
      msgRefreshed: "Refreshed",
      msgCleared: "Data cleared",
      msgAutoSync: "Auto-syncing…",
      msgFetchProgressInc: "Syncing… {0} rows fetched",
      msgFetchProgressFull: "Full sync… {0} rows fetched",
      msgDomFallback: "Network intercept failed — falling back to DOM scrape (slower)…",
      msgDomProgress: "Scraping page… {0} rows",
      msgDoneInc: "Sync done: {0} · +{1} new · {2} records / {3} aggregates",
      msgDoneFull: "Full sync done: {0} · +{1} new · {2} records / {3} aggregates",
      msgDedup: " · {0} dupes skipped",
      msgInfoBar: "{0} records · {1} aggregates · Last sync: {2}",
      msgLastSync: "Last sync: {0}",
      msgNoKeys: "No keyID data — run a network sync first",
      msgKeyRefreshing: "Fetching API key names…",
      msgKeyRefreshed: "Updated {0} key name(s)",
      msgExportEmpty: "No data in the selected range",
      msgNoSheetjs: "SheetJS unavailable — use CSV instead",
      msgExportDone: "Exported: {0} records · {1} aggregates · {2} – {3}",
      msgError: "Error: {0}",
      msgTimeout: "Operation timed out (10 min)",
      msgNone: "—",
    },
    ja: {
      panelTitle: "Go 利用状況",
      toggleOpen: "Go 利用状況を開く",
      toggleClose: "閉じる",
      btnExpandCompact: "コンパクト表示",
      btnExpandLarge: "広い表示",
      btnSettings: "設定",
      btnClose: "閉じる",
      btnFull: "全件取得",
      btnInc: "差分取得",
      btnRefresh: "再読み込み",
      btnNames: "Key名を再取得",
      btnClear: "データ削除",
      btnClearConfirm: "本当に削除？（もう一度クリック）",
      settingsTitle: "設定",
      settingGroupDisplay: "表示",
      settingGroupSync: "同期",
      settingGroupExport: "エクスポート",
      settingGroupPanel: "パネル",
      settingGroupAdvanced: "詳細設定",
      settingDisplayMode: "レイアウト",
      settingDisplayCompact: "コンパクト",
      settingDisplayLarge: "ワイド",
      settingClickOutside: "外側クリックで閉じる",
      settingAutoSync: "自動同期",
      settingAutoSyncNote: "（差分・6h 経過後）",
      settingExportPreset: "デフォルト期間",
      settingExportOpen: "エクスポート欄を初期展開",
      settingOverviewOpen: "概要を初期展開",
      settingDimensionsOpen: "内訳を初期展開",
      settingPageGap: "リクエスト間隔",
      settingTopModel: "表示モデル数",
      settingTopKey: "表示Key数",
      settingLang: "言語",
      settingLangAuto: "自動",
      exportTitle: "エクスポート",
      exportPreset7: "直近7日",
      exportPreset30: "直近30日",
      exportPresetAll: "全期間",
      exportCsv: "CSVで保存",
      exportExcel: "Excelで保存",
      statOverview: "概要",
      statWindowLabel: "集計期間",
      statRangeLabel: "データ範囲",
      statWindow30d: "直近30日分",
      statTotalRequests: "{0} リクエスト",
      statCost30d: "費用（30日）",
      statQuotaTitle: "Go 利用上限（直近30日）",
      statQuota5h: "5時間",
      statQuota7d: "7日間",
      statQuota30d: "30日間",
      statFootDetail: "{0} 件 · 集計 {1} グループ",
      statFootKeys: "Key名登録済み {0} 件",
      statEmptyDim: "データがありません。まず取得してください",
      statEmptyDetail: "データなし",
      statSummaryGroups: "集計 {0} グループ",
      dimByModel: "モデル別 · {0}",
      dimByKey: "APIキー別 · {0}",
      dimByPlan: "プラン別 · {0}",
      unitTok: " tok",
      unitReqs: " 回",
      unitReqsPlain: "回",
      keyUnknown: "不明 (dom)",
      dateUnknown: "不明",
      msgReady: "準備完了",
      msgRefreshed: "更新しました",
      msgCleared: "データを削除しました",
      msgAutoSync: "バックグラウンド同期中…",
      msgFetchProgressInc: "差分取得中… {0} 件",
      msgFetchProgressFull: "全件取得中… {0} 件",
      msgDomFallback: "ネットワーク取得に失敗。ページ解析に切り替えます（低速）…",
      msgDomProgress: "ページ解析中… {0} 件",
      msgDoneInc: "差分完了 ({0}): +{1} 件追加 · {2} 件 / {3} グループ",
      msgDoneFull: "全件完了 ({0}): +{1} 件追加 · {2} 件 / {3} グループ",
      msgDedup: " · 重複 {0} 件をスキップ",
      msgInfoBar: "{0} 件 · {1} グループ · 最終同期: {2}",
      msgLastSync: "最終同期: {0}",
      msgNoKeys: "keyIDが含まれるデータがありません。先にネットワーク取得してください",
      msgKeyRefreshing: "APIキー名を取得中…",
      msgKeyRefreshed: "{0} 件のキー名を更新しました",
      msgExportEmpty: "指定した期間にデータがありません",
      msgNoSheetjs: "SheetJS が読み込まれていません。CSV をお使いください",
      msgExportDone: "保存しました: {0} 件 · {1} グループ · {2} ～ {3}",
      msgError: "エラー: {0}",
      msgTimeout: "操作がタイムアウトしました（10分）",
      msgNone: "—",
    },
    "zh-tw": {
      panelTitle: "Go 用量匯出",
      toggleOpen: "展開用量面板",
      toggleClose: "收合面板",
      btnExpandCompact: "切換為緊湊模式",
      btnExpandLarge: "切換為寬螢幕模式",
      btnSettings: "設定",
      btnClose: "收合",
      btnFull: "全量同步",
      btnInc: "增量同步",
      btnRefresh: "重新整理",
      btnNames: "更新 Key 名稱",
      btnClear: "清除資料",
      btnClearConfirm: "確認清除？（再次點擊）",
      settingsTitle: "設定",
      settingGroupDisplay: "外觀",
      settingGroupSync: "同步",
      settingGroupExport: "匯出",
      settingGroupPanel: "面板",
      settingGroupAdvanced: "進階",
      settingDisplayMode: "版面配置",
      settingDisplayCompact: "緊湊",
      settingDisplayLarge: "寬螢幕",
      settingClickOutside: "點擊外側自動關閉",
      settingAutoSync: "自動同步",
      settingAutoSyncNote: "（增量，間隔 >6h）",
      settingExportPreset: "預設日期範圍",
      settingExportOpen: "預設展開匯出區塊",
      settingOverviewOpen: "預設展開概覽",
      settingDimensionsOpen: "預設展開維度分析",
      settingPageGap: "請求間隔",
      settingTopModel: "顯示模型數",
      settingTopKey: "顯示 Key 數",
      settingLang: "語言",
      settingLangAuto: "自動",
      exportTitle: "匯出",
      exportPreset7: "近 7 天",
      exportPreset30: "近 30 天",
      exportPresetAll: "全部",
      exportCsv: "匯出 CSV",
      exportExcel: "匯出 Excel",
      statOverview: "概覽",
      statWindowLabel: "統計區間",
      statRangeLabel: "資料範圍",
      statWindow30d: "近 30 天明細",
      statTotalRequests: "共 {0} 次請求",
      statCost30d: "費用（近 30 天）",
      statQuotaTitle: "Go 配額（近 30 天）",
      statQuota5h: "5 小時",
      statQuota7d: "7 天",
      statQuota30d: "30 天",
      statFootDetail: "明細 {0} 筆・彙整 {1} 組",
      statFootKeys: "已命名 Key {0} 個",
      statEmptyDim: "尚無資料，請先執行同步",
      statEmptyDetail: "尚無明細",
      statSummaryGroups: "彙整 {0} 組",
      dimByModel: "依模型 · {0}",
      dimByKey: "依 API Key · {0}",
      dimByPlan: "依方案 · {0}",
      unitTok: " tok",
      unitReqs: " 次",
      unitReqsPlain: "次",
      keyUnknown: "無法識別 (dom)",
      dateUnknown: "未知",
      msgReady: "就緒",
      msgRefreshed: "已重新整理",
      msgCleared: "資料已清除",
      msgAutoSync: "背景同步中…",
      msgFetchProgressInc: "增量同步中… 已取得 {0} 筆",
      msgFetchProgressFull: "全量同步中… 已取得 {0} 筆",
      msgDomFallback: "網路攔截失敗，改以頁面解析方式取得（較慢）…",
      msgDomProgress: "解析頁面中… {0} 筆",
      msgDoneInc: "增量同步完成（{0}）：新增 {1} 筆・明細 {2} 筆 / 彙整 {3} 組",
      msgDoneFull: "全量同步完成（{0}）：新增 {1} 筆・明細 {2} 筆 / 彙整 {3} 組",
      msgDedup: "・略過重複 {0} 筆",
      msgInfoBar: "明細 {0} 筆・彙整 {1} 組・上次同步：{2}",
      msgLastSync: "上次同步：{0}",
      msgNoKeys: "尚無含 keyID 的資料，請先執行網路同步",
      msgKeyRefreshing: "正在取得 API Key 名稱…",
      msgKeyRefreshed: "已更新 {0} 個 API Key 名稱",
      msgExportEmpty: "所選區間內無資料",
      msgNoSheetjs: "SheetJS 未載入，請改用 CSV",
      msgExportDone: "匯出完成：明細 {0} 筆・彙整 {1} 組・{2} ～ {3}",
      msgError: "錯誤：{0}",
      msgTimeout: "操作逾時（10 分鐘）",
      msgNone: "—",
    },
  }

  function detectLang() {
    const saved = loadSettings().lang
    if (saved && LOCALES[saved]) return saved
    const nav = (navigator.language || "").toLowerCase()
    if (nav.startsWith("zh-tw") || nav.startsWith("zh-hk") || nav.startsWith("zh-hant")) return "zh-tw"
    if (nav.startsWith("zh")) return "zh"
    if (nav.startsWith("ja")) return "ja"
    return "en"
  }

  function t(key, ...args) {
    const dict = LOCALES[detectLang()] || LOCALES.zh
    let s = dict[key] ?? LOCALES.zh[key] ?? key
    args.forEach((v, i) => { s = s.replaceAll(`{${i}}`, String(v)) })
    return s
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
      btnExpand.title = m === "large" ? t("btnExpandCompact") : t("btnExpandLarge")
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
    setRadio("oc-lang", s.lang || "")
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
          const last = ws.lastSync ? new Date(ws.lastSync).toLocaleString() : t("msgNone")
          meta.textContent = `Workspace: ${WS_ID} · ${t("msgLastSync", last)}`
        })
        .catch(() => {
          meta.textContent = `Workspace: ${WS_ID}`
        })
    }
  }

  function waitFor(fn, timeout = 3000) {
    return new Promise((resolve) => {
      const start = Date.now()
      const timer = setInterval(() => {
        if (fn() || Date.now() - start > timeout) {
          clearInterval(timer)
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
    if (!keyID) return t("keyUnknown")
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
      setStatus(null, t("msgNoKeys"))
      return
    }
    setStatus(null, t("msgKeyRefreshing"))
    const names = await fetchApiKeyNames(knownIDs)
    const next = { ...wsData, keyNames: { ...(wsData.keyNames || {}), ...names }, lastKeySync: Date.now(), lastAccess: Date.now() }
    await saveWorkspaceData(next)
    renderPanel(next.detail, next.summary, next.keyNames)
    setStatus(null, t("msgKeyRefreshed", Object.keys(names).length))
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
  const dateKey = (r) => (r.timeCreated ? new Date(r.timeCreated).toISOString().slice(0, 10) : t("dateUnknown"))
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
      for (const f of AGG_FIELDS.slice(1)) a[f] += r[f] ?? 0
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
    a.style.display = "none"
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
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
      setStatus(null, t("msgExportEmpty"))
      return
    }
    const tag = exportTag(fromVal, toVal)
    const ts = new Date().toISOString().slice(0, 10)
    if (format === "xlsx") {
      if (!exportXLSX(detail, summary, tag, keyNames)) {
        setStatus(null, t("msgNoSheetjs"))
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
    setStatus(null, t("msgExportDone", detail.length, summary.length, fromVal || "…", toVal || "…"))
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
      rows = await fetchAll((n) => setStatus(btn, t(mode === "incremental" ? "msgFetchProgressInc" : "msgFetchProgressFull", n)))
    } else {
      source = "dom"
      setStatus(btn, t("msgDomFallback"))
      rows = await domScrapeAll((n) => setStatus(btn, t("msgDomProgress", n)))
    }
    if (!Array.isArray(rows)) rows = []

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
      t(mode === "incremental" ? "msgDoneInc" : "msgDoneFull", source, added, detail.length, summary.length) +
        (dupTotal > 0 ? t("msgDedup", dupTotal) : ""),
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
    const topByCost = (arr, n) => [...arr].sort((a, b) => b.costUSD - a.costUSD).slice(0, n)
    const byModel = topByCost(mergedAggs(detail, summary, (s) => s.model, (r) => r.model), settings.topModelCount)
    const byKey = topByCost(mergedAggs(detail, summary, (s) => keyLabel(s.keyID, s.plan, keyNames), (r) => keyLabel(r.keyID, r.plan, keyNames)), settings.topKeyCount)
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

    // bar 统一以费用为主指标排序和宽度，secondary 为右侧标注文字
    const barRow = (label, cost, maxCost, secondary = "") =>
      `<div class="oc-bar-row">
        <div class="oc-bar-meta">
          <span class="oc-bar-label" title="${String(label).replace(/"/g, "&quot;")}">${label}</span>
          <span class="oc-bar-cost">${cost != null ? "$" + cost.toFixed(2) : ""}</span>
        </div>
        <div class="oc-bar-body">
          <div class="oc-bar-track"><div class="oc-bar-fill" style="width:${maxCost ? Math.max(4, (cost / maxCost) * 100) : 0}%"></div></div>
          <span class="oc-bar-val">${secondary}</span>
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
    // 三个维度统一按费用降序，bar 宽度 = 费用占比
    if (byModel.length) {
      const maxCost = byModel[0].costUSD
      dimFolds.push(`<details class="oc-fold oc-dim-fold"${dimOpen}>
        <summary>${t("dimByModel", byModel.length)}</summary>
        <div class="oc-fold-body">${byModel.map((m) => barRow(m.key, m.costUSD, maxCost, fmtT(m.inputTokens + m.cacheReadTokens + m.outputTokens) + t("unitTok"))).join("")}</div>
      </details>`)
    }
    if (byKey.length) {
      const maxCost = byKey[0].costUSD
      dimFolds.push(`<details class="oc-fold oc-dim-fold"${dimOpen}>
        <summary>${t("dimByKey", byKey.length)}</summary>
        <div class="oc-fold-body">${byKey.map((m) => barRow(m.key, m.costUSD, maxCost, m.requests.toLocaleString() + t("unitReqs"))).join("")}</div>
      </details>`)
    }
    if (byPlan.length) {
      const planSorted = [...byPlan].sort((a, b) => b.costUSD - a.costUSD)
      const maxCost = planSorted[0].costUSD
      dimFolds.push(`<details class="oc-fold oc-dim-fold"${dimOpen}>
        <summary>${t("dimByPlan", planSorted.length)}</summary>
        <div class="oc-fold-body">${planSorted.map((m) => barRow(m.key, m.costUSD, maxCost, fmtT(m.inputTokens + m.cacheReadTokens + m.outputTokens) + t("unitTok") + " · " + m.requests.toLocaleString() + t("unitReqs"))).join("")}</div>
      </details>`)
    }

    const overviewOpen = settings.overviewOpen ? " open" : ""
    panel.innerHTML = `
      <details class="oc-fold"${overviewOpen}>
        <summary>${t("statOverview")}</summary>
        <div class="oc-fold-body">
          <div class="oc-period">
            <div class="oc-period-line"><span class="oc-period-k">${t("statWindowLabel")}</span>${fmtD(winStart)} ~ ${fmtD(now)}（${t("statWindow30d")}）</div>
            <div class="oc-period-line"><span class="oc-period-k">${t("statRangeLabel")}</span>${minTC ? `${fmtD(minTC)} ~ ${fmtD(maxTC)}` : t("statEmptyDetail")}${summary.length ? ` · ${t("statSummaryGroups", summary.length)}` : ""}</div>
          </div>
          <div class="oc-panel-head">
            <span class="oc-stat-total">${t("statTotalRequests", total.requests.toLocaleString())}</span>
            <span class="oc-stat-cost-pill">$${cost30d.toFixed(2)}</span>
          </div>
          <div class="oc-stat-grid">
            <div class="oc-stat"><div class="oc-stat-k">Input</div><div class="oc-stat-v">${fmtT(total.inputTokens)}</div></div>
            <div class="oc-stat"><div class="oc-stat-k">Cache</div><div class="oc-stat-v">${fmtT(total.cacheReadTokens)}</div></div>
            <div class="oc-stat"><div class="oc-stat-k">Output</div><div class="oc-stat-v">${fmtT(total.outputTokens)}</div></div>
            <div class="oc-stat"><div class="oc-stat-k">5h / 7d</div><div class="oc-stat-v oc-stat-v-sm">$${cost5h.toFixed(2)} / $${cost7d.toFixed(2)}</div></div>
          </div>
          <div class="oc-quota-block">
            <div class="oc-section-label">${t("statQuotaTitle")}</div>
            ${quotaRow(t("statQuota5h"), cost5h, 12)}
            ${quotaRow(t("statQuota7d"), cost7d, 30)}
            ${quotaRow(t("statQuota30d"), cost30d, 60)}
          </div>
          <div class="oc-panel-foot">
            <span>${t("statFootDetail", detail.length.toLocaleString(), summary.length.toLocaleString())}</span>
            <span>${t("statFootKeys", Object.keys(keyNames || {}).length)}</span>
          </div>
        </div>
      </details>
      <div class="oc-dim-grid">${dimFolds.join("") || `<div class="oc-muted oc-empty">${t("statEmptyDim")}</div>`}</div>`

    panel.querySelectorAll("details.oc-fold").forEach((el, i) => {
      const key = el.querySelector("summary")?.textContent?.trim() || i
      if (key in foldState) el.open = foldState[key]
      else if (key.startsWith(t("statOverview"))) el.open = settings.overviewOpen
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
#oc-go-export-root.oc-mode-large #oc-go-export-drawer{position:fixed;top:50%;left:50%;bottom:auto;right:auto;width:min(780px,calc(100vw - 24px));max-height:90vh;transform:translate(-50%,-50%) scale(.98);transform-origin:center;z-index:9001}
#oc-go-export-root.oc-mode-large.oc-open #oc-go-export-drawer{opacity:1;pointer-events:auto;transform:translate(-50%,-50%);display:flex;flex-direction:column}
#oc-go-export-root.oc-busy #oc-go-export-info{color:#e84c3d}
.oc-drawer-head{flex-shrink:0}
#oc-go-export-body-wrap{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}
#oc-go-export-sidebar{display:flex;flex-direction:column;flex-shrink:0}
.oc-actions,#oc-go-export-info,.oc-export-block,.oc-settings-block{flex-shrink:0}
#oc-go-export-body{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding-right:4px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.25) rgba(255,255,255,.06)}
#oc-go-export-body::-webkit-scrollbar{width:6px}
#oc-go-export-body::-webkit-scrollbar-track{background:rgba(255,255,255,.06);border-radius:99px;margin:4px 0}
#oc-go-export-body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.28);border-radius:99px}
#oc-go-export-body::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.4)}
.oc-export-block{padding:0 12px;border-top:1px solid rgba(255,255,255,.08);border-bottom:1px solid rgba(255,255,255,.08)}
.oc-export-block.oc-fold>summary{padding:10px 0}
.oc-export-inner{padding-bottom:10px}
.oc-export-title{display:none}
.oc-export-presets{display:flex;gap:4px;margin-bottom:6px}
.oc-export-presets button{flex:1;padding:4px 0;font-size:10px;color:#ccc;background:#222;border:1px solid rgba(255,255,255,.08);border-radius:5px;cursor:pointer;font-family:inherit;white-space:nowrap}
.oc-export-presets button.oc-active{color:#fff;background:#333;border-color:rgba(232,76,61,.5)}
.oc-export-dates{display:flex;align-items:center;gap:4px;margin-bottom:6px}
.oc-export-dates input{flex:1;min-width:0;padding:4px 6px;font-size:10px;color:#eee;background:#1a1a1a;border:1px solid rgba(255,255,255,.12);border-radius:5px;font-family:inherit}
.oc-export-dates span{color:#666;font-size:10px}
.oc-export-actions{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.oc-export-actions button{padding:6px 8px;font-size:11px;font-weight:600;color:#fff;background:#2a2a2a;border:1px solid rgba(255,255,255,.08);border-radius:6px;cursor:pointer;font-family:inherit;white-space:nowrap}
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
.oc-fold-body{padding-bottom:10px}
.oc-drawer-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px 8px;border-bottom:1px solid rgba(255,255,255,.08);gap:8px}
.oc-drawer-head b{font-size:13px;color:#fff;font-weight:600;flex:1;min-width:0}
.oc-head-actions{display:flex;align-items:center;gap:2px;flex-shrink:0}
.oc-head-btn{background:none;border:none;color:#888;cursor:pointer;font-size:16px;line-height:1;padding:4px 7px;border-radius:6px;min-width:32px;min-height:32px;display:flex;align-items:center;justify-content:center}
.oc-head-btn:hover{color:#fff;background:rgba(255,255,255,.08)}
.oc-drawer-close{font-size:18px}
.oc-settings-block{padding:0 12px;border-bottom:1px solid rgba(255,255,255,.08)}
.oc-settings-block.oc-fold>summary{padding:10px 0}
.oc-settings-inner{padding-bottom:12px;padding-right:4px;max-height:min(380px,60vh);overflow-y:auto;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.2) transparent}
.oc-settings-inner::-webkit-scrollbar{width:4px}
.oc-settings-inner::-webkit-scrollbar-thumb{background:rgba(255,255,255,.2);border-radius:99px}
.oc-settings-group{margin-bottom:2px;border-radius:8px;overflow:hidden}
.oc-settings-label{display:flex;align-items:center;gap:6px;font-size:10px;color:#777;font-weight:600;padding:8px 0 5px;letter-spacing:.04em;text-transform:uppercase}
.oc-settings-label::before{content:"";flex:1;height:1px;background:rgba(255,255,255,.06)}
.oc-settings-label::after{content:"";flex:5;height:1px;background:rgba(255,255,255,.06)}
.oc-settings-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 0;font-size:11.5px;color:#d0d0d0}
.oc-settings-row+.oc-settings-row{border-top:1px solid rgba(255,255,255,.04)}
.oc-settings-row>span{flex:1;min-width:0;line-height:1.35}
.oc-settings-row:has(.oc-settings-radios){flex-direction:column;align-items:stretch;gap:6px}
.oc-settings-row:has(.oc-settings-radios)>span{flex:none;white-space:nowrap}
.oc-settings-radios{display:flex;gap:3px;flex-wrap:wrap}
.oc-settings-radios label{display:flex;align-items:center;gap:0;font-size:10.5px;color:#aaa;cursor:pointer;padding:4px 9px;background:rgba(255,255,255,.05);border:1px solid transparent;border-radius:6px;transition:background .1s,color .1s,border-color .1s;white-space:nowrap}
.oc-settings-radios label:hover{background:rgba(255,255,255,.09);color:#ddd}
.oc-settings-radios label:has(input:checked){color:#fff;background:rgba(232,76,61,.18);border-color:rgba(232,76,61,.45)}
.oc-settings-radios input[type=radio]{display:none}
.oc-settings-row select{padding:4px 8px;font-size:11px;color:#eee;background:#1e1e1e;border:1px solid rgba(255,255,255,.14);border-radius:6px;font-family:inherit;cursor:pointer;outline:none}
.oc-settings-row select:focus{border-color:rgba(232,76,61,.5)}
.oc-settings-row input[type=number]{padding:4px 6px;font-size:11px;color:#eee;background:#1e1e1e;border:1px solid rgba(255,255,255,.14);border-radius:6px;font-family:inherit;width:52px;text-align:center;outline:none}
.oc-settings-row input[type=number]:focus{border-color:rgba(232,76,61,.5)}
.oc-toggle{position:relative;display:inline-block;width:36px;height:20px;flex-shrink:0}
.oc-toggle input{opacity:0;width:0;height:0;position:absolute}
.oc-toggle-track{display:block;width:36px;height:20px;background:rgba(255,255,255,.12);border-radius:99px;cursor:pointer;transition:background .2s}
.oc-toggle input:checked+.oc-toggle-track{background:#e84c3d}
.oc-toggle-track::after{content:"";position:absolute;top:3px;left:3px;width:14px;height:14px;background:#fff;border-radius:50%;transition:transform .2s;box-shadow:0 1px 3px rgba(0,0,0,.3)}
.oc-toggle input:checked+.oc-toggle-track::after{transform:translateX(16px)}
.oc-settings-meta{font-size:10px;color:#555;line-height:1.5;margin-top:8px;padding:7px 8px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.05);border-radius:6px;word-break:break-all}
.oc-settings-advanced{margin-top:4px}
.oc-settings-advanced>summary{display:flex;align-items:center;gap:6px;font-size:10.5px;color:#666;cursor:pointer;padding:5px 0;list-style:none;transition:color .1s}
.oc-settings-advanced>summary:hover{color:#aaa}
.oc-settings-advanced>summary::-webkit-details-marker{display:none}
.oc-settings-advanced>summary::before{content:"›";font-size:13px;transition:transform .15s;display:inline-block}
.oc-settings-advanced[open]>summary::before{transform:rotate(90deg)}
.oc-settings-advanced>summary::after{content:"";flex:1;height:1px;background:rgba(255,255,255,.06)}
.oc-mode-large .oc-stat-grid{grid-template-columns:repeat(4,1fr)}
.oc-dim-grid{display:block}
.oc-mode-large .oc-dim-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start}
.oc-mode-large .oc-dim-grid .oc-empty{grid-column:1/-1}
.oc-mode-large .oc-actions{grid-template-columns:1fr 1fr}
.oc-mode-large .oc-actions button{padding:7px 8px;font-size:11px}
/* 大窗口两栏布局：sidebar 左 + body 右 */
.oc-mode-large #oc-go-export-body-wrap{flex-direction:row}
.oc-mode-large #oc-go-export-sidebar{width:260px;min-width:220px;border-right:1px solid rgba(255,255,255,.08);overflow-y:auto;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.2) transparent}
.oc-mode-large #oc-go-export-sidebar::-webkit-scrollbar{width:4px}
.oc-mode-large #oc-go-export-sidebar::-webkit-scrollbar-thumb{background:rgba(255,255,255,.2);border-radius:99px}
/* 大窗口下 export-block 无需上下边框（已在 sidebar 内） */
.oc-mode-large .oc-export-block{border-left:none;border-right:none}
/* 大窗口下 body 左侧加 padding */
.oc-mode-large #oc-go-export-body{padding-left:4px}
.oc-actions{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:10px 12px 8px}
.oc-actions button{padding:8px 10px;font-size:12px;font-weight:600;color:#fff;background:#2a2a2a;border:1px solid rgba(255,255,255,.08);border-radius:7px;cursor:pointer;font-family:inherit;transition:background .12s;white-space:nowrap}
.oc-actions button.oc-danger{color:#f88;background:#2a1818;border-color:rgba(232,76,61,.25)}
.oc-actions button.oc-danger:hover:not(:disabled){background:#3a2020}
.oc-actions button.oc-danger-confirm{color:#fff;background:#e84c3d;border-color:#e84c3d;animation:oc-pulse-danger 1.5s infinite}
@keyframes oc-pulse-danger{0%,100%{box-shadow:0 0 0 0 rgba(232,76,61,.4)}50%{box-shadow:0 0 0 4px rgba(232,76,61,0)}}
.oc-actions .oc-span2{grid-column:1/-1}
.oc-actions button:hover:not(:disabled){background:#363636}
.oc-actions button:disabled{opacity:.45;cursor:not-allowed}
.oc-actions button.oc-primary{background:#e84c3d;border-color:transparent}
.oc-actions button.oc-primary:hover:not(:disabled){background:#d44335}
#oc-go-export-info{padding:0 12px 8px;color:#999;font-size:11px;line-height:1.45;min-height:1.2em;word-break:break-word}
.oc-period{margin-bottom:10px;padding:10px 10px 8px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:8px;font-size:10.5px;color:#999;line-height:1.6}
.oc-period-line{display:flex;gap:8px;align-items:baseline}
.oc-period-line+.oc-period-line{margin-top:4px;padding-top:4px;border-top:1px solid rgba(255,255,255,.05)}
.oc-period-k{color:#666;flex-shrink:0;min-width:56px;font-size:10px;text-transform:uppercase;letter-spacing:.03em}
.oc-panel-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.oc-stat-total{font-size:11px;color:#888}
.oc-stat-cost-pill{font-size:13px;font-weight:700;color:#f0f0f0;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.oc-muted{font-size:10.5px;color:#777}
.oc-stat-v-sm{font-size:11px!important}
.oc-empty{padding:16px 0;text-align:center;color:#555;font-size:11px}
.oc-quota-block{margin-bottom:8px;padding:10px;background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.06);border-radius:8px}
.oc-quota-row{margin:7px 0}
.oc-quota-row:first-of-type{margin-top:2px}
.oc-quota-meta{display:flex;justify-content:space-between;gap:8px;font-size:10.5px;color:#888;margin-bottom:4px}
.oc-quota-num{font-variant-numeric:tabular-nums;color:#bbb;font-weight:500}
.oc-quota-track{height:6px;background:#222;border-radius:99px;overflow:hidden}
.oc-quota-fill{height:100%;background:#4caf82;border-radius:99px;transition:width .25s}
.oc-quota-fill.oc-quota-mid{background:#e6a817}
.oc-quota-fill.oc-quota-warn{background:#e84c3d}
.oc-stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-bottom:8px}
.oc-stat{background:rgba(255,255,255,.04);padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.06)}
.oc-stat-k{font-size:10px;color:#666;margin-bottom:3px;text-transform:uppercase;letter-spacing:.03em}
.oc-stat-v{font-size:14px;color:#f0f0f0;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.oc-section-label{font-size:10px;color:#666;margin:0 0 8px;text-transform:uppercase;letter-spacing:.04em}
.oc-bar-row{margin:0 0 2px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.04)}
.oc-bar-row:last-child{border-bottom:none;margin-bottom:0}
.oc-bar-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px;min-width:0}
.oc-bar-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#ddd;font-size:11px;font-weight:500}
.oc-bar-cost{flex-shrink:0;color:#888;font-size:10.5px;font-variant-numeric:tabular-nums}
.oc-bar-body{display:flex;align-items:center;gap:8px}
.oc-bar-track{flex:1;height:4px;background:rgba(255,255,255,.08);border-radius:99px;overflow:hidden;min-width:0}
.oc-bar-fill{height:100%;background:linear-gradient(90deg,#c0392b,#e84c3d);border-radius:99px;transition:width .2s}
.oc-bar-val{flex-shrink:0;min-width:48px;text-align:right;color:#999;font-size:10px;font-variant-numeric:tabular-nums;white-space:nowrap}
.oc-plan-row{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:10.5px;color:#ccc;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.04)}
.oc-plan-row:last-child{border-bottom:none}
.oc-plan-key{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.oc-plan-meta{display:flex;gap:8px;flex-shrink:0;color:#888;font-size:10px;font-variant-numeric:tabular-nums}
.oc-panel-foot{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.06);font-size:10px;color:#555}
@media(max-width:640px){#oc-go-export-root{bottom:14px;right:14px}#oc-go-export-root.oc-mode-compact #oc-go-export-drawer{width:min(300px,calc(100vw - 28px))}#oc-go-export-root.oc-mode-large #oc-go-export-drawer{width:min(780px,calc(100vw - 24px))}.oc-mode-large .oc-stat-grid{grid-template-columns:1fr 1fr}.oc-mode-large .oc-dim-grid{grid-template-columns:1fr}}`
  }

  function setDrawerOpen(open) {
    const root = document.getElementById("oc-go-export-root")
    const toggle = document.getElementById("oc-go-export-toggle")
    const backdrop = document.getElementById("oc-go-export-backdrop")
    if (!root || !toggle) return
    root.classList.toggle("oc-open", open)
    toggle.textContent = open ? "×" : "Go"
    toggle.title = open ? t("toggleClose") : t("toggleOpen")
    if (backdrop) backdrop.hidden = loadSettings().displayMode !== "large" || !open
    setPanelOpen(open)
  }
  async function setStatus(btn, text) {
    const info = $q("#oc-go-export-info")
    const isProgress = text && /…$/.test(text)
    if (info && text) info.textContent = text
    if (info && !isProgress) {
      const wsData = await getWorkspaceData().catch(() => emptyRec())
      if (!text || text === t("msgReady") || text === t("msgRefreshed")) {
        const last = wsData.lastSync ? new Date(wsData.lastSync).toLocaleString() : t("msgNone")
        info.textContent = t("msgInfoBar", wsData.detail.length.toLocaleString(), wsData.summary.length.toLocaleString(), last)
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
    toggle.title = t("toggleOpen")

    const drawer = document.createElement("div")
    drawer.id = "oc-go-export-drawer"

    const head = document.createElement("div")
    head.className = "oc-drawer-head"
    head.innerHTML = `<b>${t("panelTitle")}</b>`
    const headActions = document.createElement("div")
    headActions.className = "oc-head-actions"
    const btnExpand = document.createElement("button")
    btnExpand.id = "oc-go-export-expand"
    btnExpand.type = "button"
    btnExpand.className = "oc-head-btn"
    const _initMode = loadSettings().displayMode
    btnExpand.textContent = _initMode === "large" ? "⤡" : "⤢"
    btnExpand.title = _initMode === "large" ? t("btnExpandCompact") : t("btnExpandLarge")
    const btnSettings = document.createElement("button")
    btnSettings.id = "oc-go-export-settings-btn"
    btnSettings.type = "button"
    btnSettings.className = "oc-head-btn"
    btnSettings.textContent = "⚙"
    btnSettings.title = t("btnSettings")
    const btnClose = document.createElement("button")
    btnClose.className = "oc-head-btn oc-drawer-close"
    btnClose.type = "button"
    btnClose.textContent = "×"
    btnClose.title = t("btnClose")
    headActions.append(btnExpand, btnSettings, btnClose)
    head.appendChild(headActions)

    const settingsBlock = document.createElement("details")
    settingsBlock.id = "oc-go-export-settings"
    settingsBlock.className = "oc-settings-block oc-fold"
    settingsBlock.innerHTML = `
      <summary>${t("settingsTitle")}</summary>
      <div class="oc-settings-inner">
        <div class="oc-settings-group">
          <div class="oc-settings-label">${t("settingGroupDisplay")}</div>
          <div class="oc-settings-row">
            <span>${t("settingDisplayMode")}</span>
            <div class="oc-settings-radios">
              <label><input type="radio" name="oc-display-mode" value="compact" />${t("settingDisplayCompact")}</label>
              <label><input type="radio" name="oc-display-mode" value="large" />${t("settingDisplayLarge")}</label>
            </div>
          </div>
          <div class="oc-settings-row">
            <span>${t("settingLang")}</span>
            <div class="oc-settings-radios">
              <label><input type="radio" name="oc-lang" value="" />${t("settingLangAuto")}</label>
              <label><input type="radio" name="oc-lang" value="zh" />简体</label>
              <label><input type="radio" name="oc-lang" value="zh-tw" />繁體</label>
              <label><input type="radio" name="oc-lang" value="en" />English</label>
              <label><input type="radio" name="oc-lang" value="ja" />日本語</label>
            </div>
          </div>
          <div class="oc-settings-row">
            <span>${t("settingClickOutside")}</span>
            <label class="oc-toggle"><input type="checkbox" id="oc-set-click-outside" /><span class="oc-toggle-track"></span></label>
          </div>
        </div>
        <div class="oc-settings-group">
          <div class="oc-settings-label">${t("settingGroupSync")}</div>
          <div class="oc-settings-row">
            <span>${t("settingAutoSync")} <small style="color:#666">${t("settingAutoSyncNote")}</small></span>
            <label class="oc-toggle"><input type="checkbox" id="oc-set-auto-sync" /><span class="oc-toggle-track"></span></label>
          </div>
        </div>
        <div class="oc-settings-group">
          <div class="oc-settings-label">${t("settingGroupExport")}</div>
          <div class="oc-settings-row">
            <span>${t("settingExportPreset")}</span>
            <div class="oc-settings-radios">
              <label><input type="radio" name="oc-export-preset" value="7" />${t("exportPreset7")}</label>
              <label><input type="radio" name="oc-export-preset" value="30" />${t("exportPreset30")}</label>
              <label><input type="radio" name="oc-export-preset" value="all" />${t("exportPresetAll")}</label>
            </div>
          </div>
          <div class="oc-settings-row">
            <span>${t("settingExportOpen")}</span>
            <label class="oc-toggle"><input type="checkbox" id="oc-set-export-open" /><span class="oc-toggle-track"></span></label>
          </div>
        </div>
        <div class="oc-settings-group">
          <div class="oc-settings-label">${t("settingGroupPanel")}</div>
          <div class="oc-settings-row">
            <span>${t("settingOverviewOpen")}</span>
            <label class="oc-toggle"><input type="checkbox" id="oc-set-overview-open" /><span class="oc-toggle-track"></span></label>
          </div>
          <div class="oc-settings-row">
            <span>${t("settingDimensionsOpen")}</span>
            <label class="oc-toggle"><input type="checkbox" id="oc-set-dimensions-open" /><span class="oc-toggle-track"></span></label>
          </div>
        </div>
        <details class="oc-settings-advanced">
          <summary>${t("settingGroupAdvanced")}</summary>
          <div class="oc-settings-row" style="margin-top:6px">
            <span>${t("settingPageGap")}</span>
            <select id="oc-set-page-gap"><option value="250">250 ms</option><option value="350">350 ms</option><option value="500">500 ms</option></select>
          </div>
          <div class="oc-settings-row">
            <span>${t("settingTopModel")}</span>
            <input type="number" id="oc-set-top-model" min="3" max="20" />
          </div>
          <div class="oc-settings-row">
            <span>${t("settingTopKey")}</span>
            <input type="number" id="oc-set-top-key" min="3" max="20" />
          </div>
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
    const btnFull = mkBtn(t("btnFull"), true)
    const btnInc = mkBtn(t("btnInc"), false)
    const btnRefresh = mkBtn(t("btnRefresh"), false)
    const btnNames = mkBtn(t("btnNames"), false)
    const btnClear = mkBtn(t("btnClear"), false)
    btnClear.classList.add("oc-danger", "oc-span2")
    actions.append(btnFull, btnInc, btnRefresh, btnNames, btnClear)

    const info = document.createElement("div")
    info.id = "oc-go-export-info"

    const exportBlock = document.createElement("details")
    exportBlock.className = "oc-export-block oc-fold"
    exportBlock.open = loadSettings().exportSectionOpen
    exportBlock.innerHTML = `
      <summary>${t("exportTitle")}</summary>
      <div class="oc-export-inner">
        <div class="oc-export-presets">
          <button type="button" data-range="7">${t("exportPreset7")}</button>
          <button type="button" data-range="30" class="oc-active">${t("exportPreset30")}</button>
          <button type="button" data-range="all">${t("exportPresetAll")}</button>
        </div>
        <div class="oc-export-dates">
          <input type="date" id="oc-export-from" />
          <span>~</span>
          <input type="date" id="oc-export-to" />
        </div>
        <div class="oc-export-actions">
          <button type="button" id="oc-export-csv" class="oc-primary">${t("exportCsv")}</button>
          <button type="button" id="oc-export-xlsx">${t("exportExcel")}</button>
        </div>
      </div>`

    const body = document.createElement("div")
    body.id = "oc-go-export-body"
    const panel = document.createElement("div")
    panel.id = "oc-go-export-panel"
    body.appendChild(panel)

    const sidebar = document.createElement("div")
    sidebar.id = "oc-go-export-sidebar"
    sidebar.append(settingsBlock, actions, info, exportBlock)

    const bodyWrap = document.createElement("div")
    bodyWrap.id = "oc-go-export-body-wrap"
    bodyWrap.append(sidebar, body)

    drawer.append(head, bodyWrap)
    root.append(backdrop, drawer, toggle)
    document.body.appendChild(root)

    const openDrawer = () => setDrawerOpen(true)
    const closeDrawer = () => setDrawerOpen(false)
    toggle.addEventListener("click", () => setDrawerOpen(!root.classList.contains("oc-open")))
    btnClose.addEventListener("click", closeDrawer)
    backdrop.addEventListener("click", () => {
      if (loadSettings().clickOutsideClose) closeDrawer()
    })
    const onDocClick = (e) => {
      if (!root.classList.contains("oc-open")) return
      if (loadSettings().displayMode === "large") return
      if (!loadSettings().clickOutsideClose) return
      // 忽略游离节点（如下载用的临时 <a>）触发的点击
      if (!document.body.contains(e.target)) return
      if (root.contains(e.target)) return
      closeDrawer()
    }
    const onDocKeydown = (e) => {
      if (e.key === "Escape" && root.classList.contains("oc-open")) closeDrawer()
    }
    document.addEventListener("click", onDocClick)
    document.addEventListener("keydown", onDocKeydown)
    // 语言切换重建时清理监听器，避免泄漏
    root.addEventListener("oc-destroy", () => {
      document.removeEventListener("click", onDocClick)
      document.removeEventListener("keydown", onDocKeydown)
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
    $qa('input[name="oc-lang"]').forEach((el) => {
      el.addEventListener("change", () => {
        if (!el.checked) return
        // 保存面板开关状态，inject() 会重新读取
        const wasOpen = root.classList.contains("oc-open")
        setPanelOpen(wasOpen)
        settingsCache = null
        saveSettings({ lang: el.value })
        const oldRoot = document.getElementById("oc-go-export-root")
        if (oldRoot) {
          oldRoot.dispatchEvent(new CustomEvent("oc-destroy"))
          oldRoot.remove()
        }
        inject()
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
      Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error(t("msgTimeout"))), 10 * 60 * 1000))])
        .catch((e) => {
          setStatus(null, t("msgError", e.message))
          console.error(e)
        })
        .finally(() => {
          root.classList.remove("oc-busy")
          buttons.forEach((b) => (b.disabled = false))
        })
    }

    btnFull.addEventListener("click", guard(() => run("full", btnFull)))
    btnInc.addEventListener("click", guard(() => run("incremental", btnInc)))
    btnRefresh.addEventListener("click", guard(async () => setStatus(null, t("msgRefreshed"))))
    let clearConfirmTimer = null
    btnClear.addEventListener("click", () => {
      if (clearConfirmTimer) {
        clearTimeout(clearConfirmTimer)
        clearConfirmTimer = null
        btnClear.textContent = t("btnClear")
        btnClear.classList.remove("oc-danger-confirm")
        guard(async () => {
          await idbDelete(WS_ID)
          setStatus(null, t("msgCleared"))
          syncSettingsUI()
        })()
      } else {
        btnClear.textContent = t("btnClearConfirm")
        btnClear.classList.add("oc-danger-confirm")
        clearConfirmTimer = setTimeout(() => {
          clearConfirmTimer = null
          btnClear.textContent = t("btnClear")
          btnClear.classList.remove("oc-danger-confirm")
        }, 3000)
      }
    })
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
    setStatus(null, t("msgReady"))

    if (autoEnabled()) {
      waitFor(() => !!$q('[data-slot="usage-table"]'), 15000).then(async () => {
        const wsData = await getWorkspaceData()
        if (!wsData.lastSync || Date.now() - wsData.lastSync > AUTO_GAP_MS) {
          openDrawer()
          setStatus(null, t("msgAutoSync"))
          run("incremental", btnInc, { silent: true, downloadFiles: false }).catch(() => {}).finally(() => touch())
        } else touch()
      })
    } else touch()
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", inject)
  else inject()
})()
