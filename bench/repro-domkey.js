"use strict"
// F1 回归：domKey 无时间戳兜底键不能塌缩不同行。
// 修复前：c: 键引用不存在的 r.date/inputTotal/outputTotal → 所有无时间戳行按 model 合并成一条，静默丢数据。
const { loadApi } = require("./lib")
const api = loadApi()

let fails = 0
const check = (name, cond) => {
  if (!cond) {
    fails++
    console.log(`FAIL  ${name}`)
  } else console.log(`PASS  ${name}`)
}

// 两个不同的无时间戳行（同 model、不同 session/用量）必须保留
const a = { timeCreated: null, sessionID: "s1", model: "m1", inputTokens: 100, outputTokens: 50 }
const b = { timeCreated: null, sessionID: "s2", model: "m1", inputTokens: 200, outputTokens: 80 }
const map = new Map()
for (const r of [a, b]) map.set(api.keyOf(r), r)
check("不同行 keyOf 不冲突", map.size === 2)

// 完全相同的行应去重
const c = { timeCreated: null, sessionID: "s1", model: "m1", inputTokens: 100, outputTokens: 50 }
const map2 = new Map()
for (const r of [a, c]) map2.set(api.keyOf(r), r)
check("相同行 keyOf 一致（可去重）", map2.size === 1)

// 无时间戳行与有时间戳行不冲突
const d = { timeCreated: 12345, sessionID: "s1", model: "m1", inputTokens: 100, outputTokens: 50 }
const map3 = new Map()
for (const r of [a, d]) map3.set(api.keyOf(r), r)
check("有/无时间戳行不冲突", map3.size === 2)

// 不同 model 永不冲突
const e = { timeCreated: null, sessionID: "s1", model: "m2", inputTokens: 100, outputTokens: 50 }
const map4 = new Map()
for (const r of [a, e]) map4.set(api.keyOf(r), r)
check("不同 model 不冲突", map4.size === 2)

process.exit(fails ? 1 : 0)
