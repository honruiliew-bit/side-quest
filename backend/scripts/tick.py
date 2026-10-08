"""Render Cron Job: run the Sidequest clock on schedule.

Fires deadlines (tip, cancel, lock), releases escrowed payouts and sends nudges even when
nobody has the site open. Free web services sleep after 15 idle minutes, so this calls the
public URL and waits out a cold start.

    API_URL=https://sidequest-api.onrender.com CRON_SECRET=... python scripts/tick.py
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request


def main() -> int:
    url = os.environ["API_URL"].rstrip("/") + "/cron/tick"
    secret = os.environ["CRON_SECRET"]
    for attempt in range(1, 5):
        req = urllib.request.Request(url, method="POST", headers={"X-Cron-Secret": secret})
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                print("tick", json.loads(resp.read() or b"{}"))
                return 0
        except urllib.error.HTTPError as exc:
            if exc.code in (401, 403):
                print("tick refused: check CRON_SECRET", file=sys.stderr)
                return 1
            print(f"attempt {attempt}: HTTP {exc.code}", file=sys.stderr)
        except (urllib.error.URLError, TimeoutError) as exc:
            print(f"attempt {attempt}: {exc}", file=sys.stderr)  # usually a cold start
        time.sleep(15 * attempt)
    return 1


if __name__ == "__main__":
    sys.exit(main())
