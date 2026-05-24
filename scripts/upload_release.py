# Upload the reconstructed article JSON to a GitHub Release.

import os
import subprocess

def main():
    timestamp = os.environ.get("TIMESTAMP")
    if not timestamp:
        files = sorted(
            [f for f in os.listdir("articles") if f.endswith(".json")]
        )
        if not files:
            print("No article files to upload")
            return
        timestamp = files[-1].replace("articles_", "").replace(".json", "")

    file_path = f"articles/articles_{timestamp}.json"
    if not os.path.exists(file_path):
        print(f"File {file_path} not found")
        return

    release_tag = "gdelt-articles"

    # Create or update the release
    subprocess.run(
        [
            "gh", "release", "create", release_tag,
            "--title", "GDELT Reconstructed Articles",
            "--notes", "Automatically updated by gdeltnews pipeline.",
            "--prerelease", "--latest=false"
        ],
        check=False,
        env={
            "GITHUB_TOKEN": os.environ["GITHUB_TOKEN"],
            "PATH": os.environ["PATH"]
        }
    )

    # Upload the file, overwriting only if the same timestamp file already exists
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

    print(f"Uploaded {file_path} to release tag '{release_tag}'")


if __name__ == "__main__":
    main()
