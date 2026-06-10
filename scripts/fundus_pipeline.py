#!/usr/bin/env python3
"""Fundus article extraction for WorldHUD – Final robust pipeline.

- Builds domain → Publisher map directly from PublisherCollection (using .domains).
- Filters GDELT URLs by domain lookup (O(1) per URL).
- Fetches HTML in parallel with a shared session.
- Uses ParserProxy with the correct Publisher for each URL.
- Handles redirect loops, timeouts, and other errors gracefully.
- Saves partial results even if some URLs fail.
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

from fundus import PublisherCollection
from fundus.parser import ParserProxy


# ---------------------------------------------------------------------------
# Build a domain → Publisher mapping directly from Fundus
# ---------------------------------------------------------------------------
def build_domain_to_publisher_map() -> dict[str, object]:
    """Return a dict mapping a domain (e.g. 'nytimes.com') to its Fundus Publisher object."""
    domain_to_publisher = {}
    for attr_name in dir(PublisherCollection):
        if attr_name.startswith("_"):
            continue
        group = getattr(PublisherCollection, attr_name)
        publishers = group if isinstance(group, list) else [group]
        for publisher in publishers:
            # Use _domains, not domains
            for domain in getattr(publisher, "_domains", []):
                clean_domain = domain.lower()
                if clean_domain.startswith("www."):
                    clean_domain = clean_domain[4:]
                domain_to_publisher[clean_domain] = publisher

    print(f"  Built domain→publisher map with {len(domain_to_publisher)} entries")
    sample = list(domain_to_publisher.keys())[:10]
    if sample:
        print(f"  Sample domains: {', '.join(sample)}")
    return domain_to_publisher


# ---------------------------------------------------------------------------
# Duplicate guard – check if output file already exists in GitHub release
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

    # Skip if already processed this chunk
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

    # Build the domain → Publisher map once
    domain_to_publisher = build_domain_to_publisher_map()

    # Shared HTTP session for connection pooling
    session = requests.Session()
    session.max_redirects = 5

    MAX_WORKERS = 8
    articles: dict[str, str] = {}
    processed = 0
    start_time = time.time()

    def fetch_and_parse(url: str) -> tuple[str, str | None]:
        """Fetch HTML and extract article text for a single URL."""
        # Normalise domain
        domain = urlparse(url).netloc.lower()
        if domain.startswith("www."):
            domain = domain[4:]

        publisher = domain_to_publisher.get(domain)
        if publisher is None:
            # This should not happen if we pre-filter, but just in case
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

        parser = ParserProxy(publisher)
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

    # Submit all URLs to the thread pool
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        future_to_url = {executor.submit(fetch_and_parse, url): url for url in urls}
        for future in as_completed(future_to_url):
            url = future_to_url[future]
            processed += 1
            if processed % 10 == 0:
                print(f"  Processed {processed}/{len(urls)} articles so far…")

            try:
                returned_url, text = future.result()
                if text:
                    articles[returned_url] = text
                    short = url[:80] + "…" if len(url) > 80 else url
                    print(f"  ✅ [{processed}] Extracted: {short}")
            except Exception as e:
                print(f"  ❌ Unhandled error for {url}: {e}")

    # Save results (even if some URLs failed)
    os.makedirs("articles", exist_ok=True)
    output_path = f"articles/fundus_{timestamp}.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(articles, f, ensure_ascii=False, indent=2)

    elapsed = time.time() - start_time
    print(f"  ✅ Saved {len(articles)} Fundus articles ({processed} attempted) in {elapsed:.1f}s → {output_path}")

    # Write GitHub Actions output
    with open(os.environ["GITHUB_OUTPUT"], "a") as f:
        f.write(f"timestamp={timestamp}\n")


if __name__ == "__main__":
    # --- TEST BLOCK (remove after verification) ---
    from fundus import PublisherCollection
    from fundus.parser import ParserProxy

    pub = PublisherCollection.us[0]
    print(f"Testing with: {pub}")
    print(f"Domains: {pub._domains}")
    print(f"All attributes: {dir(pub)}")
    print("--- End of test ---")
    # --- END TEST BLOCK ---

    main()
