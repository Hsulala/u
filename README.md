# 工作日誌系統 — 部署說明

## 檔案說明
- `Code.gs` — 後端主程式：Sheet 讀寫、CRM 同步、統編查詢、Telegram 夜間彙整
- `liff.html` — LIFF 表單頁面（手機用，透過 doGet 提供）
- `sidebar.html` — Sheet 側邊欄表單（電腦、Sheet 開著時用）

## 部署步驟

### 1. 把程式碼放進 Sheet
打開「工作日誌系統」這份 Sheet → 擴充功能 → Apps Script，
把三個檔案的內容分別貼進對應檔名的檔案（新增 .html 檔案時用「檔案 → 新增 → HTML」）。

### 2. 設定指令碼屬性（Script Properties）
專案設定（左側齒輪圖示）→ 指令碼屬性 → 新增以下三筆：

| 屬性名稱 | 值 | 說明 |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | 你的 bot token | 已提供 |
| `TELEGRAM_CHAT_ID` | 5770924650 | 已提供 |
| `CRM_USERNAME` | 你登入 CRM 的帳號 | |
| `CRM_PASSWORD` | 你登入 CRM 的密碼 | |

**不用再手動抓 Cookie 了**——程式會在每次要跟 CRM 溝通時，自動用帳密登入拿一組新的 session，
存在快取裡 20 分鐘，過期會自動重新登入。你只要把帳密貼進這兩個指令碼屬性即可，
之後完全不用再理會 Cookie 這件事。

### 3. 執行一次初始化
在 Apps Script 編輯器裡，從函式下拉選單選 `setupSheets`，按執行（第一次會要求授權）。
這會依照最終欄位設計重建兩個分頁的表頭（會清空目前的示範資料列）。

### 4. 設定夜間彙整觸發器
執行 `setupNightlyTrigger` 一次，之後每天 21:00 會自動跑 `dailySummary` 推播到 Telegram。
時間要改的話，直接修改 `Code.gs` 裡 `.atHour(21)` 這一行。

### 5. 部署成網頁應用程式（給 LIFF 用）
部署 → 新增部署作業 → 類型選「網頁應用程式」：
- 執行身分：我
- 存取權：**任何人**（LIFF 從 LINE App 內部發出請求，沒有你的 Google 登入狀態，必須開放存取）

部署後會拿到一個 `https://script.google.com/macros/s/xxxx/exec` 網址，這就是 LIFF 的 Endpoint URL。

### 6. 建立 LIFF App
到 [LINE Developers](https://developers.line.biz/) 你既有的 Provider/Channel 下新增一個 LIFF app：
- Endpoint URL：貼上一步拿到的網址
- Size：Tall 或 Full 皆可

建立後會拿到一組 LIFF ID，貼到 `liff.html` 裡這一行取代：
```js
liff.init({ liffId: "PUT_YOUR_LIFF_ID_HERE" })
```
改完要記得重新部署一次（新增部署作業，或更新現有部署）。

### 7. Sheet 側邊欄
不用另外部署，重新整理 Sheet 頁面後，選單列會出現「工作日誌」選單，
點「開啟記錄側邊欄」即可使用。

## 尚待你確認/調整的地方
- `Code.gs` 裡 `crmStatusToCode()` 目前直接把中文狀態送給 CRM，
  如果送出後 CRM 沒有正確更新狀態，代表後端實際要吃的是代碼而非中文顯示值，
  需要再抓一次「手動改狀態」時的 Network 請求確認欄位值。
- `isNewClient` 目前用「有沒有填統編」簡化判斷是否為新客戶，
  之後可以改成先呼叫 CRM 用客戶名稱查詢是否已存在，會更準確。
- CRM_COOKIE 需要你手動維護更新頻率，之後如果太常過期，
  可以再討論要不要做自動偵測登出並提醒的機制。
