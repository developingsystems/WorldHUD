#!/usr/bin/env python3
"""Fundus article extraction for WorldHUD – Hybrid robust pipeline.

- Builds a domain → Publisher map by iterating over the PublisherCollection.
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
# Helper: Build domain → Publisher map by iterating PublisherCollection
# ---------------------------------------------------------------------------
def build_domain_to_publisher_map() -> dict[str, object]:
    domain_to_publisher = {}
    for country_code in dir(PublisherCollection):
        if country_code.startswith("_"):
            continue
        country_group = getattr(PublisherCollection, country_code)
        # Ensure we're working with a list of publishers
        if not hasattr(country_group, "__iter__"):
            country_group = [country_group]
        for publisher in country_group:
            # The domain list is stored in the publisher's _source.domains
            if hasattr(publisher, "_source") and hasattr(publisher._source, "domains"):
                for domain in publisher._source.domains:
                    clean_domain = domain.lower()
                    if clean_domain.startswith("www."):
                        clean_domain = clean_domain[4:]
                    domain_to_publisher[clean_domain] = publisher
    print(f"  Built domain→publisher map with {len(domain_to_publisher)} entries")
    return domain_to_publisher


# ---------------------------------------------------------------------------
# Helper: Duplicate guard – check if output file already exists in GitHub release
# ---------------------------------------------------------------------------
def article_json_exists(timestamp: str, prefix: str = "fundus_") -> bool:
    """Return True if the output file already exists in the GitHub release."""
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

    # Skip if this chunk has already been processed
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

    # ---------- 1. Build the domain → publisher map ----------
    domain_to_publisher = build_domain_to_publisher_map()

    # ---------- 2. Filter URLs by supported domains ----------
    supported_urls = []
    for url in urls:
        domain = urlparse(url).netloc.lower()
        if domain.startswith("www."):
            domain = domain[4:]
        if domain in domain_to_publisher:
            supported_urls.append(url)
        else:
            print(f"  Skipping unsupported domain: {domain} ({url[:80]}...)")

    print(f"  Filtered down to {len(supported_urls)} supported URLs")
    if not supported_urls:
        # No supported URLs – exit gracefully
        os.makedirs("articles", exist_ok=True)
        output_path = f"articles/fundus_{timestamp}.json"
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump({}, f, ensure_ascii=False, indent=2)
        print(f"  ✅ Saved 0 Fundus articles → {output_path}")
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            f.write(f"timestamp={timestamp}\n")
        return

    # ---------- 3. Prepare for parallel fetching ----------
    session = requests.Session()
    session.max_redirects = 5

    MAX_WORKERS = 8
    articles: dict[str, str] = {}
    processed = 0
    start_time = time.time()

    def fetch_and_parse(url: str) -> tuple[str, str | None]:
        """Fetch the HTML of a URL and extract its article text."""
        # Get the domain and its corresponding Publisher
        domain = urlparse(url).netloc.lower()
        if domain.startswith("www."):
            domain = domain[4:]

        publisher = domain_to_publisher.get(domain)
        if publisher is None:
            return url, None  # Should not happen after filtering

        try:
            resp = session.get(url, timeout=15)
            resp.raise_for_status()
        except TooManyRedirects:
            print(f"  🚫 Redirect loop: {url}")
            return url, None
        except Exception as e:
            print(f"  ❌ Network error for {url}: {e}")
            return url, None

        # Create a parser for the specific publisher
        parser = ParserProxy(publisher)
        try:
            article = parser.parse(resp.text, url)
            if article.body and article.body.text:
                return url, article.body.text
            else:
                # Provide a reason why extraction failed
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

    # ---------- 4. Process URLs concurrently ----------
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        future_to_url = {executor.submit(fetch_and_parse, url): url for url in supported_urls}
        for future in as_completed(future_to_url):
            url = future_to_url[future]
            processed += 1
            if processed % 10 == 0:
                print(f"  Processed {processed}/{len(supported_urls)} articles so far…")

            try:
                returned_url, text = future.result()
                if text:
                    articles[returned_url] = text
                    short = url[:80] + "…" if len(url) > 80 else url
                    print(f"  ✅ [{processed}] Extracted: {short}")
                else:
                    print(f"  ⚠️ [{processed}] No text extracted: {url}")
            except Exception as e:
                print(f"  ❌ [{processed}] Unhandled error for {url}: {e}")

    # ---------- 5. Save results ----------
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
    main()
