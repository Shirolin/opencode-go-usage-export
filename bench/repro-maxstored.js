"use strict"
// F2 回归：maxTimeCreated 循环实现，200 万行不崩溃且结果正确。
// 修复前：Math.max(0, ...detail.map(...)) 在 ~100 万参数时 RangeError: Maximum call stack size exceeded。
const { loadApi } = require("./lib")
const api = loadApi()

let fails = 0
const check = (name, cond) => {
  if (!cond) {
    fails++
    console.log(`FAIL  ${name}`)
  } else console.log(`PASS  ${name}`)
}

const rows = Array.from({ length: 2000000 }, (_, i) => ({ timeCreated: i * 7 }))
const max = api.maxTimeCreated(rows)
check("200 万行最大值正确（不崩溃）", max === 1999999 * 7)

check("空数组返回 0", api.maxTimeCreated([]) === 0)

const mixed = [{ timeCreated: null }, { timeCreated: 5 }, { timeCreated: null }]
check("null 时间戳按 0 处理", api.maxTimeCreated(mixed) === 5)

const allNull = [{ timeCreated: null }, { timeCreated: null }]
check("全 null 返回 0", api.maxTimeCreated(allNull) === 0)

process.exit(fails ? 1 : 0)
