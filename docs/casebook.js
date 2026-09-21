'use strict';
/**
 * 這支檔案改寫自業務同事「客戶成效戰情室」網站的 app.js（style.css/strengths.css
 * 也是直接拿她的檔案，公開的 cases.json 資料也是同一套邏輯），目的是讓我們自己的
 * 成效展示頁用同一套版型。跟她原始版本比，只動了三個地方：
 *
 * 1. 她的客戶頁是路徑式網址（/clients/<id>/，每個客戶一個靜態檔案），GitHub Pages
 *    沒有伺服器可以做這種動態路由；改成跟我們原本一樣的 `?client=<id>` 網址參數，
 *    整個網站只有一個 index.html。
 * 2. 她的產業分類是寫死的 11 類（她自己的客戶名單用的分類），我們自己的客戶分類
 *    不一樣，改成從資料裡直接算出有哪些分類、各有幾個客戶，不寫死。
 * 3. 最關鍵的一點：她的 renderClient()/storyBody() 假設每個客戶都有完整的成效故事
 *    資料（GSC 逐月趨勢、客戶原話、時間軸…），我們自己補的客戶通常沒有這麼完整，
 *    直接套用會因為缺欄位而整頁跳錯。這裡用後端 `?api=cases` 給的 `richStory` 旗標
 *    判斷：同事有追蹤、資料完整的客戶才套用這套版型；我們自己獨有、資料比較簡單的
 *    客戶，改用我們原本那個報告頁（renderReportPage()，在 index.html 裡）顯示。
 *
 * 已經拿掉她原始 app.js 裡幾個沒被任何地方呼叫到的舊函式（keywordTable／
 * reportedSearchHTML／timeContextHTML／publicBackgroundHTML／progressStoryHTML／
 * rankingProof／metricHTML／gscTrend），減少要維護的程式碼。
 */

var cbCases = [];
var cbGroups = [];
var cbCasesPromise = null;

// 進站時先記住首頁的原始樣子（左側欄選單＋主要內容），從客戶頁返回首頁時才能還原
var CB_HOME_MAIN_HTML = null;
var CB_HOME_SIDEBAR_NAV_HTML = null;

function cbCaptureHomeShell() {
  if (CB_HOME_MAIN_HTML == null) CB_HOME_MAIN_HTML = document.getElementById('main').innerHTML;
  var nav = document.querySelector('.sidebar nav');
  if (CB_HOME_SIDEBAR_NAV_HTML == null && nav) CB_HOME_SIDEBAR_NAV_HTML = nav.innerHTML;
}

function cbRestoreHomeShell() {
  document.body.classList.remove('client-page', 'branded-client');
  ['accent', 'ink', 'soft', 'dark'].forEach(function (key) { document.body.style.removeProperty('--brand-' + key); });
  if (CB_HOME_MAIN_HTML != null) document.getElementById('main').innerHTML = CB_HOME_MAIN_HTML;
  var nav = document.querySelector('.sidebar nav');
  if (nav && CB_HOME_SIDEBAR_NAV_HTML != null) nav.innerHTML = CB_HOME_SIDEBAR_NAV_HTML;
  var sideBottom = document.querySelector('.side-bottom');
  if (sideBottom) sideBottom.style.display = '';
}

function cbClientURL(id) { return '?client=' + encodeURIComponent(id); }

function cbFetchCases() {
  if (cbCasesPromise) return cbCasesPromise;
  cbCasesPromise = jsonpWithRetry(API_BASE + "?api=cases").then(function (data) {
    cbCases = data || [];
    var counts = {};
    cbCases.forEach(function (c) { if (c.group) counts[c.group] = (counts[c.group] || 0) + 1; });
    cbGroups = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
    return cbCases;
  });
  return cbCasesPromise;
}

function cbBullets(items) {
  return '<ul class="case-bullets">' + (items || []).filter(Boolean).map(function (t) { return '<li>' + escapeHtml(t) + '</li>'; }).join('') + '</ul>';
}

function cbCustomerQuotes(c) {
  if (!c.customerQuotes || !c.customerQuotes.length) return '';
  return '<div class="customer-quotes">' + c.customerQuotes.map(function (q) {
    return '<figure class="customer-quote">' +
      (q.summary ? '<p class="quote-summary">' + escapeHtml(q.summary) + '</p>' : '<blockquote>' + escapeHtml(q.quote) + '</blockquote>') +
      '<figcaption>' + escapeHtml(q.speaker) + ' · ' + escapeHtml(q.date) + '<small>' + escapeHtml(q.context) + '</small></figcaption>' +
      (q.summary ? '<details class="quote-original"><summary>看客戶原話</summary><blockquote>' + escapeHtml(q.quote) + '</blockquote></details>' : '') +
      '</figure>';
  }).join('') + '</div>';
}

function cbRankingOverview() {
  var el = document.getElementById('ranking-overview');
  if (!el) return;
  var withStats = cbCases.filter(function (c) { return c.gscKeywordStats; });
  var total = withStats.reduce(function (n, c) { return n + (c.gscKeywordStats.top10 || 0); }, 0);
  if (!withStats.length) { el.innerHTML = ''; return; }
  el.innerHTML = '<p class="eyebrow">' + cbCases.length + ' 家品牌，搜尋能見度一起累積</p><h2><strong>' + fmt(total) + '</strong> 組平均排名進前 10 名</h2><p>每 1 組，都是客人透過不同搜尋找到品牌的機會。</p><p class="volume-caption">加總各網站在 GSC 匯出期間的前 10 名查詢詞；同詞出現在不同網站會分別計算。包含品牌字、長尾字與合作前既有內容，非目前固定排名或本次合作目標字數。</p><details><summary>查看每家品牌的前 10 名組數</summary><div class="ranking-scroll"><table class="ranking-table"><thead><tr><th>品牌</th><th>平均前 10 名</th><th>其中前 3 名</th><th>統計期間</th></tr></thead><tbody>' +
    withStats.map(function (c) { return '<tr><th><a href="' + cbClientURL(c.id) + '">' + escapeHtml(c.name) + '</a></th><td>' + fmt(c.gscKeywordStats.top10) + ' 組</td><td>' + fmt(c.gscKeywordStats.top3) + ' 組</td><td>' + escapeHtml(c.gscKeywordStats.start) + ' ～ ' + escapeHtml(c.gscKeywordStats.end) + '</td></tr>'; }).join('') +
    '</tbody></table></div><p class="volume-caption">逐檔計算查詢詞，未以展示案例的關鍵字數代替。多數匯出檔為 1,000 筆，組數限於匯出可見範圍。</p></details>';
}

function cbConciseKeywords(c) {
  var key = function (s) { return String(s).replace(/\s+/g, '').toLowerCase(); };
  var rows = new Map();
  var volumes = new Map((c.volumes || []).map(function (v) { return [key(v.keyword), v]; }));
  var examples = ((c.gscKeywordStats && c.gscKeywordStats.examples) || [])
    .filter(function (q) { return q.position > 0 && q.position <= 10 && q.clicks >= ((c.gscKeywordStats && c.gscKeywordStats.displayMinClicks) != null ? c.gscKeywordStats.displayMinClicks : 11); })
    .sort(function (a, b) { return b.clicks - a.clicks; }).slice(0, 20);
  var observed = new Map();
  (c.reportedSearch || []).forEach(function (r) {
    var k = key(r.keyword), prev = observed.get(k);
    if ((r.position || r.ai) && (!prev || r.date > prev.date)) observed.set(k, r);
  });
  observed.forEach(function (r, k) { rows.set(k, Object.assign({}, volumes.get(k), r, { observed: true, average: null })); });
  examples.forEach(function (q) {
    var k = key(q.keyword), r = rows.get(k);
    rows.set(k, r ? Object.assign({}, q, r, { monthly: r.monthly != null ? r.monthly : q.monthly, average: q.position, clicks: q.clicks }) : Object.assign({}, volumes.get(k), q, { average: q.position }));
  });
  if (!rows.size) return '';
  var rowHTML = function (r) {
    return '<tr><th scope="row">' + escapeHtml(r.keyword) + '</th><td>' + (Number(r.monthly) > 0 ? fmt(r.monthly) + ' 次' : '尚無紀錄') + '</td><td>' +
      (r.observed ? '<strong>' + escapeHtml(r.position || '') + '</strong><small class="rank-source">' + escapeHtml(r.date) + ' 觀測</small>' : '平均第 ' + fmt(r.average) + ' 名') +
      (r.observed && r.average ? '<small class="rank-source">期間平均第 ' + fmt(r.average) + ' 名</small>' : '') + '</td><td>' +
      (r.clicks != null ? fmt(r.clicks) + ' 次' : '—') + '</td><td>' +
      (r.ai ? '<span class="ai-confirmed">' + escapeHtml((['出現 AI 摘要', '已確認'].indexOf(r.ai) !== -1) ? 'AI 摘要已確認' : 'AI 摘要 · ' + r.ai) + '</span>' : '尚無逐字觀測紀錄') + '</td></tr>';
  };
  var table = function (rs) { return '<div class="ranking-scroll"><table class="ranking-table"><thead><tr><th>客人搜尋的字</th><th>月搜尋量</th><th>排名成果</th><th>點進網站</th><th>AI 摘要紀錄</th></tr></thead><tbody>' + rs.map(rowHTML).join('') + '</tbody></table></div>'; };
  var all = Array.from(rows.values()).sort(function (a, b) { return (b.clicks != null ? b.clicks : -1) - (a.clicks != null ? a.clicks : -1); });
  return '<section class="logic-section" id="search-keywords"><p class="eyebrow">代表關鍵字</p><h2>前段排名中，哪些字帶來更多點擊？</h2>' + table(all.slice(0, 5)) +
    (all.length > 5 ? '<details class="trend-panel"><summary>查看其餘 ' + (all.length - 5) + ' 組關鍵字</summary>' + table(all.slice(5)) + '</details>' : '') +
    '<p class="volume-caption">觀測排名以標示日期為準；期間平均來自 GSC。依一般搜尋點擊由高至低排列，另保留人工觀測成果。GSC 明細列出前 10 名' +
    (c.gscKeywordStats && c.gscKeywordStats.displayMinClicks ? '的不重複查詢，最低 ' + c.gscKeywordStats.displayMinClicks + ' 次點擊' : '且點擊超過 10 次的代表查詢') +
    '；總組數不受此門檻影響。月搜尋量查無數據時標示「尚無紀錄」。一般搜尋點擊不等於 AI 點擊；AI 摘要僅依已有的逐字觀測標示。</p></section>';
}

function cbAiResults(c) {
  var a = c.aiSearch;
  if (!a || a.total == null || a.total.impressions == null) return '';
  return '<section class="logic-section ai-results" id="ai-results"><p class="eyebrow">AI 搜尋成果</p><h2>Google AI 搜尋曝光</h2><div class="ai-result-total"><strong>' + fmt(a.total.impressions) + '</strong><span>次累積曝光</span></div><p class="volume-caption">' + escapeHtml(a.start) + ' ～ ' + escapeHtml(a.end) + ' · 依已提供的 AI 搜尋報表</p><details class="source-details"><summary>統計說明</summary><p class="volume-caption">AI 曝光次數不等於訪客或訂單，不與一般搜尋曝光相加。個別關鍵字的 AI 摘要紀錄列於下表。</p></details></section>';
}

function cbEditorialTimeline(c) {
  var t = c.timeContext;
  if (!t || !t.milestones || !t.milestones.length) return '';
  var seen = {};
  var milestones = t.milestones.filter(function (m) {
    var key = m.date + '|' + m.text;
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
  return '<section class="logic-section time-context" id="timeline"><p class="eyebrow">成效時間軸</p><h2>從開始合作，到成果出現</h2><ol class="result-timeline">' +
    milestones.map(function (m) { return '<li><time>' + escapeHtml(m.date) + '</time><p>' + escapeHtml(m.text) + '</p></li>'; }).join('') + '</ol></section>';
}

// 同事那份完整故事卡的內文，只有 richStory:true（她自己有追蹤、資料完整）的客戶才會走這裡
function cbStoryBody(c) {
  var e = c.editorial || {}, s = c.gsc, k = c.gscKeywordStats;
  var quotes = ((e.quoteIndices || []).map(function (i) { return c.customerQuotes && c.customerQuotes[i]; }).filter(Boolean));
  var html = '<div class="case-context"><p>' + escapeHtml(e.intro) + '</p>' +
    (c.start ? '<p class="volume-caption">' + escapeHtml(c.start.label) + '：' + escapeHtml(c.start.date) + (c.timeContext ? ' · 截至 ' + escapeHtml(c.timeContext.asOf) + ' 已 ' + fmt(c.timeContext.days) + ' 天' : '') + '</p>' : '') + '</div>';

  if (e.outcomes && e.outcomes.length) {
    html += '<section class="logic-section business-section" id="business"><p class="eyebrow">生意上的改變</p><h2>成果，落在實際生意裡</h2>' + cbBullets(e.outcomes) +
      (e.note ? '<details class="source-details"><summary>成果來源與統計說明</summary><p class="volume-caption">' + escapeHtml(e.note) + '</p></details>' : '') + '</section>';
  }

  if (s && k) {
    html += '<section class="logic-section" id="gsc"><p class="eyebrow">GSC 累積成果</p><h2>從 Google 找到品牌</h2><p class="volume-caption">' + escapeHtml(s.start) + ' ～ ' + escapeHtml(s.end) + '</p><div class="gsc-fact-grid concise-metrics"><article><span>從搜尋點進網站</span><strong>' + fmt(s.total.clicks) + ' <small>次</small></strong></article><article><span>出現在搜尋結果</span><strong>' + fmt(s.total.impressions) + ' <small>次</small></strong></article><article><span>平均排名前 10 名</span><strong>' + fmt(k.top10) + ' <small>組</small></strong></article></div><details class="source-details"><summary>統計範圍與來源</summary><p class="volume-caption">點擊與曝光是次數，不是人數。前 10 名依 ' + escapeHtml(k.start) + ' ～ ' + escapeHtml(k.end) + ' 的 ' + fmt(k.exportedQueries) + ' 組匯出查詢計算，包含品牌字與既有內容，非目前固定排名或全部由本次合作帶來。' +
      (c.gscScopeNote ? escapeHtml(c.gscScopeNote) : '') +
      (c.referenceReport ? ' <a href="' + escapeHtml(c.referenceReport.url) + '" target="_blank" rel="noopener noreferrer">查看原始成效報告 ↗</a>' : '') + '</p></details></section>';
  }

  html += cbAiResults(c) + cbConciseKeywords(c) + cbEditorialTimeline(c);

  if (quotes.length) {
    html += '<section class="logic-section" id="feedback"><p class="eyebrow">客戶原話</p><h2>讓客戶自己說</h2>' + cbCustomerQuotes(Object.assign({}, c, { customerQuotes: quotes })) +
      (c.reviewLink ? '<p class="volume-caption"><a href="' + escapeHtml(c.reviewLink.url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(c.reviewLink.label) + ' ↗</a></p>' : '') + '</section>';
  }

  html += '<section class="case-conclusion"><p class="eyebrow">這個案例的關鍵</p><h2>從成果，看見合作的價值</h2><p>' + escapeHtml(e.ending) + '</p></section>';
  return html;
}

function cbRenderClient(c) {
  document.body.classList.add('client-page');
  if (c.brand) {
    document.body.classList.add('branded-client');
    ['accent', 'ink', 'soft', 'dark'].forEach(function (key) { if (c.brand[key]) document.body.style.setProperty('--brand-' + key, c.brand[key]); });
  }
  document.title = c.name + '｜瑪卡鎷客戶成效';
  var breadcrumb = document.querySelector('.breadcrumb');
  if (breadcrumb) breadcrumb.textContent = '客戶成效 / ' + c.name;

  var i = cbCases.findIndex(function (x) { return x.id === c.id; });
  var prev = cbCases[i - 1], next = cbCases[i + 1];

  document.getElementById('main').innerHTML = '<a href="?" class="back-link">← 所有客戶</a><header class="client-title">' +
    (c.brand ? '<div class="client-logo" data-client="' + escapeHtml(c.id) + '"><img src="' + escapeHtml(c.brand.logo) + '" alt="' + escapeHtml(c.name) + ' LOGO" width="240" height="160"></div>' : '') +
    '<p class="eyebrow">' + escapeHtml(c.group) + ' / CLIENT RESULTS</p><h1><a class="official-brand-link" href="' + escapeHtml(c.officialWebsite) + '" target="_blank" rel="noopener noreferrer" aria-label="' + escapeHtml(c.name) + '官網（另開分頁）">' + escapeHtml(c.name) + '<span aria-hidden="true">↗</span></a></h1></header>' +
    (c.brandOnly ? '<div class="brand-profile"><p>合作品牌</p></div>' : cbStoryBody(c)) +
    '<nav class="client-pagination" aria-label="切換客戶">' +
    (prev ? '<a href="' + cbClientURL(prev.id) + '"><small>← 上一位客戶</small><strong>' + escapeHtml(prev.name) + '</strong></a>' : '<span></span>') +
    (next ? '<a href="' + cbClientURL(next.id) + '"><small>下一位客戶 →</small><strong>' + escapeHtml(next.name) + '</strong></a>' : '<span></span>') +
    '</nav><footer><span class="footer-brand">MaKarma<span>瑪卡鎷網路行銷</span></span><p>讓有需要的客人，找得到你。</p><a href="?">所有客戶 ↗</a></footer>';

  var nav = document.querySelector('.sidebar nav');
  if (nav) {
    nav.innerHTML = '<a class="nav-link" href="?">← 所有客戶</a><p class="nav-label">客戶成效</p>' +
      cbGroups.map(function (g) {
        return '<p class="client-nav-group">' + escapeHtml(g) + '</p>' +
          cbCases.filter(function (x) { return x.group === g; }).map(function (x) {
            return '<a class="nav-link client-nav-link' + (x.id === c.id ? ' active' : '') + '"' + (x.id === c.id ? ' aria-current="page"' : '') + ' href="' + cbClientURL(x.id) + '">' + escapeHtml(x.name) + '</a>';
          }).join('');
      }).join('');
  }
  var sideBottom = document.querySelector('.side-bottom');
  if (sideBottom) sideBottom.style.display = 'none';

  window.scrollTo(0, 0);
}

// 首頁那幾塊照抄同事的手寫靜態文案（五大特色連結、在地小農、BEYOND TRAFFIC、LATEST CHAPTER）
// 裡面的連結／data-case 屬性，寫的都是她原本的客戶代號（例如 "hongsong"），這裡轉成我們
// 自己的 ?client= 網址；對不到的客戶（同事沒追蹤，或我們沒開啟顯示於成效展示頁）連結原樣
// 失效，不強行處理——通常代表「顯示於成效展示頁」還沒勾這個客戶，勾了之後重新整理就會對到
function cbRemapStaticLinks_() {
  document.querySelectorAll('a[href*="/clients/"]').forEach(function (a) {
    var m = a.getAttribute('href').match(/clients\/([a-z0-9-]+)\/?$/);
    if (!m) return;
    var c = cbCases.find(function (x) { return x.amyId === m[1]; });
    if (c) a.setAttribute('href', cbClientURL(c.id));
  });
  document.querySelectorAll('[data-case]').forEach(function (b) {
    var c = cbCases.find(function (x) { return x.amyId === b.getAttribute('data-case'); });
    if (c) b.setAttribute('data-case', c.id);
  });
  document.querySelectorAll('[data-client]').forEach(function (el) {
    var c = cbCases.find(function (x) { return x.amyId === el.getAttribute('data-client'); });
    if (c) el.setAttribute('data-client', c.id);
  });
}

function cbRenderOverview() {
  cbRemapStaticLinks_();
  cbRankingOverview();
  var bigCount = document.querySelector('.big-count');
  if (bigCount) bigCount.innerHTML = cbCases.length + '<span>合作品牌</span>';
  document.querySelectorAll('[data-client-count]').forEach(function (el) { el.textContent = cbCases.length; });
  var splitB = document.querySelector('.count-splits b');
  if (splitB) splitB.textContent = cbGroups.length;
  var datePill = document.querySelector('.catalog .date-pill');
  if (datePill) datePill.textContent = cbCases.length + ' 個合作品牌';

  var industryNav = document.getElementById('industry-nav');
  if (industryNav) {
    industryNav.innerHTML = cbGroups.map(function (g, i) {
      return '<a class="nav-link industry-link" href="#industry-' + i + '">' + escapeHtml(g) + '<b>' + cbCases.filter(function (c) { return c.group === g; }).length + '</b></a>';
    }).join('');
  }
  var industryIndex = document.getElementById('industry-index');
  if (industryIndex) {
    industryIndex.innerHTML = cbGroups.map(function (g, i) {
      return '<a href="#industry-' + i + '">' + escapeHtml(g) + '<span>' + cbCases.filter(function (c) { return c.group === g; }).length + '</span></a>';
    }).join('');
  }
  var casesEl = document.getElementById('cases');
  if (casesEl) {
    casesEl.innerHTML = cbGroups.map(function (g, i) {
      var groupCases = cbCases.filter(function (c) { return c.group === g; });
      return '<section class="industry-section" id="industry-' + i + '"><div class="industry-heading"><span>' + String(i + 1).padStart(2, '0') + '</span><h3>' + escapeHtml(g) + '</h3><b>' + groupCases.length + ' 個品牌</b></div><div class="case-grid">' +
        groupCases.map(function (c) {
          return '<a class="case-card" data-tone="' + (i % 4) + '" href="' + cbClientURL(c.id) + '"><div class="case-type"><span>' + escapeHtml(c.kind) + '</span><span>↗</span></div>' +
            (c.brand ? '<div class="catalog-logo" data-client="' + escapeHtml(c.id) + '"><img src="' + escapeHtml(c.brand.logo) + '" alt="' + escapeHtml(c.name) + ' LOGO" loading="lazy" width="160" height="80"></div>' : '<div class="card-slot-empty" aria-hidden="true"></div>') +
            '<h4>' + escapeHtml(c.name) + '</h4><div class="case-main"><div class="case-value">' + escapeHtml(c.value) + '</div><div class="case-unit">' + escapeHtml(c.unit) + '</div></div><p class="case-headline">' + escapeHtml((c.editorial || {}).intro) + '</p><p class="card-time-badge">' + escapeHtml(c.start ? c.start.label + ' ' + c.start.date : '搜尋成效累積') +
            (c.gscKeywordStats ? '<span class="card-rank-count">' + fmt(c.gscKeywordStats.top10) + ' 組查詢詞 · 平均排名前 10 名</span>' : '') + '</p><div class="card-volume">' +
            escapeHtml((c.volumes && c.volumes[0] && c.volumes[0].keyword) || (c.keywords && c.keywords[0]) || '關鍵字搜尋量') + '<br><strong>月搜尋量 ' +
            (Number(c.volumes && c.volumes[0] && c.volumes[0].monthly) > 0 ? fmt(c.volumes[0].monthly) : '尚無紀錄') + '</strong></div><div class="case-evidence-tags"><span>SEO 搜尋</span>' +
            (c.aiSearch && c.aiSearch.total && c.aiSearch.total.impressions ? '<span>AI 曝光</span>' : '') +
            ((c.reportedSearch || []).some(function (r) { return r.ai; }) ? '<span>AI 摘要</span>' : '') +
            '</div><div class="case-foot"><span>查看完整成效</span><span class="arrow">↗</span></div></a>';
        }).join('') + '</div></section>';
    }).join('');
  }
  document.querySelectorAll('[data-case]').forEach(function (b) {
    b.addEventListener('click', function () { location.href = cbClientURL(b.getAttribute('data-case')); });
  });
  if (location.hash) {
    var target = document.getElementById(location.hash.slice(1));
    if (target) target.scrollIntoView();
  }
}

function cbRenderHome() {
  cbRestoreHomeShell();
  cbFetchCases().then(cbRenderOverview).catch(function () {
    var casesEl = document.getElementById('cases');
    if (casesEl) casesEl.innerHTML = '<p>頁面暫時無法載入，請重新整理再試一次。</p>';
  });
}

// 進到某個客戶頁：同事有追蹤、資料完整（richStory）才套用她的版型，
// 不然改用我們自己原本的報告頁（renderReportPage，定義在 index.html 主要的 <script> 裡）
function cbRenderClientPage(clientId) {
  cbFetchCases().then(function (cases) {
    var c = cases.find(function (x) { return x.id === clientId; });
    if (!c) {
      renderReportPage(clientId); // 不在同事資料裡也試著查我們自己的資料，找不到再顯示錯誤
      return;
    }
    if (c.richStory) {
      cbRenderClient(c);
    } else {
      renderReportPage(clientId);
    }
  }).catch(function () {
    renderReportPage(clientId); // 同事那份抓不到就退回我們自己的資料，不要整頁空白
  });
}

// 這支檔案是在 index.html 的 route() 執行之前就先載入的（<script src="casebook.js">
// 排在 route() 呼叫之前），這時候 #main 裡還是最原始、還沒被任何路由邏輯動過的靜態版面，
// 一定要在這裡就把它記住，之後不管路由怎麼跳都能正確還原成首頁
cbCaptureHomeShell();
