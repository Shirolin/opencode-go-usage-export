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

let fail = false
for (const p of suite.paths) {
  const bh = baseline[p.name]?.hash
  const ch = suite.hashOf(p.fn)
  const ok = bh === ch
  if (!ok) fail = true
  console.log(`${ok ? "PASS" : "FAIL"}  ${p.name}: 基线 ${bh?.slice(0, 12) ?? "(无)"} / 当前 ${ch.slice(0, 12)}`)
}
console.log(fail ? "结果：输出不一致！" : "结果：全部输出与基线一致")
process.exit(fail ? 1 : 0)
