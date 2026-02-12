from app.services.name_resolver import NameResolver


def test_extract_chinese_self_intro() -> None:
    resolver = NameResolver()
    text = "大家好，我叫张三，今天我先来总结。"
    candidates = resolver.extract(text)

    assert candidates
    assert candidates[0].name == "张三"


def test_extract_chinese_reference_pattern() -> None:
    resolver = NameResolver()
    text = "李雷来补充一下刚才的约束。"
    candidates = resolver.extract(text)

    assert candidates
    assert candidates[0].name == "李雷"


def test_extract_rejects_generic_cjk_tokens() -> None:
    resolver = NameResolver()
    text = "我们来补充一下。"
    candidates = resolver.extract(text)

    assert candidates == []
