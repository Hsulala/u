import os, csv, io, time, requests

SHEET_ID = os.environ.get("GOOGLE_SHEET_ID", "")
CSV_URL = f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/export?format=csv"
CACHE_TTL = 300  # 5 分鐘快取

_cache: dict = {"rows": None, "timestamp": 0}

def _load_rows() -> list[dict]:
    now = time.time()
    if _cache["rows"] is not None and now - _cache["timestamp"] < CACHE_TTL:
        return _cache["rows"]
    try:
        resp = requests.get(CSV_URL, timeout=10)
        resp.raise_for_status()
        resp.encoding = "utf-8-sig"
        rows = list(csv.DictReader(io.StringIO(resp.text)))
        _cache["rows"] = rows
        _cache["timestamp"] = now
        print(f"[Sheets] 載入 {len(rows)} 列")
        return rows
    except Exception as e:
        print(f"[ERROR] 無法載入試算表：{e}")
        return _cache["rows"] or []

def load_templates() -> dict[str, str]:
    return {
        (row.get("intent") or "").strip(): (row.get("template") or "").strip()
        for row in _load_rows() if (row.get("intent") or "").strip()
    }

def load_qa_entries() -> list[dict]:
    """回傳有填「keywords」欄的列，當作免呼叫 AI 的簡單問答比對用。"""
    entries = []
    for row in _load_rows():
        keywords_raw = (row.get("keywords") or "").strip()
        answer = (row.get("template") or "").strip()
        if not keywords_raw or not answer:
            continue
        keywords = [kw.strip() for kw in keywords_raw.split(",") if kw.strip()]
        if keywords:
            entries.append({"keywords": keywords, "answer": answer})
    return entries
