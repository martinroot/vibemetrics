"""Traffic review for a single project: grounded features + an explicit reasoning chain.

The LLM only receives numbers already present in the snapshot. If no key is
configured or the API fails, a deterministic rule-based review is returned so
the panel never invents facts.
"""

import hashlib
import json
import logging
import os
import re
import urllib.request
from datetime import datetime, timezone

API_URL = "https://openrouter.ai/api/v1/chat/completions"
SYSTEM_PROMPT = (
    "You are a performance marketer reviewing web analytics for ONE project. "
    "Use ONLY the supplied metrics: never invent numbers, sources or events. "
    "Separate observations (what the data says) from hypotheses (what may explain it) "
    "and checks (what to verify). Write concise Russian, no marketing fluff. "
    "Return a JSON object with exactly these keys: "
    "summary (string <=350 chars), "
    "chain (array of 3-6 objects: step, observation, hypothesis, check, verdict), "
    "anomalies (array of objects: signal, evidence, severity in {low,medium,high}, interpretation), "
    "actions (array of 2-5 objects: priority in {high,medium,low}, title, detail, metric_to_watch), "
    "confidence (number 0..1). "
    "Every observation and evidence must reference concrete numbers from the input. "
    "If the data is too thin for a conclusion, say so explicitly instead of guessing."
)


def _feature_map(snapshot):
    return {row.get("feature"): row.get("value") for row in snapshot.get("features", [])}


def build_features(snapshot, project, days):
    """Flatten a snapshot into the compact, numeric-only payload for the model."""
    fm = _feature_map(snapshot)
    row = next((item for item in snapshot.get("projects", []) if item.get("id") == project), {})
    daily = snapshot.get("daily", [])
    previous = snapshot.get("previous", [])
    dates = [item.get("date") for item in daily if item.get("date")]
    human = [int(item.get("human_pageviews", 0) or 0) for item in daily]
    daily_pairs = [{"date": item.get("date"), "pageviews": int(item.get("pageviews", 0) or 0),
                    "human": int(item.get("human_pageviews", 0) or 0)} for item in daily]
    top = sorted(daily_pairs, key=lambda item: item["pageviews"], reverse=True)[:3]
    quiet = sorted(daily_pairs, key=lambda item: item["pageviews"])[:3]
    non_zero = [value for value in human if value > 0]
    previous_views = sum(int(item.get("pageviews", 0) or 0) for item in previous)
    current_views = sum(int(item.get("pageviews", 0) or 0) for item in daily)
    channels = [
        {"channel": item.get("channel"), "conversions": int(item.get("conversions", 0) or 0),
         "linked": int(item.get("linked", 0) or 0), "revenue": round(float(item.get("revenue", 0) or 0), 2)}
        for item in snapshot.get("attribution", [])
    ]
    traffic = [
        {"type": item.get("traffic_type"), "visitors": int(item.get("visitors", 0) or 0),
         "pageviews": int(item.get("pageviews", 0) or 0)}
        for item in snapshot.get("traffic", [])
    ]
    return {
        "project": project,
        "project_name": row.get("name", project),
        "domain": row.get("url", ""),
        "period_days": days,
        "period": {"from": dates[0] if dates else None, "to": dates[-1] if dates else None},
        "totals": {
            "pageviews": int(row.get("pageviews", 0) or 0),
            "sessions": int(row.get("sessions", 0) or 0),
            "visitors": int(row.get("visitors", 0) or 0),
            "human_visitors": int(row.get("human_visitors", 0) or 0),
            "bot_visitors": int(row.get("bot_visitors", 0) or 0),
            "human_pageviews": int(row.get("human_pageviews", 0) or 0),
            "bot_pageviews": int(row.get("bot_pageviews", 0) or 0),
            "avg_active_seconds_on_page": fm.get("Active time on page, s", 0),
            "avg_active_seconds_on_site": fm.get("Active time on site, s", 0),
            "avg_scroll_depth_percent": fm.get("Average scroll depth, %", 0),
            "engaged_sessions": fm.get("Engaged sessions", 0),
            "returning_visitors": fm.get("Returning visitors", 0),
            "goal1": fm.get("Goal 1", 0),
            "goal2": fm.get("Goal 2", 0),
            "conversions": int(row.get("conversions", 0) or 0),
            "revenue": round(float(row.get("revenue", 0) or 0), 2),
        },
        "trend": {
            "pageviews_current": current_views,
            "pageviews_previous": previous_views,
            "change_percent": round(100.0 * (current_views - previous_views) / previous_views, 1) if previous_views else None,
            "best_days": top,
            "quietest_days": quiet,
            "days_with_human_traffic": len(non_zero),
        },
        "traffic_type": traffic,
        "channels_last_touch": channels,
        "devices": [{"device": item.get("device_type"), "visitors": int(item.get("visitors", 0) or 0),
                     "pageviews": int(item.get("pageviews", 0) or 0)} for item in snapshot.get("devices", [])],
        "countries": [{"country": item.get("country"), "visitors": int(item.get("visitors", 0) or 0)}
                      for item in snapshot.get("countries", [])[:8]],
        "pages": [{"path": item.get("page") or item.get("path"), "pageviews": int(item.get("pageviews", 0) or 0)}
                  for item in snapshot.get("pages", [])[:8]],
        "goal_events": [{"event": item.get("event_name"), "count": int(item.get("events", 0) or 0),
                         "sessions": int(item.get("sessions", 0) or 0)} for item in snapshot.get("goal_events", [])],
        "top_events": [{"event": item.get("event_name"), "count": int(item.get("events", 0) or 0)}
                       for item in snapshot.get("top_events", [])[:8]],
        "hourly_visitors": [{"hour": item.get("hour"), "visitors": int(item.get("visitors", 0) or 0)}
                            for item in snapshot.get("hourly", [])],
    }


def cache_key(features):
    model = os.getenv("VM_AI_MODEL", "openai/gpt-4o-mini")
    payload = json.dumps(features, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256((model + "|" + payload).encode("utf-8")).hexdigest()


def _clean_text(value, limit=600):
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


NUM_RE = re.compile(r"(?<![\w.])(\d+(?:[.,]\d+)?)\s*(?:%|с)?")
_SKIP_FIELDS = {"step", "step_number"}


def _allowed_numbers(features):
    allowed = set()

    def walk(value):
        if isinstance(value, dict):
            for item in value.values():
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)
        elif isinstance(value, bool):
            return
        elif isinstance(value, (int, float)):
            allowed.add(str(int(value)) if float(value).is_integer() else f"{float(value):.1f}")
            allowed.add(f"{value:g}")
        elif isinstance(value, str):
            for match in NUM_RE.finditer(value):
                token = match.group(1).replace(",", ".")
                allowed.add(token)
                if "." in token:
                    allowed.add(token.rstrip("0").rstrip("."))

    walk(features)
    # Derived shares and ratios used by the deterministic review come from the
    # same feature numbers, so they are legitimate as well.
    totals = features.get("totals", {}) if isinstance(features, dict) else {}
    pageviews = int(totals.get("pageviews", 0) or 0)
    visitors = int(totals.get("visitors", 0) or 0)
    for key in ("human_pageviews", "bot_pageviews"):
        if pageviews:
            allowed.add(f"{100.0 * int(totals.get(key, 0) or 0) / pageviews:.1f}")
    for key in ("human_visitors", "bot_visitors"):
        if visitors:
            allowed.add(f"{100.0 * int(totals.get(key, 0) or 0) / visitors:.1f}")
    if visitors:
        ratio = f"{pageviews / visitors:.2f}"
        allowed.add(ratio)
        allowed.add(ratio.rstrip("0").rstrip(".") if "." in ratio else ratio)
    return allowed


def grounding_guard(features, review):
    """Reject numeric claims absent from the snapshot-derived feature payload."""
    allowed = _allowed_numbers(features)
    unsupported = []
    fields = [("summary", review.get("summary", ""))]
    for name, items in (("chain", review.get("chain", [])),
                        ("anomalies", review.get("anomalies", [])),
                        ("actions", review.get("actions", []))):
        for index, item in enumerate(items):
            for key, text in item.items():
                if key not in _SKIP_FIELDS:
                    fields.append((f"{name}[{index}].{key}", text))
    for field, text in fields:
        for match in NUM_RE.finditer(str(text)):
            token = match.group(1).replace(",", ".")
            variants = {token, token.rstrip("0").rstrip(".") if "." in token else token}
            if not variants & allowed:
                unsupported.append(f"{field}:{token}")
    guarded = dict(review)
    guarded["grounding"] = {"ok": not unsupported, "unsupported": unsupported[:20]}
    if unsupported:
        guarded["source"] = "rules"
        guarded["note"] = "LLM output failed the grounding guard"
    return guarded


def _validate(raw, features):
    if not isinstance(raw, dict):
        raise ValueError("model returned non-object JSON")
    chain = []
    for item in raw.get("chain", [])[:6]:
        if isinstance(item, dict):
            chain.append({key: _clean_text(item.get(key), 420)
                          for key in ("step", "observation", "hypothesis", "check", "verdict")})
    anomalies = []
    for item in raw.get("anomalies", [])[:6]:
        if isinstance(item, dict):
            severity = str(item.get("severity", "low")).lower()
            anomalies.append({
                "signal": _clean_text(item.get("signal"), 240),
                "evidence": _clean_text(item.get("evidence"), 300),
                "severity": severity if severity in {"low", "medium", "high"} else "low",
                "interpretation": _clean_text(item.get("interpretation"), 420),
            })
    actions = []
    for item in raw.get("actions", [])[:5]:
        if isinstance(item, dict):
            priority = str(item.get("priority", "low")).lower()
            actions.append({
                "priority": priority if priority in {"high", "medium", "low"} else "low",
                "title": _clean_text(item.get("title"), 200),
                "detail": _clean_text(item.get("detail"), 500),
                "metric_to_watch": _clean_text(item.get("metric_to_watch"), 200),
            })
    try:
        confidence = max(0.0, min(1.0, float(raw.get("confidence", 0.5))))
    except (TypeError, ValueError):
        confidence = 0.5
    return {
        "summary": _clean_text(raw.get("summary"), 600),
        "chain": chain,
        "anomalies": anomalies,
        "actions": actions,
        "confidence": round(confidence, 2),
        "source": "llm",
        "model": os.getenv("VM_AI_MODEL", "openai/gpt-4o-mini"),
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "project": features["project"],
        "days": features["period_days"],
    }


def _local_review(features, reason=""):
    """Deterministic marketer style review, derived only from supplied numbers."""
    t = features["totals"]
    trend = features["trend"]
    chain = []
    anomalies = []
    actions = []

    def add(step, observation, hypothesis, check, verdict):
        chain.append({"step": step, "observation": observation, "hypothesis": hypothesis,
                      "check": check, "verdict": verdict})

    change = trend["change_percent"]
    change_text = f"{change}%" if change is not None else "нет данных за прошлый период"
    add("1. Объём", f"За {features['period_days']} дн. {t['pageviews']} просмотров и {t['visitors']} посетителей; "
        f"сравнение с прошлым периодом: {change_text}.",
        "Рост или падение может быть связан с изменением объёма закупки трафика.",
        "Сверить с расходами и числом уникальных посетителей по дням.",
        "Объём зафиксирован; причина изменения требует внешних данных.")
    human_share = round(100.0 * t["human_pageviews"] / t["pageviews"], 1) if t["pageviews"] else 0
    add("2. Качество трафика", f"Люди: {t['human_visitors']}, боты: {t['bot_visitors']}; "
        f"доля человеческих просмотров {human_share}%.",
        "Ботовая часть может завышать просмотры и размывать метрики вовлечённости.",
        "Проверить источники с высоким bot_pageviews и User-Agent.",
        "Оценка качества сделана по User-Agent, это эвристика.")
    if t["bot_visitors"] and t["visitors"] and t["bot_visitors"] / t["visitors"] > 0.2:
        anomalies.append({"signal": "Высокая доля ботов", "evidence": f"{t['bot_visitors']} из {t['visitors']} посетителей",
                          "severity": "medium", "interpretation": "Часть трафика не является реальной аудиторией."})
    views_per_visitor = round(t["pageviews"] / t["visitors"], 2) if t["visitors"] else 0
    add("3. Глубина", f"{views_per_visitor} просмотра на посетителя; среднее активное время на странице "
        f"{t['avg_active_seconds_on_page']} с; возвратных посетителей {t['returning_visitors']}.",
        "Низкая глубина может означать попандер-трафик или несоответствие ожиданий страницы.",
        "Посмотреть распределение по страницам и источникам с большим числом выходов.",
        "Глубина измерена, гипотезу нужно проверять по срезам.")
    if t["visitors"] and t["pageviews"] / t["visitors"] < 1.3:
        anomalies.append({"signal": "Один просмотр на посетителя", "evidence": f"{views_per_visitor} просмотра на посетителя",
                          "severity": "high", "interpretation": "Похоже на входящий трафик без интереса к сайту."})
    goals = t["goal1"] + t["goal2"]
    add("4. Цели", f"Goal1 {t['goal1']}, Goal2 {t['goal2']}, вместе {goals}; "
        f"Вовлечённых сессий {t['engaged_sessions']}.",
        "Отсутствие целей может быть как проблемой трафика, так и отсутствием разметки.",
        "Сверить вызовы vibeGoal на сайте по инструкции и число конверсий по дням.",
        "Если разметка есть — это сигнал о качестве трафика.")
    if not goals and t["visitors"] > 30:
        actions.append({"priority": "high", "title": "Проверить разметку целей",
                        "detail": "За период 0 Goal1/Goal2 при трафике >30 посетителей. Сначала убедиться, что vibeGoal вызывается, затем оценивать качество.",
                        "metric_to_watch": "goals/visitors"})
    if t["bot_visitors"] > 0:
        actions.append({"priority": "medium", "title": "Отсечь ботовый трафик в аналитике",
                        "detail": f"Ботов {t['bot_visitors']}; исключить их из оценки качества и сверить источник.",
                        "metric_to_watch": "bot_visitors / visitors"})
    if not actions:
        actions.append({"priority": "low", "title": "Продолжить наблюдение",
                        "detail": "Критичных аномалий по доступным метрикам нет; оставить текущую разметку.",
                        "metric_to_watch": "pageviews, goals, engaged sessions"})
    return {
        "summary": f"За {features['period_days']} дн.: {t['pageviews']} просмотров, {t['visitors']} посетителей, "
                   f"целей {goals}, возвратных {t['returning_visitors']}. "
                   "Выводы основаны только на метриках выбранного проекта.",
        "chain": chain,
        "anomalies": anomalies,
        "actions": actions[:5],
        "confidence": 0.55,
        "source": "rules",
        "model": "local-rules",
        "note": reason,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "project": features["project"],
        "days": features["period_days"],
    }


def analyze(features):
    key = os.getenv("VM_AI_API_KEY") or os.getenv("OPENROUTER_API_KEY")
    if not key:
        return grounding_guard(features, _local_review(features, "LLM key is not configured"))
    model = os.getenv("VM_AI_MODEL", "openai/gpt-4o-mini")
    body = {
        "model": model,
        "temperature": 0.3,
        "max_tokens": 2500,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": "PROJECT METRICS (JSON):\n" + json.dumps(features, ensure_ascii=False, default=str)},
        ],
    }
    try:
        request = urllib.request.Request(
            API_URL, data=json.dumps(body).encode("utf-8"),
            headers={"Authorization": "Bearer " + key, "Content-Type": "application/json",
                     "HTTP-Referer": os.getenv("VM_PUBLIC_URL", "https://vibemetrics.click"),
                     "X-Title": "VibeMetrics traffic review"},
            method="POST")
        with urllib.request.urlopen(request, timeout=25) as response:
            data = json.loads(response.read().decode("utf-8"))
        content = data["choices"][0]["message"]["content"]
        if not content:
            raise ValueError("model returned empty content")
        if content.startswith("```"):
            content = re.sub(r"^```(?:json)?\s*|\s*```$", "", content.strip())
        validated = _validate(json.loads(content), features)
        return grounding_guard(features, validated)
    except Exception as error:  # noqa: BLE001 - fall back to grounded rules
        logging.warning("AI review failed, using local rules: %s", type(error).__name__)
        return grounding_guard(features, _local_review(features, "LLM unavailable: " + type(error).__name__))
