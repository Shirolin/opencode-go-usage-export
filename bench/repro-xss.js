"use strict"
// F3 回归：面板渲染服务端/用户数据必须 HTML 转义（防 XSS 注入）。
// 修复前：barRow 把 model/plan/keyName 原样插入 innerHTML。
const { loadApi } = require("./lib")
const api = loadApi()

let fails = 0
const check = (name, cond) => {
  if (!cond) {
    fails++
    console.log(`FAIL  ${name}`)
  } else console.log(`PASS  ${name}`)
}

// 恶意 model 名直接注入
const evilModel = `<img src=x onerror=alert(1)>`
const esc1 = api.escHtml(evilModel)
check("标签字符被转义", !esc1.includes("<img") && esc1.includes("&lt;img"))

// 属性上下文：引号被转义（防 title 属性逃逸）
const evilAttr = `"><script>alert(1)</script>`
const esc2 = api.escHtml(evilAttr)
check("引号被转义", !esc2.includes('"') && esc2.includes("&quot;"))

// 单引号与 & 一并转义
const esc3 = api.escHtml(`a'b&c`)
check("单引号与 & 转义", esc3 === "a&#39;b&amp;c")

// 普通文本不变
check("普通文本保持不变", api.escHtml("model-01") === "model-01")

// 空值安全
check("null/undefined 安全", api.escHtml(null) === "" && api.escHtml(undefined) === "")

// 集成：keyLabel（含恶意 keyName）→ escHtml 后的标签不再含可执行 HTML
const evilLabel = api.keyLabel("key_123456", "pro", { key_123456: evilModel })
const safe = api.escHtml(evilLabel)
check("keyLabel 输出经转义后安全", !safe.includes("<img") && safe.includes("&lt;img"))

process.exit(fails ? 1 : 0)
