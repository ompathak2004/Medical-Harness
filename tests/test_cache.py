"""Tests for the in-process TTL+LRU cache and key helper."""

import time

from app.cache import TTLCache, text_key


class TestTextKey:
    def test_stable_and_normalized(self):
        assert text_key("What is  FLU? ") == text_key("what is flu?")
        assert text_key("a", "b") != text_key("ab")  # separator prevents collisions
        assert text_key("a", "b") != text_key("b", "a")

    def test_is_hex_digest(self):
        key = text_key("hello")
        assert len(key) == 64
        int(key, 16)  # parses as hex


class TestTTLCache:
    def test_put_get_hit(self):
        cache = TTLCache(max_entries=4, ttl_seconds=60)
        cache.put("k", {"v": 1})
        assert cache.get("k") == {"v": 1}
        assert cache.hits == 1
        assert cache.misses == 0

    def test_miss_counts(self):
        cache = TTLCache()
        assert cache.get("absent") is None
        assert cache.misses == 1

    def test_ttl_expiry(self, monkeypatch):
        cache = TTLCache(ttl_seconds=10)
        now = time.monotonic()
        cache.put("k", "v")
        monkeypatch.setattr(time, "monotonic", lambda: now + 11)
        assert cache.get("k") is None
        assert cache.misses == 1
        assert cache.stats()["size"] == 0  # expired entry removed

    def test_lru_eviction(self):
        cache = TTLCache(max_entries=2, ttl_seconds=60)
        cache.put("a", 1)
        cache.put("b", 2)
        assert cache.get("a") == 1  # refresh 'a' → 'b' is now LRU
        cache.put("c", 3)
        assert cache.get("b") is None  # evicted
        assert cache.get("a") == 1
        assert cache.get("c") == 3

    def test_stats(self):
        cache = TTLCache(max_entries=8, ttl_seconds=30)
        cache.put("k", "v")
        cache.get("k")
        cache.get("nope")
        stats = cache.stats()
        assert stats == {
            "size": 1,
            "max_entries": 8,
            "ttl_seconds": 30,
            "hits": 1,
            "misses": 1,
        }
