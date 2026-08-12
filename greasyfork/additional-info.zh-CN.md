**OpenCode Go 用量仪表盘与导出**（[OpenCode 控制台](https://opencode.ai) 页面内统计面板 + CSV/Excel 导出）。

**页面内统计面板**（无需下载）：

- 总量、近 30 天成本、Go 限额对比（5h/$12 · 7d/$30 · 30d/$60）
- 按模型 / API key / plan 的条形图分解
- 大窗口模式，便于浏览统计

**数据管线**：

- 网络层抓取原始服务端 JSON（精确时间戳、keyID、plan），比 DOM 抓取快数十倍
- IndexedDB 分层存储：30 天明细 + 按 日期 × 模型 × plan × key 永久聚合
- 全量 / 增量同步（时间戳早停）、断点续传、可中断抓取、自动同步

**导出**：CSV / Excel，支持日期区间筛选。

**GPL-3.0 开源** —— 请仅从官方仓库安装：

- 官方仓库：https://github.com/Shirolin/opencode-go-usage-export
- 直接安装：https://raw.githubusercontent.com/Shirolin/opencode-go-usage-export/main/opencode-go-usage-export.user.js
- 支持 / 问题反馈：https://github.com/Shirolin/opencode-go-usage-export/issues
