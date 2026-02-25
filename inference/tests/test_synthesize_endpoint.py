from unittest.mock import patch

from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.main import app


def test_synthesize_endpoint_exists() -> None:
    """Verify the route is registered."""
    routes = [r.path for r in app.routes]
    assert "/analysis/synthesize" in routes


def test_synthesize_returns_422_for_empty_body() -> None:
    client = TestClient(app, raise_server_exceptions=False)
    with patch("app.main.settings") as mock_settings:
        mock_settings.inference_api_key = SecretStr("")
        mock_settings.max_request_body_bytes = 50 * 1024 * 1024
        mock_settings.rate_limit_enabled = False
        response = client.post("/analysis/synthesize", json={})
    assert response.status_code == 422
