"use strict"
// 等价性验证：当前源码的规范输出哈希必须与基线完全一致。
// 用法：node bench/verify.js   退出码 0 = 全部一致
// 用例与 bench.js 共享 bench/paths.js：同一输入、同一输出、同一哈希方法。
const fs = require("node:fs")
const path = require("node:path")
const { loadApi } = require("./lib")
const { makeData } = require("./data")
const { makeSuite } = require("./paths")

const baselinePath = path.join(__dirname, "baseline.json")
if (!fs.existsSync(baselinePath)) {
  console.error("缺少 bench/baseline.json，先运行 node bench/bench.js --save")
  process.exit(2)
}
const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"))

const api = loadApi()
const data = makeData()
const suite = makeSuite(api, data)
const { detail, summary } = suite

let fail = false
for (const p of suite.paths) {
  const bh = baseline[p.name]?.hash
  const ch = suite.hashOf(p.fn)
  const ok = bh === ch
  if (!ok) fail = true
  console.log(`${ok ? "PASS" : "FAIL"}  ${p.name}: 基线 ${bh?.slice(0, 12) ?? "(无)"} / 当前 ${ch.slice(0, 12)}`)
}

// ---- 行为检查：面板极值统计跳过无时间戳行（修复 0 时间戳污染为 1970-01-01） ----
if (api.computePanelStats) {
  const keyNames = data.keyNames
  const settings = { statPresetDays: 30, topModelCount: 6, topKeyCount: 5 }
  const stats = api.computePanelStats(detail, summary, keyNames, settings, data.NOW)
  const realTimes = detail.filter((r) => r.timeCreated).map((r) => r.timeCreated)
  const expMin = Math.min(...realTimes)
  const expMax = Math.max(...realTimes)
  const allNull = api.computePanelStats([{ timeCreated: null }, { timeCreated: null }], [], {}, settings, data.NOW)
  const checks = [
    { name: "minTC 为最小真实时间戳（>0，非 1970）", ok: stats.minTC === expMin && stats.minTC > 0 },
    { name: "maxTC 为最大真实时间戳", ok: stats.maxTC === expMax },
    { name: "全部无时间戳时 minTC/maxTC 为 null", ok: allNull.minTC === null && allNull.maxTC === null },
    { name: "minTC ≤ maxTC", ok: stats.minTC <= stats.maxTC },
  ]
  for (const c of checks) {
    if (!c.ok) fail = true
    console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}`)
  }
} else {
  console.log("SKIP  行为检查（当前源码无 computePanelStats，可能是基线源）")
}

console.log(fail ? "结果：输出不一致！" : "结果：全部输出与基线一致，行为检查通过")
process.exit(fail ? 1 : 0)
