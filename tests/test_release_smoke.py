from io import BytesIO
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import create_app
from scripts import smoke_release


def test_release_smoke_checks_the_running_app_and_rejects_a_stale_revision(monkeypatch):
    sha = "a" * 40
    monkeypatch.setattr(get_settings(), "app_release_sha", sha)
    with TestClient(create_app()) as client:
        def open_request(request, timeout):
            response = client.request(
                request.get_method(), request.selector, content=request.data, headers=dict(request.headers),
            )
            assert response.status_code == 200
            payload = BytesIO(response.content)
            payload.headers = response.headers
            return payload

        monkeypatch.setattr(smoke_release, "build_opener", lambda *handlers: SimpleNamespace(open=open_request))
        smoke_release.smoke("http://127.0.0.1", sha)
        with pytest.raises(ValueError, match="deployed revision"):
            smoke_release.smoke("http://127.0.0.1", "b" * 40)
