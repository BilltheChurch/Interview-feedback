"""Test LLM Adapter wiring — runtime uses DashScopeLLMAdapter, not DashScopeLLM directly."""
import pytest
from unittest.mock import MagicMock, patch


def test_runtime_uses_adapter_not_direct_llm():
    """Runtime should use DashScopeLLMAdapter, not DashScopeLLM directly."""
    from app.services.backends.llm_dashscope import DashScopeLLMAdapter

    adapter = DashScopeLLMAdapter.__new__(DashScopeLLMAdapter)
    assert hasattr(adapter, "generate_json")


def test_adapter_has_pool_semaphores():
    """Adapter should have separate pool semaphores for checkpoint, finalize, default."""
    from app.services.backends.llm_dashscope import DashScopeLLMAdapter
    from app.services.backends.llm_protocol import LLMConfig

    config = LLMConfig(api_key="test", model="qwen-turbo")
    adapter = DashScopeLLMAdapter(config=config, redis_client=None)

    assert "checkpoint" in adapter._pools
    assert "finalize" in adapter._pools
    assert "default" in adapter._pools


def test_runtime_no_direct_dashscope_llm_import():
    """runtime.py should NOT import DashScopeLLM for instantiation."""
    import ast
    from pathlib import Path

    runtime_src = Path(__file__).resolve().parent.parent / "app" / "runtime.py"
    tree = ast.parse(runtime_src.read_text())

    # Collect all imported names
    imported_names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            for alias in node.names:
                imported_names.add(alias.asname or alias.name)

    assert "DashScopeLLM" not in imported_names, (
        "runtime.py should not import DashScopeLLM — use DashScopeLLMAdapter instead"
    )


def test_adapter_generate_json_kwarg_compat():
    """Adapter's generate_json must accept keyword args system_prompt, user_prompt
    to be a drop-in replacement for DashScopeLLM."""
    from app.services.backends.llm_dashscope import DashScopeLLMAdapter
    from app.services.backends.llm_protocol import LLMConfig
    import inspect

    config = LLMConfig(api_key="test", model="qwen-turbo")
    adapter = DashScopeLLMAdapter(config=config, redis_client=None)

    sig = inspect.signature(adapter.generate_json)
    params = list(sig.parameters.keys())
    assert "system_prompt" in params
    assert "user_prompt" in params


def test_adapter_redis_injection():
    """After construction, redis can be injected for idempotency cache."""
    from app.services.backends.llm_dashscope import DashScopeLLMAdapter
    from app.services.backends.llm_protocol import LLMConfig

    config = LLMConfig(api_key="test", model="qwen-turbo")
    adapter = DashScopeLLMAdapter(config=config, redis_client=None)

    assert adapter._redis is None

    mock_redis = MagicMock()
    adapter._redis = mock_redis
    assert adapter._redis is mock_redis
