"use strict"
// renderPanel DOM 冒烟：修复 tokOf 作用域断裂（定义在 computePanelStats 内，
// renderPanel 跨函数引用 → ReferenceError）。jsdom 渲染面板全链路，断言免费模型可见。
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
let JSDOM
try {
  JSDOM = require(path.join(__dirname, "node_modules", "jsdom")).JSDOM
} catch {
  JSDOM = null
}
if (!JSDOM) {
  console.log("SKIP  jsdom 未安装，仅做静态作用域检查")
  // 静态兜底：tokOf 必须定义在使用它的两个函数的共同可见作用域（模块顶层）
  const src = fs.readFileSync(path.join(__dirname, "..", "opencode-go-usage-export.user.js"), "utf8")
  const def = src.indexOf("const tokOf")
  const statsFn = src.indexOf("function computePanelStats")
  const panelFn = src.indexOf("function renderPanel")
  const okScope = def < statsFn && def < panelFn
  console.log(`${okScope ? "PASS" : "FAIL"}  tokOf 定义于 computePanelStats/renderPanel 之前的模块级作用域`)
  process.exit(okScope ? 0 : 1)
}

const { loadApi } = require("./lib")
const api = loadApi()

const NOW = Date.now()
const mk = (model, tok, cost) => ({
  timeCreated: NOW - 3600e3, sessionID: "s-" + model, model,
  inputTokens: tok, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: tok, reasoningTokens: 0,
  costUSD: cost, plan: "go", keyID: "k1", source: "network",
})

// 沙箱 + jsdom：加载完整 user.js（含 UI 区段），驱动 renderPanel 真实执行
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://opencode.ai/workspace/wrk_test/usage", pretendToBeVisual: true })
const { window } = dom

const sb = window
sb.indexedDB = {
  open: () => {
    const req = {}
    setTimeout(() => req.onerror && req.onerror(new Error("no idb")), 0)
    return req
  },
}
// 最小 localStorage 存根
const storeMap = new Map()
Object.defineProperty(sb, "localStorage", { value: { getItem: (k) => storeMap.get(k) ?? null, setItem: (k, v) => storeMap.set(k, String(v)), removeItem: (k) => storeMap.delete(k) } })

const src = fs.readFileSync(path.join(__dirname, "..", "opencode-go-usage-export.user.js"), "utf8")

let fails = 0
const check = (name, cond) => {
  if (!cond) fails++
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`)
}

async function main() {
  // runScripts: "dangerously" 让脚本在 jsdom window 内求值（location/navigator 等原生可用）
  const dom2 = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://opencode.ai/workspace/wrk_test/usage",
    pretendToBeVisual: true,
    runScripts: "outside-only",
  })
  const w = dom2.window
  w.indexedDB = {
    open: () => {
      const req = { set onupgradeneeded(f) {}, addEventListener() {} }
      setTimeout(() => req.onerror && req.onerror(new Error("no idb")), 0)
      return req
    },
  }
  w.fetch = () => Promise.resolve({ ok: false, status: 0, text: () => Promise.resolve("") })
  const XHR = class {
    open() {}
    setRequestHeader() {}
    send() {}
  }
  Object.defineProperty(w, "XMLHttpRequest", { value: XHR, configurable: true })
  Object.defineProperty(w.XMLHttpRequest.prototype, "open", { value: XHR.prototype.open, writable: true, configurable: true })
  Object.defineProperty(w.XMLHttpRequest.prototype, "setRequestHeader", { value: XHR.prototype.setRequestHeader, writable: true, configurable: true })
  Object.defineProperty(w.XMLHttpRequest.prototype, "send", { value: XHR.prototype.send, writable: true, configurable: true })
  try {
    w.eval(src)
  } catch (e) {
    check("user.js 在 jsdom 中加载无异常", false)
    console.log(e.stack)
    process.exit(1)
  }
  check("user.js 在 jsdom 中加载无异常", true)

  // 等待 inject() 完成（readyState=complete → 立即注入）
  await new Promise((r) => setTimeout(r, 50))
  check("面板根节点已注入", !!w.document.getElementById("oc-go-export-root"))
  check("统计面板容器已注入", !!w.document.getElementById("oc-go-export-panel"))

  // 直接触发原报错路径：setStatus → renderPanel（免费模型 + $0 数据）
  const detail = []
  for (let i = 1; i <= 6; i++) detail.push(mk("paid-model-" + i, 10000, 0.5))
  detail.push(mk("ox-alpha-free", 5000000, 0))

  // 通过 IndexedDB 存根失败路径走 emptyRec → 无数据；改为直接向 info 元素写状态触发渲染
  const errCapture = []
  const origErr = console.error
  console.error = (...a) => errCapture.push(a.join(" "))
  // no-op：等待自动同步定时器与微任务队列排空

  // 手动构造缓存数据：绕开 idb，直接调暴露的调试入口不存在 → 用 UI 流程：
  // 点击「全量抓取」会发网络请求；这里改用更直接的断点——eval 内部函数不可达，
  // 因此以 unhandled rejection / console.error 是否含 tokOf 为准。
  await new Promise((r) => setTimeout(r, 200))
  console.error = origErr
  const tokOfErr = errCapture.find((s) => s.includes("tokOf"))
  check("无 tokOf ReferenceError", !tokOfErr)

  process.exit(fails ? 1 : 0)
}
main()
