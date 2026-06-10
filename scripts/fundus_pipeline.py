#!/usr/bin/env python3
"""Fundus article extraction for WorldHUD – Final pipeline.

- Parses the raw HTML table to build a domain→publisher map.
- Filters GDELT URLs by domain lookup.
- Fetches HTML in parallel with realistic browser headers.
- Extracts text using ParserProxy (auto‑detects publisher from URL).
- Handles errors and saves partial results.
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

# Import Fundus – this loads all publishers and parsers automatically
import fundus
from fundus import PublisherCollection
from fundus.parser import ParserProxy


# ---------------------------------------------------------------------------
# Build a domain → publisher map from the raw HTML file
# ---------------------------------------------------------------------------
def build_domain_to_publisher_map() -> dict[str, object]:
    url = "https://raw.githubusercontent.com/flairNLP/fundus/refs/heads/master/docs/supported_publishers.md"
    try:
        response = requests.get(url, timeout=15)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, "html.parser")
    except Exception as e:
        print(f"Error fetching publisher list: {e}")
        return {}

    def get_publisher_by_class_name(country_group, class_name):
        try:
            return getattr(country_group, class_name)
        except AttributeError:
            if isinstance(country_group, list):
                for pub in country_group:
                    if pub.__name__ == class_name:
                        return pub
            return None

    domain_to_publisher = {}
    tables = soup.find_all("table")
    for table in tables:
        # Extract country code from table class (e.g., 'at', 'us')
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
            publisher = get_publisher_by_class_name(country_group, class_name)
            if publisher:
                domain_to_publisher[domain] = publisher

    print(f"Built domain→publisher map with {len(domain_to_publisher)} entries")
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

    print(f"Filtered down to {len(supported_urls)} supported URLs")
    if not supported_urls:
        os.makedirs("articles", exist_ok=True)
        output_path = f"articles/fundus_{timestamp}.json"
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump({}, f, ensure_ascii=False, indent=2)
        print(f"✅ Saved 0 Fundus articles → {output_path}")
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            f.write(f"timestamp={timestamp}\n")
        return

    # Setup session with realistic browser headers
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

    def fetch_and_parse(url: str) -> tuple[str, str | None]:
        try:
            resp = session.get(url, timeout=15)
            resp.raise_for_status()
        except TooManyRedirects:
            print(f"🚫 Redirect loop: {url}")
            return url, None
        except Exception as e:
            print(f"❌ Network error for {url}: {e}")
            return url, None

        # ParserProxy auto‑detects the publisher from the URL
        parser = ParserProxy()
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
                print(f"⚠️ Extraction failed for {url}: {', '.join(reasons)}")
                return url, None
        except Exception as e:
            print(f"❌ Parsing error for {url}: {e}")
            return url, None

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        future_to_url = {executor.submit(fetch_and_parse, url): url for url in supported_urls}
        for future in as_completed(future_to_url):
            url = future_to_url[future]
            processed += 1
            if processed % 10 == 0:
                print(f"Processed {processed}/{len(supported_urls)} articles so far…")

            try:
                returned_url, text = future.result()
                if text:
                    articles[returned_url] = text
                    short = url[:80] + "…" if len(url) > 80 else url
                    print(f"✅ [{processed}] Extracted: {short}")
            except Exception as e:
                print(f"❌ [{processed}] Unhandled error for {url}: {e}")

    os.makedirs("articles", exist_ok=True)
    output_path = f"articles/fundus_{timestamp}.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(articles, f, ensure_ascii=False, indent=2)

    elapsed = time.time() - start_time
    print(f"✅ Saved {len(articles)} Fundus articles ({processed} attempted) in {elapsed:.1f}s → {output_path}")

    with open(os.environ["GITHUB_OUTPUT"], "a") as f:
        f.write(f"timestamp={timestamp}\n")


if __name__ == "__main__":
    main()
