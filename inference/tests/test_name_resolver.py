from app.services.name_resolver import NameResolver


def test_extract_name_candidates_from_patterns() -> None:
    resolver = NameResolver()
    text = "Hello, my name is alice johnson. nice to meet you."
    candidates = resolver.extract(text)

    assert candidates
    assert candidates[0].name == "Alice Johnson"


def test_extract_name_candidates_from_im_pattern() -> None:
    resolver = NameResolver()
    text = "I'm bob"
    candidates = resolver.extract(text)

    assert candidates
    assert candidates[0].name == "Bob"
