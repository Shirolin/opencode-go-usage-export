"use strict"
// 基准用例共享套件：bench.js（计时）与 verify.js（等价性）使用完全相同的输入、输出与哈希。
const crypto = require("node:crypto")
const { makeNewRows } = require("./data")

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex")
const hashJson = (v) => sha(JSON.stringify(v))

function makePanelOut() {
  return (s) => ({
    cost5h: s.cost5h,
    cost7d: s.cost7d,
    cost30dQuota: s.cost30dQuota,
    viewCost: s.viewCost,
    total: s.total,
    byModel: s.byModel,
    byKey: s.byKey,
    byPlan: s.byPlan,
    minTC: s.minTC,
    maxTC: s.maxTC,
  })
}

// 优化前面板数值计算的逐行复刻（仅当源码无 computePanelStats 时用于基线源）
function makePanelReplica(api) {
  const { mergedAggs, keyLabel } = api
  return function panelCompute(detail, summary, keyNames, settings, now) {
    const sumF = (list, f) => list.reduce((a, r) => a + (r[f] ?? 0), 0)
    const sumCost = (list) => list.reduce((a, r) => a + (r.costUSD ?? 0), 0)
    const cost5h = sumCost(detail.filter((r) => r.timeCreated && now - r.timeCreated < 5 * 3600e3))
    const cost7d = sumCost(detail.filter((r) => r.timeCreated && now - r.timeCreated < 7 * 24 * 3600e3))
    const cost30dQuota = sumCost(detail)
    let preset = settings.statPresetDays
    if (preset !== 7 && preset !== 30 && preset !== "all") preset = 30
    let viewDetail = detail
    let viewSummary = []
    if (preset === 7) {
      const cut = now - 7 * 24 * 3600e3
      viewDetail = detail.filter((r) => r.timeCreated && r.timeCreated >= cut)
      viewSummary = []
    } else if (preset === 30) {
      viewDetail = detail
      viewSummary = []
    } else {
      viewDetail = detail
      viewSummary = summary
    }
    const viewCost = sumCost(viewDetail) + sumF(viewSummary, "costUSD")
    const total = {
      requests: viewDetail.length + sumF(viewSummary, "requests"),
      inputTokens: sumF(viewDetail, "inputTokens") + sumF(viewSummary, "inputTokens"),
      cacheReadTokens: sumF(viewDetail, "cacheReadTokens") + sumF(viewSummary, "cacheReadTokens"),
      outputTokens: sumF(viewDetail, "outputTokens") + sumF(viewSummary, "outputTokens"),
    }
    const topByCost = (arr, n) => [...arr].sort((a, b) => b.costUSD - a.costUSD).slice(0, n)
    const byModel = topByCost(mergedAggs(viewDetail, viewSummary, (s) => s.model, (r) => r.model), settings.topModelCount)
    const byKey = topByCost(
      mergedAggs(viewDetail, viewSummary, (s) => keyLabel(s.keyID, s.plan, keyNames), (r) => keyLabel(r.keyID, r.plan, keyNames)),
      settings.topKeyCount,
    )
    const byPlan = mergedAggs(viewDetail, viewSummary, (s) => s.plan || "pay-as-you-go", (r) => r.plan || "pay-as-you-go")
    const minTC = viewDetail.some((r) => r.timeCreated) ? Math.min(...viewDetail.map((r) => r.timeCreated)) : null
    const maxTC = viewDetail.some((r) => r.timeCreated) ? Math.max(...viewDetail.map((r) => r.timeCreated)) : null
    return { cost5h, cost7d, cost30dQuota, viewCost, total, byModel, byKey, byPlan, minTC, maxTC }
  }
}

function makeSuite(api, data) {
  const keyOf = api.keyOf
  const storedDeduped = []
  const seenKeys = new Set()
  for (const r of data.rows) {
    const k = keyOf(r)
    if (!seenKeys.has(k)) {
      seenKeys.add(k)
      storedDeduped.push(r)
    }
  }
  const newRows = makeNewRows(data.rows)
  const keyNames = data.keyNames
  const AGG_COLS = ["key", ...api.AGG_FIELDS]
  const dims = [
    { name: "by-model", sumKey: (s) => s.model, detKey: (r) => r.model },
    { name: "by-date", sumKey: (s) => s.date, detKey: api.dateKey },
    { name: "by-key", sumKey: (s) => api.keyLabel(s.keyID, s.plan, keyNames), detKey: (r) => api.keyLabel(r.keyID, r.plan, keyNames) },
    { name: "by-plan", sumKey: (s) => s.plan || "pay-as-you-go", detKey: (r) => r.plan || "pay-as-you-go" },
  ]

  // 模拟 run() 主流程：存储明细建 Map → 合并新抓取行 → 排序 → 分层
  // rollup 会原地累加 summary 条目，每次调用克隆，避免多轮计时互相污染
  function runMergeRollup() {
    const mergedMap = new Map(storedDeduped.map((r) => [keyOf(r), r]))
    let added = 0
    for (const r of newRows) {
      const k = keyOf(r)
      if (!mergedMap.has(k)) {
        mergedMap.set(k, r)
        added++
      }
    }
    const merged = [...mergedMap.values()].sort((a, b) => (b.timeCreated || 0) - (a.timeCreated || 0))
    return api.rollup(merged, data.summary.map((s) => ({ ...s })), data.CUTOFF)
  }

  // 预计算「上次抓取后」的存储态（不含新抓取行），供导出/面板/区间路径使用
  const rolled = api.rollup([...storedDeduped], data.summary.map((s) => ({ ...s })), data.CUTOFF)
  const detail = rolled.detail
  const summary = rolled.summary

  function aggregateDims() {
    return dims.map((d) => api.mergedAggs(detail, summary, d.sumKey, d.detKey))
  }
  function exportCSV() {
    const raw = api.rawRows(detail, keyNames)
    const cols = Object.keys(raw[0] || {})
    let out = api.toCSV(raw, cols)
    for (const d of dims) out += api.toCSV(api.mergedAggs(detail, summary, d.sumKey, d.detKey), AGG_COLS)
    return out
  }
  function filterRange() {
    return api.filterByRange(detail, summary, data.NOW - 7 * 24 * 3600e3, data.NOW)
  }
  const panelOut = makePanelOut()
  const panelReplica = makePanelReplica(api)
  const panelSettings = { statPresetDays: 30, topModelCount: 6, topKeyCount: 5 }
  function panel() {
    if (api.computePanelStats) return panelOut(api.computePanelStats(detail, summary, keyNames, panelSettings, data.NOW))
    return panelOut(panelReplica(detail, summary, keyNames, panelSettings, data.NOW))
  }
  function keyNamesPath() {
    const known = api.collectKnownKeyIDs(detail, summary)
    return api.extractApiKeyNames(data.apiPayload, known)
  }

  const paths = [
    { name: "runMergeRollup (合并去重+排序+分层)", rows: storedDeduped.length + newRows.length, fn: runMergeRollup },
    { name: "aggregateDims (4 维聚合)", rows: detail.length, fn: aggregateDims },
    { name: "exportCSV (raw+4 维 5 张表)", rows: detail.length, fn: exportCSV },
    { name: "filterRange (近 7 天区间)", rows: detail.length + summary.length, fn: filterRange },
    { name: "panelCompute (面板统计 30d)", rows: detail.length, fn: panel },
    { name: "keyNames (key 名提取)", rows: summary.length, fn: keyNamesPath },
  ]

  return {
    paths,
    detail,
    summary,
    meta: {
      storedDetail: detail.length,
      summary: summary.length,
      newRows: newRows.length,
    },
    hashOf: (fn) => hashJson(fn()),
  }
}

module.exports = { makeSuite, hashJson }
