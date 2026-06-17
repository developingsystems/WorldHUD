# Reconstruct GDELT full articles using gdeltnews.
# Fires 6 minutes after each quarter‑hour, when all NGrams files are ready.

import os
import json
import csv
import tempfile
import urllib.request
from datetime import datetime, timezone, timedelta
from gdeltnews import download, reconstruct

# Set this to 0 to disable filtering, or adjust after reviewing stats
MIN_ARTICLE_LENGTH = 0  # e.g., 100 to filter out short snippets

def article_json_exists(timestamp: str) -> bool:
    """Return True if gdeltnews_{timestamp}.json already exists in the release."""
    url = f"https://github.com/developingsystems/WorldHUD/releases/download/gdelt-articles/gdeltnews_{timestamp}.json"
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
                    url = row.get("URL", "").strip()
                    text = row.get("Text", "").strip()
                    if not url or not text:
                        continue
                    # Keep the longest version of each article
                    if url not in articles or len(text) > len(articles[url]):
                        articles[url] = text

        # --- DIAGNOSTICS: show article length distribution ---
        if articles:
            lengths = [len(t) for t in articles.values()]
            lengths.sort()
            total = len(lengths)
            min_len = min(lengths)
            max_len = max(lengths)
            median = lengths[total // 2]
            print(f"📊 Article length stats: total={total}, min={min_len}, max={max_len}, median={median}")
            # Show first 10 lengths as sample
            print(f"📊 Sample lengths: {lengths[:10]}")

        # --- OPTIONAL FILTER: remove articles shorter than threshold ---
        if MIN_ARTICLE_LENGTH > 0:
            filtered = {url: text for url, text in articles.items() if len(text) >= MIN_ARTICLE_LENGTH}
            removed = len(articles) - len(filtered)
            if removed > 0:
                print(f"✂️ Filtered out {removed} articles shorter than {MIN_ARTICLE_LENGTH} characters.")
            articles = filtered

        os.makedirs("articles", exist_ok=True)
        output_path = f"articles/gdeltnews_{timestamp}.json"
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(articles, f, ensure_ascii=False, indent=2)

        print(f"✅ Saved {len(articles)} articles → {output_path}")

        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            f.write(f"timestamp={timestamp}\n")


if __name__ == "__main__":
    main()
