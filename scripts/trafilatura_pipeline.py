#!/usr/bin/env python3
"""Trafilatura article extraction for WorldHUD.

- Fetches HTML directly (no domain filtering – works on any URL).
- Uses trafilatura to extract main text, metadata, and image URLs.
- Saves results as JSON with metadata included.
- Parallel fetching with configurable workers.
- Duplicate guard via GitHub release.
"""

import os
import json
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse

import requests
from requests.exceptions import TooManyRedirects
import trafilatura


# ---------------------------------------------------------------------------
# Duplicate guard – check if output file already exists in GitHub release
# ---------------------------------------------------------------------------
def article_json_exists(timestamp: str) -> bool:
    url = f"https://github.com/developingsystems/WorldHUD/releases/download/gdelt-articles/trafilatura_{timestamp}.json"
    try:
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status == 200
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------
def main():
    os.makedirs("articles", exist_ok=True)

    timestamp = os.environ.get("CHUNK_TIMESTAMP")
    urls_json = os.environ.get("URLS")
    if not timestamp or not urls_json:
        print("Error: CHUNK_TIMESTAMP and URLS must be set")
        sys.exit(1)

    if article_json_exists(timestamp):
        print(f"Trafilatura articles for {timestamp} already exist – skipping.")
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            f.write("timestamp=skip\n")
        return

    urls = json.loads(urls_json)
    if not isinstance(urls, list) or not urls:
        print("Error: URLS is not a valid list")
        sys.exit(1)

    print(f"Trafilatura extraction for chunk {timestamp} – {len(urls)} URLs")

    # Setup HTTP session with realistic headers
    session = requests.Session()
    session.max_redirects = 5
    session.headers.update({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
    })

    MAX_WORKERS = 8
    results: dict[str, dict] = {}   # url -> full trafilatura JSON object
    processed = 0
    start_time = time.time()

    def fetch_and_parse(url: str) -> tuple[str, str | None]:
        """Fetch HTML and extract using trafilatura with chosen parameters."""
        try:
            resp = session.get(url, timeout=15)
            resp.raise_for_status()
            html = resp.text
        except TooManyRedirects:
            print(f"🚫 Redirect loop: {url}")
            return url, None
        except Exception as e:
            print(f"❌ Network error for {url}: {e}")
            return url, None

        # Extract with trafilatura
        try:
            extracted_json = trafilatura.extract(
                html,
                include_images=True,
                include_tables=True,
                include_formatting=True,
                include_links=False,
                with_metadata=True,
                output_format="json",
            )
            if extracted_json:
                return url, extracted_json
            else:
                print(f"⚠️ No extractable content for {url}")
                return url, None
        except Exception as e:
            print(f"❌ Extraction error for {url}: {e}")
            return url, None

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        future_to_url = {executor.submit(fetch_and_parse, url): url for url in urls}
        for future in as_completed(future_to_url):
            url = future_to_url[future]
            processed += 1
            if processed % 10 == 0:
                print(f"Processed {processed}/{len(urls)} articles so far…")

            try:
                returned_url, extracted = future.result()
                if extracted:
                    # Convert JSON string to dict for storage
                    results[returned_url] = json.loads(extracted)
                    short = url[:80] + "…" if len(url) > 80 else url
                    print(f"✅ [{processed}] Extracted: {short}")
            except Exception as e:
                print(f"❌ [{processed}] Unhandled error for {url}: {e}")

    output_path = f"articles/trafilatura_{timestamp}.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    elapsed = time.time() - start_time
    print(f"✅ Saved {len(results)} Trafilatura articles ({processed} attempted) in {elapsed:.1f}s → {output_path}")

    with open(os.environ["GITHUB_OUTPUT"], "a") as f:
        f.write(f"timestamp={timestamp}\n")


if __name__ == "__main__":
    main()
