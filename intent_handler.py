import os, json, re
from openai import OpenAI
from sheets_loader import load_templates

client = OpenAI(api_key=os.environ["GROK_API_KEY"], base_url="https://api.x.ai/v1")

CLASSIFY_PROMPT = """你是訊息分類助理。只能回傳 JSON，格式：{"intent": "<意圖>", "entities": {}}

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
meeting_thanks: {"person_names":..,"follow_up":..}"""

def _classify(message: str) -> dict:
    resp = client.chat.completions.create(
        model="grok-3",
        messages=[{"role":"system","content":CLASSIFY_PROMPT},{"role":"user","content":message}],
        temperature=0,
    )
    content = resp.choices[0].message.content.strip()
    m = re.search(r"\{.*\}", content, re.DOTALL)
    return json.loads(m.group()) if m else {"intent":"unknown","entities":{}}

def _meeting(template: str, entities: dict, user_input: str) -> str:
    system = f"你是業務助理，撰寫會面相關訊息。參考此風格：\n---\n{template}\n---\n只回傳訊息本文。"
    lines = "\n".join(f"{k}: {v}" for k,v in entities.items() if v)
    resp = client.chat.completions.create(
        model="grok-3",
        messages=[{"role":"system","content":system},
                  {"role":"user","content":f"輸入：{user_input}\n資訊：\n{lines}"}],
        temperature=0.3,
    )
    return resp.choices[0].message.content.strip()

FALLBACK_SYSTEM_PROMPT = """你是瑪卡鎷網路行銷（MaKarma）LINE 官方帳號的客服助理。
使用者這則訊息無法對應到既有的範本。請用繁體中文簡短回覆（不超過3句話），語氣親切自然。
如果問題涉及報價、合約細節、專案進度等你不清楚的具體資訊，請直接引導對方稍等由專人回覆，不要編造答案。"""

def _fallback_reply(message: str) -> str:
    resp = client.chat.completions.create(
        model="grok-3",
        messages=[{"role":"system","content":FALLBACK_SYSTEM_PROMPT},
                  {"role":"user","content":message}],
        temperature=0.3,
        max_tokens=150,
    )
    return resp.choices[0].message.content.strip()

def process_message(message: str) -> str:
    try:
        templates = load_templates()
        result = _classify(message)
        intent = result.get("intent","unknown")
        entities = result.get("entities",{}) or {}
        tmpl = templates.get(intent,"")

        if intent in ("payment_personal","payment_company"):
            amount = int(entities.get("amount") or 0)
            return tmpl.replace("{amount}", f"{amount:,}")
        elif intent == "payment_screenshot":
            return tmpl.replace("{payment_type}", entities.get("payment_type") or "匯款")
        elif intent in ("meeting_reminder","meeting_thanks"):
            return _meeting(tmpl, entities, message)
        else:
            return _fallback_reply(message)
    except Exception as e:
        print(f"[ERROR] {e}")
        return "處理訊息時發生錯誤，請稍後再試 🙏"
