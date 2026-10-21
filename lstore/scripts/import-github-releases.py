#!/usr/bin/env python3
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urlparse
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


GITHUB_RELEASES = "https://api.github.com/repos/c22hv8dcf7-alt/eddy/releases?per_page=100"
MAX_RELEASES = 100
LOCAL_TOKEN_FILE = Path(__file__).resolve().parents[1] / "data" / "admin-token"


def fetch_json(url):
    request = Request(url, headers={"User-Agent": "eddy-lstore-migration"})
    with urlopen(request, timeout=60) as response:
        return json.load(response)


def download(url, destination):
    request = Request(url, headers={"User-Agent": "eddy-lstore-migration"})
    with urlopen(request, timeout=180) as response, open(destination, "wb") as output:
        shutil.copyfileobj(response, output, length=1024 * 1024)


def release_version(tag):
    match = re.fullmatch(r"v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)", tag)
    if not match:
        raise ValueError(f"Unsupported release tag: {tag}")
    return match.group(1)


def request_json(url, token=None, method="GET", payload=None):
    headers = {"User-Agent": "eddy-lstore-migration"}
    body = None
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if payload is not None:
        headers["Content-Type"] = "application/json"
        body = json.dumps(payload).encode("utf-8")
    request = Request(url, headers=headers, method=method, data=body)
    with urlopen(request, timeout=60) as response:
        return json.load(response)


def local_url(url):
    parsed = urlparse(url)
    return parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}


def main():
    base_url = os.environ.get("LSTORE_URL", "").rstrip("/")
    token = os.environ.get("LSTORE_ADMIN_TOKEN", "")
    if not base_url.startswith("https://") and not local_url(base_url):
        raise SystemExit("LSTORE_URL must use HTTPS or point to localhost on this Mac.")
    if not token and local_url(base_url) and LOCAL_TOKEN_FILE.is_file():
        token = LOCAL_TOKEN_FILE.read_text(encoding="utf-8").strip()
    if len(token) < 32:
        raise SystemExit("Set a 32+ character LSTORE_ADMIN_TOKEN or start local LStore first.")

    releases = fetch_json(GITHUB_RELEASES)
    if len(releases) >= MAX_RELEASES:
        raise SystemExit("GitHub returned the maximum page size; increase pagination before importing.")

    try:
        existing = request_json(f"{base_url}/api/releases/eddy")
    except HTTPError as error:
        if error.code != 404:
            raise
        try:
            request_json(
                f"{base_url}/api/apps",
                token=token,
                method="POST",
                payload={"appName": "Eddy", "slug": "eddy"},
            )
        except HTTPError as create_error:
            if create_error.code != 409:
                raise
        existing = []
    imported_versions = {entry["version"] for entry in existing}
    published = [release for release in releases if not release["draft"] and not release["prerelease"]]
    published.sort(key=lambda item: tuple(int(part) for part in release_version(item["tag_name"]).split("-")[0].split(".")))

    with tempfile.TemporaryDirectory(prefix="eddy-release-import-") as temp_dir:
        temp = Path(temp_dir)
        header_path = temp / "authorization-header"
        header_path.write_text(f"Authorization: Bearer {token}\n", encoding="utf-8")
        header_path.chmod(0o600)

        imported = 0
        skipped = 0
        for release in published:
            version = release_version(release["tag_name"])
            if version in imported_versions:
                print(f"Already present: Eddy {version}")
                skipped += 1
                continue

            assets = {asset["name"]: asset for asset in release["assets"]}
            archive = assets.get("Eddy.app.tar.gz")
            signature_asset = assets.get("Eddy.app.tar.gz.sig")
            installer = next(
                (asset for asset in release["assets"]
                 if asset["name"].endswith("_aarch64.dmg")),
                None,
            )
            if not archive or not signature_asset:
                raise SystemExit(
                    f"Eddy {version} is missing Eddy.app.tar.gz or its .sig file; "
                    "nothing was imported for this release."
                )

            archive_path = temp / "Eddy.app.tar.gz"
            signature_path = temp / "Eddy.app.tar.gz.sig"
            download(archive["browser_download_url"], archive_path)
            download(signature_asset["browser_download_url"], signature_path)
            signature = signature_path.read_text(encoding="utf-8").strip()
            if not signature:
                raise SystemExit(f"Eddy {version} has an empty updater signature.")

            command = [
                "curl", "--fail-with-body", "--silent", "--show-error",
                "--header", f"@{header_path}",
                "-F", "appId=eddy",
                "-F", f"version={version}",
                "--form-string", f"notes={release.get('body') or release.get('name') or f'Eddy {version}'}",
                "-F", "platform=darwin-aarch64",
                "--form-string", f"signature={signature}",
                "-F", f"artifact=@{archive_path};type=application/gzip",
            ]

            installer_path = None
            if installer:
                installer_path = temp / installer["name"]
                download(installer["browser_download_url"], installer_path)
                command.extend([
                    "-F", f"installer=@{installer_path};type=application/x-apple-diskimage",
                ])

            command.append(f"{base_url}/api/releases")
            try:
                subprocess.run(command, check=True, text=True, capture_output=True)
            except subprocess.CalledProcessError as error:
                raise SystemExit(
                    f"Failed to import Eddy {version}: "
                    f"{error.stderr.strip() or error.stdout.strip()}"
                ) from error

            imported_versions.add(version)
            imported += 1
            print(f"Imported Eddy {version}")

    print(f"Finished: {imported} imported, {skipped} already present.")


if __name__ == "__main__":
    try:
        main()
    except (HTTPError, URLError, TimeoutError) as error:
        raise SystemExit(f"Migration stopped due to a network error: {error}") from error
