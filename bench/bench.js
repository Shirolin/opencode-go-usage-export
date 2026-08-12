"use strict"
// 基准：测量 user.js 核心数据管线（合并去重、聚合、导出、面板统计）。
// 用法：node bench/bench.js           跑基准并打印
//       node bench/bench.js --save   同时写入 bench/baseline.json（哈希基线）
// 每次运行直接读取当前 user.js 源码，确保测量的是真实代码；
// 用例与 verify.js 共享 bench/paths.js，保证输入/输出/哈希完全一致。
const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")
const { loadApi } = require("./lib")
const { makeData } = require("./data")
const { makeSuite } = require("./paths")

const ITER = 11
const WARMUP = 2

function timeMs(fn) {
  const t0 = process.hrtime.bigint()
  fn()
  return Number(process.hrtime.bigint() - t0) / 1e6
}
function bench(fn) {
  for (let i = 0; i < WARMUP; i++) fn()
  const runs = []
  for (let i = 0; i < ITER; i++) runs.push(timeMs(fn))
  return runs.sort((a, b) => a - b)[Math.floor(runs.length / 2)]
}

function main() {
  const save = process.argv.includes("--save")
  const api = loadApi()
  const data = makeData()
  const suite = makeSuite(api, data)
  const srcHash = crypto.createHash("sha256").update(fs.readFileSync(require("./lib").SRC, "utf8")).digest("hex")

  const results = {}
  for (const p of suite.paths) {
    const ms = bench(p.fn)
    results[p.name] = { ms, hash: suite.hashOf(p.fn) }
  }
  results["__meta__"] = {
    node: process.version,
    srcHash: srcHash.slice(0, 12),
    ...suite.meta,
  }

  const w = Math.max(...suite.paths.map((p) => p.name.length))
  console.log(
    `node ${process.version} · 明细 ${suite.meta.storedDetail} · 汇总 ${suite.meta.summary} · 新抓取 ${suite.meta.newRows}`,
  )
  console.log("-".repeat(w + 42))
  for (const p of suite.paths) {
    const r = results[p.name]
    console.log(p.name.padEnd(w) + "  " + String(r.ms.toFixed(2)).padStart(9) + " ms   hash " + r.hash.slice(0, 12))
  }
  console.log("-".repeat(w + 42))

  if (save) {
    const baselinePath = path.join(__dirname, "baseline.json")
    fs.writeFileSync(baselinePath, JSON.stringify(results, null, 2) + "\n")
    console.log(`baseline 已写入 ${baselinePath}`)
  }
}

main()
