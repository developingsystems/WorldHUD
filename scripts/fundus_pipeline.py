#!/usr/bin/env python3
"""Fundus article extraction – Sequential debug version."""

import os
import json
import sys
import urllib.request
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup
from fundus import PublisherCollection

# ----------------------------------------------------------------------
def build_domain_publisher_map():
    url = "https://raw.githubusercontent.com/flairNLP/fundus/refs/heads/master/docs/supported_publishers.md"
    resp = requests.get(url, timeout=15)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    domain_to_pub = {}
    tables = soup.find_all("table")
    for table in tables:
        country_code = None
        for cls in table.get('class', []):
            if cls in ['at','au','be','ca','ch','cn','cz','de','dk','es','fr',
                       'gl','id','il','ind','isl','it','jp','kr','lb','li','ls',
                       'lt','lu','mx','my','na','no','pl','pt','py','ru','se',
                       'tr','tw','tz','ua','uk','us','vn','za']:
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
            try:
                publisher = getattr(country_group, class_name)
            except AttributeError:
                publisher = None
                for pub in country_group:
                    if pub.__name__ == class_name:
                        publisher = pub
                        break
            if publisher:
                domain_to_pub[domain] = publisher
    print(f"Built domain map with {len(domain_to_pub)} entries")
    return domain_to_pub

# ----------------------------------------------------------------------
def article_json_exists(timestamp):
    url = f"https://github.com/developingsystems/WorldHUD/releases/download/gdelt-articles/fundus_{timestamp}.json"
    try:
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status == 200
    except Exception:
        return False

# ----------------------------------------------------------------------
def main():
    os.makedirs("articles", exist_ok=True)

    timestamp = os.environ.get("CHUNK_TIMESTAMP")
    urls_json = os.environ.get("URLS")
    if not timestamp or not urls_json:
        print("Error: missing environment variables")
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

    session = requests.Session()
    session.headers.update({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    })

    articles = {}
    for idx, (url, publisher) in enumerate(supported, 1):
        print(f"\n[{idx}/{len(supported)}] Processing: {url[:80]}...")
        # Fetch HTML
        try:
            resp = session.get(url, timeout=15)
            resp.raise_for_status()
            html = resp.text
        except Exception as e:
            print(f"  ❌ Network error: {e}")
            continue

        # Extract using the publisher's parser
        try:
            # Get the parser class from the publisher object
            parser_class = publisher.parser
            parser = parser_class()
            # NOTE: Do NOT pass the URL as second argument; it is not expected.
            result = parser.parse(html)   # <-- FIXED: removed url argument

            # Handle result (could be Article object or dict)
            text = None
            if hasattr(result, 'body') and result.body and result.body.text:
                text = result.body.text
            elif isinstance(result, dict):
                # Look inside 'body' dict first
                body = result.get('body')
                if isinstance(body, dict):
                    text = body.get('text') or body.get('content') or body.get('articleBody')
                    if not text:
                        # fallback: first long string in body values
                        for v in body.values():
                            if isinstance(v, str) and len(v) > 100:
                                text = v
                                break
                elif isinstance(body, str):
                    text = body
                if not text:
                    # try top-level text keys
                    text = result.get('text') or result.get('content')
            else:
                print(f"  ⚠️ Unexpected result type: {type(result)}")

            if text and len(text) > 50:
                articles[url] = text
                print(f"  ✅ Extracted ({len(text)} chars)")
            else:
                print(f"  ⚠️ No extractable text")
        except Exception as e:
            print(f"  ❌ Parsing error: {e}")
            import traceback
            traceback.print_exc()

    output_path = f"articles/fundus_{timestamp}.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(articles, f, ensure_ascii=False, indent=2)
    print(f"\n✅ Saved {len(articles)} Fundus articles → {output_path}")

    with open(os.environ["GITHUB_OUTPUT"], "a") as f:
        f.write(f"timestamp={timestamp}\n")

if __name__ == "__main__":
    main()
