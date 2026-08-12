"use strict"
// F5 回归：区间筛选与日期标签统一为 UTC 日界，结果与机器时区无关。
// 修复前：parseDateInput 按本地时区算日界，与 UTC 日期标签/汇总键口径打架，
// 边界日（本地 0-8 点，UTC+8）明细被计入区间但归到前一日、对应汇总组被排除。
const { loadApi } = require("./lib")
const api = loadApi()

let fails = 0
const check = (name, cond) => {
  if (!cond) {
    fails++
    console.log(`FAIL  ${name}`)
  } else console.log(`PASS  ${name}`)
}

// 1) parseDateInput 返回 UTC 日界（任何时区机器一致）
const fromMs = api.parseDateInput("2026-08-10")
check("起始日 = UTC 零点", fromMs === Date.UTC(2026, 7, 10))
check("结束日 = UTC 当日 23:59:59.999", api.parseDateInput("2026-08-10", true) === Date.UTC(2026, 7, 10) + 86400000 - 1)
check("空值返回 null", api.parseDateInput("") === null)
check("非法日期返回 null", api.parseDateInput("abc") === null)

// 2) 区间口径与 dateKey（UTC 日期）一致：
//    行 timeCreated=2026-08-09T17:00Z（dateKey=2026-08-09，本地+8 是 8/10 凌晨）
//    —— UTC 语义下应被「从 2026-08-10」排除，且与它的日期标签一致
const detail = [
  { timeCreated: Date.UTC(2026, 7, 9, 17), model: "m", sessionID: "s1", inputTokens: 1, outputTokens: 1, plan: "p", keyID: "k", source: "network" },
  { timeCreated: Date.UTC(2026, 7, 10, 1), model: "m", sessionID: "s2", inputTokens: 1, outputTokens: 1, plan: "p", keyID: "k", source: "network" },
]
const summary = [
  { key: "2026-08-09|m|p|k", date: "2026-08-09", model: "m", plan: "p", keyID: "k", requests: 2, inputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2, reasoningTokens: 0, costUSD: 0 },
  { key: "2026-08-10|m|p|k", date: "2026-08-10", model: "m", plan: "p", keyID: "k", requests: 2, inputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2, reasoningTokens: 0, costUSD: 0 },
]
const { detail: fd, summary: fs } = api.filterByRange(detail, summary, fromMs, null)
check("UTC 8/9 行被排除（与日期标签一致）", fd.length === 1 && fd[0].timeCreated === Date.UTC(2026, 7, 10, 1))
check("UTC 8/9 汇总组被排除（与明细一致）", fs.length === 1 && fs[0].date === "2026-08-10")

// 3) 明细行的日期标签与所在汇总组同进同出：dateKey(8/9 行) = 2026-08-09，其组也被排除
check("dateKey 与区间口径一致", api.dateKey({ timeCreated: Date.UTC(2026, 7, 9, 17) }) === "2026-08-09")

// 4) 结束日界：to=2026-08-10（UTC 当日末），UTC 8/11 00:00 行被排除
const detail3 = [...detail, { timeCreated: Date.UTC(2026, 7, 11, 0), model: "m", sessionID: "s3", inputTokens: 1, outputTokens: 1, plan: "p", keyID: "k", source: "network" }]
const { detail: fd3 } = api.filterByRange(detail3, [], null, api.parseDateInput("2026-08-10", true))
check("to 日界排除 UTC 8/11 行", fd3.length === 2 && fd3.every((r) => r.timeCreated <= Date.UTC(2026, 7, 10) + 86400000 - 1))

process.exit(fails ? 1 : 0)
