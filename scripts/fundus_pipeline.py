"""Fundus article extraction for WorldHUD.

Triggered via workflow_dispatch. Expects:
  CHUNK_TIMESTAMP  – YYYYMMDDHHMMSS string
  URLS             – JSON‑encoded list of article URLs

Outputs:
  fundus_<timestamp>.json  – a JSON object mapping URL → extracted text
  Uploaded to the gdelt-articles GitHub Release.
"""

import os
import json
import csv
import tempfile
import sys
import time
import urllib.request
from datetime import datetime, timezone
from fundus import PublisherCollection, Crawler, NewsArticle
from fundus.parser import ArticleBody

# ---------- helper ----------
def article_json_exists(timestamp: str, prefix: str = "fundus_") -> bool:
    """Return True if the file already exists in the release."""
    url = f"https://github.com/developingsystems/WorldHUD/releases/download/gdelt-articles/{prefix}{timestamp}.json"
    try:
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status == 200
    except Exception:
        return False


def main():
    timestamp = os.environ.get("CHUNK_TIMESTAMP")
    urls_json = os.environ.get("URLS")

    if not timestamp or not urls_json:
        print("Error: CHUNK_TIMESTAMP and URLS must be set")
        sys.exit(1)

    if article_json_exists(timestamp, prefix="fundus_"):
        print(f"Fundus articles for {timestamp} already exist – skipping.")
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            f.write("timestamp=skip\n")
        return

    urls = json.loads(urls_json)
    if not isinstance(urls, list) or not urls:
        print("Error: URLS is not a valid list")
        sys.exit(1)

    print(f"Fundus extraction for chunk {timestamp} – {len(urls)} URLs")

    # Fundus requires the PublisherCollection to be initialised
    # We'll use the default crawler that covers all supported publishers.
    articles: dict[str, str] = {}

    for url in urls:
        try:
            # Fundus can extract from a URL directly
            article = NewsArticle(url)
            article.fetch()
            if article.body:
                articles[url] = article.body.text
            else:
                print(f"  No body extracted: {url}")
        except Exception as e:
            print(f"  Extraction failed for {url}: {e}")
            # Continue with next URL

    os.makedirs("articles", exist_ok=True)
    output_path = f"articles/fundus_{timestamp}.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(articles, f, ensure_ascii=False, indent=2)

    print(f"Saved {len(articles)} Fundus articles → {output_path}")

    with open(os.environ["GITHUB_OUTPUT"], "a") as f:
        f.write(f"timestamp={timestamp}\n")


if __name__ == "__main__":
    main()
