"""Send a reproducible sample to a separate local VibeMetrics test stack."""

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from random import Random
from urllib.request import Request, urlopen


def dotenv():
    path = Path(__file__).resolve().parent.parent / ".env"
    lines = path.read_text().splitlines() if path.exists() else []
    return dict(line.split("=", 1) for line in lines if line.strip() and not line.lstrip().startswith("#") and "=" in line)


def send(url, token, route, records):
    for offset in range(0, len(records), 200):
        request = Request(url + "/api/" + route, json.dumps(records[offset:offset + 200]).encode(), headers={
            "Content-Type": "application/json", "Authorization": "Bearer " + token,
        })
        with urlopen(request, timeout=30) as response:
            print(route, json.load(response))


def main():
    values = dotenv() | os.environ
    token = values.get("VM_INGEST_TOKEN", "").strip("'\"")
    if not token:
        raise SystemExit("Set VM_INGEST_TOKEN in .env or in the shell.")
    base = values.get("VM_API_URL", "http://127.0.0.1:" + values.get("VM_PORT", "8080")).rstrip("/")
    registry = json.loads(Path(__file__).with_name("projects.json").read_text())
    channels = ("Organic search", "Paid search", "Direct", "Partner referral", "Email")
    rng = Random(37)
    anchor = datetime.now(timezone.utc) - timedelta(hours=1)
    events = []
    deals = []
    for project in registry:
        for day in range(30):
            for slot in range(7 + rng.randrange(6)):
                moment = anchor - timedelta(days=day, minutes=slot * 11)
                tag = f"sample-{moment.date().isoformat()}-{slot}"
                channel = rng.choice(channels)
                common = {"project_id": project["id"], "session_id": tag, "person_id": f"sample-person-{slot}-{day % 4}"}
                events.extend([
                    {**common, "event_id": tag + "-view", "event_name": "page_view", "page": "/", "channel": channel, "timestamp": moment.isoformat()},
                    {**common, "event_id": tag + "-cta", "event_name": "cta_click", "page": "/pricing", "timestamp": (moment + timedelta(seconds=35)).isoformat()},
                ])
                if rng.randrange(4) != 0:
                    continue
                events.append({
                    **common, "event_id": tag + "-goal", "event_name": "purchase", "page": "/checkout",
                    "is_conversion": True, "timestamp": (moment + timedelta(minutes=2)).isoformat(),
                })
                if rng.randrange(4) != 0:
                    deals.append({
                        "project_id": project["id"], "person_id": common["person_id"], "deal_id": tag + "-deal",
                        "revenue": str(rng.choice((19, 29, 49, 129))), "closed_at": (moment + timedelta(minutes=9)).isoformat(),
                    })
    send(base, token, "events", events)
    send(base, token, "crm", deals)


if __name__ == "__main__":
    main()
