"""Read-only stdio MCP bridge to the VibeMetrics API (2025 protocol revisions)."""

import csv
import io
import json
import os
import sys
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

VERSIONS = {"2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"}
FILTERS = {
    "project": {"type": "string", "description": "Project ID. Omit for the whole network."},
    "days": {"type": "integer", "enum": [7, 14, 30], "default": 14},
    "model": {"type": "string", "enum": ["first", "last"], "default": "last"},
}
DATASETS = {
    "projects": ("id", "name", "events", "sessions", "conversions", "linked", "revenue"),
    "attribution": ("channel", "conversions", "linked", "revenue"),
    "daily": ("date", "events"),
    "features": ("feature", "value", "definition"),
}


def tool(name, description, fields):
    return {
        "name": name, "description": description,
        "inputSchema": {"type": "object", "properties": fields, "additionalProperties": False},
        "annotations": {"readOnlyHint": True},
    }


TOOLS = [
    tool("list_projects", "List all VibeMetrics projects and their stable IDs.", {}),
    tool("get_snapshot", "Read period totals, attribution, behavior features and up to 100 recent events.", FILTERS),
    tool("export_csv", "Return the requested analytics slice as CSV text.", {
        **FILTERS, "dataset": {"type": "string", "enum": list(DATASETS), "default": "projects"},
    }),
]


def api(path, params=None):
    endpoint = os.getenv("VM_API_URL", "http://127.0.0.1:8080").rstrip("/")
    token = os.environ["VM_READ_TOKEN"]
    request = Request(endpoint + "/api/" + path + ("?" + urlencode(params) if params else ""), headers={
        "Authorization": "Bearer " + token, "Accept": "application/json",
    })
    with urlopen(request, timeout=75) as response:
        return json.load(response)


def csv_safe(value):
    if isinstance(value, str) and value.lstrip("\t\r\n \ufeff").startswith(("=", "+", "-", "@")):
        return "'" + value
    return value


def call_tool(name, args):
    if not isinstance(args, dict):
        raise ValueError("arguments must be an object")
    if name == "list_projects":
        if args:
            raise ValueError("list_projects takes no arguments")
        return json.dumps(api("projects"), ensure_ascii=False)
    if name not in {"get_snapshot", "export_csv"}:
        raise ValueError("Unknown tool")
    allowed = set(FILTERS) | ({"dataset"} if name == "export_csv" else set())
    if set(args) - allowed:
        raise ValueError("Unexpected tool argument")
    dataset = args.get("dataset", "projects")
    if name == "export_csv" and (not isinstance(dataset, str) or dataset not in DATASETS):
        raise ValueError("Unknown dataset")
    payload = api("snapshot", {key: args[key] for key in FILTERS if key in args})
    if name == "get_snapshot":
        return json.dumps(payload, ensure_ascii=False)
    columns = DATASETS[dataset]
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(columns)
    writer.writerows([csv_safe(row.get(key)) for key in columns] for row in payload[dataset])
    return buffer.getvalue()


def handle(message):
    if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
        return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid Request"}}
    if "id" not in message:
        return None
    response = {"jsonrpc": "2.0", "id": message["id"]}
    method = message.get("method")
    params = message.get("params", {})
    if not isinstance(params, dict):
        return {**response, "error": {"code": -32602, "message": "Invalid params"}}
    if method == "initialize":
        requested = params.get("protocolVersion")
        version = requested if isinstance(requested, str) and requested in VERSIONS else "2025-11-25"
        result = {"protocolVersion": version, "capabilities": {"tools": {}},
                  "serverInfo": {"name": "vibemetrics", "version": "1.0.0"}}
    elif method == "ping":
        result = {}
    elif method == "tools/list":
        result = {"tools": TOOLS}
    elif method == "tools/call":
        try:
            text = call_tool(params.get("name"), params.get("arguments", {}))
            result = {"content": [{"type": "text", "text": text}]}
        except ValueError as error:
            result = {"isError": True, "content": [{"type": "text", "text": str(error)}]}
        except (URLError, OSError, KeyError):
            result = {"isError": True, "content": [{"type": "text", "text": "Cannot read VibeMetrics API. Check VM_API_URL, VM_READ_TOKEN and ClickHouse."}]}
    else:
        return {**response, "error": {"code": -32601, "message": "Method not found"}}
    return {**response, "result": result}


def main():
    for line in sys.stdin:
        try:
            response = handle(json.loads(line))
        except json.JSONDecodeError:
            response = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}
        if response is not None:
            print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
