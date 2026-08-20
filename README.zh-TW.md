[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [繁體中文](README.zh-TW.md)

# OpenCode Go 用量匯出

![License](https://img.shields.io/github/license/Shirolin/opencode-go-usage-export) ![Version](https://img.shields.io/badge/version-1.0.5-3fb950.svg) ![Tampermonkey](https://img.shields.io/badge/Tampermonkey-userscript-00485b.svg)

Tampermonkey 使用者腳本：匯出 [OpenCode 控制台](https://opencode.ai) Usage 頁的 Go 訂閱用量統計，含 token 細分（cache read / reasoning）、依模型 / API key / plan / 日期彙總，支援 CSV + Excel 匯出。

## 功能

- **網路層擷取**：攔截並重放控制台的伺服器請求，直接取得原始 JSON（含精確時間戳、keyID、plan），比 DOM 抓取快數十倍
- **分層儲存（IndexedDB）**：明細只保留最近 30 天，更早資料依「日期 × 模型 × plan × key」彙總後長期保留，杜絕無限膨脹
- **全量 / 增量同步**：增量依精確時間戳早停，只拉取新增請求
- **斷點續傳**：每頁抓完即寫入，中斷後可繼續
- **順序拉頁 + 重試**：預設 350ms 間隔，失敗自動重試，具停滯偵測防死循環
- **可中斷同步**：「停止」按鈕 / 逾時立即中止同步並儲存已抓資料；全量同步有頁數上限（2000 頁）兜底
- **自動同步**：開啟頁面距上次同步超過 6 小時自動增量（不下載檔案），可在設定中開關
- **頁面內統計面板**：總量、近 30 天成本、Go 配額比較（5h/$12 · 7d/$30 · 30d/$60）、依模型 / key / plan 長條圖
- **依模型快取命中率**：依模型的快取讀取命中率（cacheRead / (cacheRead + cacheWrite + input)），在模型長條圖副標註命中率%，並單列快取命中率表格；依模型 CSV/Excel 匯出也包含該欄。
- **大視窗模式**：置中彈窗（720px），更適合瀏覽統計與維度分析
- **設定面板**：顯示模式、自動同步、匯出預設值、面板摺疊、拉頁間隔、排行數量等
- **API key 名稱**：手動更新 key 名稱，面板與匯出中顯示友善標籤
- **匯出**：手動匯出 CSV / Excel，支援日期區間篩選
- **快取自動清理**：30 天未存取的舊 workspace 記錄自動刪除

## 安全提示

> **請僅從官方儲存庫取得本腳本**：<https://github.com/Shirolin/opencode-go-usage-export>（公開、開源，程式碼可審計）。

本腳本會直接存取 OpenCode 後端 API，涉及你的登入工作階段與 API Key 相關資料。Tampermonkey 安裝頁會展示完整腳本程式碼，**安裝前請核對來源**——來路不明的修改版可能竊取你的 API Key、用量資料甚至帳號工作階段。

- 安裝後首次開啟面板會顯示一次性安全提示（點「我知道了」後不再出現），設定區底部有常駐來源提醒
- 核對版本：比對 Tampermonkey 中腳本的 `@version` 與本儲存庫最新版本號是否一致

## 安裝

**方式一：Greasy Fork（推薦）** —— 造訪腳本主頁點擊安裝：<https://greasyfork.org/scripts/591009-opencode-go-usage-export>

**方式二：GitHub 直裝** —— 瀏覽器開啟 [opencode-go-usage-export.user.js](https://raw.githubusercontent.com/Shirolin/opencode-go-usage-export/main/opencode-go-usage-export.user.js)，Tampermonkey 會彈出安裝確認。

**方式三：手動** —— 新增腳本，貼上 [opencode-go-usage-export.user.js](./opencode-go-usage-export.user.js) 內容，儲存。

安裝後開啟 `https://opencode.ai/workspace/<workspace-id>/usage`（需已登入），右下角 **Go** 按鈕開啟面板。

## 使用方式

| 按鈕 / 功能 | 行為 |
|---|---|
| 全量同步 | 從頭拉全部頁，合併去重，寫入快取 |
| 增量同步 | 只拉新增請求（早停），合併去重 |
| 重新整理 | 用快取重新渲染統計面板 |
| 更新 Key 名稱 | 從 API 金鑰介面拉取名稱並快取 |
| 匯出 CSV / Excel | 依所選日期區間手動匯出 |
| 清除資料 | 刪除目前 workspace 快取 |
| 停止 | 中止目前同步，保留已抓資料（斷點續傳） |
| ⤢ 寬螢幕 | 切換緊湊抽屜 / 置中彈窗 |
| ⚙ 設定 | 展開設定區，設定顯示、同步、匯出等 |

資料來源說明：優先使用網路層原始 JSON（`source=network`）；若介面擷取失敗，自動降級為 DOM 抓取（`source=dom`，較慢，無 keyID/plan）。

## 設定項目

設定儲存在 `localStorage`（`oc-go-export-settings-v1`）：

- **版面配置**：緊湊（右下角抽屜）/ 寬螢幕（置中彈窗）
- **點擊外側自動關閉**：開 / 關
- **自動同步**：>6h 自動增量
- **預設匯出期間**：近 7 天 / 近 30 天 / 全部
- **預設展開區塊**：概覽、維度分析、匯出
- **日期顯示格式**：跟隨瀏覽器語言（auto）/ ISO（YYYY-MM-DD）/ YMD（YYYY/MM/DD）/ DMY（DD/MM/YYYY）/ MDY（MM/DD/YYYY）

- **進階**：拉頁間隔（250/350/500ms）、模型/key 排行數量

## 資料儲存

- IndexedDB：`oc-go-usage-export-v5` 資料庫，`workspaces` 資料表依 workspace ID 儲存
- 明細（detail）：近 30 天原始請求
- 彙整（summary）：視窗外資料彙總，長期保留
- keyNames：API key ID → 顯示名稱對應

## 注意事項

- 腳本依賴控制台**未公開**的內部介面，控制台改版可能隨時失效；失效時自動降級 DOM 抓取
- 面板配額比較僅基於已快取明細（近 30 天），非權威資料
- 需要精確稽核請定期手動「全量同步」並保留下載的 CSV

## 版本歷史

- **v1.0.5**：統計面板新增「依模型快取命中率」（業內口徑 A：cacheRead / (cacheRead + cacheWrite + input)），模型長條圖副標註命中率% 並單列命中率表格，依模型 CSV/Excel 匯出同步包含該欄。
- **v1.0.4**：面板日期顯示格式支援自訂（auto / ISO / YMD / DMY / MDY），可在設定面板切換。
- **v1.0.3**：`@description` 突出統計面板（dashboard & export），改為英文優先表述。
- **v1.0.2**：`@description` 精簡為英文單行，中文內容移交 Greasy Fork 本地化塊。
- **v1.0.1**：腳本名改為英文 "OpenCode Go Usage Export"，`@description` 英文優先。

- **v1.0.0**：首個公開發布版。功能：網路層擷取原始 JSON、分層儲存（30 天明細 + 永久彙總）、全量/增量同步、斷點續傳、可中斷同步（停止按鈕/逾時/頁數上限兜底）、自動同步、統計面板、CSV/Excel 匯出；安全提示（僅官方來源）、UTC 日界統一、去重/XSS/CSV 健壯性修復。（開發期 v5.x 歷史壓縮）

## 授權條款

[GNU General Public License v3.0](LICENSE) — 自由軟體：可自由散布與修改，但修改版必須同樣以 GPL-3.0 開源。詳見 [LICENSE](./LICENSE)。

Copyright (C) 2026 Shirolin

## 贊助與支持

如果你覺得本專案提升了你的 OpenCode 用量統計體驗，歡迎支持開發者的持續維護：

- ❤️ **愛發電 (Afdian)**：[https://ifdian.net/a/shirolin](https://ifdian.net/a/shirolin)
- ☕ **Ko-fi**：[https://ko-fi.com/shirolin](https://ko-fi.com/shirolin)
