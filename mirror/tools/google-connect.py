#!/usr/bin/env python3
"""Signs one Google account in for the mirror and stores its token on the Pi.

Run this on a computer with a browser, once per account:

    mirror/tools/google-connect.py sam-personal
    mirror/tools/google-connect.py heather-merrows --email heather@example.com
    mirror/tools/google-connect.py heather-personal --photos --app Firefox

It opens Google's sign-in page, waits for the person to approve read-only
access to their calendar and tasks, and writes the resulting token to
~/mirror-data/google/<name>.json on the Pi with mode 600. The mirror's
calendar and tasks modules pick the file up by themselves within a few
minutes.

The OAuth client file is read from the Pi over SSH and kept in memory.
Nothing is written on this computer. Only Python's standard library is used.

The SSH command defaults to "ssh mirror". Set MIRROR_SSH to change it.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import http.server
import json
import os
import re
import secrets
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

SCOPES = [
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/tasks.readonly",
]
# Lets the person choose photos for their slideshow through Google's picker.
PHOTOS_SCOPE = "https://www.googleapis.com/auth/photospicker.mediaitems.readonly"
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
REMOTE_DIR = "mirror-data/google"
NAME_PATTERN = re.compile(r"^[a-z][a-z0-9-]{0,40}$")
WAIT_SECONDS = 300


def ssh_command() -> list[str]:
    return shlex.split(os.environ.get("MIRROR_SSH", "ssh mirror"))


def read_client() -> dict:
    """Reads the OAuth client from the Pi. It never touches this computer's disk."""
    result = subprocess.run(ssh_command() + [f"cat {REMOTE_DIR}/credentials.json"], capture_output=True, text=True, check=False)
    if result.returncode != 0:
        sys.exit(f"Could not read {REMOTE_DIR}/credentials.json from the Pi: {result.stderr.strip()}")
    client = json.loads(result.stdout).get("installed")
    if not client or not client.get("client_id") or not client.get("client_secret"):
        sys.exit("The OAuth client file on the Pi is not a Desktop client.")
    return client


def authorization_url(client_id: str, redirect_uri: str, state: str, challenge: str, email: str | None, scopes: list[str]) -> str:
    query = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": " ".join(scopes),
        "access_type": "offline",
        # Always ask, so Google returns a refresh token even on a repeat sign-in.
        "prompt": "consent",
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    if email:
        query["login_hint"] = email
    return f"{AUTH_URL}?{urllib.parse.urlencode(query)}"


def pkce_pair() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(verifier.encode()).digest()
    return verifier, base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def open_page(url: str, app: str | None, no_browser: bool) -> bool:
    """Opens the sign-in page. Returns False when the address has to be printed."""
    if no_browser:
        return False
    if app:
        return subprocess.run(["open", "-a", app, url], check=False).returncode == 0
    return webbrowser.open(url)


class Callback(http.server.BaseHTTPRequestHandler):
    """Catches the one redirect Google sends back to this computer."""

    result: dict = {}

    def do_GET(self):  # noqa: N802 - the name http.server requires
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        Callback.result = {key: values[0] for key, values in query.items()}
        done = "error" not in Callback.result
        body = "You can close this tab. The mirror has what it needs." if done else "The sign-in was not completed. You can close this tab."
        page = f"<!doctype html><meta charset='utf-8'><title>Household Mirror</title><p style='font: 1.1rem system-ui; margin: 3rem'>{body}</p>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(page.encode())

    def log_message(self, *args):  # keep the terminal quiet
        return


def wait_for_code(server: http.server.HTTPServer, state: str) -> str:
    server.timeout = 1
    deadline = time.monotonic() + WAIT_SECONDS
    while not Callback.result and time.monotonic() < deadline:
        server.handle_request()
    result = Callback.result
    if not result:
        sys.exit(f"Nobody finished the sign-in within {WAIT_SECONDS // 60} minutes.")
    if "error" in result:
        sys.exit(f"Google reported: {result['error']}")
    if result.get("state") != state:
        sys.exit("The reply did not match this sign-in. Nothing was saved.")
    return result["code"]


def exchange(client: dict, code: str, verifier: str, redirect_uri: str) -> dict:
    form = urllib.parse.urlencode({
        "client_id": client["client_id"],
        "client_secret": client["client_secret"],
        "code": code,
        "code_verifier": verifier,
        "grant_type": "authorization_code",
        "redirect_uri": redirect_uri,
    }).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(TOKEN_URL, data=form), timeout=30) as response:
            token = json.load(response)
    except urllib.error.HTTPError as error:
        sys.exit(f"Google refused the sign-in code: {error.read().decode(errors='replace')[:300]}")
    if "refresh_token" not in token:
        sys.exit("Google returned no refresh token, so the mirror could not stay signed in. Nothing was saved.")
    # The shape google-auth-library stores: expiry as a millisecond timestamp.
    token["expiry_date"] = int(time.time() * 1000) + int(token.pop("expires_in", 3600)) * 1000
    return token


def account_address(token: dict) -> str:
    """Asks Google which account this is. The primary calendar's id is the address."""
    request = urllib.request.Request("https://www.googleapis.com/calendar/v3/calendars/primary", headers={"Authorization": f"Bearer {token['access_token']}"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response).get("id", "an unnamed account")
    except urllib.error.URLError:
        return "an account whose address could not be read"


def store(name: str, token: dict) -> None:
    remote = f"umask 077 && mkdir -p {REMOTE_DIR} && cat > {REMOTE_DIR}/{name}.json.tmp && mv {REMOTE_DIR}/{name}.json.tmp {REMOTE_DIR}/{name}.json"
    result = subprocess.run(ssh_command() + [remote], input=json.dumps(token), capture_output=True, text=True, check=False)
    if result.returncode != 0:
        sys.exit(f"Could not write the token to the Pi: {result.stderr.strip()}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("name", help="a short name for the account, for example sam-personal")
    parser.add_argument("--email", help="the account's address, to preselect it on Google's page")
    parser.add_argument("--photos", action="store_true", help="also ask for access to photos the person picks, for the slideshow")
    parser.add_argument("--app", help="open the sign-in page in this application, for example Firefox (macOS)")
    parser.add_argument("--no-browser", action="store_true", help="print the sign-in address instead of opening it")
    args = parser.parse_args()
    if not NAME_PATTERN.match(args.name):
        sys.exit("Use a name of lowercase letters, digits and hyphens, for example heather-personal.")

    client = read_client()
    server = http.server.HTTPServer(("127.0.0.1", 0), Callback)
    redirect_uri = f"http://127.0.0.1:{server.server_address[1]}"
    verifier, challenge = pkce_pair()
    state = secrets.token_urlsafe(24)
    scopes = SCOPES + ([PHOTOS_SCOPE] if args.photos else [])
    url = authorization_url(client["client_id"], redirect_uri, state, challenge, args.email, scopes)

    wanted = "read-only calendar and tasks access" + (", plus the photos they pick" if args.photos else "")
    print(f"Sign in to Google as the account for '{args.name}' and approve {wanted}.")
    if not open_page(url, args.app, args.no_browser):
        print(f"Open this address in a browser on this computer:\n{url}")
    code = wait_for_code(server, state)
    server.server_close()

    token = exchange(client, code, verifier, redirect_uri)
    address = account_address(token)
    store(args.name, token)
    print(f"Signed in as {address}. Saved on the Pi as {REMOTE_DIR}/{args.name}.json.")


if __name__ == "__main__":
    main()
