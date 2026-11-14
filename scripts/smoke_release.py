import argparse
import json
import os
import re
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def smoke(base_url: str, revision: str, bypass: str = "") -> None:
    base = urlsplit(base_url)
    loopback = base.hostname in {"localhost", "127.0.0.1", "::1"}
    if (base.scheme != "https" and not (base.scheme == "http" and loopback)) or not base.hostname:
        raise ValueError("Expected an HTTPS deployment URL")
    if base.username or base.password or base.query or base.fragment or base.path not in {"", "/"}:
        raise ValueError("Expected a bare deployment origin")
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("Expected the full Git revision")
    if bypass and not (base.scheme == "https" and base.hostname.endswith(".vercel.app")):
        raise ValueError("The bypass token can only be sent to a Vercel deployment")

    opener = build_opener(NoRedirect())
    headers = {"x-vercel-protection-bypass": bypass} if bypass else {}
    origin = base_url.rstrip("/")

    def fetch(path, payload=None):
        data = json.dumps(payload).encode() if payload is not None else None
        request_headers = {**headers, "Content-Type": "application/json"} if data else headers
        try:
            with opener.open(Request(origin + path, data=data, headers=request_headers), timeout=8) as response:
                body = response.read(262145)
                if len(body) > 262144:
                    raise ValueError(f"{path} exceeded the smoke-test size limit")
                return body, response.headers
        except HTTPError as exc:
            raise ValueError(f"{path} returned HTTP {exc.code}") from None
        except URLError:
            raise ValueError(f"{path} could not be reached") from None

    health, response_headers = fetch("/api/health")
    health = json.loads(health)
    if health.get("status") != "ok" or health.get("revision") != revision:
        raise ValueError("Liveness or deployed revision did not match")
    if not re.fullmatch(r"[0-9a-f]{32}", response_headers.get("X-Request-ID", "")):
        raise ValueError("The health route did not return a request ID")
    index, _ = fetch("/")
    script = re.search(rb'src="(/static/dist/app-[A-Z0-9]{8}\.js)"', index)
    stylesheet = re.search(rb'href="(/static/dist/app-[A-Z0-9]{8}\.css)"', index)
    if b'id="user-input"' not in index or not script or not stylesheet:
        raise ValueError("The home page or its main bundle links were missing")
    for match, expected_types in ((script, {"text/javascript", "application/javascript"}), (stylesheet, {"text/css"})):
        body, asset_headers = fetch(match.group(1).decode())
        if not body or asset_headers.get("Content-Type", "").split(";", 1)[0] not in expected_types:
            raise ValueError("A main bundle was empty or had the wrong content type")
    result, _ = fetch("/api/tools/bmi", {"inputs": {"age_years": 34, "weight_kg": 70, "height_cm": 175}})
    if json.loads(result).get("result", {}).get("bmi") != 22.9:
        raise ValueError("The synthetic calculator result did not match")
    growth, _ = fetch("/api/tools/growth_percentile", {
        "inputs": {"sex": "male", "age_months": 0, "measure": "weight", "value": 3.3464},
    })
    if json.loads(growth).get("result", {}).get("percentile") != 50.0:
        raise ValueError("The bundled growth calculator result did not match")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--revision", required=True)
    args = parser.parse_args()
    for attempt in range(4):
        try:
            smoke(args.url, args.revision, os.getenv("VERCEL_AUTOMATION_BYPASS_SECRET", ""))
            print("Release smoke checks passed")
            return
        except (ValueError, TimeoutError) as exc:
            if attempt == 3:
                raise SystemExit(f"Release smoke checks failed: {exc}") from None
            time.sleep(3)


if __name__ == "__main__":
    main()
