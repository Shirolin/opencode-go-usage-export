"use strict"
// 从真实 user.js 源码按分节标记切出纯逻辑区段，注入浏览器存根后 vm 求值。
// 基准永远测量当前源码；优化后标记不变，无需改动本文件。
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")

const SRC = process.env.BENCH_SRC || path.join(__dirname, "..", "opencode-go-usage-export.user.js")

function sliceByMarkers(src, startMarker, endMarker) {
  const s = src.indexOf(startMarker)
  if (s < 0) throw new Error("marker not found: " + startMarker)
  const e = src.indexOf(endMarker, s + startMarker.length)
  if (e < 0) throw new Error("marker not found: " + endMarker)
  return src.slice(s, e)
}

function makeSandbox() {
  const sandbox = {
    console,
    setTimeout: globalThis.setTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    URL: globalThis.URL,
    Date, JSON, Math, Map, Set, Array, Object, Promise, String, Number, Boolean,
    RegExp, Error, TypeError, parseInt, parseFloat, isNaN,
    encodeURIComponent, decodeURIComponent, Infinity, NaN,
    t: (key) => key,
    location: { origin: "https://opencode.ai", pathname: "/workspace/ws1/usage" },
    window: { fetch: async () => ({ ok: false, status: 0, text: async () => "" }) },
    XMLHttpRequest: class {
      open() {}
      send() {}
      setRequestHeader() {}
    },
    Headers: class {
      forEach() {}
    },
    Request: class {},
    document: {
      readyState: "complete",
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: () => null,
      createElement: () => ({ click() {}, style: {}, setAttribute() {} }),
      body: { appendChild() {}, removeChild() {} },
      addEventListener() {},
      removeEventListener() {},
    },
    Blob: class {},
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { language: "zh-CN" },
    XLSX: undefined,
    $q: () => null,
    $qa: () => [],
    getWorkspaceData: async () => ({ detail: [], summary: [], keyNames: {} }),
    setStatus: () => {},
  }
  sandbox.globalThis = sandbox
  // 设置层存根：throttleFetch 依赖区域外的 sleep/getPageGapMs，用沙箱全局解析（页间隔可测）
  sandbox.sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  sandbox.getPageGapMs = () => sandbox.__pageGapMs || 250
  vm.createContext(sandbox)
  return sandbox
}

function loadApi() {
  const src = fs.readFileSync(SRC, "utf8")
  const sb = makeSandbox()
  let regionA = sliceByMarkers(src, "// ---------- 网络层拦截", "// ---------- DOM 兜底")
  let regionB = sliceByMarkers(src, "// ---------- DOM 兜底", "// ---------- 主流程")
  // AGG_FIELDS / AGG_COLS 定义在更早位置，按行提取后前置
  const aggConsts = (src.match(/const AGG_FIELDS = \[[^\]]*\]\s*\n\s*const AGG_COLS = \[[^\]]*\]\s*/) || [""])[0]
  if (!aggConsts) throw new Error("AGG_FIELDS 常量未找到")
  const windowMs = (src.match(/const WINDOW_MS = [^\n]+/) || [""])[0]
  if (!windowMs) throw new Error("WINDOW_MS 常量未找到")
  const fetchConsts = (["PAGE_SIZE", "CONC", "MAX_PAGES"].map((n) => (src.match(new RegExp("const " + n + " = [^\\n]+")) || [""])[0])).join("\n")
  if (!fetchConsts.trim()) throw new Error("分页常量未找到")
  regionB = aggConsts + "\n" + windowMs + "\n" + fetchConsts + "\n" + regionB
  regionA += "\n;globalThis.__apiA = { norm, keyDisplayName, keyLabel, collectKnownKeyIDs, extractApiKeyNames };"
  regionB += "\n;globalThis.__apiB = { keyOf, dateKey, rollup, aggregate, sumAggregate, mergeAgg, mergedAggs, maxTimeCreated, escHtml, rawRows, toCSV, filterByRange, parseDateInput, fetchPages, AGG_FIELDS, AGG_COLS, ...(typeof computePanelStats !== 'undefined' ? { computePanelStats } : {}) };"
  vm.runInContext(regionA, sb, { filename: "user.js#network" })
  vm.runInContext(regionB, sb, { filename: "user.js#dom-agg" })
  const api = { ...sb.__apiA, ...sb.__apiB }
  api.sandbox = sb
  // 测试钩子：注入模拟请求（observed）与可控 fetch（origFetch 已改为 let）
  api.setObserved = (val) => {
    sb.__hook = val
    vm.runInContext("observed = __hook", sb)
  }
  api.setOrigFetch = (fn) => {
    sb.__hook = fn
    vm.runInContext("origFetch = __hook", sb)
  }
  return api
}

module.exports = { loadApi, SRC }
