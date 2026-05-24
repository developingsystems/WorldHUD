#!/usr/bin/env python3
"""gdeltnews pipeline for WorldHUD – two‑stage reconstruction.

   stage1 – early reconstruction (cron at :06/:21/:36/:51)
   stage2 – final reconstruction (cron at :17/:32/:47/:02)

   Stage2 waits until the last minute‑file of the burst (:14) is available,
   then downloads the full 15‑minute window and overwrites the final JSON.
   Stage1 files are kept for testing/toggle purposes.
"""

import os
import sys
import json
import csv
import time
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path
from gdeltnews.download import download as gd_download
from gdeltnews.reconstruct import reconstruct as gd_reconstruct
from gdeltnews.filtermerge import filtermerge as gd_filtermerge

# ---------- helpers ----------
def url_exists(url: str) -> bool:
    """Return True if the remote URL returns HTTP 200."""
    try:
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status == 200
    except Exception:
        return False

def wait_for_last_minute_file(chunk_start: datetime):
    """Block until the :14 minute file of the chunk is available."""
    last_file_url = (
        f"http://data.gdeltproject.org/gdeltv3/webngrams/"
        f"{(chunk_start + timedelta(minutes=14)).strftime('%Y%m%d%H%M%S')}.webngrams.json.gz"
    )
    print(f"[stage2] Waiting for {last_file_url} …")
    while not url_exists(last_file_url):
        print("[stage2] Not yet available – sleeping 60 s")
        time.sleep(60)
    print("[stage2] File available, starting download.")

# ---------- main ----------
DATA_DIR = Path("gdeltdata")
RECON_DIR = Path("reconstructed")
STAGE = os.environ.get("STAGE", "stage2")

# 1. Determine chunk start (most recent quarter‑hour boundary)
now = datetime.now(timezone.utc)
chunk_start = now.replace(minute=(now.minute // 15) * 15, second=0, microsecond=0)
ts = chunk_start.strftime("%Y%m%d%H%M%S")

if STAGE == "stage1":
    end = now
else:
    # Wait until the last file of the burst is guaranteed to exist
    wait_for_last_minute_file(chunk_start)
    end = chunk_start + timedelta(minutes=14)

print(f"[{STAGE}] Chunk: {ts}, window: {chunk_start.isoformat()} → {end.isoformat()}")

# 2. Download NGrams 3.0 files for the window
DATA_DIR.mkdir(parents=True, exist_ok=True)
gd_download(
    start=chunk_start.strftime("%Y-%m-%dT%H:%M:%S"),
    end=end.strftime("%Y-%m-%dT%H:%M:%S"),
    outdir=str(DATA_DIR),
    decompress=False,
)
ngram_files = sorted(DATA_DIR.glob("*.webngrams.json.gz"))
print(f"[{STAGE}] Downloaded {len(ngram_files)} file(s)")

# 3. Reconstruct
RECON_DIR.mkdir(parents=True, exist_ok=True)
gd_reconstruct(
    input_dir=str(DATA_DIR),
    output_dir=str(RECON_DIR),
    language="en",
    processes=4,
)
print(f"[{STAGE}] Reconstruction finished")

# 4. Filtermerge → CSV
merged_csv = Path(f"articles_{ts}.csv")
gd_filtermerge(
    input_dir=str(RECON_DIR),
    output_file=str(merged_csv),
)
print(f"[{STAGE}] Filtermerge finished")

# 5. CSV → JSON
articles: dict[str, str] = {}
with merged_csv.open("r", encoding="utf-8") as fh:
    reader = csv.DictReader(fh)
    for row in reader:
        url = row.get("url", "").strip()
        text = row.get("text", "").strip()
        if url and text:
            articles[url] = text

# Stage1 → temporary file; Stage2 → final file (both kept for now)
if STAGE == "stage1":
    json_file = Path(f"articles_{ts}_stage1.json")
else:
    json_file = Path(f"articles_{ts}.json")
    # Note: _stage1 file is intentionally kept for testing toggles

json_file.write_text(json.dumps(articles, ensure_ascii=False, indent=2))
print(f"[{STAGE}] Wrote {len(articles)} articles → {json_file}")

# 6. Cleanup
import shutil
shutil.rmtree(DATA_DIR, ignore_errors=True)
shutil.rmtree(RECON_DIR, ignore_errors=True)
merged_csv.unlink(missing_ok=True)
print(f"[{STAGE}] Done!")
