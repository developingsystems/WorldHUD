#!/usr/bin/env python3
"""Fundus article extraction for WorldHUD – Crawler-based pipeline with JSON serialization fix."""

import os
import json
import sys
import time
import urllib.request
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup
from fundus import PublisherCollection, Crawler


def build_supported_domains() -> set[str]:
    url = "https://raw.githubusercontent.com/flairNLP/fundus/refs/heads/master/docs/supported_publishers.md"
    try:
        resp = requests.get(url, timeout=15)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")
    except Exception as e:
        print(f"Error fetching publisher list: {e}")
        return set()
    domains = set()
    tables = soup.find_all("table")
    for table in tables:
        for row in table.find_all("tr"):
            cells = row.find_all("td")
            if len(cells) < 3:
                continue
            a_tag = cells[2].find("a")
            if not a_tag:
                continue
            href = a_tag.get("href", "")
            if not href.startswith("https://"):
                continue
            domain = href.split("//")[1].split("/")[0].lower()
            if domain.startswith("www."):
                domain = domain[4:]
            domains.add(domain)
    print(f"Built supported domains set with {len(domains)} entries")
    return domains


def article_json_exists(timestamp: str) -> bool:
    url = f"https://github.com/developingsystems/WorldHUD/releases/download/gdelt-articles/fundus_{timestamp}.json"
    try:
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status == 200
    except Exception:
        return False


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

    supported_domains = build_supported_domains()
    target_urls = set()
    for url in urls:
        domain = urlparse(url).netloc.lower()
        if domain.startswith("www."):
            domain = domain[4:]
        if domain in supported_domains:
            target_urls.add(url)

    print(f"Filtered down to {len(target_urls)} supported URLs")
    if not target_urls:
        output_path = f"articles/fundus_{timestamp}.json"
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump({}, f, ensure_ascii=False, indent=2)
        print(f"✅ Saved 0 Fundus articles → {output_path}")
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            f.write(f"timestamp={timestamp}\n")
        return

    crawler = Crawler(PublisherCollection)
    articles: dict[str, str] = {}
    start_time = time.time()

    for article in crawler.crawl(max_articles=len(target_urls), timeout=30,
                                 url_filter=lambda url: url in target_urls):
        # Extract the article text safely
        try:
            # article.body.text could be a property or a method
            body_text = article.body.text
            if callable(body_text):
                body_text = body_text()
            text = str(body_text) if body_text else ""
        except Exception as e:
            print(f"⚠️ Could not extract text for {article.html.requested_url}: {e}")
            continue

        if text and len(text) > 50:
            articles[article.html.requested_url] = text
            print(f"✅ Extracted: {article.html.requested_url[:80]}...")
        else:
            print(f"⚠️ Extraction failed for: {article.html.requested_url} (text too short or empty)")

    output_path = f"articles/fundus_{timestamp}.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(articles, f, ensure_ascii=False, indent=2)

    elapsed = time.time() - start_time
    print(f"✅ Saved {len(articles)} Fundus articles in {elapsed:.1f}s → {output_path}")

    with open(os.environ["GITHUB_OUTPUT"], "a") as f:
        f.write(f"timestamp={timestamp}\n")


if __name__ == "__main__":
    main()
