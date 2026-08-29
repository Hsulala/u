import os, csv, io, time, requests

SHEET_ID = os.environ.get("GOOGLE_SHEET_ID", "")
CSV_URL = f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/export?format=csv"
CACHE_TTL = 300  # 5 分鐘快取

_cache: dict = {"data": None, "timestamp": 0}

def load_templates() -> dict[str, str]:
    now = time.time()
    if _cache["data"] is not None and now - _cache["timestamp"] < CACHE_TTL:
        return _cache["data"]
    try:
        resp = requests.get(CSV_URL, timeout=10)
        resp.raise_for_status()
        resp.encoding = "utf-8-sig"
        reader = csv.DictReader(io.StringIO(resp.text))
        templates = {
            (row.get("intent") or "").strip(): (row.get("template") or "").strip()
            for row in reader if (row.get("intent") or "").strip()
        }
        _cache["data"] = templates
        _cache["timestamp"] = now
        print(f"[Sheets] 載入 {len(templates)} 個範本")
        return templates
    except Exception as e:
        print(f"[ERROR] 無法載入試算表：{e}")
        return _cache["data"] or {}
