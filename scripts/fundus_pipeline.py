#!/usr/bin/env python3
"""Fundus article extraction for WorldHUD – Parser-based pipeline.

- Downloads the official supported_publishers.md file at runtime.
- Filters GDELT URLs to only those from Fundus‑supported domains.
- Fetches HTML in parallel and extracts text with per‑publisher Parsers.
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
# Build a set of supported domains from the official markdown file
# ---------------------------------------------------------------------------
def build_domain_set() -> set[str]:
    """Download supported_publishers.md and return a set of all supported domains."""
    url = "https://raw.githubusercontent.com/flairNLP/fundus/master/docs/supported_publishers.md"
    try:
        resp = requests.get(url, timeout=15)
        resp.raise_for_status()
    except Exception as e:
        print(f"  ❌ Failed to fetch supported_publishers.md: {e}")
        raise

    domain_set = set()
    lines = resp.text.splitlines()
    in_code_block = False

    for line in lines:
        # Skip code blocks
        if line.startswith("```"):
            in_code_block = not in_code_block
            continue
        if in_code_block:
            continue

        # Look for lines that contain a URL pattern
        # The markdown file uses a specific format for example URLs
        # We need to extract the domain from these patterns
        if "http://" in line or "https://" in line:
            # Extract domain using simple regex-like approach
            # Find the part between https:// and the next /
            parts = line.split("https://")
            if len(parts) > 1:
                domain_part = parts[1].split("/")[0]
                if domain_part and not domain_part.startswith("www."):
                    domain_set.add(domain_part)
            parts = line.split("http://")
            if len(parts) > 1:
                domain_part = parts[1].split("/")[0]
                if domain_part and not domain_part.startswith("www."):
                    domain_set.add(domain_part)

    # Debug: print a few domains to verify
    sample_domains = list(domain_set)[:10]
    print(f"  Built domain set with {len(domain_set)} entries")
    if sample_domains:
        print(f"  Sample domains: {', '.join(sample_domains)}")
    else:
        print("  ⚠️ No domains found – check markdown parsing logic")
    return domain_set


# ---------------------------------------------------------------------------
# Helper: filter URLs to supported domains
# ---------------------------------------------------------------------------
def filter_urls(urls: list[str], domain_set: set[str]) -> list[str]:
    """Return URLs whose domain (without 'www.') is present in the supported domain set."""
    filtered = []
    for url in urls:
        parsed = urlparse(url)
        domain = parsed.netloc.lower()
        # Remove common 'www.' prefix for consistent comparison
        if domain.startswith("www."):
            domain = domain[4:]
        if domain in domain_set:
            filtered.append(url)
        else:
            print(f"  Skipping unsupported domain: {domain} ({url[:80]}...)")
    return filtered


# ---------------------------------------------------------------------------
# Duplicate guard
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

    # Check if we've already processed this chunk
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

    # Build the set of supported domains from the official markdown file
    try:
        domain_set = build_domain_set()
    except Exception as e:
        print(f"Failed to build domain set: {e}")
        sys.exit(1)

    # Filter the GDELT URLs to only those from supported domains
    filtered = filter_urls(urls, domain_set)
    print(f"  Filtered down to {len(filtered)} supported URLs")

    if not filtered:
        print("  No supported URLs found – nothing to extract")
        # Save empty result and exit gracefully
        os.makedirs("articles", exist_ok=True)
        output_path = f"articles/fundus_{timestamp}.json"
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump({}, f, ensure_ascii=False, indent=2)
        print(f"  ✅ Saved 0 Fundus articles → {output_path}")
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            f.write(f"timestamp={timestamp}\n")
        return

    # Shared HTTP session for connection pooling
    session = requests.Session()
    session.max_redirects = 5

    MAX_WORKERS = 8
    articles: dict[str, str] = {}
    processed = 0
    start = time.time()

    def fetch_and_parse(url: str) -> tuple[str, str | None]:
        """Fetch the HTML of a URL and extract its article text."""
        domain = urlparse(url).netloc.lower()
        if domain.startswith("www."):
            domain = domain[4:]

        # For the ParserProxy we don't need the specific publisher object;
        # the library will automatically detect the correct parser based on the URL.
        # However, we still need to pass a Publisher object.
        # To keep things simple, we can use any publisher from the collection,
        # but the safest is to let Fundus determine it automatically.
        # The ParserProxy requires a Publisher object, but it will be overridden by the URL.
        # We'll just pass the first publisher from the US collection as a placeholder.
        try:
            # Get a valid Publisher object – any will work because the URL determines the parser
            pub = PublisherCollection.us[0]
        except (IndexError, AttributeError):
            # Fallback in case the US collection is empty
            for country in dir(PublisherCollection):
                if not country.startswith("_") and hasattr(PublisherCollection, country):
                    region = getattr(PublisherCollection, country)
                    if isinstance(region, list) and region:
                        pub = region[0]
                        break
            else:
                print(f"  ❌ No valid Publisher found for {url}")
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

        parser = ParserProxy(pub)
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

    # Save results (even if some articles failed)
    os.makedirs("articles", exist_ok=True)
    output_path = f"articles/fundus_{timestamp}.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(articles, f, ensure_ascii=False, indent=2)

    elapsed = time.time() - start
    print(f"  ✅ Saved {len(articles)} Fundus articles ({processed} crawled) in {elapsed:.1f}s → {output_path}")

    # Write GitHub output
    with open(os.environ["GITHUB_OUTPUT"], "a") as f:
        f.write(f"timestamp={timestamp}\n")


if __name__ == "__main__":
    main()
