"use strict"
// 确定性合成数据：5 万条明细（含重复项、乱序、空字段）+ 预存汇总。
// 固定 NOW 与种子，保证每次运行输出哈希一致。
const NOW = Date.UTC(2026, 7, 10, 12, 0, 0) // 2026-08-10T12:00:00Z
const WINDOW_MS = 30 * 24 * 3600e3
const CUTOFF = NOW - WINDOW_MS

function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const MODELS = Array.from({ length: 20 }, (_, i) => `model-${String(i + 1).padStart(2, "0")}`)
const PLANS = ["free", "basic", "pro", "team", "enterprise", "go-5h", "go-7d", "go-30d"]
const KEY_IDS = Array.from({ length: 15 }, (_, i) => `key_${String(i + 1).padStart(3, "0")}_abcdef`)
const SESSIONS = Array.from({ length: 400 }, (_, i) => `sess-${i}`)

function makeData() {
  const rnd = mulberry32(0xc0ffee)
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)]
  const randInt = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1))

  const rows = []
  for (let i = 0; i < 50000; i++) {
    const ageDays = Math.floor(rnd() * 75) // 0..74 天前，乱序
    const timeCreated = NOW - ageDays * 24 * 3600e3 - randInt(0, 86399e3)
    const r = {
      timeCreated,
      sessionID: rnd() < 0.2 ? "" : pick(SESSIONS),
      model: rnd() < 0.01 ? "(unknown)" : pick(MODELS),
      inputTokens: randInt(0, 8000),
      cacheReadTokens: randInt(0, 20000),
      cacheWriteTokens: randInt(0, 2000),
      outputTokens: randInt(0, 4000),
      reasoningTokens: randInt(0, 1500),
      costUSD: rnd() < 0.05 ? null : Math.round((rnd() * 2 + 0.0001) * 1e6) / 1e6,
      plan: rnd() < 0.03 ? null : pick(PLANS),
      keyID: pick(KEY_IDS),
      source: "network",
    }
    if (rnd() < 0.02) r.timeCreated = null // DOM 兜底式无时间戳行
    rows.push(r)
  }
  // ~10% 精确重复（同 timeCreated + sessionID），模拟重复抓取
  for (let i = 0; i < 5000; i++) rows.push({ ...rows[i * 9] })
  // 打乱顺序
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[rows[i], rows[j]] = [rows[j], rows[i]]
  }

  // 预存汇总：窗口外（31..74 天前）按 date|model|plan|key 聚合 ~3000 组
  const summary = []
  const seen = new Set()
  let gi = 0
  while (summary.length < 3000) {
    const day = 31 + Math.floor(rnd() * 44)
    const d = new Date(NOW - day * 24 * 3600e3).toISOString().slice(0, 10)
    const model = pick(MODELS)
    const plan = pick(PLANS)
    const keyID = pick(KEY_IDS)
    const k = `${d}|${model}|${plan}|${keyID}`
    if (seen.has(k)) continue
    seen.add(k)
    const n = randInt(1, 40)
    summary.push({
      key: k,
      date: d,
      model,
      plan,
      keyID,
      requests: n,
      inputTokens: n * randInt(100, 4000),
      cacheReadTokens: n * randInt(0, 12000),
      cacheWriteTokens: n * randInt(0, 900),
      outputTokens: n * randInt(50, 2500),
      reasoningTokens: n * randInt(0, 800),
      costUSD: Math.round(n * rnd() * 0.5 * 1e6) / 1e6,
    })
    gi++
  }

  // key 名称映射：15 个已知 key 中 11 个有名
  const keyNames = {}
  for (let i = 0; i < 11; i++) keyNames[KEY_IDS[i]] = `Key ${i + 1} 名称`

  // 合成 API 响应：对象树中包含全部 keyID 的 id/name 对（模拟 extractApiKeyNames 输入）
  const apiPayload = {
    t: { t: 9, a: [{ id: "root" }] },
    keys: KEY_IDS.map((id, i) => ({
      id,
      name: i < 11 ? `Key ${i + 1} 名称` : "未命名",
      sub: { nested: { apiKeyID: id, label: i < 11 ? `Key ${i + 1} 名称` : null } },
    })),
    orphan: { keyId: "zzz_missing", name: "孤儿" },
  }

  return { NOW, WINDOW_MS, CUTOFF, rows, summary, keyNames, apiPayload }
}

// 新抓取行：1500 全新（近 30 天）+ 500 与 rows 中已有行 keyOf 重复；确定性
function makeNewRows(rows) {
  const rnd = (() => {
    let a = 0x5eed >>> 0
    return () => {
      a |= 0
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  })()
  const newRows = []
  for (let i = 0; i < 1500; i++) {
    const age = Math.floor(rnd() * 30)
    newRows.push({
      timeCreated: NOW - age * 24 * 3600e3 - Math.floor(rnd() * 86399e3),
      sessionID: "sess-new-" + Math.floor(rnd() * 50),
      model: "model-" + String(1 + Math.floor(rnd() * 20)).padStart(2, "0"),
      inputTokens: Math.floor(rnd() * 8000),
      cacheReadTokens: Math.floor(rnd() * 20000),
      cacheWriteTokens: Math.floor(rnd() * 2000),
      outputTokens: Math.floor(rnd() * 4000),
      reasoningTokens: Math.floor(rnd() * 1500),
      costUSD: Math.round(rnd() * 2 * 1e6) / 1e6,
      plan: "pro",
      keyID: KEY_IDS[Math.floor(rnd() * 15)],
      source: "network",
    })
  }
  for (let i = 0; i < 500; i++) newRows.push({ ...rows[i * 7] })
  for (let i = newRows.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[newRows[i], newRows[j]] = [newRows[j], newRows[i]]
  }
  return newRows
}

module.exports = { makeData, makeNewRows, NOW, WINDOW_MS, CUTOFF }
