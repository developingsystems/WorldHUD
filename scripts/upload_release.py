# Upload all article JSON files (both Trafilatura and gdeltnews) to a GitHub Release.

import os
import subprocess
import requests

def main():
    # Get all JSON files in the 'articles' directory
    files = [f for f in os.listdir("articles") if f.endswith(".json")]
    if not files:
        print("No article files to upload")
        return

    # For each file, extract the base timestamp (e.g., "20260611164500")
    file_map = {}
    for f in files:
        # Filenames are either "trafilatura_TIMESTAMP.json" or "gdeltnews_TIMESTAMP.json"
        parts = f.split("_")
        if len(parts) >= 2:
            timestamp = parts[1].replace(".json", "")
            file_map[timestamp] = file_map.get(timestamp, []) + [f]
        else:
            print(f"Skipping file {f} (unexpected naming)")
            continue

    # For each timestamp, upload all corresponding files
    for timestamp, file_list in file_map.items():
        # Check if any file for this timestamp already exists in the release
        release_tag = "gdelt-articles"
        existing_urls = get_release_assets(release_tag)
        existing_files = {os.path.basename(asset["name"]) for asset in existing_urls}

        for file in file_list:
            if file in existing_files:
                print(f"Skipping {file} (already in release)")
                continue

            file_path = f"articles/{file}"
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

            # Upload the file, overwriting only if the same file already exists
            subprocess.run(
                [
                    "gh", "release", "upload", release_tag, file_path, "--clobber"
                ],
                check=True,
                env={
                    "GITHUB_TOKEN": os.environ["GITHUB_TOKEN"],
                    "PATH": os.environ["PATH"]
                }
            )

def get_release_assets(release_tag):
    """Return a list of assets for a given release tag."""
    api_url = f"https://api.github.com/repos/developingsystems/WorldHUD/releases/tags/{release_tag}"
    resp = requests.get(api_url, headers={"Authorization": f"token {os.environ['GITHUB_TOKEN']}"})
    if resp.status_code == 200:
        return resp.json().get("assets", [])
    return []

if __name__ == "__main__":
    main()
