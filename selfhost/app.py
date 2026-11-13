"""Serve VibeMetrics and its ClickHouse-backed HTTP API."""

import base64
import binascii
import hmac
import ipaddress
import json
import logging
import os
import re
import secrets
import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import URLError
from urllib.parse import parse_qs, unquote, urlsplit

import warehouse
import geoip

ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.getenv("VM_STATE_PATH", ROOT / "state" / "registry.db"))
WEB_ROOT = Path(os.getenv("VM_WEB_ROOT", ROOT.parent))
AGENT_IPS_PATH = Path(os.getenv("VM_AGENT_IPS_PATH", "/run/vibemetrics/agent-ips.json"))
ID_PATTERN = re.compile(r"[a-z][a-z0-9-]{0,47}")
BOT_UA_RE = re.compile(r"(?:bot|crawler|spider|slurp|headless|selenium|phantom|puppeteer|playwright|lighthouse|pagespeed|curl/|wget/|python-requests|scrapy|facebookexternalhit|twitterbot|discordbot|telegrambot)", re.I)
TRAFFIC_TYPES = {"human", "bot", "unknown"}
LEGACY_NOISE_EVENTS = {"page_exit", "scroll_depth"}
PROJECT_FIELDS = ("id", "name", "url", "type", "mark", "color", "tags")
VIEW_PAGES = {"overview", "projects", "events", "attribution", "features", "reports", "sources", "exports", "mcp"}
MAX_BODY = 512 * 1024
COLLECT_RATE_LIMIT = 300
COLLECT_RATE_WINDOW = 60.0
PUBLIC_GET_API = {"/api/status", "/api/projects", "/api/snapshot"}
PUBLIC_RATE_LIMIT = 30
PUBLIC_RATE_WINDOW = 60.0
_RATE_LOCK = threading.Lock()
_RATE_BUCKETS = {}


class APIError(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


def connection():
    con = sqlite3.connect(DB_PATH, timeout=8)
    con.row_factory = sqlite3.Row
    return con


def initialize():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with connection() as con:
        con.execute("PRAGMA journal_mode = WAL")
        con.execute("""
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL,
                type TEXT NOT NULL, mark TEXT NOT NULL, color TEXT NOT NULL,
                origin TEXT NOT NULL DEFAULT '',
                allowed_origins TEXT NOT NULL DEFAULT '[]',
                site_key TEXT NOT NULL DEFAULT ''
            )
        """)
        columns = {row["name"] for row in con.execute("PRAGMA table_info(projects)")}
        for name, definition in (
            ("origin", "TEXT NOT NULL DEFAULT ''"),
            ("allowed_origins", "TEXT NOT NULL DEFAULT '[]'"),
            ("site_key", "TEXT NOT NULL DEFAULT ''"),
            ("tags", "TEXT NOT NULL DEFAULT '[]'"),
        ):
            if name not in columns:
                con.execute(f"ALTER TABLE projects ADD COLUMN {name} {definition}")
        con.execute("CREATE UNIQUE INDEX IF NOT EXISTS projects_origin_unique ON projects(origin) WHERE origin <> ''")


def projects():
    fields = ", ".join(PROJECT_FIELDS)
    with connection() as con:
        rows = [dict(row) for row in con.execute(f"SELECT {fields} FROM projects ORDER BY name COLLATE NOCASE")]
    for row in rows:
        row["tags"] = parse_tags(row.get("tags"))
    return rows


def parse_tags(value):
    if isinstance(value, list):
        return [str(item).strip()[:40] for item in value if str(item).strip()][:8]
    try:
        data = json.loads(value if isinstance(value, str) else "[]")
    except (ValueError, TypeError):
        return []
    return parse_tags(data) if isinstance(data, list) else []


def tag_list(data):
    raw = data.get("tags", [])
    if not isinstance(raw, list) or len(raw) > 8:
        raise APIError(400, "Теги: список не более чем из 8 значений")
    tags = []
    for item in raw:
        if not isinstance(item, str):
            raise APIError(400, "Каждый тег должен быть строкой")
        value = " ".join(item.split()).strip()[:40]
        if value and not any(value.lower() == tag.lower() for tag in tags):
            tags.append(value)
    return tags


def normalize_origin(value):
    if not isinstance(value, str) or not value.strip():
        raise APIError(400, "Укажите HTTPS-домен сайта")
    raw = value.strip()
    if "://" not in raw:
        raw = "https://" + raw
    try:
        parts = urlsplit(raw)
        host = parts.hostname
        port = parts.port
        if parts.scheme not in {"https", "http"} or not host or parts.username or parts.password:
            raise ValueError
        if parts.scheme != "https" and host.lower() not in {"localhost", "127.0.0.1", "::1"}:
            raise ValueError
        host = host.encode("idna").decode("ascii").lower().rstrip(".")
        if ":" in host and not host.startswith("["):
            host = "[" + host + "]"
        if port and not (parts.scheme == "https" and port == 443) and not (parts.scheme == "http" and port == 80):
            host += ":" + str(port)
        return parts.scheme.lower() + "://" + host
    except (UnicodeError, ValueError):
        raise APIError(400, "Домен должен быть корректным HTTPS origin") from None


def site_slug(origin):
    host = urlsplit(origin).hostname or "site"
    slug = re.sub(r"[^a-z0-9]+", "-", host.lower()).strip("-") or "site"
    if not slug[0].isalpha():
        slug = "site-" + slug
    return slug[:48].rstrip("-")


def registration_result(row, created):
    public = {key: (parse_tags(row[key]) if key == "tags" else row[key]) for key in PROJECT_FIELDS}
    base = os.getenv("VM_PUBLIC_URL", "https://vibemetrics.click").rstrip("/")
    tracker_url = base + "/tracker.js"
    snippet = (f'<script defer src="{tracker_url}" '
               f'data-site-id="{row["id"]}" data-site-key="{row["site_key"]}"></script>')
    return {
        **public,
        "created": created,
        "allowed_origin": row["origin"],
        "allowed_origins": json.loads(row["allowed_origins"] or "[]"),
        "site_key": row["site_key"],
        "tracker_url": tracker_url,
        "snippet": snippet,
    }


def register_site(data, requested_id=""):
    name = required_text(data, "name", 80)
    domain = required_text(data, "domain", 253, False) or required_text(data, "url", 253)
    origin = normalize_origin(domain)
    project_type = required_text(data, "type", 60, False)
    tags = tag_list(data)
    extra_origins = data.get("allowed_origins", [])
    if not isinstance(extra_origins, list) or len(extra_origins) > 9:
        raise APIError(400, "allowed_origins должен быть списком не более чем из 9 доменов")
    origins = list(dict.fromkeys([origin] + [normalize_origin(item) for item in extra_origins]))

    if requested_id:
        pid = required_text({"id": requested_id}, "id", 48)
        if not ID_PATTERN.fullmatch(pid):
            raise APIError(400, "Некорректный ID проекта")
    else:
        pid = site_slug(origin)

    with connection() as con:
        existing = con.execute("SELECT * FROM projects WHERE origin = ?", (origin,)).fetchone()
        if existing:
            old_origins = json.loads(existing["allowed_origins"] or "[]")
            merged = list(dict.fromkeys(old_origins + origins))
            for other in con.execute("SELECT id, origin, allowed_origins FROM projects WHERE id <> ?", (existing["id"],)):
                other_origins = set(json.loads(other["allowed_origins"] or "[]")) | {other["origin"]}
                if set(origins) & other_origins:
                    raise APIError(409, "Один из доменов уже привязан к другому проекту")
            site_key = existing["site_key"] or secrets.token_urlsafe(32)
            if requested_id and requested_id != existing["id"]:
                raise APIError(409, "Этот домен уже зарегистрирован под другим ID")
            con.execute("UPDATE projects SET site_key = ?, allowed_origins = ? WHERE id = ?",
                        (site_key, json.dumps(merged), existing["id"]))
            row = con.execute("SELECT * FROM projects WHERE id = ?", (existing["id"],)).fetchone()
            return registration_result(row, False)

        for other in con.execute("SELECT id, origin, allowed_origins FROM projects"):
            other_origins = set(json.loads(other["allowed_origins"] or "[]")) | {other["origin"]}
            if set(origins) & other_origins:
                raise APIError(409, "Один из доменов уже привязан к другому проекту")

        if requested_id:
            collision = con.execute("SELECT 1 FROM projects WHERE id = ?", (pid,)).fetchone()
            if collision:
                raise APIError(409, "Проект с таким ID уже есть")
        else:
            base_id = pid
            while con.execute("SELECT 1 FROM projects WHERE id = ?", (pid,)).fetchone():
                suffix = secrets.token_hex(3)
                pid = (base_id[:41].rstrip("-") + "-" + suffix)[:48]

        site_key = secrets.token_urlsafe(32)
        row = (pid, name, origin, project_type, name[0].upper(), "#3a7864",
               origin, json.dumps(origins), site_key, json.dumps(tags, ensure_ascii=False))
        con.execute("""
            INSERT INTO projects (id, name, url, type, mark, color, origin, allowed_origins, site_key, tags)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, row)
        created = con.execute("SELECT * FROM projects WHERE id = ?", (pid,)).fetchone()
    return registration_result(created, True)


def required_text(data, key, size, required=True):
    value = data.get(key, "")
    if not isinstance(value, str) or len(value) > size or (required and not value.strip()):
        raise APIError(400, f"Некорректное поле {key}")
    return value.strip()


def new_project(data):
    pid = required_text(data, "id", 48)
    if not ID_PATTERN.fullmatch(pid):
        raise APIError(400, "Некорректный ID проекта")
    return register_site({
        "name": required_text(data, "name", 80),
        "domain": required_text(data, "url", 200),
        "type": required_text(data, "type", 60, False),
        "tags": data.get("tags", []) if isinstance(data.get("tags", []), list) else [],
    }, requested_id=pid)


def domain_host(value):
    raw = str(value or "").strip()
    if not raw:
        return ""
    if "://" not in raw:
        raw = "https://" + raw
    try:
        host = urlsplit(raw).hostname
    except ValueError:
        return ""
    return (host or "").lower().rstrip(".")


def agent_stats_query(parts):
    params = parse_qs(parts.query, max_num_fields=12)
    raw_domains = [value for chunk in params.get("domains", [""]) for value in chunk.split(",")]
    domains = []
    for item in raw_domains:
        value = domain_host(item)
        if value and value not in domains:
            domains.append(value)
    if len(domains) > 50:
        raise APIError(400, "Не более 50 доменов в одном запросе")
    today = datetime.now(timezone.utc).date()
    raw_days = params.get("days", [""])[0]
    raw_from = params.get("from", [""])[0]
    raw_to = params.get("to", [""])[0]
    try:
        if raw_from or raw_to:
            start_day = datetime.fromisoformat(raw_from or raw_to).date()
            end_day = datetime.fromisoformat(raw_to or raw_from).date()
            if not raw_from or not raw_to:
                raise APIError(400, "Укажите даты from и to в формате YYYY-MM-DD")
        else:
            days = int(raw_days or 14)
            if not 1 <= days <= 90:
                raise APIError(400, "days должен быть целым числом от 1 до 90")
            end_day = today
            start_day = today - timedelta(days=days - 1)
    except APIError:
        raise
    except (ValueError, TypeError):
        raise APIError(400, "Даты from и to требуют формат YYYY-MM-DD") from None
    if end_day < start_day:
        raise APIError(400, "Дата to должна быть не раньше from")
    if (end_day - start_day).days > 91:
        raise APIError(400, "Период не более 92 дней")
    registry = projects()
    host_map = {}
    for row in registry:
        host = domain_host(row["url"])
        if host:
            host_map.setdefault(host, row["id"])
    if domains:
        matched = []
        for host in domains:
            pid = host_map.get(host)
            if pid and pid not in [item["project_id"] for item in matched]:
                matched.append({"domain": host, "project_id": pid})
        unknown = [host for host in domains if host not in host_map]
    else:
        matched = [{"domain": domain_host(row["url"]), "project_id": row["id"]} for row in registry if domain_host(row["url"])]
        unknown = []
    ids = [item["project_id"] for item in matched]
    metrics = warehouse.domain_stats(ids, start_day, end_day) if ids else {}
    names = {row["id"]: row["name"] for row in registry}
    stats = [{
        "domain": item["domain"],
        "project_id": item["project_id"],
        "name": names.get(item["project_id"], item["project_id"]),
        **metrics.get(item["project_id"], {}),
    } for item in matched]
    return {
        "mode": "live",
        "period": {"from": start_day.isoformat(), "to": end_day.isoformat()},
        "requested_domains": domains,
        "unknown_domains": unknown,
        "stats": stats,
    }


def update_tags(data):
    pid = required_text(data, "id", 48)
    tags = tag_list(data)
    with connection() as con:
        known = con.execute("SELECT 1 FROM projects WHERE id = ?", (pid,)).fetchone()
        if not known:
            raise APIError(404, "Проект не найден")
        con.execute("UPDATE projects SET tags = ? WHERE id = ?", (json.dumps(tags, ensure_ascii=False), pid))
    return next((row for row in projects() if row["id"] == pid), {"id": pid, "tags": tags})


def timestamp(data, key):
    value = required_text(data, key, 45, False)
    try:
        moment = datetime.fromisoformat(value) if value else datetime.now(timezone.utc)
        if moment.tzinfo is None or not 1970 <= moment.year <= 2200:
            raise ValueError
        return moment.astimezone(timezone.utc).isoformat(sep=" ", timespec="milliseconds")[:-6]
    except ValueError:
        raise APIError(400, f"Поле {key} требует ISO 8601 с часовым поясом") from None


def read_event(data):
    flag = data.get("is_conversion", False)
    duration = data.get("duration_ms", 0)
    depth = data.get("scroll_depth", 0)
    traffic_type = data.get("traffic_type", "unknown")
    country_code = data.get("country_code", "ZZ")
    properties = data.get("properties", {})
    if type(flag) is not bool:
        raise APIError(400, "Поле is_conversion должно быть true или false")
    if type(duration) is not int or not 0 <= duration <= 86_400_000:
        raise APIError(400, "duration_ms должен быть целым числом от 0 до 86400000")
    if type(depth) is not int or not 0 <= depth <= 100:
        raise APIError(400, "scroll_depth должен быть целым числом от 0 до 100")
    if not isinstance(traffic_type, str) or traffic_type not in TRAFFIC_TYPES:
        raise APIError(400, "traffic_type должен быть human, bot или unknown")
    if not isinstance(country_code, str) or not re.fullmatch(r"(?:[A-Za-z]{2}|ZZ)", country_code):
        raise APIError(400, "country_code должен быть ISO-3166 alpha-2 или ZZ")
    country_code = country_code.upper()
    if not isinstance(properties, dict) or len(properties) > 32:
        raise APIError(400, "properties должен быть объектом не более чем с 32 полями")
    try:
        properties_json = json.dumps(properties, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError, RecursionError):
        raise APIError(400, "Некорректный объект properties") from None
    if len(properties_json.encode()) > 8192:
        raise APIError(400, "properties слишком велик")
    return {
        "project_id": required_text(data, "project_id", 48),
        "event_id": required_text(data, "event_id", 150),
        "session_id": required_text(data, "session_id", 150),
        "person_id": required_text(data, "person_id", 150, False),
        "ts": timestamp(data, "timestamp"),
        "event_name": required_text(data, "event_name", 80),
        "channel": required_text(data, "channel", 100, False),
        "page": required_text(data, "page", 512, False),
        "is_conversion": int(flag),
        "duration_ms": duration,
        "scroll_depth": depth,
        "traffic_type": traffic_type,
        "country_code": country_code,
        "referrer": required_text(data, "referrer", 512, False),
        "properties": properties_json,
    }


def read_deal(data):
    try:
        if data.get("currency", "USD") != "USD":
            raise ValueError
        revenue = Decimal(str(data["revenue"]))
        if not revenue.is_finite() or not 0 <= revenue < 10 ** 15 or revenue != revenue.quantize(Decimal("0.01")):
            raise ValueError
    except (KeyError, ValueError, InvalidOperation):
        raise APIError(400, "Поле revenue требует неотрицательную сумму в USD, до двух знаков после запятой") from None
    return {
        "project_id": required_text(data, "project_id", 48),
        "deal_id": required_text(data, "deal_id", 150),
        "person_id": required_text(data, "person_id", 150),
        "closed_at": timestamp(data, "closed_at"),
        "revenue": format(revenue, ".2f"),
    }


def ingest(payload, kind):
    batch = payload if isinstance(payload, list) else [payload]
    if not 1 <= len(batch) <= 500 or any(not isinstance(item, dict) for item in batch):
        raise APIError(400, "Передайте от 1 до 500 объектов")
    parser, table, key = {
        "events": (read_event, "events", "event_id"),
        "crm": (read_deal, "crm_deals", "deal_id"),
    }[kind]
    rows = [parser(item) for item in batch]
    known = {project["id"] for project in projects()}
    if any(row["project_id"] not in known for row in rows):
        raise APIError(400, "Проект не найден в реестре")
    ignored_legacy = 0
    if kind == "events":
        kept = []
        for row in rows:
            if row["event_name"] in LEGACY_NOISE_EVENTS:
                ignored_legacy += 1
            else:
                kept.append(row)
        rows = kept
        if not rows:
            return {"accepted": 0, "ignored_legacy": ignored_legacy}
    unique = {(row["project_id"], row[key]): row for row in rows}
    warehouse.query(f"INSERT INTO {table} FORMAT JSONEachRow", data=unique.values())
    result = {"accepted": len(unique)}
    if kind == "events":
        result["ignored_legacy"] = ignored_legacy
    return result


def collection_rate_allowed(site_id, client_ip):
    now = time.monotonic()
    key = (site_id, client_ip or "unknown")
    with _RATE_LOCK:
        start, count = _RATE_BUCKETS.get(key, (now, 0))
        if now - start >= COLLECT_RATE_WINDOW:
            start, count = now, 0
        if count >= COLLECT_RATE_LIMIT:
            return False
        _RATE_BUCKETS[key] = (start, count + 1)
        if len(_RATE_BUCKETS) > 10000:
            for old_key, (old_start, _) in list(_RATE_BUCKETS.items()):
                if now - old_start >= COLLECT_RATE_WINDOW:
                    _RATE_BUCKETS.pop(old_key, None)
    return True


def classify_traffic(user_agent):
    value = str(user_agent or "")[:512]
    if not value.strip():
        return "unknown"
    return "bot" if BOT_UA_RE.search(value) else "human"


def ingest_from_site(payload, request_origin, client_ip="unknown", user_agent=""):
    if not isinstance(payload, dict):
        raise APIError(400, "Требуется объект site_id/site_key/events")
    site_id = required_text(payload, "site_id", 48)
    site_key = required_text(payload, "site_key", 128)
    origin = normalize_origin(request_origin)
    with connection() as con:
        site = con.execute("SELECT site_key, allowed_origins FROM projects WHERE id = ?", (site_id,)).fetchone()
    if not site or not site["site_key"]:
        raise APIError(403, "Неверный site_id или ключ")
    allowed = json.loads(site["allowed_origins"] or "[]")
    if origin not in allowed or not hmac.compare_digest(site_key, site["site_key"]):
        raise APIError(403, "Сайт или Origin не разрешён")
    if not collection_rate_allowed(site_id, client_ip):
        raise APIError(429, "Слишком много событий с этого адреса; повторите позже")
    batch = payload.get("events")
    if not isinstance(batch, list) or not 1 <= len(batch) <= 100:
        raise APIError(400, "Передайте от 1 до 100 событий")
    traffic_type = classify_traffic(user_agent)
    country_code = geoip.country_code(client_ip)
    rows = []
    ignored_legacy = 0
    for event in batch:
        if not isinstance(event, dict):
            raise APIError(400, "Каждое событие должно быть объектом")
        if event.get("project_id") not in (None, "", site_id):
            raise APIError(403, "project_id не совпадает с site_id")
        event_name = event.get("event_name")
        if isinstance(event_name, str) and event_name in LEGACY_NOISE_EVENTS:
            ignored_legacy += 1
            continue
        rows.append({**event, "project_id": site_id, "traffic_type": traffic_type, "country_code": country_code})
    if not rows:
        return {"site_id": site_id, "accepted": 0, "ignored_legacy": ignored_legacy}
    return {"site_id": site_id, **ingest(rows, "events"), "ignored_legacy": ignored_legacy}


def secret_matches(received, name):
    expected = os.getenv(name, "")
    return bool(expected) and hmac.compare_digest(received.encode(), expected.encode())


def canonical_ip(value):
    if not isinstance(value, str) or not value.strip():
        raise APIError(403, "Не удалось определить IP сервера")
    raw = value.strip().split("%", 1)[0]
    try:
        address = ipaddress.ip_address(raw)
    except ValueError:
        raise APIError(403, "Некорректный IP сервера") from None
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    return address.compressed


def allowed_agent_servers():
    try:
        data = json.loads(AGENT_IPS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        raise APIError(503, "Список привязок серверов временно недоступен") from None
    if not isinstance(data, dict):
        raise APIError(503, "Некорректный список привязок серверов")
    servers = {}
    for raw_ip, codes in data.items():
        try:
            ip = canonical_ip(raw_ip)
        except APIError:
            continue
        if not isinstance(codes, list):
            continue
        clean_codes = [code.strip() for code in codes if isinstance(code, str) and re.fullmatch(r"[A-Za-z0-9_. -]{1,100}", code.strip())]
        servers.setdefault(ip, []).extend(clean_codes)
    return {ip: sorted(set(codes)) for ip, codes in servers.items()}


def agent_key_for_ip(client_ip):
    secret = os.getenv("VM_AGENT_KEY_SECRET", "")
    if len(secret) < 32:
        raise APIError(503, "Секрет выдачи agent API key не настроен")
    message = b"vibemetrics-agent-registration-v1:" + client_ip.encode("ascii")
    digest = hmac.new(secret.encode(), message, "sha256").digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def registration_key_matches(headers, client_ip):
    authorization = headers.get("Authorization", "")
    if not authorization.lower().startswith("bearer "):
        return False
    token = authorization[7:].strip()
    return bool(token) and hmac.compare_digest(token, agent_key_for_ip(client_ip))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_ROOT), **kwargs)

    def request_ip(self):
        raw = self.headers.get("X-Real-IP", "") or self.client_address[0]
        if "," in raw:
            raise APIError(403, "Некорректный адрес клиента")
        return canonical_ip(raw)

    def list_directory(self, path):
        self.send_error(404)
        return None

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        super().end_headers()

    def send_json(self, data, status=200):
        payload = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(payload)))
        if getattr(self, "cors_origin", ""):
            self.send_header("Access-Control-Allow-Origin", self.cors_origin)
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(payload)

    def unauthorized(self, challenge=False):
        self.send_response(401)
        if challenge:
            self.send_header("WWW-Authenticate", 'Basic realm="VibeMetrics", charset="UTF-8"')
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def is_admin(self):
        header = self.headers.get("Authorization", "")
        if not header.startswith("Basic "):
            return False
        try:
            user, separator, password = base64.b64decode(header[6:], validate=True).decode().partition(":")
        except (UnicodeDecodeError, binascii.Error):
            return False
        if not separator:
            return False
        admin_user = os.getenv("VM_ADMIN_USER", "admin")
        if user == admin_user and secret_matches(password, "VM_ADMIN_PASSWORD"):
            return True
        bot_user = os.getenv("VM_PANEL_BOT_USER", "")
        return bool(bot_user) and user == bot_user and secret_matches(password, "VM_PANEL_BOT_PASSWORD")

    def bearer(self, name):
        header = self.headers.get("Authorization", "")
        return header.startswith("Bearer ") and secret_matches(header[7:], name)

    def public_rate_allowed(self):
        """Per-IP limiter for the unauthenticated read-only stats endpoints."""
        try:
            client_ip = self.request_ip()
        except APIError:
            client_ip = "unknown"
        now = time.monotonic()
        with _RATE_LOCK:
            start, count = _RATE_BUCKETS.get(("public", client_ip), (now, 0))
            if now - start >= PUBLIC_RATE_WINDOW:
                start, count = now, 0
            allowed = count < PUBLIC_RATE_LIMIT
            if allowed:
                _RATE_BUCKETS[("public", client_ip)] = (start, count + 1)
            if len(_RATE_BUCKETS) > 10000:
                for old_key, (old_start, _) in list(_RATE_BUCKETS.items()):
                    if now - old_start >= PUBLIC_RATE_WINDOW:
                        _RATE_BUCKETS.pop(old_key, None)
        return allowed

    def agent_authorized(self):
        if self.bearer("VM_READ_TOKEN") or self.is_admin():
            return True
        try:
            client_ip = self.request_ip()
            servers = allowed_agent_servers()
        except APIError:
            return False
        return client_ip in servers and registration_key_matches(self.headers, client_ip)

    def json_body(self):
        if self.headers.get_content_type() != "application/json":
            raise APIError(415, "Требуется Content-Type: application/json")
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 1 <= size <= MAX_BODY:
                raise APIError(413, "Размер тела запроса вне допустимого диапазона")
            return json.loads(self.rfile.read(size))
        except (ValueError, UnicodeDecodeError, RecursionError):
            raise APIError(400, "Некорректный JSON") from None

    def collector_body(self):
        if self.headers.get_content_type() not in {"application/json", "text/plain"}:
            raise APIError(415, "Требуется JSON в text/plain или application/json")
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 1 <= size <= 128 * 1024:
                raise APIError(413, "Размер тела коллектора вне допустимого диапазона")
            return json.loads(self.rfile.read(size))
        except (ValueError, UnicodeDecodeError, RecursionError):
            raise APIError(400, "Некорректный JSON") from None

    def handle_api(self, parts, write):
        try:
            path = parts.path
            if not write and path == "/api/agent/stats":
                if not self.agent_authorized():
                    return self.send_json({"error": "Требуется IP-привязанный ключ агента (POST /api/agent/key), VM_READ_TOKEN или Basic-авторизация"}, 401)
                return self.send_json(agent_stats_query(parts))
            if write and path == "/api/agent/key":
                client_ip = self.request_ip()
                servers = allowed_agent_servers()
                if client_ip not in servers:
                    return self.send_json({"error": "IP сервера не привязан к агенту"}, 403)
                base = os.getenv("VM_PUBLIC_URL", "https://vibemetrics.click").rstrip("/")
                return self.send_json({
                    "server_ip": client_ip,
                    "server_codes": servers[client_ip],
                    "api_key": agent_key_for_ip(client_ip),
                    "bound_to_ip": True,
                    "register_url": base + "/api/agent/sites",
                    "docs_url": base + "/agent.md",
                })
            if write and path == "/api/agent/sites":
                client_ip = self.request_ip()
                servers = allowed_agent_servers()
                if client_ip not in servers:
                    return self.send_json({"error": "IP сервера не привязан к агенту"}, 403)
                if not registration_key_matches(self.headers, client_ip):
                    return self.unauthorized()
                data = self.json_body()
                if not isinstance(data, dict):
                    raise APIError(400, "Требуется объект регистрации сайта")
                result = register_site(data, requested_id=data.get("project_id", ""))
                return self.send_json(result, 201 if result["created"] else 200)
            if write and path == "/api/collect":
                payload = self.collector_body()
                origin = normalize_origin(self.headers.get("Origin", ""))
                self.cors_origin = origin
                client_ip = self.headers.get("X-Real-IP", "") or self.client_address[0]
                return self.send_json(ingest_from_site(payload, origin, client_ip, self.headers.get("User-Agent", "")), 202)
            if write and path in {"/api/events", "/api/crm"}:
                if not self.bearer("VM_INGEST_TOKEN"):
                    return self.unauthorized()
                return self.send_json(ingest(self.json_body(), path.rsplit("/", 1)[-1]), 202)
            public_read = not write and path in PUBLIC_GET_API
            if public_read and not self.public_rate_allowed():
                return self.send_json({"error": "Слишком много запросов; повторите позже"}, 429)
            if not public_read and not self.is_admin() and (write or not self.bearer("VM_READ_TOKEN")):
                return self.unauthorized(challenge=not write)
            if write and path == "/api/projects":
                data = self.json_body()
                if not isinstance(data, dict):
                    raise APIError(400, "Требуется объект проекта")
                result = new_project(data)
                return self.send_json(result, 201 if result["created"] else 200)
            if write and path == "/api/projects/tags":
                data = self.json_body()
                if not isinstance(data, dict):
                    raise APIError(400, "Требуется объект с id и tags")
                return self.send_json(update_tags(data))
            if not write and path == "/api/status":
                return self.send_json({"mode": "live"})
            if not write and path == "/api/projects":
                return self.send_json(projects())
            if not write and path == "/api/snapshot":
                params = parse_qs(parts.query, max_num_fields=8)
                project = params.get("project", [""])[0]
                model = params.get("model", ["last"])[0]
                raw_days = params.get("days", ["14"])[0]
                raw_offset = params.get("offset", ["0"])[0]
                tag = params.get("tag", [""])[0]
                registry = projects()
                if raw_days not in {str(n) for n in range(1, 31)} or model not in {"first", "last"}:
                    raise APIError(400, "Выберите период от 1 до 30 дней и модель first или last")
                if raw_offset not in {"0", "1"}:
                    raise APIError(400, "offset должен быть 0 (текущий период) или 1 (вчера)")
                if project and project not in {row["id"] for row in registry}:
                    raise APIError(404, "Проект не найден")
                ids = None
                if tag:
                    if len(tag) > 40:
                        raise APIError(400, "Некорректный тег")
                    ids = [row["id"] for row in registry if tag in row["tags"]]
                return self.send_json(warehouse.snapshot(registry, project, int(raw_days), model, ids, int(raw_offset)))
            return self.send_json({"error": "Маршрут не найден"}, 404)
        except APIError as error:
            return self.send_json({"error": str(error)}, error.status)
        except ValueError:
            return self.send_json({"error": "Некорректные параметры"}, 400)
        except (URLError, TimeoutError, OSError, sqlite3.Error, KeyError):
            logging.exception("API request failed")
            return self.send_json({"error": "Хранилище недоступно"}, 503)

    def allowed_static(self):
        path = unquote(urlsplit(self.path).path)
        parts = path.split("/")
        return path in {"/", "/index.html"} or (
            len(parts) == 3 and parts[1] in {"assets", "downloads"}
            and re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]*", parts[2])
        )

    def serve_spa_route(self, parts):
        if parts.path.strip("/") in VIEW_PAGES:
            self.path = "/?" + parts.query if parts.query else "/"

    def do_GET(self):
        parts = urlsplit(self.path)
        if parts.path.startswith("/api/"):
            return self.handle_api(parts, write=False)
        # SPA и статика публичны; все пишущие и админские маршруты остаются
        # под Basic/Bearer-гейтами в handle_api.
        self.serve_spa_route(parts)
        if not self.allowed_static():
            return self.send_error(404)
        return super().do_GET()

    def do_HEAD(self):
        parts = urlsplit(self.path)
        if parts.path.startswith("/api/"):
            return self.handle_api(parts, write=False)
        self.serve_spa_route(parts)
        if not self.allowed_static():
            return self.send_error(404)
        return super().do_HEAD()

    def do_POST(self):
        return self.handle_api(urlsplit(self.path), write=True)

    def do_OPTIONS(self):
        if urlsplit(self.path).path != "/api/collect":
            return self.send_error(404)
        try:
            origin = normalize_origin(self.headers.get("Origin", ""))
        except APIError:
            return self.send_error(403)
        with connection() as con:
            registered = False
            for row in con.execute("SELECT allowed_origins FROM projects"):
                if origin in json.loads(row["allowed_origins"] or "[]"):
                    registered = True
                    break
        if not registered:
            return self.send_error(403)
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Vary", "Origin")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, message, *args):
        # Avoid logging query strings and credentials.
        if args and len(args) >= 2:
            logging.info("%s %s", self.command, args[1])


def main():
    required = ("VM_ADMIN_PASSWORD", "VM_INGEST_TOKEN", "VM_READ_TOKEN", "CLICKHOUSE_PASSWORD", "VM_AGENT_KEY_SECRET")
    if any(len(os.getenv(key, "")) < 32 for key in ("VM_INGEST_TOKEN", "VM_AGENT_KEY_SECRET")):
        raise SystemExit("VM_INGEST_TOKEN and VM_AGENT_KEY_SECRET must be at least 32 characters.")
    if any(len(os.getenv(key, "")) < 16 for key in ("VM_ADMIN_PASSWORD", "VM_READ_TOKEN", "CLICKHOUSE_PASSWORD")):
        raise SystemExit("VM_ADMIN_PASSWORD, VM_READ_TOKEN and CLICKHOUSE_PASSWORD must be at least 16 characters.")
    if len({os.environ[key] for key in required}) != len(required):
        raise SystemExit("Use a distinct value for each service secret.")
    logging.basicConfig(level=logging.INFO)
    initialize()
    warehouse.ensure_event_schema()
    geoip.initialize()
    host = os.getenv("VM_BIND", "127.0.0.1")
    with ThreadingHTTPServer((host, int(os.getenv("VM_PORT", "8080"))), Handler) as server:
        server.serve_forever()


if __name__ == "__main__":
    main()
