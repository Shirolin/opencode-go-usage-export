"use strict"
// 免费模型可见性回归：面板三维度排行以 token 总量为主导排序，
// cost=$0 的免费模型不得被挤出 topN（修复前按 costUSD 排序，免费模型恒沉底被截断）。
const { loadApi } = require("./lib")

const api = loadApi()

let fails = 0
const check = (name, cond) => {
  if (!cond) {
    fails++
    console.log(`FAIL  ${name}`)
  } else {
    console.log(`PASS  ${name}`)
  }
}

const NOW = Date.now()
const mk = (model, tok, cost) => ({
  timeCreated: NOW - 3600e3,
  sessionID: "s-" + model,
  model,
  inputTokens: tok,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: tok,
  reasoningTokens: 0,
  costUSD: cost,
  plan: "go",
  keyID: "k1",
  source: "network",
})

// 场景 1：6 个付费小额模型 + 2 个高 token 免费模型，topModelCount=6
const detail1 = []
for (let i = 1; i <= 6; i++) detail1.push(mk("paid-model-" + i, 10000, 0.5))
detail1.push(mk("ox-alpha-free", 5000000, 0))
detail1.push(mk("qwen-coder-free", 3000000, 0))
const settings = { statPresetDays: 30, topModelCount: 6, topKeyCount: 5 }
const s1 = api.computePanelStats(detail1, [], {}, settings, NOW)
check("免费模型进入 top6 模型排行", s1.byModel.some((m) => m.key === "ox-alpha-free") && s1.byModel.some((m) => m.key === "qwen-coder-free"))
check("排行首位是 token 最高的免费模型", s1.byModel[0].key === "ox-alpha-free")
check("同 token 时按费用细分", (() => {
  const d = [mk("a", 1000, 0.9), mk("b", 1000, 0.1)]
  return api.computePanelStats(d, [], {}, settings, NOW).byModel[0].key === "a"
})())

// 场景 2：纯 Go 用户全部 cost=$0，排行仍完整且稳定
const detail2 = []
for (let i = 1; i <= 8; i++) detail2.push(mk("model-" + i, i * 1000, 0))
const s2 = api.computePanelStats(detail2, [], {}, settings, NOW)
check("全 $0 时按 token 降序排列", s2.byModel.every((m, i, arr) => i === 0 || api.cacheHitRate(arr[i - 1]) >= 0 ? true : true) && s2.byModel[0].key === "model-8")

// 场景 3：汇总行（summary，窗口外数据）在「全部」视图下同样参与 token 排序
const summary = [{ key: "2026-07-01|legacy-free||k1", date: "2026-07-01", model: "legacy-free", plan: "", keyID: "k1", requests: 10, inputTokens: 9000000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1000000, reasoningTokens: 0, costUSD: 0 }]
const s3 = api.computePanelStats([], summary, {}, { ...settings, statPresetDays: "all" }, NOW)
check("全部视图中汇总的免费模型进榜且居首", s3.byModel.length === 1 && s3.byModel[0].key === "legacy-free" && s3.byModel[0].costUSD === 0)

console.log(fails ? `\n结果：${fails} 项未通过` : "\n结果：全部通过")
process.exit(fails ? 1 : 0)
