#!/usr/bin/env python3
# Upload all article JSON files (both Trafilatura and gdeltnews) to a GitHub Release.

import os
import subprocess
import requests
import sys
import json   # <-- new import

def is_valid_article_file(file_path):
    """DEBUG: print structure, then return False."""
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        
        print(f"🔎 DEBUG: File {file_path.name}")
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
        
        # For now, return False to avoid uploading until we know the structure
        return False
    except Exception as e:
        print(f"  Validation error: {e}")
        return False

def main():
    # Get all JSON files in the 'articles' directory
    allowed_prefixes = ("trafilatura_", "gdeltnews_")
    files = [f for f in os.listdir("articles") if f.endswith(".json") and f.startswith(allowed_prefixes)]
    if not files:
        print("No article files to upload")
        return

    # For each file, extract the base timestamp (e.g., "20260611164500")
    file_map = {}
    for f in files:
        parts = f.split("_")
        if len(parts) >= 2:
            timestamp = parts[1].replace(".json", "")
            file_map[timestamp] = file_map.get(timestamp, []) + [f]
        else:
            print(f"Skipping file {f} (unexpected naming)")
            continue

    # For each timestamp, upload all corresponding files
    for timestamp, file_list in file_map.items():
        release_tag = "gdelt-articles"
        existing_urls = get_release_assets(release_tag)
        existing_files = {os.path.basename(asset["name"]) for asset in existing_urls}

        for file in file_list:
            if file in existing_files:
                print(f"Skipping {file} (already in release)")
                continue

            file_path = f"articles/{file}"

            # --- Validation: skip if file has no usable article data ---
            if not is_valid_article_file(file_path):
                print(f"Skipping {file} (no article text found in JSON)")
                continue

            print(f"Uploading {file_path} to release tag '{release_tag}'")

            # Create release if it doesn't exist (idempotent)
            subprocess.run(
                [
                    "gh", "release", "create", release_tag,
                    "--title", "GDELT Reconstructed Articles",
                    "--notes", "Automatically updated by gdeltnews and Trafilatura pipelines.",
                    "--prerelease", "--latest=false"
                ],
                check=False,
                env={
                    "GITHUB_TOKEN": os.environ["GITHUB_TOKEN"],
                    "PATH": os.environ["PATH"]
                }
            )

            # Upload – but don't crash if asset already exists (422)
            result = subprocess.run(
                [
                    "gh", "release", "upload", release_tag, file_path, "--clobber"
                ],
                check=False,
                env={
                    "GITHUB_TOKEN": os.environ["GITHUB_TOKEN"],
                    "PATH": os.environ["PATH"]
                }
            )

            # If upload failed, check if the asset exists now – if so, it's fine
            if result.returncode != 0:
                print(f"⚠️ Upload command exited with {result.returncode}")
                current_assets = get_release_assets(release_tag)
                current_files = {os.path.basename(asset["name"]) for asset in current_assets}
                if file in current_files:
                    print(f"✅ {file} is already in the release – treating as success")
                else:
                    print(f"❌ Upload failed and {file} is not in the release – aborting")
                    sys.exit(1)

def get_release_assets(release_tag):
    """Return a list of assets for a given release tag."""
    api_url = f"https://api.github.com/repos/developingsystems/WorldHUD/releases/tags/{release_tag}"
    resp = requests.get(api_url, headers={"Authorization": f"token {os.environ['GITHUB_TOKEN']}"})
    if resp.status_code == 200:
        return resp.json().get("assets", [])
    return []

if __name__ == "__main__":
    main()
