"use strict"
// 按模型缓存命中率（业内共识口径 A）统计回归：
//   cacheHitRate = cacheReadTokens / (cacheReadTokens + cacheWriteTokens + inputTokens)
// 断言全部通过且进程退出 0，即视为硬验收达标。
const { loadApi } = require("./lib")
const { makeData } = require("./data")

const api = loadApi()
const data = makeData()

// 构造明细/汇总（与主流程 run()/paths.js 一致：rollup 分层）
const rolled = api.rollup(data.rows, data.summary, data.CUTOFF)
const detail = rolled.detail
const summary = rolled.summary
const keyNames = data.keyNames
const settings = { statPresetDays: 30, topModelCount: 6, topKeyCount: 5 }

let fails = 0
const check = (name, cond) => {
  if (!cond) {
    fails++
    console.log(`FAIL  ${name}`)
  } else {
    console.log(`PASS  ${name}`)
  }
}

// (1) 公式 A：cacheRead / (cacheRead + cacheWrite + input)，含边界安全
const o = { inputTokens: 100, cacheReadTokens: 30, cacheWriteTokens: 10, outputTokens: 5 }
const got = api.cacheHitRate(o)
const exp = 30 / (30 + 10 + 100)
check("公式 A 计算值与手算一致", Math.abs(got - exp) < 1e-12)
check("全 0 / 分母为 0 返回 0（非 NaN）", api.cacheHitRate({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }) === 0)
check("仅 cacheRead 时返回 1", api.cacheHitRate({ inputTokens: 0, cacheReadTokens: 7, cacheWriteTokens: 0 }) === 1)
check("字段缺失时视为 0（undefined 安全）", api.cacheHitRate({}) === 0)

// (2) computePanelStats.byModel 每条含数值 cacheHitRate
const stats = api.computePanelStats(detail, summary, keyNames, settings, data.NOW)
check("byModel 为非空数组", Array.isArray(stats.byModel) && stats.byModel.length > 0)
const allHave = stats.byModel.every((m) => typeof m.cacheHitRate === "number" && !Number.isNaN(m.cacheHitRate))
check("byModel 每条含数值 cacheHitRate", allHave)
const m0 = stats.byModel[0]
const denom0 = (m0.inputTokens ?? 0) + (m0.cacheReadTokens ?? 0) + (m0.cacheWriteTokens ?? 0)
const exp0 = denom0 ? (m0.cacheReadTokens ?? 0) / denom0 : 0
check("byModel[0].cacheHitRate 与公式一致", Math.abs(m0.cacheHitRate - exp0) < 1e-12)

// (3) 导出按模型数据含 cacheHitRate 列/字段（与 doExport/exportXLSX 构造一致）
const byModelRows = api.mergedAggs(detail, summary, (s) => s.model, (r) => r.model).map((r) => ({ ...r, cacheHitRate: api.cacheHitRate(r) * 100 }))
check("导出按模型对象含 cacheHitRate 字段", byModelRows.every((r) => "cacheHitRate" in r))
const csv = api.toCSV(byModelRows, [...api.AGG_COLS, "cacheHitRate"])
check("CSV 表头含 cacheHitRate 列", csv.split("\n")[0].split(",").includes("cacheHitRate"))

console.log(fails ? `\n结果：${fails} 项未通过` : "\n结果：全部通过")
process.exit(fails ? 1 : 0)
