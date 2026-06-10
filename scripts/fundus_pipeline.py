#!/usr/bin/env python3
"""Fundus article extraction for WorldHUD – Parser-based pipeline.

- Uses the official supported_publishers.md file to build a domain → publisher map.
- Filters GDELT URLs to only those from Fundus-supported domains.
- Fetches HTML in parallel and extracts text with per-publisher Parsers.
- Handles redirect loops, timeouts, and other errors gracefully.
- Saves partial results even if some URLs fail.
"""

import os
import json
import sys
import time
import re
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse

import requests
from requests.exceptions import TooManyRedirects

from fundus import PublisherCollection
from fundus.parser import ParserProxy


# ---------------------------------------------------------------------------
# Build a domain → publisher map from the official supported_publishers.md
# ---------------------------------------------------------------------------
def build_domain_to_publisher_map() -> dict[str, object]:
    """
    Fetches the official supported_publishers.md file and parses it to build
    a mapping from domain (e.g. 'nytimes.com') to its Fundus Publisher object.
    """
    print("  Fetching the official list of supported publishers...")
    url = "https://raw.githubusercontent.com/flairNLP/fundus/master/docs/supported_publishers.md"
    try:
        response = requests.get(url, timeout=15)
        response.raise_for_status()
        content = response.text
    except Exception as e:
        print(f"  Error fetching publisher list: {e}")
        return {}

    # Regular expression to extract the class name and the domain(s)
    # Pattern 1: Finds lines like:
    #   `ClassName`
    #   Name
    #   【1† domain.com †domain.com】
    # We'll capture: class_name, domain1, domain2 (optional)
    domain_to_publisher = {}

    # Split content into blocks separated by blank lines to group each publisher
    blocks = re.split(r'\n\s*\n', content)
    current_class = None

    for block in blocks:
        lines = block.strip().splitlines()
        if not lines:
            continue

        # Look for a line that starts and ends with backticks (the class name)
        # This is the line with the publisher's class name
        class_match = None
        for line in lines:
            line = line.strip()
            if line.startswith('`') and line.endswith('`'):
                # This is the class name line
                class_match = line[1:-1]  # remove backticks
                break

        if class_match:
            current_class = class_match
        elif current_class:
            # This block belongs to the current class
            # Find domain(s) in this block
            # Pattern for the domain line: 【数字† domain †domain】
            domain_pattern = r'【\d+†\s*([^\s†]+)\s*†\s*([^\s†]+)】'
            for line in lines:
                match = re.search(domain_pattern, line)
                if match:
                    # The first capture group is the domain (usually without www)
                    # The second is the same domain (with or without www)
                    domain = match.group(1).strip()
                    clean_domain = domain.lower()
                    if clean_domain.startswith('www.'):
                        clean_domain = clean_domain[4:]

                    # Find the Publisher object for this class name
                    publisher = _get_publisher_by_class_name(current_class)
                    if publisher:
                        domain_to_publisher[clean_domain] = publisher
                        # Also add the domain with www if it's not already there
                        # (helps with matching URLs that have www)
                        if domain != clean_domain:
                            domain_to_publisher[domain] = publisher
                    break  # Assume only one domain per publisher (most have one)

    print(f"  Built domain→publisher map with {len(domain_to_publisher)} entries")
    sample = list(domain_to_publisher.keys())[:10]
    if sample:
        print(f"  Sample domains: {', '.join(sample)}")
    else:
        print("  [Diagnostic] Domain map is empty. Check if the markdown file format has changed.")
    return domain_to_publisher


def _get_publisher_by_class_name(class_name: str) -> object | None:
    """
    Given a publisher class name (e.g., 'TheNewYorker'), find and return the
    corresponding Publisher object from PublisherCollection.
    """
    # Iterate through all country groups in PublisherCollection
    for country_code in dir(PublisherCollection):
        if country_code.startswith('_'):
            continue
        try:
            country_group = getattr(PublisherCollection, country_code)
        except Exception:
            continue

        # Determine if this is a list of publishers or a single publisher
        if isinstance(country_group, list):
            publishers = country_group
        else:
            publishers = [country_group]

        # Search for the publisher by its class name
        for publisher in publishers:
            if publisher.__name__ == class_name:
                return publisher
    return None


# ---------------------------------------------------------------------------
# Duplicate guard – check if output file already exists in GitHub release
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

    # Build the domain → publisher map
    domain_to_publisher = build_domain_to_publisher_map()

    # Filter URLs by supported domains
    supported_urls = []
    for url in urls:
        domain = urlparse(url).netloc.lower()
        if domain.startswith("www."):
            domain = domain[4:]
        if domain in domain_to_publisher:
            supported_urls.append(url)
        # Unsupported domains are silently skipped (no log noise)

    print(f"  Filtered down to {len(supported_urls)} supported URLs")
    if not supported_urls:
        # Exit gracefully if no URLs are supported
        os.makedirs("articles", exist_ok=True)
        output_path = f"articles/fundus_{timestamp}.json"
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump({}, f, ensure_ascii=False, indent=2)
        print(f"  ✅ Saved 0 Fundus articles → {output_path}")
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            f.write(f"timestamp={timestamp}\n")
        return

    # Setup for parallel fetching
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

        # Create a parser for the specific publisher and parse the article
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

    # Process URLs in parallel
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
                # else: already logged inside fetch_and_parse
            except Exception as e:
                print(f"  ❌ [{processed}] Unhandled error for {url}: {e}")

    # Save results
    os.makedirs("articles", exist_ok=True)
    output_path = f"articles/fundus_{timestamp}.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(articles, f, ensure_ascii=False, indent=2)

    elapsed = time.time() - start_time
    print(f"  ✅ Saved {len(articles)} Fundus articles ({processed} attempted) in {elapsed:.1f}s → {output_path}")

    # GitHub Actions output
    with open(os.environ["GITHUB_OUTPUT"], "a") as f:
        f.write(f"timestamp={timestamp}\n")


if __name__ == "__main__":
    main()
