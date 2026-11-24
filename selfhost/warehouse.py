"""ClickHouse queries shared by the portal and the read-only MCP API."""

import json
import os
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def query(sql, params=None, data=None):
    settings = {
        "database": os.getenv("CLICKHOUSE_DB", "vibemetrics"),
        "wait_end_of_query": "1",
        "max_execution_time": "20",
        "output_format_json_quote_64bit_integers": "0",
    }
    settings.update({"param_" + key: value for key, value in (params or {}).items()})
    if data is None:
        body = sql.encode()
    else:
        settings["query"] = sql
        body = "\n".join(json.dumps(row, ensure_ascii=False) for row in data).encode()
    endpoint = os.getenv("CLICKHOUSE_URL", "http://clickhouse:8123").rstrip("/")
    request = Request(endpoint + "/?" + urlencode(settings), body, headers={
        "X-ClickHouse-User": os.getenv("CLICKHOUSE_USER", "vibemetrics"),
        "X-ClickHouse-Key": os.environ["CLICKHOUSE_PASSWORD"],
    })
    with urlopen(request, timeout=25) as response:
        return response.read()


def ensure_event_schema():
    for column, kind, default in (
        ("duration_ms", "UInt32", "0"),
        ("scroll_depth", "UInt8", "0"),
        ("referrer", "String", "''"),
        ("properties", "String", "'{}'"),
        ("traffic_type", "LowCardinality(String)", "'unknown'"),
        ("country_code", "FixedString(2)", "'ZZ'"),
        ("device_type", "LowCardinality(String)", "'unknown'"),
        ("active_ms", "UInt32", "0"),
        ("wall_ms", "UInt32", "0"),
        ("interaction_ms", "UInt32", "0"),
        ("clicks", "UInt16", "0"),
        ("keys", "UInt16", "0"),
        ("scrolls", "UInt16", "0"),
        ("moves", "UInt16", "0"),
        ("interacted", "UInt8", "0"),
        ("refocused", "UInt8", "0"),
    ):
        query(f"ALTER TABLE events ADD COLUMN IF NOT EXISTS {column} {kind} DEFAULT {default}")


def domain_stats(ids, start_day, end_day):
    """Per-project totals for [start_day, end_day) dates; ids is a non-empty project id list."""
    params = {
        "ids_csv": ",".join(ids),
        "start": start_day.isoformat() + " 00:00:00",
        "end": end_day.isoformat() + " 00:00:00",
    }
    totals = {
        row["project_id"]: {
            "events": int(row["events"]),
            "pageviews": int(row["pageviews"]),
            "sessions": int(row["sessions"]),
            "visitors": int(row["visitors"]),
            "human_visitors": int(row["human_visitors"]),
            "bot_visitors": int(row["bot_visitors"]),
            "unknown_visitors": int(row["unknown_visitors"]),
            "conversions": int(row["conversions"]),
            "avg_time_seconds": int(round(float(row["avg_time_ms"] or 0) / 1000)),
            "avg_scroll_depth": int(round(float(row["avg_scroll_depth"] or 0))),
        }
        for row in rows(f"""
            SELECT project_id,
                countIf(event_name NOT IN ('page_exit','scroll_depth')) AS events,
                countIf(event_name = 'page_view') AS pageviews,
                uniqExactIf(session_id, event_name = 'page_view') AS sessions,
                uniqExactIf(if(empty(person_id), concat('session:', session_id), concat('person:', person_id)), event_name = 'page_view') AS visitors,
                uniqExactIf(if(empty(person_id), concat('session:', session_id), concat('person:', person_id)), event_name = 'page_view' AND traffic_type = 'human') AS human_visitors,
                uniqExactIf(if(empty(person_id), concat('session:', session_id), concat('person:', person_id)), event_name = 'page_view' AND traffic_type = 'bot') AS bot_visitors,
                uniqExactIf(if(empty(person_id), concat('session:', session_id), concat('person:', person_id)), event_name = 'page_view' AND traffic_type = 'unknown') AS unknown_visitors,
                countIf(is_conversion = 1) AS conversions,
                avgIf(duration_ms, event_name = 'page_view' AND duration_ms > 0) AS avg_time_ms,
                avgIf(scroll_depth, event_name = 'page_view' AND duration_ms > 0) AS avg_scroll_depth
            FROM events FINAL
            WHERE (empty({{ids_csv:String}}) OR has(splitByString(',', {{ids_csv:String}}), project_id))
                AND ts >= toDateTime64({{start:String}}, 3, 'UTC') AND ts < toDateTime64({{end:String}}, 3, 'UTC')
            GROUP BY project_id
        """, params)
    }
    deals = {
        row["project_id"]: {"crm_deals": int(row["deals"]), "crm_revenue": round(float(row["revenue"] or 0), 2)}
        for row in rows(f"""
            SELECT project_id, count() AS deals, sum(revenue) AS revenue
            FROM crm_deals FINAL
            WHERE (empty({{ids_csv:String}}) OR has(splitByString(',', {{ids_csv:String}}), project_id))
                AND closed_at >= toDateTime64({{start:String}}, 3, 'UTC') AND closed_at < toDateTime64({{end:String}}, 3, 'UTC')
            GROUP BY project_id
        """, params)
    }
    result = {}
    for project_id in ids:
        base = totals.get(project_id, {"events": 0, "pageviews": 0, "sessions": 0, "visitors": 0,
                                       "human_visitors": 0, "bot_visitors": 0, "unknown_visitors": 0,
                                       "conversions": 0, "avg_time_seconds": 0, "avg_scroll_depth": 0})
        result[project_id] = {**base, **deals.get(project_id, {"crm_deals": 0, "crm_revenue": 0})}
    return result


def rows(sql, params):
    return [json.loads(line) for line in query(sql + " FORMAT JSONEachRow", params).splitlines()]


PROJECT_FILTER = "({project:String} = '' OR project_id = {project:String})"
IDS_FILTER = "(empty({ids_csv:String}) OR has(splitByString(',', {ids_csv:String}), project_id))"
START = "toDateTime64({start:String}, 3, 'UTC')"
PREVIOUS = "toDateTime64({previous:String}, 3, 'UTC')"
END = "toDateTime64({end:String}, 3, 'UTC')"
WINDOW = f"ts >= {START} AND ts < {END}"
FEATURES = [
    ("pageviews", "Pageviews", "page_view events in the period"),
    ("visitors", "Unique visitors", "Anonymous visitor ID, or session ID when absent"),
    ("human_visitors", "Humans · likely", "User-Agent without known bot/crawler signatures"),
    ("bot_visitors", "Bots", "User-Agent matched a bot/crawler signature"),
    ("unknown_visitors", "Unidentified", "No User-Agent available for classification"),
    ("avg_time_seconds", "Active time on page, s", "Visible, focused and interacted time only"),
    ("avg_session_seconds", "Active time on site, s", "Active time summed across closed sessions"),
    ("avg_scroll_depth", "Average scroll depth, %", "Maximum scroll depth before exit"),
    ("engaged", "Engaged sessions", "Active time >=10s with 2+ clicks/keys/scrolls, or a goal"),
    ("converting", "Sessions with a conversion", "Sessions with a goal event"),
    ("repeat", "Returning visitors", "Visitors with two or more sessions"),
    ("goal1", "Goal 1", "JS event named Goal1 sent by the site"),
    ("goal2", "Goal 2", "JS event named Goal2 sent by the site"),
]


def period_points(first, days, counts):
    empty = {"events": 0, "pageviews": 0, "human_pageviews": 0, "bot_pageviews": 0}
    return [
        {"date": day.isoformat(), **counts.get(day.isoformat(), empty)}
        for day in (first + timedelta(days=i) for i in range(days))
    ]


def snapshot(projects, project, days, model, ids=None, offset=0):
    today = datetime.now(timezone.utc).date()
    start = today - timedelta(days=days - 1 + offset)
    previous = start - timedelta(days=days)
    end = today + timedelta(days=1 - offset)
    at_midnight = lambda day: day.isoformat() + " 00:00:00"
    # ids=None → all projects (or single `project`); ids=[...] → explicit subset (tag filter).
    if project:
        ids = [project]
    id_list = ",".join(ids) if ids else ""
    params = {
        "project": project, "ids_csv": id_list, "start": at_midnight(start),
        "previous": at_midnight(previous), "end": at_midnight(end),
    }
    id_set = set(ids) if ids is not None else None
    daily_counts = {
        row["date"]: {key: int(row[key]) for key in ("events", "pageviews", "human_pageviews", "bot_pageviews")}
        for row in rows(f"""
            SELECT toDate(ts, 'UTC') AS date, countIf(event_name NOT IN ('page_exit','scroll_depth')) AS events,
                countIf(event_name = 'page_view') AS pageviews,
                countIf(event_name = 'page_view' AND traffic_type = 'human') AS human_pageviews,
                countIf(event_name = 'page_view' AND traffic_type = 'bot') AS bot_pageviews
            FROM events FINAL
            WHERE {IDS_FILTER} AND ts >= {PREVIOUS} AND ts < {END}
            GROUP BY date
        """, params)
    }
    totals = {row["project_id"]: row for row in rows(f"""
        SELECT project_id, countIf(event_name NOT IN ('page_exit','scroll_depth')) AS events, uniqExactIf(session_id, event_name = 'page_view') AS sessions,
            countIf(event_name = 'page_view') AS pageviews,
            uniqExactIf(if(empty(person_id), concat('session:', session_id), concat('person:', person_id)), event_name = 'page_view') AS visitors,
            avgIf(if(active_ms > 0, active_ms, duration_ms), event_name = 'page_view' AND duration_ms > 0) AS avg_time_ms,
            avgIf(scroll_depth, event_name = 'page_view' AND duration_ms > 0) AS avg_scroll_depth,
            countIf(event_name = 'Goal1') AS goal1,
            countIf(event_name = 'Goal2') AS goal2
        FROM events FINAL WHERE {IDS_FILTER} AND {WINDOW} GROUP BY project_id
    """, params)}
    traffic_project_rows = rows(f"""
        WITH visitor_pages AS (
            SELECT project_id,
                if(empty(person_id), concat('session:', session_id), concat('person:', person_id)) AS identity,
                argMax(traffic_type, tuple(ts, event_id)) AS visitor_type,
                countIf(event_name = 'page_view') AS pageviews
            FROM events FINAL WHERE {IDS_FILTER} AND {WINDOW} AND event_name = 'page_view'
            GROUP BY project_id, identity
            HAVING pageviews > 0
        )
        SELECT project_id, visitor_type AS traffic_type, count() AS visitors, sum(pageviews) AS pageviews
        FROM visitor_pages GROUP BY project_id, traffic_type
    """, params)
    traffic_by_project = {}
    traffic_by_type = {}
    for row in traffic_project_rows:
        kind = row["traffic_type"]
        visitors = int(row["visitors"])
        views = int(row["pageviews"])
        traffic_by_project.setdefault(row["project_id"], {})[kind] = {"visitors": visitors, "pageviews": views}
        totals_for_type = traffic_by_type.setdefault(kind, {"traffic_type": kind, "visitors": 0, "pageviews": 0})
        totals_for_type["visitors"] += visitors
        totals_for_type["pageviews"] += views

    # Touches have to precede the goal, including within a single session.
    # Each closed deal is credited to the closest earlier conversion for its project and person.
    touch = "argMinIf" if model == "first" else "argMaxIf"
    attribution_rows = rows(f"""
        WITH current_events AS (
            SELECT project_id, event_id, session_id, ts, channel, is_conversion,
                if(empty(person_id), argMaxIf(person_id, tuple(ts, event_id), notEmpty(person_id))
                    OVER (PARTITION BY project_id, session_id), person_id) AS known_person,
                if(empty(known_person), concat('session:', session_id), concat('person:', known_person)) AS identity
            FROM events FINAL WHERE {IDS_FILTER} AND {WINDOW} AND event_name NOT IN ('page_exit','scroll_depth')
        ), with_touches AS (
            SELECT project_id, event_id, known_person AS person_id, ts, is_conversion,
                {touch}(channel, tuple(ts, event_id), notEmpty(channel)) OVER (
                    PARTITION BY project_id, identity ORDER BY ts, event_id
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                ) AS touch_channel
            FROM current_events
        ), goals AS (
            SELECT project_id, event_id, person_id, ts, if(empty(touch_channel), 'Direct', touch_channel) AS channel
            FROM with_touches WHERE is_conversion = 1
        ), goal_times AS (
            SELECT project_id, person_id, ts, max(event_id) AS event_id
            FROM goals WHERE notEmpty(person_id) GROUP BY project_id, person_id, ts
        ), deals AS (
            SELECT project_id, person_id, closed_at, revenue
            FROM crm_deals FINAL WHERE {IDS_FILTER} AND closed_at >= {START} AND closed_at < {END}
        ), matched AS (
            SELECT d.project_id AS project_id, g.event_id AS event_id,
                sum(d.revenue) AS revenue, count() AS deal_count
            FROM deals AS d ASOF INNER JOIN goal_times AS g
                ON d.project_id = g.project_id AND d.person_id = g.person_id AND d.closed_at >= g.ts
            GROUP BY d.project_id, g.event_id
        )
        SELECT g.project_id AS project_id, g.channel AS channel, count() AS conversions,
            countIf(m.deal_count > 0) AS linked, toFloat64(sum(m.revenue)) AS revenue
        FROM goals AS g LEFT JOIN matched AS m ON g.project_id = m.project_id AND g.event_id = m.event_id
        GROUP BY g.project_id, g.channel
    """, params)

    project_metrics = {}
    channels = {}
    for row in attribution_rows:
        by_project = project_metrics.setdefault(row["project_id"], {"conversions": 0, "linked": 0, "revenue": 0})
        by_channel = channels.setdefault(row["channel"], {"channel": row["channel"], "conversions": 0, "linked": 0, "revenue": 0})
        for key in by_project:
            by_project[key] += row[key]
            by_channel[key] += row[key]
    result_projects = [
        {**p,
         "events": int(totals.get(p["id"], {}).get("events", 0)),
         "sessions": int(totals.get(p["id"], {}).get("sessions", 0)),
         "pageviews": int(totals.get(p["id"], {}).get("pageviews", 0)),
         "visitors": int(totals.get(p["id"], {}).get("visitors", 0)),
         "human_visitors": int(traffic_by_project.get(p["id"], {}).get("human", {}).get("visitors", 0)),
         "bot_visitors": int(traffic_by_project.get(p["id"], {}).get("bot", {}).get("visitors", 0)),
         "unknown_visitors": int(traffic_by_project.get(p["id"], {}).get("unknown", {}).get("visitors", 0)),
         "human_pageviews": int(traffic_by_project.get(p["id"], {}).get("human", {}).get("pageviews", 0)),
         "bot_pageviews": int(traffic_by_project.get(p["id"], {}).get("bot", {}).get("pageviews", 0)),
         "avg_time_seconds": int(round(float(totals.get(p["id"], {}).get("avg_time_ms", 0) or 0) / 1000)),
         "avg_scroll_depth": int(round(float(totals.get(p["id"], {}).get("avg_scroll_depth", 0) or 0))),
         "goal1": int(totals.get(p["id"], {}).get("goal1", 0)),
         "goal2": int(totals.get(p["id"], {}).get("goal2", 0)),
         **project_metrics.get(p["id"], {"conversions": 0, "linked": 0, "revenue": 0})}
        for p in projects if project or ids is None or p["id"] in id_set
    ]

    behavior = rows(f"""
        WITH per_session AS (
            SELECT project_id, session_id,
                argMaxIf(person_id, tuple(ts, event_id), notEmpty(person_id)) AS known_person,
                max(if(((active_ms >= 10000 AND (clicks + keys + scrolls) >= 2) OR is_conversion = 1), 1, 0)) AS engaged_flag,
                max(is_conversion) AS converted
            FROM events FINAL WHERE {IDS_FILTER} AND {WINDOW} AND event_name NOT IN ('page_exit','scroll_depth')
            GROUP BY project_id, session_id
        ), per_visitor AS (
            SELECT project_id,
                if(empty(known_person), concat('session:', session_id), concat('person:', known_person)) AS identity,
                count() AS sessions, sum(engaged_flag) AS engaged_sessions, sum(converted) AS converting_sessions
            FROM per_session GROUP BY project_id, identity
        )
        SELECT sum(engaged_sessions) AS engaged, sum(converting_sessions) AS converting,
            countIf(sessions >= 2) AS repeat, count() AS visitors FROM per_visitor
    """, params)[0]
    usage = rows(f"""
        SELECT countIf(event_name = 'page_view') AS pageviews,
            avgIf(if(active_ms > 0, active_ms, duration_ms), event_name = 'page_view' AND duration_ms > 0) AS avg_time_ms,
            avgIf(scroll_depth, event_name = 'page_view' AND duration_ms > 0) AS avg_scroll_depth,
            countIf(event_name = 'Goal1') AS goal1,
            countIf(event_name = 'Goal2') AS goal2
        FROM events FINAL WHERE {IDS_FILTER} AND {WINDOW}
    """, params)[0]
    countries = rows(f"""
        WITH visitor_pages AS (
            SELECT project_id,
                if(empty(person_id), concat('session:', session_id), concat('person:', person_id)) AS identity,
                argMax(country_code, tuple(ts, event_id)) AS visitor_country,
                countIf(event_name = 'page_view') AS pageviews
            FROM events FINAL WHERE {IDS_FILTER} AND {WINDOW} AND event_name = 'page_view'
            GROUP BY project_id, identity HAVING pageviews > 0
        )
        SELECT visitor_country AS country_code, sum(pageviews) AS pageviews, count() AS visitors
        FROM visitor_pages GROUP BY country_code
        ORDER BY visitors DESC, pageviews DESC, country_code LIMIT 100
    """, params)
    session_usage = rows(f"""
        SELECT avg(session_ms) AS avg_session_ms FROM (
            SELECT project_id, session_id,
                sumIf(if(active_ms > 0, active_ms, duration_ms), event_name = 'page_view') AS session_ms
            FROM events FINAL WHERE {IDS_FILTER} AND {WINDOW}
            GROUP BY project_id, session_id
            HAVING session_ms > 0
        )
    """, params)[0]
    pages = rows(f"""
        SELECT page, countIf(event_name = 'page_view') AS views,
            uniqExactIf(session_id, event_name = 'page_view') AS sessions,
            uniqExactIf(if(empty(person_id), concat('session:', session_id), concat('person:', person_id)), event_name = 'page_view') AS visitors,
            avgIf(if(active_ms > 0, active_ms, duration_ms), event_name = 'page_view' AND duration_ms > 0) AS avg_time_ms,
            avgIf(scroll_depth, event_name = 'page_view' AND duration_ms > 0) AS avg_scroll_depth
        FROM events FINAL
        WHERE {IDS_FILTER} AND {WINDOW} AND notEmpty(page)
        GROUP BY page
        HAVING countIf(event_name = 'page_view') > 0
        ORDER BY views DESC, page
        LIMIT 100
    """, params)
    recent = rows(f"""
        SELECT ts AS timestamp, project_id, event_name, session_id, channel, page,
            duration_ms, scroll_depth, referrer, traffic_type, country_code
        FROM events FINAL WHERE {IDS_FILTER} AND {WINDOW} AND event_name NOT IN ('page_exit','scroll_depth')
        ORDER BY ts DESC, event_id DESC LIMIT 100
    """, params)
    traffic_metrics = [
        {"traffic_type": row["traffic_type"], "pageviews": int(row["pageviews"]), "visitors": int(row["visitors"])}
        for row in sorted(traffic_by_type.values(), key=lambda item: (-item["visitors"], item["traffic_type"]))
    ]
    country_metrics = [
        {"country_code": str(row["country_code"]).strip(), "pageviews": int(row["pageviews"]), "visitors": int(row["visitors"])}
        for row in countries
    ]
    top_events = rows(f"""
        SELECT event_name, count() AS events_count, countIf(is_conversion = 1) AS conversions
        FROM events FINAL WHERE {IDS_FILTER} AND {WINDOW} AND event_name NOT IN ('page_exit','scroll_depth')
        GROUP BY event_name ORDER BY events_count DESC, event_name LIMIT 50
    """, params)
    feature_values = {
        "pageviews": int(usage.get("pageviews", 0) or 0),
        "visitors": sum(int(row["visitors"]) for row in traffic_by_type.values()),
        "human_visitors": int(traffic_by_type.get("human", {}).get("visitors", 0) or 0),
        "bot_visitors": int(traffic_by_type.get("bot", {}).get("visitors", 0) or 0),
        "unknown_visitors": int(traffic_by_type.get("unknown", {}).get("visitors", 0) or 0),
        "avg_time_seconds": int(round(float(usage.get("avg_time_ms", 0) or 0) / 1000)),
        "avg_session_seconds": int(round(float(session_usage.get("avg_session_ms", 0) or 0) / 1000)),
        "avg_scroll_depth": int(round(float(usage.get("avg_scroll_depth", 0) or 0))),
        "engaged": int(behavior.get("engaged", 0) or 0),
        "converting": int(behavior.get("converting", 0) or 0),
        "repeat": int(behavior.get("repeat", 0) or 0),
        "goal1": int(usage.get("goal1", 0) or 0),
        "goal2": int(usage.get("goal2", 0) or 0),
    }
    page_metrics = [
        {"page": row["page"], "views": int(row["views"]), "sessions": int(row["sessions"]),
         "visitors": int(row["visitors"]),
         "avg_time_seconds": int(round(float(row.get("avg_time_ms", 0) or 0) / 1000)),
         "avg_scroll_depth": int(round(float(row.get("avg_scroll_depth", 0) or 0)))}
        for row in pages
    ]
    top_event_metrics = [{"event_name": row["event_name"], "events": int(row["events_count"]), "conversions": int(row["conversions"])} for row in top_events]
    goal_rows = rows(f"""
        SELECT event_name, count() AS events, uniqExact(session_id) AS sessions, max(ts) AS last_seen
        FROM events FINAL WHERE {IDS_FILTER} AND {WINDOW}
          AND (is_conversion = 1 OR event_name IN ('Goal1', 'Goal2'))
        GROUP BY event_name ORDER BY events DESC, event_name LIMIT 100
    """, params)
    goal_events = [
        {"event_name": row["event_name"], "events": int(row["events"]),
         "sessions": int(row["sessions"]), "last_seen": str(row["last_seen"])}
        for row in goal_rows
    ]
    device_rows = rows(f"""
        SELECT device_type, uniqExact(if(empty(person_id), concat('session:', session_id), concat('person:', person_id))) AS visitors,
            countIf(event_name = 'page_view') AS pageviews
        FROM events FINAL WHERE {IDS_FILTER} AND {WINDOW} AND event_name = 'page_view'
        GROUP BY device_type ORDER BY visitors DESC, device_type
    """, params)
    device_metrics = [
        {"device_type": row["device_type"], "visitors": int(row["visitors"]), "pageviews": int(row["pageviews"])}
        for row in device_rows
    ]
    hourly_counts = {int(row["hour"]): int(row["visitors"]) for row in rows(f"""
        SELECT toHour(ts, 'UTC') AS hour,
            uniqExact(if(empty(person_id), concat('session:', session_id), concat('person:', person_id))) AS visitors
        FROM events FINAL WHERE {IDS_FILTER} AND {WINDOW} AND event_name = 'page_view'
        GROUP BY hour ORDER BY hour
    """, params)}
    hourly = [{"hour": hour, "visitors": hourly_counts.get(hour, 0)} for hour in range(24)]
    return {
        "mode": "live", "project": project, "days": days, "model": model,
        "projects": result_projects, "daily": period_points(start, days, daily_counts),
        "previous": period_points(previous, days, daily_counts),
        "hourly": hourly,
        "attribution": sorted(channels.values(), key=lambda row: (-row["conversions"], row["channel"])),
        "features": [
            {"feature": name, "value": feature_values[key], "definition": definition}
            for key, name, definition in FEATURES
        ],
        "pages": page_metrics,
        "traffic": traffic_metrics,
        "countries": country_metrics,
        "top_events": top_event_metrics,
        "devices": device_metrics,
        "goals": {"goal1": feature_values["goal1"], "goal2": feature_values["goal2"]},
        "goal_events": goal_events,
        "events": recent,
    }
