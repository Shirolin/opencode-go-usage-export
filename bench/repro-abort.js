"use strict"
// 抓取中止/上限回归：注入可控 origFetch 驱动 fetchPages，验证
// 1) 正常翻页到短页结束  2) 中途 abort 快速返回部分结果  3) 开始前已 abort 不发请求  4) abort 后新运行正常
const { loadApi } = require("./lib")
const api = loadApi()

let fails = 0
const check = (name, cond) => {
  if (!cond) {
    fails++
    console.log(`FAIL  ${name}`)
  } else console.log(`PASS  ${name}`)
}

// 加速：页间隔 250ms
api.sandbox.__pageGapMs = 250

// 模拟观察到的 usage.list 请求（POST，args 纯数组）
api.setObserved({ kind: "server", method: "POST", url: "https://opencode.ai/_server", headers: {}, body: JSON.stringify(["wrk_1", 0]), args: ["wrk_1", 0] })

const mkRows = (offset, n = 50) =>
  Array.from({ length: n }, (_, i) => ({
    timeCreated: 1786363084893 - (offset + i) * 1000,
    sessionID: "sess-" + (offset + i),
    model: "m1",
    inputTokens: 10,
    cacheReadTokens: 20,
    cacheWrite5mTokens: null,
    cacheWrite1hTokens: null,
    outputTokens: 8,
    reasoningTokens: 2,
    cost: 100,
    keyID: "k1",
    enrichment: { plan: "lite" },
  }))

let calls = 0
api.setOrigFetch(async (url, init) => {
  calls++
  if (init && init.signal && init.signal.aborted) {
    const e = new Error("aborted")
    e.name = "AbortError"
    throw e
  }
  const page = calls - 1
  const n = page < 3 ? 50 : 30 // 第 4 页短页 → 正常终止
  return { ok: true, status: 200, text: async () => JSON.stringify(mkRows(page, n)) }
})

const noop = () => {}

// 1) 正常：4 页（50×3 + 30 短页）→ 结束
;(async () => {
  calls = 0
  const res = await api.fetchPages(noop, 0)
  check("正常翻页：180 行 / 非上限 / 非中止", res.rows.length === 180 && !res.capped && !res.aborted)
  check("正常翻页：4 次请求", calls === 4)

  // 2) 中途 abort：第 2 次请求返回后中止 → 快速返回已抓部分，不再发第 3 次
  calls = 0
  const ac = new AbortController()
  const t0 = Date.now()
  api.setOrigFetch(async (url, init) => {
    calls++
    const page = calls - 1
    if (page === 1) ac.abort()
    return { ok: true, status: 200, text: async () => JSON.stringify(mkRows(page, 50)) }
  })
  const res2 = await api.fetchPages(noop, 0, ac.signal)
  const elapsed = Date.now() - t0
  check("中途中止：aborted=true 且保留已抓部分", res2.aborted && res2.rows.length === 100 && calls === 2)
  check("中途中止：快速退出（<2.5s）", elapsed < 2500)

  // 3) 开始前已 abort：不发任何请求
  calls = 0
  const ac3 = new AbortController()
  ac3.abort()
  const res3 = await api.fetchPages(noop, 0, ac3.signal)
  check("预先中止：0 行 / aborted / 0 请求", res3.rows.length === 0 && res3.aborted && calls === 0)

  // 4) abort 后新运行恢复正常
  calls = 0
  api.setOrigFetch(async (url, init) => {
    calls++
    const page = calls - 1
    const n = page < 3 ? 50 : 30
    return { ok: true, status: 200, text: async () => JSON.stringify(mkRows(page, n)) }
  })
  const res4 = await api.fetchPages(noop, 0)
  check("中止后新运行正常", res4.rows.length === 180 && !res4.aborted && calls === 4)

  process.exit(fails ? 1 : 0)
})().catch((e) => {
  console.error("repro 异常:", e)
  process.exit(1)
})
