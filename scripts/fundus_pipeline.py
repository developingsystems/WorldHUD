#!/usr/bin/env python3
"""Fundus article extraction for WorldHUD – Final direct parser pipeline.

- Builds domain → publisher map from the HTML table.
- Filters URLs to supported domains.
- Fetches HTML in parallel.
- Uses publisher.parser to get the correct parser class.
- Handles both Article object and dict return types.
- Debug prints to trace execution.
"""

import os
import json
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup
from requests.exceptions import TooManyRedirects

from fundus import PublisherCollection

# ---------------------------------------------------------------------------
# Build domain → publisher map
# ---------------------------------------------------------------------------
def build_domain_publisher_map() -> dict[str, object]:
    """Parse the supported_publishers.md HTML table and return domain -> Publisher."""
    url = "https://raw.githubusercontent.com/flairNLP/fundus/refs/heads/master/docs/supported_publishers.md"
    try:
        resp = requests.get(url, timeout=15)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")
    except Exception as e:
        print(f"Error fetching publisher list: {e}")
        return {}

    domain_to_pub = {}
    tables = soup.find_all("table")
    for table in tables:
        # Determine country code from table class (e.g., 'at', 'us')
        country_code = None
        for cls in table.get('class', []):
            if cls in ['at', 'au', 'be', 'ca', 'ch', 'cn', 'cz', 'de', 'dk', 'es', 'fr',
                       'gl', 'id', 'il', 'ind', 'isl', 'it', 'jp', 'kr', 'lb', 'li', 'ls',
                       'lt', 'lu', 'mx', 'my', 'na', 'no', 'pl', 'pt', 'py', 'ru', 'se',
                       'tr', 'tw', 'tz', 'ua', 'uk', 'us', 'vn', 'za']:
                country_code = cls
                break
        if not country_code:
            continue
        country_group = getattr(PublisherCollection, country_code, None)
        if not country_group:
            continue

        for row in table.find_all("tr"):
            cells = row.find_all("td")
            if len(cells) < 3:
                continue
            code_tag = cells[0].find("code")
            if not code_tag:
                continue
            class_name = code_tag.get_text(strip=True)
            a_tag = cells[2].find("a")
            if not a_tag:
                continue
            href = a_tag.get("href", "")
            if not href.startswith("https://"):
                continue
            domain = href.split("//")[1].split("/")[0].lower()
            if domain.startswith("www."):
                domain = domain[4:]

            # Get the Publisher object from the country group by class name
            try:
                publisher = getattr(country_group, class_name)
            except AttributeError:
                # Fallback: iterate over the group
                publisher = None
                for pub in country_group:
                    if pub.__name__ == class_name:
                        publisher = pub
                        break
            if publisher:
                domain_to_pub[domain] = publisher

    print(f"Built domain → publisher map with {len(domain_to_pub)} entries")
    return domain_to_pub


# ---------------------------------------------------------------------------
# Duplicate guard – check if output already exists in GitHub release
# ---------------------------------------------------------------------------
def article_json_exists(timestamp: str) -> bool:
    url = f"https://github.com/developingsystems/WorldHUD/releases/download/gdelt-articles/fundus_{timestamp}.json"
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
        print(f"Fundus articles for {timestamp} already exist – skipping.")
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            f.write("timestamp=skip\n")
        return

    urls = json.loads(urls_json)
    if not isinstance(urls, list) or not urls:
        print("Error: URLS is not a valid list")
        sys.exit(1)

    print(f"Fundus extraction for chunk {timestamp} – {len(urls)} URLs")

    domain_to_pub = build_domain_publisher_map()

    supported = []
    for url in urls:
        domain = urlparse(url).netloc.lower()
        if domain.startswith("www."):
            domain = domain[4:]
        pub = domain_to_pub.get(domain)
        if pub:
            supported.append((url, pub))

    print(f"Filtered down to {len(supported)} supported URLs")
    if not supported:
        output_path = f"articles/fundus_{timestamp}.json"
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump({}, f, ensure_ascii=False, indent=2)
        print(f"✅ Saved 0 Fundus articles → {output_path}")
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            f.write(f"timestamp={timestamp}\n")
        return

    # Debug: show first supported item
    print(f"DEBUG: First supported URL: {supported[0][0][:80]}... Publisher: {supported[0][1]}")

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
    articles: dict[str, str] = {}
    processed = 0
    start_time = time.time()

def fetch_and_parse(url: str, publisher) -> tuple[str, str | None]:
    print(f"Fetching: {url[:80]}...")
    try:
        resp = session.get(url, timeout=15)
        resp.raise_for_status()
        html = resp.text
    except Exception as e:
        print(f"❌ Network error for {url}: {e}")
        return url, None

    try:
        parser_class = publisher.parser
        parser = parser_class()
        result = parser.parse(html, url)

        # Handle object with .body
        if hasattr(result, 'body') and result.body and result.body.text:
            return url, result.body.text

        # Handle dictionary
        if isinstance(result, dict):
            # First, try to get the 'body' field
            body = result.get('body')
            if body is not None:
                # If body is a string, use it directly
                if isinstance(body, str):
                    text = body.strip()
                    if text:
                        return url, text
                # If body is a dict, look for common text keys
                elif isinstance(body, dict):
                    text = body.get('text') or body.get('content') or body.get('articleBody') or body.get('html')
                    if text and isinstance(text, str) and len(text) > 50:
                        return url, text
                    # Fallback: take the first long string value from the body dict
                    for val in body.values():
                        if isinstance(val, str) and len(val) > 100:
                            return url, val
            # Fallback: search other top-level keys
            for key in ['text', 'content', 'articleBody']:
                if key in result and isinstance(result[key], str) and len(result[key]) > 100:
                    return url, result[key]

            # If all else fails, print a diagnostic and return None
            print(f"⚠️ Could not extract text from dict for {url}. Top-level keys: {list(result.keys())}")
            if 'body' in result:
                print(f"   'body' type: {type(result['body'])}")
                if isinstance(result['body'], dict):
                    print(f"   'body' keys: {list(result['body'].keys())}")
            return url, None
        else:
            print(f"⚠️ No extractable text for {url}")
            return url, None
    except Exception as e:
        print(f"❌ Parsing error for {url}: {e}")
        return url, None

    print("DEBUG: Starting ThreadPoolExecutor...")
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        future_to_url = {executor.submit(fetch_and_parse, url, pub): url for url, pub in supported}
        for future in as_completed(future_to_url):
            url = future_to_url[future]
            processed += 1
            if processed % 10 == 0:
                print(f"Processed {processed}/{len(supported)} articles so far…")
            try:
                returned_url, text = future.result()
                if text:
                    articles[returned_url] = text
                    short = url[:80] + "…" if len(url) > 80 else url
                    print(f"✅ [{processed}] Extracted: {short}")
            except Exception as e:
                print(f"❌ [{processed}] Unhandled error for {url}: {e}")

    output_path = f"articles/fundus_{timestamp}.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(articles, f, ensure_ascii=False, indent=2)

    elapsed = time.time() - start_time
    print(f"✅ Saved {len(articles)} Fundus articles ({processed} attempted) in {elapsed:.1f}s → {output_path}")

    with open(os.environ["GITHUB_OUTPUT"], "a") as f:
        f.write(f"timestamp={timestamp}\n")


if __name__ == "__main__":
    main()
