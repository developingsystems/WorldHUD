#!/usr/bin/env python3
"""Fundus article extraction for WorldHUD – Parser‑based approach.

- Uses the official supported_publishers.md file for domain discovery.
- Filters GDELT URLs to only those from Fundus‑supported domains.
- Fetches HTML in parallel and extracts text with per‑publisher Parsers.
- Handles redirect loops, timeouts, and other errors gracefully.
"""

import os
import json
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse
from collections import defaultdict

import requests
from requests.exceptions import TooManyRedirects

from fundus import PublisherCollection, Parser

# URL of the official Fundus supported‑publishers list
SUPPORTED_PUBLISHERS_URL = (
    "https://raw.githubusercontent.com/flairNLP/fundus/main/docs/"
    "supported_publishers.md"
)


# ---------------------------------------------------------------------------
# Build a domain → Publisher mapping from the official markdown file
# ---------------------------------------------------------------------------
def build_publisher_map() -> dict[str, object]:
    """Download the supported_publishers.md file and return a dict mapping
    each supported domain string to its corresponding Fundus Publisher object."""

    resp = requests.get(SUPPORTED_PUBLISHERS_URL, timeout=15)
    resp.raise_for_status()
    lines = resp.text.splitlines()

    # The markdown file organises publishers by region.
    # We'll parse lines like:
    #   - **Publisher Name** (domain1.com, domain2.org)
    mapping = {}
    current_region = None

    for line in lines:
        line = line.strip()
        if line.startswith("## "):
            # Region heading, e.g. "## US"
            current_region = line[3:].strip().lower()
        elif line.startswith("- **") and current_region:
            # Publisher line: "- **The New Yorker** (newyorker.com)"
            try:
                # Extract name and domains
                name_part = line[4:]  # remove "- **"
                name_end = name_part.index("**")
                pub_name = name_part[:name_end]
                # Everything after the name is the domain list in parentheses
                rest = name_part[name_end + 2:].strip()
                if rest.startswith("(") and rest.endswith(")"):
                    domains_str = rest[1:-1]  # remove parentheses
                    domains = [d.strip() for d in domains_str.split(",") if d.strip()]

                    # Find the actual Publisher object from PublisherCollection
                    regional = getattr(PublisherCollection, current_region, None)
                    if regional is not None:
                        for publisher in regional:
                            if publisher.name.lower() == pub_name.lower():
                                for domain in domains:
                                    mapping[domain] = publisher
                                break
            except (ValueError, IndexError):
                continue

    print(f"  Built publisher map with {len(mapping)} domain entries")
    return mapping


# ---------------------------------------------------------------------------
# Helper: filter URLs to supported domains
# ---------------------------------------------------------------------------
def filter_urls(urls: list[str], supported: dict[str, object]) -> list[str]:
    return [url for url in urls if urlparse(url).netloc in supported]


# ---------------------------------------------------------------------------
# Duplicate guard
# ---------------------------------------------------------------------------
def article_json_exists(timestamp: str, prefix: str = "fundus_") -> bool:
    url = f"https://github.com/developingsystems/WorldHUD/releases/download/gdelt-articles/{prefix}{timestamp}.json"
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

    # Build publisher map from the official markdown file
    supported_publishers = build_publisher_map()
    filtered = filter_urls(urls, supported_publishers)
    print(f"  Filtered down to {len(filtered)} supported URLs")

    # Shared HTTP session for connection pooling
    session = requests.Session()
    session.max_redirects = 5

    MAX_WORKERS = 8
    articles: dict[str, str] = {}
    processed = 0
    start = time.time()

    def fetch_and_parse(url: str) -> tuple[str, str | None]:
        domain = urlparse(url).netloc
        pub = supported_publishers.get(domain)
        if pub is None:
            return url, None

        try:
            resp = session.get(url, timeout=15)
            resp.raise_for_status()
        except TooManyRedirects:
            print(f"  🚫 Redirect loop: {url}")
            return url, None
        except Exception as e:
            print(f"  ❌ Network error for {url}: {e}")
            return url, None

        parser = Parser(pub)
        try:
            article = parser.parse(resp.text, url)
            if article.body and article.body.text:
                return url, article.body.text
            else:
                reasons = []
                if not article.body:
                    reasons.append("no body")
                elif not article.body.text:
                    reasons.append("no extractable text")
                print(f"  ⚠️ Extraction failed for {url}: {', '.join(reasons)}")
                return url, None
        except Exception as e:
            print(f"  ❌ Parsing error for {url}: {e}")
            return url, None

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        future_to_url = {executor.submit(fetch_and_parse, url): url for url in filtered}
        for future in as_completed(future_to_url):
            url = future_to_url[future]
            processed += 1
            try:
                returned_url, text = future.result()
                if text:
                    articles[returned_url] = text
                    short = url[:80] + "…" if len(url) > 80 else url
                    print(f"  ✅ [{processed}] Extracted: {short}")
            except Exception as e:
                print(f"  ❌ Unhandled error for {url}: {e}")

    os.makedirs("articles", exist_ok=True)
    output_path = f"articles/fundus_{timestamp}.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(articles, f, ensure_ascii=False, indent=2)

    elapsed = time.time() - start
    print(f"  ✅ Saved {len(articles)} Fundus articles ({processed} crawled) in {elapsed:.1f}s → {output_path}")

    with open(os.environ["GITHUB_OUTPUT"], "a") as f:
        f.write(f"timestamp={timestamp}\n")


if __name__ == "__main__":
    main()
