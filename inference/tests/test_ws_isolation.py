"""Test WS route isolation when V1 is disabled."""
import pytest
from unittest.mock import MagicMock

from app.routes.ws_incremental import register_ws_routes


def test_ws_routes_not_registered_when_v1_disabled():
    """WS route should NOT be registered when incremental_v1_enabled=False."""
    app = MagicMock()
    runtime = MagicMock()
    runtime.settings.incremental_v1_enabled = False

    register_ws_routes(app, runtime)

    # app.websocket() should NOT have been called
    app.websocket.assert_not_called()


def test_ws_routes_registered_when_v1_enabled():
    """WS route should be registered when incremental_v1_enabled=True."""
    app = MagicMock()
    # Need app.websocket to return a decorator
    app.websocket.return_value = lambda f: f
    runtime = MagicMock()
    runtime.settings.incremental_v1_enabled = True

    register_ws_routes(app, runtime)

    app.websocket.assert_called_once_with("/ws/v1/increment")
