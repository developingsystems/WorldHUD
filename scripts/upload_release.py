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
    """DEBUG: print structure, then return False."""
    try:
        filename = os.path.basename(file_path)
        print(f"🔎 DEBUG: File {filename}")

        with open(file_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        print(f"  Top-level type: {type(data).__name__}")

        if isinstance(data, dict):
            keys = list(data.keys())
            print(f"  Number of keys: {len(keys)}")
            if keys:
                first_key = keys[0]
                first_val = data[first_key]
                print(f"  First key: {first_key[:80]}...")
                print(f"  Type of first value: {type(first_val).__name__}")
                if isinstance(first_val, str):
                    print(f"  First value (first 100 chars): {first_val[:100]}...")
                elif isinstance(first_val, dict):
                    print(f"  Keys in first value: {list(first_val.keys())[:5]}")
                elif isinstance(first_val, list):
                    print(f"  Length of first value list: {len(first_val)}")
                    if first_val:
                        print(f"  Type of first item in list: {type(first_val[0]).__name__}")
        elif isinstance(data, list):
            print(f"  Length of list: {len(data)}")
            if data:
                print(f"  Type of first item: {type(data[0]).__name__}")
                if isinstance(data[0], dict):
                    print(f"  Keys in first item: {list(data[0].keys())[:5]}")
        else:
            print(f"  Unexpected top-level type: {type(data).__name__}")

        # Return False for now to avoid uploading until we know the structure
        return False
    except Exception as e:
        print(f"  Validation error: {e}")
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
    elif resp.status_code == 422 and "already exists" in resp.text:
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
    # Note: ARTICLES_DIR is a Path, but we want to work with full path strings
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
