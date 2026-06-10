#!/usr/bin/env python3
"""Fundus article extraction for WorldHUD – Direct publisher parser pipeline.

- Parses the raw HTML table to build domain → (publisher, country, class_name).
- Dynamically imports the correct parser class for each domain.
- Fetches HTML in parallel and extracts text using that parser.
- Handles errors and saves partial results.
"""

import os
import json
import sys
import time
import importlib
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup
from requests.exceptions import TooManyRedirects

from fundus import PublisherCollection


# ---------------------------------------------------------------------------
# Build a domain → (publisher, country_code, class_name) map
# ---------------------------------------------------------------------------
def build_domain_info_map() -> dict[str, tuple[object, str, str]]:
    """Parse HTML table and return dict: domain -> (Publisher, country_code, class_name)."""
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

    domain_info = {}
    tables = soup.find_all("table")
    for table in tables:
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
                domain_info[domain] = (publisher, country_code, class_name)

    print(f"Built domain info map with {len(domain_info)} entries")
    return domain_info


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
    os.makedirs("articles", exist_ok=True)

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

    domain_info = build_domain_info_map()

    # Filter and prepare list of (url, country_code, class_name, publisher)
    supported = []
    for url in urls:
        domain = urlparse(url).netloc.lower()
        if domain.startswith("www."):
            domain = domain[4:]
        if domain in domain_info:
            publisher, country_code, class_name = domain_info[domain]
            supported.append((url, country_code, class_name, publisher))

    print(f"Filtered down to {len(supported)} supported URLs")
    if not supported:
        output_path = f"articles/fundus_{timestamp}.json"
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump({}, f, ensure_ascii=False, indent=2)
        print(f"✅ Saved 0 Fundus articles → {output_path}")
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            f.write(f"timestamp={timestamp}\n")
        return

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

def fetch_and_parse(url: str, country_code: str, class_name: str, publisher) -> tuple[str, str | None]:
    # 1. Fetch the HTML (your existing logic)
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

    # 2. Get the specific parser class from the Publisher object
    try:
        parser_class = publisher.parser
    except AttributeError:
        # Fallback: try dynamic import
        import importlib
        module_path = f"fundus.parser.publishers.{country_code}.{class_name.lower()}"
        parser_class_name = f"{class_name}Parser"
        try:
            module = importlib.import_module(module_path)
            parser_class = getattr(module, parser_class_name)
        except (ImportError, AttributeError) as e:
            print(f"❌ Could not import parser for {class_name} in {country_code}: {e}")
            return url, None

    # 3. Instantiate and parse
    try:
        parser = parser_class()
        article = parser.parse(html, url)
        if article.body and article.body.text:
            return url, article.body.text
        else:
            print(f"⚠️ Extraction failed for {url}: no extractable text")
            return url, None
    except Exception as e:
        print(f"❌ Parsing error for {url}: {e}")
        return url, None

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        future_to_url = {
            executor.submit(fetch_and_parse, url, country_code, class_name): url
            for url, country_code, class_name, _ in supported
        }
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
