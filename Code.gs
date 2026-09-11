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
 *    - CRM_USERNAME         登入 makarma CRM 用的員工帳號（該員工需在CRM後台「允許API呼叫」）
 *    - CRM_PASSWORD         登入 makarma CRM 用的密碼
 *    程式會呼叫 CRM 官方 REST API 自動領 token，過期/失效時自動重新領取
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
const QA_SHEET = "問答範本";
const LINE_CHANNEL_ID = "2007968447"; // LIFF ID 開頭那段數字，用來驗證 liff.getIDToken() 拿到的 token
const SHARED_CALENDAR_ID = "98965ff9c9be5cf34d9836f9d5aa671ba4c185a003084987e03649d18bbc1adb@group.calendar.google.com";
const MEETING_TIME_ZONE = "Asia/Taipei";

// LINE LIFF ID（用來組成選單按鈕的連結）
const LIFF_ID_WORKLOG = "2007968447-bNwIeM6Y"; // 建立好工作日誌的 LIFF app 後，把 ID 貼在這裡
const LIFF_ID_CARD = "2007968447-L1XqQgMW";
const LIFF_ID_MEETING = "2007968447-PQ3LQjeO";

// 業務戰情室（同事另外架設的 Cloudflare 應用，管客戶/Pipeline/戰報），外部網站直接開連結即可，不需要 LIFF ID
const SALES_WAR_ROOM_URL = "https://sales-war-room.gorgeousamy2022.chatgpt.site";

const DEFAULT_TAX_ID = "96756074"; // 沒有真實統編時的暫代值（CRM API 允許這組統編重複）

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
    "統一編號", "是否新客", "是否已同步CRM", "CRM同步訊息",
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
        requireAuthorizedUser(body.idToken);
        return jsonOut(handleSubmit(body));
      case "lookupTaxId":
        requireAuthorizedUser(body.idToken);
        return jsonOut({ status: "success", candidates: lookupTaxId(body.companyName) });
      case "updateDeal":
        requireAuthorizedUser(body.idToken);
        return jsonOut(handleUpdateDeal(body));
      case "getDealStage":
        requireAuthorizedUser(body.idToken);
        return jsonOut({ status: "success", deal: getDealForClient(body.clientName) });
      case "meetingSearch":
        requireAuthorizedUser(body.idToken);
        return jsonOut({ status: "success", meetings: searchMeetings(body.keyword || "") });
      case "meetingCreate":
        requireAuthorizedUser(body.idToken);
        return jsonOut(upsertMeeting(body, true));
      case "meetingUpdate":
        requireAuthorizedUser(body.idToken);
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

  const isNewClientInput = !!data.isNewClient;
  let crmResult = { synced: false, message: "未同步" };
  if (data.crmStatus) {
    try {
      let isNewClient = isNewClientInput;
      let crmId = data.crmId || "";

      if (!isNewClient && !crmId) {
        // 已有客戶但沒填編號，先用名稱查詢 CRM 找出編號
        crmId = findClientIdByName(clientName);
        if (!crmId) {
          crmResult = {
            synced: false,
            message: "找不到「" + clientName + "」在 CRM 的客戶編號，請手動填入 CRM 客戶編號後再試一次",
          };
        }
      }

      if (crmId || isNewClient) {
        // isNewClient 且統編其實已存在的狀況，由 syncToCRM 收到 duplicate_tax_id 時自動改走更新
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
    isNewClientInput ? "新客戶" : "已有客戶",
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
// CRM 官方 REST API（客戶資料 API：領 token → 查詢/新增/更新）
// 文件：CRMAPI使用指南.pdf
// 前提：CRM_USERNAME 這個員工帳號要先在後台「工作人員 → 編輯該員工 → 主要頁籤 →
//       允許 API 呼叫」打開，且帳號狀態為啟用中，否則會收到 api_not_allowed。
// ============================================================
const CRM_REST_URL = "https://crm.makarma.com.tw/client/rest/index.php";

// 每次重新領取 token 都會讓舊 token 立刻失效，所以領到後存進 Script Properties 重複使用，
// 只在沒有快取或收到 auth_failed（token 過期/失效）時才重新領取。
function getCRMToken(forceNew) {
  const props = PropertiesService.getScriptProperties();
  if (!forceNew) {
    const cached = props.getProperty("CRM_TOKEN");
    if (cached) return cached;
  }

  const username = props.getProperty("CRM_USERNAME");
  const password = props.getProperty("CRM_PASSWORD");
  if (!username || !password) {
    throw new Error("尚未設定 CRM_USERNAME / CRM_PASSWORD");
  }

  const resp = UrlFetchApp.fetch(CRM_REST_URL, {
    method: "post",
    contentType: "application/json; charset=utf-8",
    payload: JSON.stringify({ username: username, password: password }),
    muteHttpExceptions: true,
  });

  let result;
  try {
    result = JSON.parse(resp.getContentText());
  } catch (err) {
    throw new Error("領取 token 回應無法解析（HTTP " + resp.getResponseCode() + "）：" + resp.getContentText().slice(0, 200));
  }
  if (result.status !== "success" || !result.data || !result.data.token) {
    throw new Error("CRM 登入失敗：" + (result.message || JSON.stringify(result)));
  }

  props.setProperty("CRM_TOKEN", result.data.token);
  return result.data.token;
}

// 呼叫查詢／新增／更新，統一處理 Bearer token；如果 token 失效會自動重新領取一次再重試
function crmApiRequest(method, opts) {
  opts = opts || {};
  let url = CRM_REST_URL;
  if (opts.query) {
    const qs = Object.keys(opts.query)
      .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(opts.query[k]))
      .join("&");
    if (qs) url += "?" + qs;
  }

  const doFetch = (token) => {
    const fetchOpts = {
      method: method,
      headers: { Authorization: "Bearer " + token },
      muteHttpExceptions: true,
    };
    if (opts.body) {
      fetchOpts.contentType = "application/json; charset=utf-8";
      fetchOpts.payload = JSON.stringify(opts.body);
    }
    const resp = UrlFetchApp.fetch(url, fetchOpts);
    try {
      return JSON.parse(resp.getContentText());
    } catch (err) {
      throw new Error("CRM 回應無法解析（HTTP " + resp.getResponseCode() + "）：" + resp.getContentText().slice(0, 200));
    }
  };

  let result = doFetch(getCRMToken(false));
  if (result.status === "fail" && result.error_code === "auth_failed") {
    result = doFetch(getCRMToken(true));
  }
  return result;
}

// 診斷用：在編輯器裡直接執行這個函式，看「執行項目」或「查看 → 記錄」的 Log 輸出
function testCRMApiLogin() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty("CRM_TOKEN"); // 強制重新領一次，確認帳密真的可行
  try {
    const token = getCRMToken(true);
    Logger.log("領取 token 成功，長度：" + token.length);
  } catch (err) {
    Logger.log("領取 token 失敗：" + err);
    return;
  }

  // 用剛拿到的 token 查一筆隨便的公司名稱，確認查詢流程也通（查無資料是正常的，代表 API 有回應）
  const result = crmApiRequest("get", { query: { company_name: "測試 API 公司 001" } });
  Logger.log("查詢測試回應：" + JSON.stringify(result));
}

// 診斷用：實際新增一筆「看得出來是測試」的客戶資料，驗證新增流程真的能寫進 CRM。
// - 統編用 96756074（文件裡明確允許跟其他客戶重複的暫代碼），不會跟真實客戶的統編卡到。
// - 公司名稱帶時間戳記方便辨認，測完請自行到 CRM 網頁上手動刪除這筆測試資料。
function testCRMApiCreate() {
  const testName = "測試診斷勿刪_" + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd_HHmmss");
  const result = syncToCRM({
    clientName: testName,
    status: crmStatusToCode("開發中"),
    taxId: DEFAULT_TAX_ID,
    note: "這是 testCRMApiCreate() 建立的測試資料，確認可刪除",
    isNewClient: true,
    crmId: "0",
  });
  Logger.log("新增測試結果：" + JSON.stringify(result));
  if (result.synced) {
    Logger.log(`成功！公司名稱「${testName}」、CRM 編號 ${result.crmId}。請到 CRM 網頁上手動刪除這筆測試資料。`);
  }
}

// ============================================================
// 用客戶名稱查詢 CRM，找出既有客戶的編號（company_name 需完全相符，不支援模糊搜尋）
// ============================================================
function findClientIdByName(name) {
  const result = crmApiRequest("get", { query: { company_name: name } });
  if (result.status !== "success" || !result.data) return null;
  if (Array.isArray(result.data)) {
    return result.data.length > 0 ? result.data[0].id : null;
  }
  return result.data.id || null;
}

// ============================================================
// CRM 同步（REST API：新增用 POST，更新用 PUT）
// ============================================================
// 中文狀態顯示文字 → CRM API 實際要送的代碼（對照 CRMAPI使用指南.pdf 附錄 7.3）
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

// info: { clientName, status, taxId, note, isNewClient, crmId }
function syncToCRM(info) {
  try {
    if (info.isNewClient) {
      const body = {
        company_name: info.clientName,
        tax_id_number: info.taxId,
        status: info.status,
      };
      if (info.note) body.content_plain = info.note;

      const result = crmApiRequest("post", { body: body });
      if (result.status === "success") {
        return { synced: true, message: "新增成功", crmId: result.data.id };
      }

      if (result.error_code === "duplicate_tax_id") {
        // 統編已存在：改成用公司名稱查出既有客戶編號，改走更新流程，避免建出重複客戶
        const existingId = findClientIdByName(info.clientName);
        if (existingId) {
          const updateResult = syncToCRM(Object.assign({}, info, { isNewClient: false, crmId: existingId }));
          updateResult.message =
            `統編已存在於 CRM（編號 ${existingId}），已自動改成更新該筆客戶；` + (updateResult.message || "");
          return updateResult;
        }
        return {
          synced: false,
          message: `統編 ${info.taxId} 已存在於 CRM，但依公司名稱「${info.clientName}」查不到對應客戶（名稱可能不完全一致），請手動確認後再試一次`,
        };
      }

      return { synced: false, message: (result.message || "新增失敗") + (result.error_code ? `（${result.error_code}）` : "") };
    }

    const body = { id: info.crmId, status: info.status };
    if (info.note) body.content_plain = info.note;
    if (info.taxId && info.taxId !== DEFAULT_TAX_ID) body.tax_id_number = info.taxId;

    const result = crmApiRequest("put", { body: body });
    if (result.status === "success") {
      return { synced: true, message: "更新成功", crmId: result.data.id };
    }
    return { synced: false, message: (result.message || "更新失敗") + (result.error_code ? `（${result.error_code}）` : "") };
  } catch (err) {
    return { synced: false, message: "同步失敗：" + err };
  }
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

// 純粹比對「名片名單」授權名單，不驗證 idToken——給已經知道 LINE userId 的呼叫方用
// （例如 LINE Webhook 事件本身帶的 source.userId，本來就是 LINE 平台驗證過的，不需要再驗一次）
function isAuthorizedUserId(userId) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CARD_ROSTER_SHEET);
  if (!sheet || !userId) return false;
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === userId && String(data[i][7]).toUpperCase() === "TRUE") return true;
  }
  return false;
}

// 給 LIFF 表單（會議、工作日誌）用：驗證 idToken 是誰、且必須是授權名單裡啟用中的人，
// 沒通過就丟例外（doPost 的 try/catch 會接住，回傳 error 訊息給前端）
function requireAuthorizedUser(idToken) {
  const userId = verifyLineIdToken(idToken);
  if (!isAuthorizedUserId(userId)) {
    throw new Error("您尚未完成綁定審核，請先在 LINE 官方帳號的圖文選單點選「綁定」");
  }
  return userId;
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
    const synced = String(row[7]).toUpperCase() === "TRUE";
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

    sheet.getRange(i + 1, 8, 1, 2).setValues([[result.synced ? "TRUE" : "FALSE", result.message]]);
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
    const userId = event.source && event.source.userId;
    if (!userId) return;

    if (event.type === "message" && event.message && event.message.type === "text") {
      const text = event.message.text.trim();

      if (text === "綁定" || text.toLowerCase() === "bind") {
        handleBindRequest(userId, event.replyToken, token);
        return;
      }

      if (!isAuthorizedUserId(userId)) {
        replyLineText(event.replyToken, token, "您好，這是內部帳號，請先點選圖文選單的「綁定」完成審核才能使用🙏");
        return;
      }

      if (text === "選單" || text.toLowerCase() === "menu") {
        replyMenu(event.replyToken, token);
      } else {
        const replyMsg = generateReplyText(text);
        replyLineText(event.replyToken, token, replyMsg);
      }
    }
  });

  return ContentService.createTextOutput("");
}

// ============================================================
// 綁定申請：未在「名片名單」裡的人第一次點「綁定」，自動加一列（啟用=FALSE）
// 並用 Telegram 通知管理員手動審核；已經在名單裡的人依現在的啟用狀態回覆對應訊息。
// 真正的核准動作是管理員把 Sheet 上「啟用」欄改成 TRUE——那一刻由 onSheetEditInstallable
// 這個安裝式觸發器接手，自動切換圖文選單並推播通知使用者。
// ============================================================
function handleBindRequest(userId, replyToken, token) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CARD_ROSTER_SHEET);
  if (!sheet) {
    replyLineText(replyToken, token, "系統尚未設定完成，請聯絡管理員");
    return;
  }

  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === userId) {
      const enabled = String(data[i][7]).toUpperCase() === "TRUE";
      replyLineText(
        replyToken,
        token,
        enabled ? "您已經綁定過了，可以直接使用選單功能囉🙏" : "您的綁定申請正在審核中，請耐心等候，通過後會通知您🙏"
      );
      return;
    }
  }

  const displayName = getLineDisplayName(userId, token);
  sheet.appendRow([userId, displayName, "", "", "", "", "", "FALSE"]);

  replyLineText(replyToken, token, "已收到您的綁定申請，請等待管理員審核，通過後會自動通知您🙏");
  notifyAdminOfBindRequest(displayName, userId);
}

function getLineDisplayName(userId, token) {
  try {
    const resp = UrlFetchApp.fetch("https://api.line.me/v2/bot/profile/" + userId, {
      headers: { Authorization: "Bearer " + token },
      muteHttpExceptions: true,
    });
    const result = JSON.parse(resp.getContentText());
    return result.displayName || "";
  } catch (err) {
    return "";
  }
}

function notifyAdminOfBindRequest(displayName, userId) {
  sendTelegramMessage(
    "🔔 新的綁定申請\n姓名：" + (displayName || "（無法取得）") + "\nLINE ID：" + userId +
    "\n\n請到「" + CARD_ROSTER_SHEET + "」分頁把這個人那一列的「啟用」欄改成 TRUE 來核准"
  );
}

// ============================================================
// 核准後的自動處理：安裝式 onEdit 觸發器（需在編輯器手動執行 setupBindApprovalTrigger 一次授權）
// 偵測「名片名單」分頁的「啟用」欄被改成 TRUE，自動切換該使用者的圖文選單、推播通知
// ============================================================
function onSheetEditInstallable(e) {
  try {
    const sheet = e.range.getSheet();
    if (sheet.getName() !== CARD_ROSTER_SHEET) return;
    if (e.range.getColumn() !== 8 || e.range.getRow() === 1) return; // 第8欄＝啟用，跳過表頭

    const newValue = String(e.value || "").toUpperCase();
    if (newValue !== "TRUE") return;

    const userId = sheet.getRange(e.range.getRow(), 1).getValue();
    if (!userId) return;

    switchUserToRichMenu(userId, "RICH_MENU_ID_BOUND");
    notifyUserApproved(userId);
  } catch (err) {
    Logger.log("[onSheetEditInstallable ERROR] " + err);
  }
}

function switchUserToRichMenu(userId, propertyName) {
  const props = PropertiesService.getScriptProperties();
  const richMenuId = props.getProperty(propertyName);
  const token = props.getProperty("LINE_CHANNEL_ACCESS_TOKEN");
  if (!richMenuId || !token) {
    Logger.log("尚未設定 " + propertyName + " 或 LINE_CHANNEL_ACCESS_TOKEN");
    return;
  }
  UrlFetchApp.fetch("https://api.line.me/v2/bot/user/" + userId + "/richmenu/" + richMenuId, {
    method: "post",
    headers: { Authorization: "Bearer " + token },
    muteHttpExceptions: true,
  });
}

function notifyUserApproved(userId) {
  const token = PropertiesService.getScriptProperties().getProperty("LINE_CHANNEL_ACCESS_TOKEN");
  UrlFetchApp.fetch("https://api.line.me/v2/bot/message/push", {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + token },
    payload: JSON.stringify({
      to: userId,
      messages: [{ type: "text", text: "🎉 您的綁定申請已通過！選單已切換，可以開始使用囉。" }],
    }),
    muteHttpExceptions: true,
  });
}

// 在編輯器裡手動執行一次即可（會要求授權），之後管理員在 Sheet 上核准就會自動生效
function setupBindApprovalTrigger() {
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === "onSheetEditInstallable") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("onSheetEditInstallable")
    .forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet())
    .onEdit()
    .create();
  Logger.log("綁定核准觸發器已設定完成");
}

function replyLineText(replyToken, token, text) {
  UrlFetchApp.fetch("https://api.line.me/v2/bot/message/reply", {
    method: "post",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
    },
    payload: JSON.stringify({
      replyToken: replyToken,
      messages: [{ type: "text", text: text }],
    }),
    muteHttpExceptions: true,
  });
}

// ============================================================
// AI 回覆 / QA 比對（問答範本分頁：intent, template, keywords）
// keywords 有填的列，命中就直接回 template，不呼叫 AI；沒命中才進 AI 分類流程
// ============================================================
function loadTemplatesData() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(QA_SHEET);
  if (!sheet) return { templates: {}, qaEntries: [] };

  const data = sheet.getDataRange().getValues();
  const header = data[0];
  const intentCol = header.indexOf("intent");
  const templateCol = header.indexOf("template");
  const keywordsCol = header.indexOf("keywords");

  const templates = {};
  const qaEntries = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const intent = String(row[intentCol] || "").trim();
    const template = String(row[templateCol] || "").trim();
    if (!intent || !template) continue;

    templates[intent] = template;

    const keywordsRaw = keywordsCol !== -1 ? String(row[keywordsCol] || "").trim() : "";
    if (keywordsRaw) {
      const keywords = keywordsRaw.split(",").map((k) => k.trim()).filter(Boolean);
      if (keywords.length) qaEntries.push({ keywords: keywords, answer: template });
    }
  }

  return { templates: templates, qaEntries: qaEntries };
}

function matchQa(message, qaEntries) {
  for (const entry of qaEntries) {
    if (entry.keywords.some((kw) => message.indexOf(kw) !== -1)) {
      return entry.answer;
    }
  }
  return null;
}

// effort: "low"（預設，快速分類/簡短回覆用）或 "medium"/"high"（複雜生成可拉高）
// 注意：Claude 目前預設會用 adaptive thinking，這種情況下不能帶 temperature（會 400），
// 所以這裡完全不送 temperature，改用 effort 控制運算深度。
function callClaude(systemPrompt, userPrompt, maxTokens, effort) {
  const apiKey = PropertiesService.getScriptProperties().getProperty("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("尚未設定 ANTHROPIC_API_KEY");

  const payload = {
    model: "claude-opus-5",
    max_tokens: maxTokens || 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
    output_config: { effort: effort || "low" },
  };

  const resp = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
    method: "post",
    contentType: "application/json",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const result = JSON.parse(resp.getContentText());
  if (!result.content || !result.content.length) {
    throw new Error("Claude 回應異常（HTTP " + resp.getResponseCode() + "）：" + resp.getContentText().slice(0, 300));
  }
  const textBlock = result.content.filter((b) => b.type === "text")[0];
  return textBlock ? textBlock.text.trim() : "";
}

const CLASSIFY_PROMPT = `你是訊息分類助理。只能回傳 JSON，格式：{"intent": "<意圖>", "entities": {}}

意圖清單：
- payment_personal  → 匯款個人帳號（不需發票）。關鍵字：個人帳號
- payment_company   → 匯款公司帳號（需發票）。關鍵字：公司帳號、發票
- payment_screenshot → 請截圖。關鍵字：截圖、刷卡、信用卡、匯款完成
- meeting_reminder  → 碰面/Demo 前提醒。含日期時間地點
- meeting_thanks    → 碰面/Demo 後感謝。含人名
- unknown

entities：
payment_*: {"amount": 數字}
payment_screenshot: {"payment_type": "匯款"或"刷卡"}
meeting_reminder: {"person_name":..,"date":..,"weekday":..,"time":..,"address":..,"phone":..,"topics":..}
meeting_thanks: {"person_names":..,"follow_up":..}`;

function classifyIntent(message) {
  const content = callClaude(CLASSIFY_PROMPT, message, 300, "low");
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return { intent: "unknown", entities: {} };
  try {
    return JSON.parse(match[0]);
  } catch (err) {
    return { intent: "unknown", entities: {} };
  }
}

function fillTemplate(template, replacements) {
  let result = template;
  Object.keys(replacements).forEach((key) => {
    result = result.split("{" + key + "}").join(replacements[key]);
  });
  return result;
}

function generateMeetingMessage(template, entities, userInput) {
  const systemPrompt =
    "你是業務助理，撰寫會面相關訊息。參考此風格：\n---\n" + template + "\n---\n只回傳訊息本文。";
  const lines = Object.keys(entities)
    .filter((k) => entities[k])
    .map((k) => k + ": " + entities[k])
    .join("\n");
  return callClaude(systemPrompt, "輸入：" + userInput + "\n資訊：\n" + lines, 800, "low");
}

const FALLBACK_SYSTEM_PROMPT =
  "你是瑪卡鎷網路行銷（MaKarma）LINE 官方帳號的客服助理。\n" +
  "使用者這則訊息無法對應到既有的範本。請用繁體中文簡短回覆（不超過3句話），語氣親切自然。\n" +
  "如果問題涉及報價、合約細節、專案進度等你不清楚的具體資訊，請直接引導對方稍等由專人回覆，不要編造答案。";

function fallbackReply(message) {
  return callClaude(FALLBACK_SYSTEM_PROMPT, message, 300, "low");
}

function generateReplyText(message) {
  try {
    const loaded = loadTemplatesData();
    const templates = loaded.templates;

    const qaAnswer = matchQa(message, loaded.qaEntries);
    if (qaAnswer) return qaAnswer;

    const result = classifyIntent(message);
    const intent = result.intent || "unknown";
    const entities = result.entities || {};
    const template = templates[intent] || "";

    if (intent === "payment_personal" || intent === "payment_company") {
      const amount = Number(entities.amount) || 0;
      return fillTemplate(template, { amount: amount.toLocaleString("en-US") });
    }
    if (intent === "payment_screenshot") {
      return fillTemplate(template, { payment_type: entities.payment_type || "匯款" });
    }
    if (intent === "meeting_reminder" || intent === "meeting_thanks") {
      return generateMeetingMessage(template, entities, message);
    }
    return fallbackReply(message);
  } catch (err) {
    Logger.log("[generateReplyText ERROR] " + err);
    return "處理訊息時發生錯誤，請稍後再試 🙏";
  }
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
          {
            type: "button",
            style: "primary",
            height: "sm",
            color: "#1976D2",
            action: { type: "uri", label: "業務戰情室", uri: SALES_WAR_ROOM_URL },
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
