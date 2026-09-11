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

**改用 CRM 官方 REST API**——程式會用這組帳密向 CRM 領取 API token，存起來重複使用，
過期或失效時自動重新領取。使用前提：這個員工帳號要先請 CRM 管理員在後台
「工作人員 → 編輯該員工 → 主要頁籤 → 允許 API 呼叫」打開，否則會收到 `api_not_allowed`。

設定好帳密後，可以到 Apps Script 編輯器選函式 `testCRMApiLogin` 執行一次，
在「執行項目/記錄」裡看到「領取 token 成功」就代表帳密與 API 權限都沒問題。

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
- 目前每次寫入「備註」都會用 `content_plain` 覆蓋掉 CRM 客戶資料裡的「備註／內容」欄位，
  不是像原本手動操作介面那樣逐筆累加的工作日誌——API 本身沒有提供「新增一則日誌」的動作，
  只能整筆覆蓋客戶的備註內容。完整的每次紀錄歷史還是以 Google Sheet「日誌事件表」為準。
- 一般員工新增/更新時不能指定負責業務（`sales_staff_id`），系統會自動設成呼叫者自己，
  這點跟 CRM API 規則一致，不需要額外處理。
- `findClientIdByName()` 用的是公司名稱「完全相符」查詢，若 Sheet 裡填的客戶名稱跟 CRM
  裡登記的公司名稱有些微差異（多空格、簡稱等），會查不到既有客戶。
