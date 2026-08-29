/**
 * ============================================================
 * 工作日誌系統 — GAS 後端
 * ============================================================
 * 部署方式：
 * 1. 在 Google Sheet「工作日誌系統」裡開啟「擴充功能 → Apps Script」
 * 2. 把這幾個檔案（Code.gs / liff.html / sidebar.html）貼進去
 * 3. 專案設定 →指令碼屬性（Script Properties）新增：
 *    - TELEGRAM_BOT_TOKEN   你的 Telegram bot token
 *    - TELEGRAM_CHAT_ID     你的 Telegram chat id
 *    - CRM_USERNAME         登入 makarma CRM 用的帳號
 *    - CRM_PASSWORD         登入 makarma CRM 用的密碼
 *    程式會自動登入拿 session，過期時自動重新登入，不需要手動抓 Cookie
 * 4. 部署 → 新增部署作業 → 網頁應用程式，執行身分「我」，存取權「僅限我自己」
 *    （若要讓 LINE LIFF 打得到，存取權要選「任何人」，因為 LIFF 是從 LINE App 內部發出請求，
 *      沒有你的 Google 登入狀態，必須開放）
 * 5. 部署後的網址就是 LIFF 的 Endpoint URL，貼到 LINE Developers 後台建立 LIFF app，
 *    同一個網址也要貼到會議邀請 index.html 的 gasWebAppUrl（會議功能已合併進這支）
 * ============================================================
 */

const SHEET_LOG = "日誌事件表";
const SHEET_DEAL = "案件管道表";
const MEETING_SHEET = "會議記錄表";
const CARD_ROSTER_SHEET = "名片名單";
const LINE_CHANNEL_ID = "2007968447"; // LIFF ID 開頭那段數字，用來驗證 liff.getIDToken() 拿到的 token
const SHARED_CALENDAR_ID = "98965ff9c9be5cf34d9836f9d5aa671ba4c185a003084987e03649d18bbc1adb@group.calendar.google.com";
const MEETING_TIME_ZONE = "Asia/Taipei";

// LINE LIFF ID（用來組成選單按鈕的連結）
const LIFF_ID_WORKLOG = "2007968447-bNwIeM6Y"; // 建立好工作日誌的 LIFF app 後，把 ID 貼在這裡
const LIFF_ID_CARD = "2007968447-L1XqQgMW";
const LIFF_ID_MEETING = "2007968447-PQ3LQjeO";

const CRM_BASE = "https://crm.makarma.com.tw/client/spanel/index.php";
const CRM_ADD_PAGE = "https://crm.makarma.com.tw/client/spanel/index.php?mode=add";
const DEFAULT_TAX_ID = "96756074"; // 沒有真實統編時的暫代值

// 動作類型 → 案件管道階段 對照（CRM 狀態 → 我們自己的三分類）
const STAGE_MAP = {
  "評估考慮中": "斡旋中",
  "接洽中": "斡旋中",
  "簽約中": "預計成交",
  "合約書已簽回": "預計成交",
  "已成交": "已成交",
};

// ============================================================
// 初次設定：建立/重建兩個分頁的表頭（在編輯器裡手動執行一次）
// ============================================================
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  let logSheet = ss.getSheetByName(SHEET_LOG);
  if (!logSheet) logSheet = ss.insertSheet(SHEET_LOG);
  logSheet.clear();
  logSheet.appendRow([
    "時間戳記", "客戶名稱", "動作類型", "CRM狀態", "備注",
    "統一編號", "是否已同步CRM", "CRM同步訊息",
  ]);
  logSheet.setFrozenRows(1);

  let dealSheet = ss.getSheetByName(SHEET_DEAL);
  if (!dealSheet) dealSheet = ss.insertSheet(SHEET_DEAL);
  dealSheet.clear();
  dealSheet.appendRow(["客戶名稱", "階段", "金額", "備註", "最後更新日期"]);
  dealSheet.setFrozenRows(1);
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(["斡旋中", "預計成交", "已成交"], true)
    .build();
  dealSheet.getRange("B2:B500").setDataValidation(rule);

  Logger.log("Sheet 結構已重建完成");
}

// 建立/重建「會議記錄表」分頁（在編輯器裡手動執行一次）
function setupMeetingSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(MEETING_SHEET);
  if (!sheet) sheet = ss.insertSheet(MEETING_SHEET);
  sheet.clear();
  sheet.appendRow([
    "會議ID", "標題", "日期", "開始時間", "結束時間", "地點", "Meet連結", "建立/更新時間",
  ]);
  sheet.setFrozenRows(1);
  Logger.log("會議記錄表已建立");
}

// 建立/重建「名片名單」分頁（在編輯器裡手動執行一次）
// 名片內容由這張表控管：只有列在這裡、且「啟用」為 TRUE 的 LINE 使用者，才能用名片 LIFF 產生並分享名片
function setupCardRosterSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CARD_ROSTER_SHEET);
  if (!sheet) sheet = ss.insertSheet(CARD_ROSTER_SHEET);
  sheet.clear();
  sheet.appendRow([
    "LINE使用者ID", "姓名", "英文姓名", "職稱", "手機", "Email", "LINE ID", "啟用",
  ]);
  sheet.setFrozenRows(1);
  Logger.log("名片名單已建立。第一次使用名片 LIFF 時，畫面上會顯示你的 LINE 使用者ID，把它填進第一欄即可。");
}

// ============================================================
// Web App 進入點（LIFF 頁面 + API）
// ============================================================
function doGet(e) {
  const page = ((e && e.parameter && e.parameter.page) || "worklog").toLowerCase();
  const fileMap = { worklog: "liff", card: "card", meeting: "meeting" };
  const file = fileMap[page] || "liff";
  return HtmlService.createHtmlOutputFromFile(file)
    .setTitle("MaKarma")
    .addMetaTag("viewport", "width=device-width, initial-scale=1.0");
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut({ status: "error", message: "無法解析請求內容" });
  }

  // LINE Webhook 傳來的事件會有 events 陣列，跟 LIFF 表單送出的格式不同，分開處理
  if (body.events) {
    return handleLineWebhook(body);
  }

  try {
    switch (body.action) {
      case "submit":
        return jsonOut(handleSubmit(body));
      case "lookupTaxId":
        return jsonOut({ status: "success", candidates: lookupTaxId(body.companyName) });
      case "updateDeal":
        return jsonOut(handleUpdateDeal(body));
      case "getDealStage":
        return jsonOut({ status: "success", deal: getDealForClient(body.clientName) });
      case "meetingSearch":
        return jsonOut({ status: "success", meetings: searchMeetings(body.keyword || "") });
      case "meetingCreate":
        return jsonOut(upsertMeeting(body, true));
      case "meetingUpdate":
        return jsonOut(upsertMeeting(body, false));
      case "getMyCard":
        return jsonOut(getCardForLineUser(body.idToken));
      default:
        return jsonOut({ status: "error", message: "未知的 action" });
    }
  } catch (err) {
    return jsonOut({ status: "error", message: String(err) });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// 表單送出（LIFF 與側邊欄共用這個函式；側邊欄用 google.script.run 直接呼叫）
// ============================================================
function writeEntry(data) {
  return handleSubmit(data);
}

function handleSubmit(data) {
  // data: { clientName, actionTypes:[...], crmStatus, note, taxId, isNewClient, crmId }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const logSheet = ss.getSheetByName(SHEET_LOG);

  const clientName = (data.clientName || "").trim();
  if (!clientName) throw new Error("客戶名稱不能為空");

  const actionTypes = (data.actionTypes || []).join(",");
  const taxId = (data.taxId || "").trim() || DEFAULT_TAX_ID;

  let crmResult = { synced: false, message: "未同步" };
  if (data.crmStatus) {
    try {
      let isNewClient = !!data.isNewClient;
      let crmId = data.crmId || "";

      if (!isNewClient && !crmId) {
        // 已有客戶但沒填編號，先用名稱搜尋 CRM 找出編號
        crmId = findClientIdByName(clientName);
        if (!crmId) {
          crmResult = {
            synced: false,
            message: "找不到「" + clientName + "」在 CRM 的客戶編號，請手動填入 CRM 客戶編號後再試一次",
          };
        }
      }

      if (crmId || isNewClient) {
        crmResult = syncToCRM({
          clientName: clientName,
          status: crmStatusToCode(data.crmStatus),
          taxId: taxId,
          note: data.note || "",
          isNewClient: isNewClient,
          crmId: crmId || "0",
        });
      }
    } catch (err) {
      crmResult = { synced: false, message: "同步失敗：" + err };
    }
  }

  logSheet.appendRow([
    new Date(),
    clientName,
    actionTypes,
    data.crmStatus || "",
    data.note || "",
    taxId,
    crmResult.synced ? "TRUE" : "FALSE",
    crmResult.message,
  ]);

  // 若同時帶了案件階段/金額，順便更新案件管道表
  if (data.dealStage) {
    upsertDeal(clientName, data.dealStage, data.dealAmount || "", data.note || "");
  }

  return { status: "success", crm: crmResult };
}

// ============================================================
// 統編自動查詢（經濟部商業開放資料）
// ============================================================
function lookupTaxId(companyName) {
  if (!companyName) return [];
  const url =
    "https://data.gcis.nat.gov.tw/od/data/api/8813AADD-D020-4C55-A703-FC15B49F4262" +
    "?$format=json&$filter=" +
    encodeURIComponent(`Company_Name like ${companyName}`) +
    "&$top=10";
  try {
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    const list = JSON.parse(resp.getContentText());
    if (!Array.isArray(list)) return [];
    return list.map((row) => ({
      name: row.Company_Name,
      taxId: row.Business_Accounting_NO,
      status: row.Company_Status_Desc || "",
    }));
  } catch (err) {
    Logger.log("統編查詢失敗: " + err);
    return [];
  }
}

// ============================================================
// CRM 自動登入（存帳密，session 過期會自動重新登入，不用手動抓 Cookie）
// ============================================================
const CRM_LOGIN_URL = "https://crm.makarma.com.tw/spanel/api.php";
const CRM_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

function loginToCRM() {
  const props = PropertiesService.getScriptProperties();
  const username = props.getProperty("CRM_USERNAME");
  const password = props.getProperty("CRM_PASSWORD");
  if (!username || !password) {
    throw new Error("尚未設定 CRM_USERNAME / CRM_PASSWORD");
  }

  // cid 是伺服器發的長效期（90天）裝置識別 cookie，帶著上次拿到的一起送出，
  // 讓伺服器認得這是「同一台裝置」在登入，而不是每次都當成全新、不受信任的裝置
  const savedCid = props.getProperty("CRM_CID");
  const loginHeaders = {
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent": CRM_USER_AGENT,
  };
  if (savedCid) loginHeaders["Cookie"] = "cid=" + savedCid;

  const resp = UrlFetchApp.fetch(CRM_LOGIN_URL, {
    method: "post",
    headers: loginHeaders,
    payload: {
      panel_uu: username,
      panel_pp: password,
      mode: "sign_in",
      goto: "/client/spanel/",
      verify_code: "",
    },
    muteHttpExceptions: true,
    followRedirects: false,
  });

  const headers = resp.getAllHeaders();
  const rawSetCookie = headers["Set-Cookie"] || headers["set-cookie"];
  if (!rawSetCookie) {
    throw new Error(
      "登入沒有拿到 Set-Cookie（HTTP " + resp.getResponseCode() + "）。回應：" +
      resp.getContentText().slice(0, 200)
    );
  }
  const cookieList = Array.isArray(rawSetCookie) ? rawSetCookie : [rawSetCookie];
  // 整理成乾淨的 Cookie 字串：同名的只留最後一筆，避免重複 PHPSESSID 讓伺服器解析混亂
  const cookieMap = {};
  cookieList.forEach((c) => {
    const pair = c.split(";")[0];
    const eqIdx = pair.indexOf("=");
    if (eqIdx === -1) return;
    const name = pair.substring(0, eqIdx);
    const value = pair.substring(eqIdx + 1);
    cookieMap[name] = value;
  });
  if (cookieMap["cid"]) {
    props.setProperty("CRM_CID", cookieMap["cid"]);
  }

  const cookieString = Object.keys(cookieMap)
    .map((name) => `${name}=${cookieMap[name]}`)
    .join("; ");

  // 真實瀏覽器登入成功後，前端 JS 會照著回應裡的 goto 網址導頁，
  // 這一步可能才是讓伺服器真正把 session 標記成「已登入」的地方；
  // 我們是直接呼叫登入 API，跳過了這一步，補上避免 session 不穩定
  try {
    const loginResult = JSON.parse(resp.getContentText());
    const gotoPath = loginResult.goto;
    if (gotoPath) {
      const gotoUrl = gotoPath.indexOf("http") === 0 ? gotoPath : "https://crm.makarma.com.tw" + gotoPath;
      UrlFetchApp.fetch(gotoUrl, {
        headers: { Cookie: cookieString, "User-Agent": CRM_USER_AGENT },
        muteHttpExceptions: true,
      });
    }
  } catch (err) {
    Logger.log("登入後導頁失敗（不影響登入結果）：" + err);
  }

  return cookieString;
}

// 取得目前可用的 CRM Cookie（每次都直接重新登入，避免快取到失效的 session）
function getCRMCookie() {
  return loginToCRM();
}

// 診斷用：在編輯器裡直接執行這個函式，然後看「執行項目」或「查看 → 記錄」的 Log 輸出
function testCRMLogin() {
  Logger.log("開始測試登入...");
  const props = PropertiesService.getScriptProperties();
  const username = props.getProperty("CRM_USERNAME");
  const password = props.getProperty("CRM_PASSWORD");
  Logger.log("帳號長度：" + (username ? username.length : 0) + "，密碼長度：" + (password ? password.length : 0));

  const loginResp = UrlFetchApp.fetch(CRM_LOGIN_URL, {
    method: "post",
    headers: { "X-Requested-With": "XMLHttpRequest" },
    payload: {
      panel_uu: username,
      panel_pp: password,
      mode: "sign_in",
      goto: "/client/spanel/",
      verify_code: "",
    },
    muteHttpExceptions: true,
    followRedirects: false,
  });
  Logger.log("登入請求狀態碼：" + loginResp.getResponseCode());
  Logger.log("回應內容：" + loginResp.getContentText().slice(0, 300));

  const headers = loginResp.getAllHeaders();
  const rawSetCookie = headers["Set-Cookie"] || headers["set-cookie"];
  if (!rawSetCookie) {
    Logger.log("沒有 Set-Cookie，登入失敗");
    return;
  }
  const cookieList = Array.isArray(rawSetCookie) ? rawSetCookie : [rawSetCookie];
  const cookie = cookieList.map((c) => c.split(";")[0]).join("; ");
  Logger.log("拿到 cookie：" + cookie.substring(0, 20) + "...");

  const check = UrlFetchApp.fetch(CRM_ADD_PAGE, {
    headers: { Cookie: cookie, "X-Requested-With": "XMLHttpRequest" },
    muteHttpExceptions: true,
  });
  const snippet = check.getContentText().replace(/\s+/g, " ").slice(0, 300);
  Logger.log("驗證頁面片段：" + snippet);
  Logger.log(snippet.indexOf("sign_in.php") !== -1 ? "結論：還是沒登入成功" : "結論：登入成功了！");
}

// 診斷用：仔細檢查登入回應到底設定了哪些 Cookie，看有沒有漏抓
function testLoginCookieDetail() {
  const props = PropertiesService.getScriptProperties();
  const username = props.getProperty("CRM_USERNAME");
  const password = props.getProperty("CRM_PASSWORD");

  const resp = UrlFetchApp.fetch(CRM_LOGIN_URL, {
    method: "post",
    headers: { "X-Requested-With": "XMLHttpRequest" },
    payload: {
      panel_uu: username,
      panel_pp: password,
      mode: "sign_in",
      goto: "/client/spanel/",
      verify_code: "",
    },
    muteHttpExceptions: true,
    followRedirects: false,
  });

  const headers = resp.getAllHeaders();
  Logger.log("所有回應標頭的 key：" + Object.keys(headers).join(", "));

  const rawSetCookie = headers["Set-Cookie"] || headers["set-cookie"];
  Logger.log("Set-Cookie 原始型態：" + (Array.isArray(rawSetCookie) ? "陣列，共 " + rawSetCookie.length + " 個" : "單一字串"));
  Logger.log("Set-Cookie 完整內容（JSON）：" + JSON.stringify(rawSetCookie));
}

// 診斷用：確認登入後拿「新增客戶」頁面，到底回傳什麼內容
function testAddPage() {
  const cookie = loginToCRM();
  Logger.log("已登入，cookie：" + cookie.substring(0, 20) + "...");

  const resp = UrlFetchApp.fetch(CRM_ADD_PAGE, {
    headers: { Cookie: cookie, "X-Requested-With": "XMLHttpRequest" },
    muteHttpExceptions: true,
  });
  const html = resp.getContentText();
  Logger.log("狀態碼：" + resp.getResponseCode() + "，內容長度：" + html.length);

  const idx = html.indexOf("cmark");
  if (idx === -1) {
    Logger.log("整份內容裡完全沒有 cmark 這個字");
    Logger.log("標題附近內容：" + html.replace(/\s+/g, " ").slice(0, 200));
    Logger.log("內容中段（第 2000-2300 字）：" + html.replace(/\s+/g, " ").slice(2000, 2300));
    Logger.log("內容尾端（最後 300 字）：" + html.replace(/\s+/g, " ").slice(-300));
  } else {
    Logger.log("找到 cmark，位置：" + idx + "，前後文：" + html.substring(Math.max(0, idx - 60), idx + 100).replace(/\s+/g, " "));
  }
}

// 診斷用：一次跑完整個流程（登入→抓cmark→送出），並印出詳細的送出內容跟完整回應
function testFullSubmit() {
  const cookie = loginToCRM();
  Logger.log("登入完成，cookie：" + cookie.substring(0, 20) + "...");

  const pageResp = UrlFetchApp.fetch(CRM_ADD_PAGE, {
    headers: {
      Cookie: cookie,
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent": CRM_USER_AGENT,
    },
    muteHttpExceptions: true,
  });
  const html = pageResp.getContentText();
  const cmarkMatch = html.match(/name="cmark"\s+id="cmark"\s+value="([a-f0-9]+)"/);
  if (!cmarkMatch) {
    Logger.log("抓不到 cmark，內容長度：" + html.length);
    Logger.log("內容：" + html.replace(/\s+/g, " ").slice(0, 800));
    return;
  }
  const cmark = cmarkMatch[1];
  Logger.log("拿到 cmark：" + cmark);

  const payload = {
    company_name: "測試診斷勿刪" + new Date().getTime(),
    status: "dev",
    sales_staff_id: "9",
    industry: "",
    data_source: "",
    type: "",
    contact_name_1: "",
    contact_mobile_1: "",
    phone_1: "",
    referrer: "",
    fax: "",
    tax_id_number: "96756074",
    contact_email_1: "",
    address: "",
    web_site: "",
    work_log_content: "測試診斷內容",
    appointment_type: "",
    appointment_date: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd"),
    mode: "insert",
    id: "0",
    cmark: cmark,
    _dummy: Utilities.newBlob("", "application/octet-stream", ""),
  };

  const resp = UrlFetchApp.fetch(CRM_ADD_PAGE, {
    method: "post",
    headers: {
      Cookie: cookie,
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent": CRM_USER_AGENT,
      "Referer": CRM_ADD_PAGE,
    },
    payload: payload,
    muteHttpExceptions: true,
  });

  Logger.log("送出狀態碼：" + resp.getResponseCode());
  const actualContentType = resp.getHeaders()["Content-Type"] || resp.getHeaders()["content-type"];
  Logger.log("回應 Content-Type：" + actualContentType);
  const body = resp.getContentText();
  Logger.log("回應長度：" + body.length);
  Logger.log("回應內容（前 1500 字）：" + body.replace(/\s+/g, " ").slice(0, 1500));

  ["必填", "錯誤", "失敗", "invalid", "required", "denied", "權限"].forEach((kw) => {
    const i = body.indexOf(kw);
    if (i !== -1) {
      Logger.log(`關鍵字「${kw}」出現：` + body.substring(Math.max(0, i - 50), i + 80).replace(/\s+/g, " "));
    }
  });
}

// 包一層 fetch：自動帶入登入後的 Cookie
function crmFetch(url, options) {
  options = options || {};
  const cookie = getCRMCookie();
  options.headers = Object.assign({}, options.headers, { Cookie: cookie });
  options.muteHttpExceptions = true;
  return UrlFetchApp.fetch(url, options);
}

// ============================================================
// 用客戶名稱搜尋 CRM，找出既有客戶的編號
// ⚠️ 這個 column index 對應是根據畫面上的欄位順序（NO./編號/狀態/行業別/公司名稱...）猜測的，
//    第一次用請實際測一筆已知客戶確認有正確抓到編號，如果不對再回報，一起對照修正
// ============================================================
function findClientIdByName(name) {
  const url =
    "https://crm.makarma.com.tw/client/spanel/index.php?mode=get_list" +
    "&draw=1&start=0&length=10" +
    "&search%5Bvalue%5D=" + encodeURIComponent(name) +
    "&search%5Bregex%5D=false";

  const resp = crmFetch(url, {
    headers: { "X-Requested-With": "XMLHttpRequest" },
  });

  try {
    const result = JSON.parse(resp.getContentText());
    if (result.data && result.data.length > 0) {
      return result.data[0][0]; // 假設第一欄是客戶編號
    }
  } catch (err) {
    Logger.log("客戶搜尋失敗: " + err);
  }
  return null;
}

// ============================================================
// CRM 同步（模擬表單送出）
// ============================================================
// 中文狀態顯示文字 → CRM 實際要送的代碼（已用 testStatusOptions() 核對過）
const STATUS_CODE_MAP = {
  "名單公庫": "lp",
  "開發中": "dev",
  "評估考慮中": "eval",
  "接洽中": "cont",
  "簽約中": "sign",
  "試刊中": "trl",
  "製稿中": "drft",
  "已結案": "clsd",
  "對產品無興趣": "ni",
  "重複名單": "dup",
  "放棄名單": "aban",
  "有興趣再約訪": "intv",
  "空號": "inv",
  "未接通": "uc",
  "黑名單": "bl",
  "已收資料": "recv",
  "再追蹤": "fu",
  "未開發": "udev",
  "已結束營業": "out",
  "到期不續約": "nr",
  "合約書已簽回": "sr",
  "已成交": "done",
};

function crmStatusToCode(displayStatus) {
  return STATUS_CODE_MAP[displayStatus] || displayStatus;
}

// 診斷用：從新增客戶頁面的 HTML 裡，把「狀態」下拉選單真正的 value 對照表撈出來
function testStatusOptions() {
  const cookie = getCRMCookie();
  const resp = UrlFetchApp.fetch(CRM_ADD_PAGE, {
    headers: { Cookie: cookie, "X-Requested-With": "XMLHttpRequest" },
    muteHttpExceptions: true,
  });
  const html = resp.getContentText();

  // 抓 <select ... name="status" ...> ... </select> 這一段
  const selectMatch = html.match(/<select[^>]*name="status"[^>]*>([\s\S]*?)<\/select>/);
  if (!selectMatch) {
    Logger.log("找不到 status 下拉選單。內容長度：" + html.length);
    Logger.log("內容片段：" + html.replace(/\s+/g, " ").slice(0, 500));
    return;
  }
  const optionsHtml = selectMatch[1];
  const optionRegex = /<option[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/g;
  let m;
  const results = [];
  while ((m = optionRegex.exec(optionsHtml)) !== null) {
    results.push(`${m[2].trim()} = ${m[1]}`);
  }
  Logger.log("狀態對照表：\n" + results.join("\n"));
}

// 手動組出 multipart/form-data（GAS 的 payload 給物件時預設是 url-encoded，
// 但這個 CRM 表單原本用的是 multipart，格式不對會導致伺服器認不出這是合法送出）
function buildMultipartPayload(fields) {
  const boundary = "----WorklogBoundary" + Utilities.getUuid().replace(/-/g, "");
  let body = "";
  for (const key in fields) {
    body += "--" + boundary + "\r\n";
    body += `Content-Disposition: form-data; name="${key}"\r\n\r\n`;
    body += (fields[key] === undefined || fields[key] === null ? "" : fields[key]) + "\r\n";
  }
  body += "--" + boundary + "--\r\n";
  return { boundary: boundary, body: body };
}

function syncToCRM(info) {
  const pageUrl = info.isNewClient
    ? CRM_ADD_PAGE
    : `https://crm.makarma.com.tw/client/spanel/index.php?mode=edit&id=${info.crmId}`;

  let cookie, html, statusCode, cmarkMatch;
  const maxAttempts = 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    cookie = loginToCRM(); // 每次重試都整個重新登入，不沿用舊的

    const pageResp = UrlFetchApp.fetch(pageUrl, {
      headers: {
        Cookie: cookie,
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": CRM_USER_AGENT,
      },
      muteHttpExceptions: true,
    });
    statusCode = pageResp.getResponseCode();
    html = pageResp.getContentText();
    cmarkMatch = html.match(/name="cmark"\s+id="cmark"\s+value="([a-f0-9]+)"/);
    if (cmarkMatch) break;
    if (attempt < maxAttempts) Utilities.sleep(3000);
  }

  if (!cmarkMatch) {
    const snippet = html.replace(/\s+/g, " ").slice(0, 200);
    return {
      synced: false,
      message: `抓不到 cmark，重試${maxAttempts}次仍失敗（HTTP ${statusCode}，網址：${pageUrl}）。回應片段：${snippet}`,
    };
  }
  const cmark = cmarkMatch[1];

  // Step 2: 組表單送出，用同一組 cookie，欄位對齊真實瀏覽器送出的內容
  const payload = {
    company_name: info.clientName,
    status: info.status,
    sales_staff_id: "9", // TODO: 如果之後用不同帳號執行，這裡要改成對應的業務編號
    industry: "",
    data_source: "",
    type: "",
    contact_name_1: "",
    contact_mobile_1: "",
    phone_1: "",
    referrer: "",
    fax: "",
    tax_id_number: info.taxId,
    contact_email_1: "",
    address: "",
    web_site: "",
    work_log_content: info.note,
    appointment_type: "",
    appointment_date: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd"),
    mode: info.isNewClient ? "insert" : "update",
    id: info.isNewClient ? "0" : info.crmId,
    cmark: cmark,
    _dummy: Utilities.newBlob("", "application/octet-stream", ""),
  };

  const resp = UrlFetchApp.fetch(pageUrl, {
    method: "post",
    headers: {
      Cookie: cookie,
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent": CRM_USER_AGENT,
      "Referer": pageUrl,
    },
    payload: payload,
    muteHttpExceptions: true,
  });

  let result;
  try {
    result = JSON.parse(resp.getContentText());
  } catch (err) {
    return {
      synced: false,
      message: `CRM 回應無法解析（HTTP ${resp.getResponseCode()}）: ` + resp.getContentText().replace(/\s+/g, " ").slice(0, 200),
    };
  }

  if (result.status === "success") {
    return { synced: true, message: result.title || "同步成功", crmId: result.id };
  }
  return { synced: false, message: result.title || "CRM 回傳失敗" };
}

// ============================================================
// 案件管道表 讀寫
// ============================================================
function upsertDeal(clientName, stage, amount, note) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_DEAL);
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === clientName) {
      sheet.getRange(i + 1, 2, 1, 4).setValues([[stage, amount, note, new Date()]]);
      return;
    }
  }
  sheet.appendRow([clientName, stage, amount, note, new Date()]);
}

function getDealForClient(clientName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_DEAL);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === clientName) {
      return { stage: data[i][1], amount: data[i][2], note: data[i][3] };
    }
  }
  return null;
}

function handleUpdateDeal(data) {
  upsertDeal(data.clientName, data.stage, data.amount || "", data.note || "");
  return { status: "success" };
}

// ============================================================
// 會議邀請（合併自原本獨立的會議產生器後端）
// ============================================================
function upsertMeeting(data, isNew) {
  const title = data.title;
  const date = data.date;
  const startTime = data.startTime;
  const endTime = data.endTime;
  const location = data.location || "";

  const startDateTime = new Date(date + "T" + startTime).toISOString();
  const endDateTime = new Date(date + "T" + endTime).toISOString();

  const eventResource = {
    summary: title,
    location: location,
    start: { dateTime: startDateTime, timeZone: MEETING_TIME_ZONE },
    end: { dateTime: endDateTime, timeZone: MEETING_TIME_ZONE },
  };

  let createdEvent;
  if (isNew || !data.eventId) {
    eventResource.conferenceData = {
      createRequest: { requestId: `meet-${Date.now()}` },
    };
    createdEvent = Calendar.Events.insert(eventResource, SHARED_CALENDAR_ID, { conferenceDataVersion: 1 });
  } else {
    createdEvent = Calendar.Events.patch(eventResource, SHARED_CALENDAR_ID, data.eventId);
  }

  const meetingLink = createdEvent.hangoutLink || "";
  logMeeting(createdEvent.id, title, date, startTime, endTime, location, meetingLink);

  return { status: "success", meetingLink: meetingLink, eventId: createdEvent.id };
}

function logMeeting(eventId, title, date, startTime, endTime, location, meetingLink) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(MEETING_SHEET);
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === eventId) {
      sheet.getRange(i + 1, 2, 1, 7).setValues([[title, date, startTime, endTime, location, meetingLink, new Date()]]);
      return;
    }
  }
  sheet.appendRow([eventId, title, date, startTime, endTime, location, meetingLink, new Date()]);
}

function searchMeetings(keyword) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(MEETING_SHEET);
  const data = sheet.getDataRange().getValues();

  const results = [];
  for (let i = data.length - 1; i >= 1; i--) {
    const [eventId, title, date, startTime, endTime, location] = data[i];
    if (!keyword || String(title).indexOf(keyword) !== -1) {
      results.push({ eventId, title, date, startTime, endTime, location });
    }
    if (results.length >= 10) break;
  }
  return results;
}

// ============================================================
// 名片授權：驗證 liff.getIDToken() 拿到的 ID Token，比對「名片名單」分頁，
// 只有登記在案、啟用中的 LINE 使用者才能拿到自己的名片內容
// ============================================================
function verifyLineIdToken(idToken) {
  if (!idToken) throw new Error("缺少 LINE 登入資訊，請重新開啟這個頁面");

  const resp = UrlFetchApp.fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "post",
    payload: { id_token: idToken, client_id: LINE_CHANNEL_ID },
    muteHttpExceptions: true,
  });
  const result = JSON.parse(resp.getContentText());
  if (resp.getResponseCode() !== 200 || !result.sub) {
    throw new Error("LINE 登入驗證失敗：" + (result.error_description || resp.getContentText()));
  }
  return result.sub; // 這組是 LINE 內部使用者 ID，同一個人在同一個 Channel 下永遠固定不變
}

function getCardForLineUser(idToken) {
  let userId;
  try {
    userId = verifyLineIdToken(idToken);
  } catch (err) {
    return { status: "error", message: String(err.message || err) };
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CARD_ROSTER_SHEET);
  if (!sheet) {
    return { status: "error", message: "尚未建立「" + CARD_ROSTER_SHEET + "」分頁，請聯絡管理員" };
  }

  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const [rowUserId, name, englishName, title, mobile, email, lineId, enabled] = data[i];
    if (rowUserId === userId && String(enabled).toUpperCase() === "TRUE") {
      return { status: "success", card: { name, englishName, title, mobile, email, lineId } };
    }
  }

  return {
    status: "error",
    message: "你尚未被加入名片名單，請把這組 ID 交給管理員加入「" + CARD_ROSTER_SHEET + "」分頁：" + userId,
  };
}

// ============================================================
// 重新同步：把 Sheet 裡所有「是否已同步CRM」= FALSE 的列，逐筆重新嘗試同步
// ============================================================
function resyncFailedCRMEntries() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_LOG);
  const data = sheet.getDataRange().getValues();

  let attempted = 0;
  let succeeded = 0;

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const synced = String(row[6]).toUpperCase() === "TRUE";
    const crmStatus = row[3];
    if (synced || !crmStatus) continue; // 已同步過的、或本來就沒要同步CRM狀態的，跳過

    attempted++;
    const clientName = row[1];
    const note = row[4];
    const taxId = row[5] || DEFAULT_TAX_ID;

    let result;
    try {
      result = syncToCRM({
        clientName: clientName,
        status: crmStatusToCode(crmStatus),
        taxId: taxId,
        note: note,
        isNewClient: true, // 補送預設當新客戶；如果實際是已有客戶失敗的情況，之後可再優化判斷
        crmId: "0",
      });
    } catch (err) {
      result = { synced: false, message: "重試失敗：" + err };
    }

    sheet.getRange(i + 1, 7, 1, 2).setValues([[result.synced ? "TRUE" : "FALSE", result.message]]);
    if (result.synced) succeeded++;
    Utilities.sleep(500); // 稍微間隔一下，避免太密集的請求
  }

  const msg = `重新同步完成：共嘗試 ${attempted} 筆，成功 ${succeeded} 筆`;
  Logger.log(msg);
  SpreadsheetApp.getActiveSpreadsheet().toast(msg, "工作日誌", 8);
}

// ============================================================
// 夜間彙整 → Telegram（用「觸發器」設定每晚固定時間執行 dailySummary）
// ============================================================
function dailySummary() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const logSheet = ss.getSheetByName(SHEET_LOG);
  const dealSheet = ss.getSheetByName(SHEET_DEAL);

  const today = new Date();
  const todayStr = Utilities.formatDate(today, Session.getScriptTimeZone(), "yyyy-MM-dd");

  const logData = logSheet.getDataRange().getValues();
  const counts = { 開發: new Set(), 有效: new Set(), 加LINE: new Set(), 追蹤: new Set(), DEMO: new Set() };
  const noteLines = [];

  for (let i = 1; i < logData.length; i++) {
    const row = logData[i];
    const ts = row[0];
    if (!(ts instanceof Date)) continue;
    const dateStr = Utilities.formatDate(ts, Session.getScriptTimeZone(), "yyyy-MM-dd");
    if (dateStr !== todayStr) continue;

    const clientName = row[1];
    const types = String(row[2] || "").split(",").map((s) => s.trim()).filter(Boolean);
    types.forEach((t) => {
      if (counts[t]) counts[t].add(clientName); // 當天同客戶只算一次
    });

    const note = row[4];
    if (note) noteLines.push(`${clientName}＿${note}`);
  }

  // 案件管道表：依階段分組列出 客戶+金額
  const dealData = dealSheet.getDataRange().getValues();
  const groups = { 斡旋中: [], 預計成交: [], 已成交: [] };
  let totalRevenue = 0;

  for (let i = 1; i < dealData.length; i++) {
    const [name, stage, amount] = dealData[i];
    if (!name || !groups[stage]) continue;
    const amt = Number(amount) || 0;
    groups[stage].push(amt ? `${name} ${amt}` : `${name}`);
    if (stage === "已成交") totalRevenue += amt;
  }

  const dateLabel = Utilities.formatDate(today, Session.getScriptTimeZone(), "M/d");
  let msg = `${dateLabel} Uly  辦公室日誌\n\n`;
  msg += `開發數：${counts["開發"].size}\n`;
  msg += `有效數：${counts["有效"].size}\n`;
  msg += `加LINE：${counts["加LINE"].size}\n`;
  msg += `追蹤數：${counts["追蹤"].size}\n`;
  msg += `DEMO：${counts["DEMO"].size}\n\n`;

  noteLines.forEach((line, idx) => {
    msg += `${idx + 1}）${line}\n`;
  });

  msg += `\n\n目前成交：${groups["已成交"].join("、") || "無"}\n`;
  msg += `預計成交：${groups["預計成交"].join("、") || "無"}\n`;
  msg += `斡旋中：${groups["斡旋中"].join("、") || "無"}\n\n`;
  msg += `目前業績：$${totalRevenue}`;

  sendTelegramMessage(msg);
}

function sendTelegramMessage(text) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty("TELEGRAM_BOT_TOKEN");
  const chatId = props.getProperty("TELEGRAM_CHAT_ID");
  if (!token || !chatId) {
    Logger.log("缺少 TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_ID");
    return;
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  UrlFetchApp.fetch(url, {
    method: "post",
    payload: { chat_id: chatId, text: text },
    muteHttpExceptions: true,
  });
}

// 執行一次即可建立每晚 21:00 自動觸發
function setupNightlyTrigger() {
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === "dailySummary") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("dailySummary").timeBased().everyDays(1).atHour(21).create();
}

// ============================================================
// Sheet 側邊欄
// ============================================================
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("工作日誌")
    .addItem("開啟記錄側邊欄", "showSidebar")
    .addItem("重新同步未成功的CRM記錄", "resyncFailedCRMEntries")
    .addItem("重建 Sheet 結構", "setupSheets")
    .addItem("建立會議記錄表", "setupMeetingSheet")
    .addItem("建立名片名單表", "setupCardRosterSheet")
    .addItem("設定每晚彙整觸發器", "setupNightlyTrigger")
    .addToUi();
}

function showSidebar() {
  const html = HtmlService.createHtmlOutputFromFile("sidebar")
    .setTitle("工作日誌記錄");
  SpreadsheetApp.getUi().showSidebar(html);
}

// ============================================================
// LINE Webhook：使用者打字進來時，回覆一個選單（連到三個 LIFF）
// ⚠️ 說明：GAS 的 doPost 無法讀取自訂請求標頭，所以這裡沒有驗證 LINE 官方要求的
// X-Line-Signature 簽章。對個人自用的 bot 影響不大，但如果之後開放給更多人用，
// 要注意這個限制（一般作法是換成其他能讀取標頭的平台來驗證）。
// ============================================================
function handleLineWebhook(body) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty("LINE_CHANNEL_ACCESS_TOKEN");
  if (!token) {
    Logger.log("尚未設定 LINE_CHANNEL_ACCESS_TOKEN");
    return ContentService.createTextOutput("");
  }

  (body.events || []).forEach((event) => {
    if (event.type === "message" && event.message && event.message.type === "text") {
      replyMenu(event.replyToken, token);
    }
  });

  return ContentService.createTextOutput("");
}

function replyMenu(replyToken, token) {
  const baseUrl = ScriptApp.getService().getUrl(); // 這個 Web App 目前部署的網址
  const liffUrl = (liffId) => `https://liff.line.me/${liffId}`;

  const flexMessage = {
    type: "flex",
    altText: "MaKarma 快捷選單",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "20px",
        contents: [
          { type: "text", text: "MaKarma 快捷選單", weight: "bold", size: "lg" },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          {
            type: "button",
            style: "primary",
            height: "sm",
            color: "#FFA000",
            action: { type: "uri", label: "工作日誌", uri: liffUrl(LIFF_ID_WORKLOG) },
          },
          {
            type: "button",
            style: "primary",
            height: "sm",
            color: "#FFA000",
            action: { type: "uri", label: "名片", uri: liffUrl(LIFF_ID_CARD) },
          },
          {
            type: "button",
            style: "primary",
            height: "sm",
            color: "#FFA000",
            action: { type: "uri", label: "會議邀請", uri: liffUrl(LIFF_ID_MEETING) },
          },
        ],
      },
    },
  };

  UrlFetchApp.fetch("https://api.line.me/v2/bot/message/reply", {
    method: "post",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
    },
    payload: JSON.stringify({
      replyToken: replyToken,
      messages: [flexMessage],
    }),
    muteHttpExceptions: true,
  });
}
