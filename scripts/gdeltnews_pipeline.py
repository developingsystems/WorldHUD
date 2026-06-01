# Reconstruct GDELT full articles using gdeltnews.
# Fires 6 minutes after each quarter‑hour, when all NGrams files are ready.

import os
import json
import csv
import tempfile
import urllib.request
from datetime import datetime, timezone, timedelta
from gdeltnews import download, reconstruct

def article_json_exists(timestamp: str) -> bool:
    """Return True if articles_{timestamp}.json already exists in the release."""
    url = f"https://github.com/developingsystems/WorldHUD/releases/download/gdelt-articles/articles_{timestamp}.json"
    try:
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status == 200
    except Exception:
        return False

def main():
    now = datetime.now(timezone.utc)

    # ---------- Determine target chunk ----------
    chunk_ts = os.environ.get("CHUNK_TIMESTAMP", "auto")
    if chunk_ts != "auto" and len(chunk_ts) == 14:
        # Dispatched by the HUD – use the exact requested timestamp
        chunk_end = datetime.strptime(chunk_ts, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
        chunk_start = chunk_end - timedelta(minutes=15)
        timestamp = chunk_end.strftime("%Y%m%d%H%M%S")
    else:
        # Cron run – most recent complete chunk, with 3‑minute grace period
        chunk_end = now.replace(minute=(now.minute // 15) * 15, second=0, microsecond=0)
        # 3‑minute grace period – if the chunk's files aren't ready yet, fall back to the previous one
        if (now - chunk_end).seconds < 180:
            chunk_end = chunk_end - timedelta(minutes=15)
        chunk_start = chunk_end - timedelta(minutes=15)
        timestamp = chunk_end.strftime("%Y%m%d%H%M%S")

    print(f"Window: {chunk_start.isoformat()} → {chunk_end.isoformat()}  (timestamp: {timestamp})")

    # ---------- Skip if already reconstructed ----------
    if article_json_exists(timestamp):
        print(f"Articles for {timestamp} already exist – skipping.")
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            f.write("timestamp=skip\n")
        return

    # ---------- Download & reconstruct ----------
    with tempfile.TemporaryDirectory() as ngram_dir, \
         tempfile.TemporaryDirectory() as csv_dir:

        print("Downloading n-grams …")
        download(start=chunk_start, end=chunk_end, outdir=ngram_dir)

        print("Reconstructing articles …")
        reconstruct(input_dir=ngram_dir, output_dir=csv_dir)

        articles: dict[str, str] = {}
        for fname in os.listdir(csv_dir):
            if not fname.endswith(".csv"):
                continue
            with open(os.path.join(csv_dir, fname), "r", encoding="utf-8") as f:
                reader = csv.DictReader(
                    f, delimiter="|",
                    fieldnames=["Text", "Date", "URL", "Source"]
                )
                for row in reader:
                    url = row.get("URL", "")
                    text = row.get("Text", "")
                    if not url or not text:
                        continue
                    # Keep the longest version of each article
                    if url not in articles or len(text) > len(articles[url]):
                        articles[url] = text

        os.makedirs("articles", exist_ok=True)
        output_path = f"articles/articles_{timestamp}.json"
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(articles, f, ensure_ascii=False, indent=2)

        print(f"Saved {len(articles)} articles → {output_path}")

        # Pass the timestamp to the next workflow step
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            f.write(f"timestamp={timestamp}\n")


if __name__ == "__main__":
    main()
