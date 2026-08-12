"use strict"
// F4 回归：toCSV 对含 \r 的值必须加引号，避免 CSV 行断裂。
// 修复前：引号判定只匹配 [",\n]，含 \r 的值裸奔。
const { loadApi } = require("./lib")
const api = loadApi()

let fails = 0
const check = (name, cond) => {
  if (!cond) {
    fails++
    console.log(`FAIL  ${name}`)
  } else console.log(`PASS  ${name}`)
}

const out = api.toCSV([{ a: "x\ry" }], ["a"])
check("含 CR 值被引号包裹", out === 'a\n"x\ry"')

const out2 = api.toCSV([{ a: 'q"w' }], ["a"])
check("含引号值仍正确转义", out2 === 'a\n"q""w"')

const out3 = api.toCSV([{ a: "x\ny" }], ["a"])
check("含换行值仍正确转义", out3 === 'a\n"x\ny"')

const out4 = api.toCSV([{ a: 1.5, b: "plain" }], ["a", "b"])
check("普通行不受影响", out4 === "a,b\n1.5,plain")

process.exit(fails ? 1 : 0)
