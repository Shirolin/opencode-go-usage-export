# OpenCode Go 用量导出

Tampermonkey 用户脚本：导出 [OpenCode 控制台](https://opencode.ai) Usage 页的 Go 订阅用量统计，含 token 细分（cache read / reasoning）、按模型 / API key / plan / 日期聚合，支持 CSV + Excel 导出。

## 功能

- **网络层抓取**：拦截并重放控制台的服务端请求，直接拿原始 JSON（含精确时间戳、keyID、plan），比 DOM 抓取快几十倍
- **分层存储（IndexedDB）**：明细只保留最近 30 天，更早数据按「日期 × 模型 × plan × key」聚合后长期保留，杜绝无限膨胀
- **全量 / 增量抓取**：增量按精确时间戳早停，只拉新增请求
- **断点续传**：每页抓完即落盘，中断后可继续
- **并发拉页 + 重试**：并发 3，失败自动重试，带停滞检测防死循环
- **自动同步**：打开页面距上次同步超过 6 小时自动增量（不下载文件），可开关
- **页面内统计面板**：总量、近 30 天成本、Go 限额对比（5h/$12 · 7d/$30 · 30d/$60）、按模型 / key / plan 条形图
- **导出**：CSV（raw-30d / by-model / by-date / by-key / by-plan）+ 单文件 Excel（5 sheet）
- **缓存自动清理**：30 天未访问的旧 workspace 记录自动删除

## 安装

1. 浏览器安装 Tampermonkey
2. 新建脚本，粘贴 [opencode-go-usage-export.user.js](./opencode-go-usage-export.user.js) 内容，保存
3. 打开 `https://opencode.ai/workspace/<workspace-id>/usage`（需已登录）
4. 右上角红色按钮：全量抓取 / 增量抓取 / 自动同步开关

## 使用

| 按钮 | 行为 |
|---|---|
| 全量抓取 | 从头拉全部页，替换缓存，导出 CSV + Excel |
| 增量抓取 | 只拉新增请求（早停），合并去重，导出 CSV + Excel |
| 刷新面板 | 用缓存重新渲染统计面板 |
| 自动同步: 开/关 | 打开页面距上次同步 >6h 自动增量（不下载文件） |
| 清空缓存 | 删除当前 workspace 缓存 |

数据源说明：优先使用网络层原始 JSON（`source=network`）；若接口捕获失败，自动降级为 DOM 抓取（`source=dom`，较慢，无 keyID/plan）。

## 数据存储

- IndexedDB：`oc-go-usage-export-v5` 库，`workspaces` 表按 workspace ID 存储
- 明细（detail）：近 30 天原始请求
- 汇总（summary）：窗口外数据聚合，长期保留

## 注意

- 脚本依赖控制台**未公开**的内部接口，控制台改版可能随时失效；失效时自动降级 DOM 抓取
- 面板限额对比仅基于已缓存明细（近 30 天），非权威数据
- 需要精确审计请定期手动「全量抓取」并保留下载的 CSV

## 版本历史

- **v5**：分层存储（30 天明细 + 永久聚合）、防卡死（停滞检测 + 超时护栏）、自动迁移 v4 缓存
- **v4**：并发拉页 + 重试、自动同步、按 keyID/plan 维度、Excel 导出、恢复分页状态
- **v3**：网络层拦截原始 JSON、增量时间戳早停、断点续传、IndexedDB 存储
- **v2**：增量抓取、localStorage 缓存去重
- **v1**：DOM 抓取导出 CSV
