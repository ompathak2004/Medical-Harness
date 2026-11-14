from io import BytesIO
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import create_app
from app.tools import growth
from scripts import smoke_release


@pytest.mark.parametrize("missing_growth_tables", [False, True])
def test_release_smoke_checks_revision_and_bundled_growth_tables(monkeypatch, missing_growth_tables):
    sha = "a" * 40
    monkeypatch.setattr(get_settings(), "app_release_sha", sha)
    if missing_growth_tables:
        def unavailable():
            raise growth.GrowthTablesError("missing")

        monkeypatch.setattr(growth, "load_tables", unavailable)
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
        if missing_growth_tables:
            with pytest.raises(ValueError, match="bundled growth calculator"):
                smoke_release.smoke("http://127.0.0.1", sha)
        else:
            smoke_release.smoke("http://127.0.0.1", sha)
        with pytest.raises(ValueError, match="deployed revision"):
            smoke_release.smoke("http://127.0.0.1", "b" * 40)
