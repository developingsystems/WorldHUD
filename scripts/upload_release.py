#!/usr/bin/env python3
# Upload all article JSON files (Trafilatura and gdeltnews) to a GitHub Release.

import os
import json
import requests
import sys
from pathlib import Path

REPO = os.environ.get("GITHUB_REPOSITORY", "developingsystems/WorldHUD")
TOKEN = os.environ.get("GITHUB_TOKEN")
if not TOKEN:
    print("Error: GITHUB_TOKEN not set")
    sys.exit(1)

RELEASE_TAG = "gdelt-articles"
ARTICLES_DIR = Path("articles")
ALLOWED_PREFIXES = ("trafilatura_", "gdeltnews_")

def get_release_assets():
    """Return a dict mapping asset name -> asset ID."""
    url = f"https://api.github.com/repos/{REPO}/releases/tags/{RELEASE_TAG}"
    resp = requests.get(url, headers={"Authorization": f"token {TOKEN}"})
    if resp.status_code == 200:
        data = resp.json()
        return {asset["name"]: asset["id"] for asset in data.get("assets", [])}
    elif resp.status_code == 404:
        return {}  # Release doesn't exist yet
    else:
        print(f"Failed to get release: {resp.status_code}")
        return {}

def create_release_if_missing():
    """Create the release if it doesn't exist."""
    url = f"https://api.github.com/repos/{REPO}/releases"
    payload = {
        "tag_name": RELEASE_TAG,
        "name": "GDELT Reconstructed Articles",
        "body": "Automatically updated by gdeltnews and Trafilatura pipelines.",
        "prerelease": True,
        "draft": False,
    }
    resp = requests.post(url, json=payload, headers={"Authorization": f"token {TOKEN}"})
    if resp.status_code == 201:
        print(f"Created release {RELEASE_TAG}")
        return True
    elif resp.status_code == 422:
        # Check if the error is because the release already exists
        try:
            errors = resp.json().get("errors", [])
            if errors and errors[0].get("code") == "already_exists":
                print(f"Release {RELEASE_TAG} already exists.")
                return True
        except Exception:
            pass
        print(f"Failed to create release: {resp.status_code} {resp.text}")
        return False
    else:
        print(f"Failed to create release: {resp.status_code} {resp.text}")
        return False

def is_valid_article_file(file_path):
    """Return True if the JSON contains at least one non-empty article entry."""
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        if isinstance(data, dict):
            for url, content in data.items():
                # gdeltnews format: values are strings
                if isinstance(content, str) and len(content.strip()) > 50:
                    return True
                # trafilatura format: values are dicts with 'text' key
                if isinstance(content, dict):
                    # Check for common text keys
                    for key in ['text', 'content', 'body', 'article']:
                        if content.get(key) and isinstance(content[key], str) and len(content[key].strip()) > 50:
                            return True
                    # Or any string value with length > 50
                    for v in content.values():
                        if isinstance(v, str) and len(v.strip()) > 50:
                            return True
        elif isinstance(data, list):
            for item in data:
                if isinstance(item, dict):
                    for v in item.values():
                        if isinstance(v, str) and len(v.strip()) > 50:
                            return True
        return False
    except Exception:
        return False

def upload_asset(file_path, asset_name):
    """Upload a file as a release asset."""
    url = f"https://api.github.com/repos/{REPO}/releases/tags/{RELEASE_TAG}"
    resp = requests.get(url, headers={"Authorization": f"token {TOKEN}"})
    if resp.status_code != 200:
        print(f"Failed to get release for upload: {resp.status_code}")
        return False
    release = resp.json()
    upload_url = release["upload_url"].split("{")[0]

    with open(file_path, "rb") as f:
        files = {"file": (asset_name, f, "application/json")}
        resp = requests.post(
            upload_url + f"?name={asset_name}",
            headers={"Authorization": f"token {TOKEN}"},
            files=files,
        )
    if resp.status_code == 201:
        print(f"  ✅ Uploaded {asset_name}")
        return True
    elif resp.status_code == 422 and "already_exists" in resp.text:
        print(f"  ⏭️  Asset {asset_name} already exists (upload skipped)")
        return True  # treat as success
    else:
        print(f"  ❌ Upload failed: {resp.status_code} {resp.text}")
        return False

def main():
    # 1. Ensure release exists
    if not create_release_if_missing():
        sys.exit(1)

    # 2. Get existing assets
    existing_assets = get_release_assets()
    print(f"Found {len(existing_assets)} existing assets in release.")

    # 3. Gather files
    files = [str(f) for f in ARTICLES_DIR.iterdir() if f.suffix == ".json" and f.name.startswith(ALLOWED_PREFIXES)]
    if not files:
        print("No article files to upload")
        return  # success

    uploaded_count = 0
    skipped_existing = 0
    skipped_invalid = 0

    for file_path in files:
        asset_name = os.path.basename(file_path)

        # Skip if already exists
        if asset_name in existing_assets:
            print(f"⏭️  Skipping {asset_name} (already exists in release)")
            skipped_existing += 1
            continue

        # Validate content
        print(f"🔍 Validating {asset_name}...")
        if not is_valid_article_file(file_path):
            print(f"  ⏭️  Skipping {asset_name} (file is empty or has no usable text)")
            skipped_invalid += 1
            continue

        # Upload
        print(f"⬆️  Uploading {asset_name}...")
        if upload_asset(file_path, asset_name):
            uploaded_count += 1
        else:
            sys.exit(1)

    print(f"\n✅ Done. Uploaded: {uploaded_count}, Skipped (existing): {skipped_existing}, Skipped (invalid): {skipped_invalid}")
    sys.exit(0)

if __name__ == "__main__":
    main()
