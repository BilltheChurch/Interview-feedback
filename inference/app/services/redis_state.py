"""Redis-backed session state manager.

Single-writer principle: only Inference writes session state.
Worker reads via API endpoints.

Key structure:
  session:{id}:meta       -> Hash  (status, increments_done, etc.)
  session:{id}:profiles   -> Hash  (field=spk_id, value=JSON)
  session:{id}:chkpts     -> List  (append-only CheckpointResponse JSON)
  session:{id}:utts:{N}   -> List  (append-only utterance JSON)
  session:{id}:idem       -> Hash  (increment_id -> "processed")
  session:{id}:lock       -> String (distributed lock)
"""
from __future__ import annotations

import json
import logging
from typing import Any

from redis import Redis

logger = logging.getLogger(__name__)


class RedisSessionState:
    """Thread-safe Redis session state with single-writer semantics."""

    def __init__(self, redis_client: Redis, ttl_s: int = 7200) -> None:
        self._redis = redis_client
        self._ttl = ttl_s

    # -- Keys ------------------------------------------------------------------

    def _key(self, session_id: str, suffix: str) -> str:
        return f"session:{session_id}:{suffix}"

    def _refresh_ttl(self, session_id: str, *suffixes: str) -> None:
        pipe = self._redis.pipeline(transaction=False)
        for suffix in suffixes:
            pipe.expire(self._key(session_id, suffix), self._ttl)
        pipe.execute()

    # -- Meta (Hash) -----------------------------------------------------------

    def set_meta(self, session_id: str, mapping: dict[str, Any]) -> None:
        key = self._key(session_id, "meta")
        self._redis.hset(key, mapping={str(k): str(v) for k, v in mapping.items()})
        self._redis.expire(key, self._ttl)

    def get_meta(self, session_id: str) -> dict[str, str]:
        return self._redis.hgetall(self._key(session_id, "meta"))

    # -- Speaker Profiles (Hash) -----------------------------------------------

    def set_speaker_profile(
        self, session_id: str, speaker_id: str, profile: dict
    ) -> None:
        key = self._key(session_id, "profiles")
        self._redis.hset(key, speaker_id, json.dumps(profile))
        self._redis.expire(key, self._ttl)

    def get_speaker_profile(self, session_id: str, speaker_id: str) -> str | None:
        return self._redis.hget(self._key(session_id, "profiles"), speaker_id)

    def get_all_speaker_profiles(self, session_id: str) -> dict[str, dict]:
        raw = self._redis.hgetall(self._key(session_id, "profiles"))
        return {k: json.loads(v) for k, v in raw.items()}

    # -- Checkpoints (List, append-only) ---------------------------------------

    def append_checkpoint(self, session_id: str, checkpoint: dict) -> None:
        key = self._key(session_id, "chkpts")
        self._redis.rpush(key, json.dumps(checkpoint))
        self._redis.expire(key, self._ttl)

    def get_all_checkpoints(self, session_id: str) -> list[dict]:
        raw = self._redis.lrange(self._key(session_id, "chkpts"), 0, -1)
        return [json.loads(item) for item in raw]

    # -- Utterances (List per increment, append-only) --------------------------

    def append_utterances(
        self, session_id: str, increment_index: int, utterances: list[dict]
    ) -> None:
        key = self._key(session_id, f"utts:{increment_index}")
        if utterances:
            self._redis.rpush(key, *[json.dumps(u) for u in utterances])
            self._redis.expire(key, self._ttl)

    def get_utterances(self, session_id: str, increment_index: int) -> list[dict]:
        raw = self._redis.lrange(
            self._key(session_id, f"utts:{increment_index}"), 0, -1
        )
        return [json.loads(item) for item in raw]

    def get_all_utterances(self, session_id: str, max_increments: int = 100) -> list[dict]:
        all_utts = []
        for i in range(max_increments):
            utts = self.get_utterances(session_id, i)
            if not utts:
                break
            all_utts.extend(utts)
        return all_utts

    # -- Idempotency (Hash) ----------------------------------------------------

    def is_already_processed(self, session_id: str, increment_id: str) -> bool:
        """Check-only: returns True if increment was already processed (duplicate).
        Does NOT mark -- marking happens atomically inside atomic_write_increment."""
        key = self._key(session_id, "idem")
        return bool(self._redis.hexists(key, increment_id))

    # -- Distributed Lock ------------------------------------------------------

    def acquire_session_lock(
        self, session_id: str, worker_id: str, lock_ttl_s: int = 300
    ) -> bool:
        key = self._key(session_id, "lock")
        return bool(self._redis.set(key, worker_id, nx=True, ex=lock_ttl_s))

    # Lua compare-and-delete: atomic lock release (prevents TOCTOU race)
    _RELEASE_LOCK_LUA = """
    if redis.call('GET', KEYS[1]) == ARGV[1] then
        return redis.call('DEL', KEYS[1])
    else
        return 0
    end
    """

    def release_session_lock(self, session_id: str, worker_id: str) -> bool:
        """Atomic lock release via Lua script.
        Only deletes the lock if the current holder matches worker_id.
        Prevents the TOCTOU race condition of GET+DEL (another worker could
        acquire the lock between our GET and DEL)."""
        key = self._key(session_id, "lock")
        result = self._redis.eval(self._RELEASE_LOCK_LUA, 1, key, worker_id)
        return bool(result)

    # -- Atomic Increment Write ------------------------------------------------

    # Lua script: atomic idempotent write.
    # KEYS: [1]=idem_key [2]=meta_key [3]=prof_key [4]=utt_key [5]=chkpt_key
    # ARGV: [1]=increment_id [2]=ttl [3]=meta_json [4]=profiles_json
    #        [5]=utterances_json [6]=checkpoint_json (empty string if none)
    _ATOMIC_WRITE_LUA = """
    -- Gate check: if already processed, return 0 (skip all writes)
    if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then
        return 0
    end

    -- Mark as processed FIRST (gate)
    redis.call('HSET', KEYS[1], ARGV[1], 'processed')
    redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))

    -- Meta update (decode JSON table -> HSET)
    local meta = cjson.decode(ARGV[3])
    if next(meta) then
        local flat = {}
        for k, v in pairs(meta) do flat[#flat+1] = k; flat[#flat+1] = tostring(v) end
        redis.call('HSET', KEYS[2], unpack(flat))
        redis.call('EXPIRE', KEYS[2], tonumber(ARGV[2]))
    end

    -- Speaker profiles
    local profiles = cjson.decode(ARGV[4])
    if next(profiles) then
        for spk_id, profile_json in pairs(profiles) do
            redis.call('HSET', KEYS[3], spk_id, cjson.encode(profile_json))
        end
        redis.call('EXPIRE', KEYS[3], tonumber(ARGV[2]))
    end

    -- Utterances (append-only)
    local utts = cjson.decode(ARGV[5])
    if #utts > 0 then
        local encoded = {}
        for i, u in ipairs(utts) do encoded[i] = cjson.encode(u) end
        redis.call('RPUSH', KEYS[4], unpack(encoded))
        redis.call('EXPIRE', KEYS[4], tonumber(ARGV[2]))
    end

    -- Checkpoint (append-only, optional)
    if ARGV[6] ~= '' then
        redis.call('RPUSH', KEYS[5], ARGV[6])
        redis.call('EXPIRE', KEYS[5], tonumber(ARGV[2]))
    end

    return 1
    """

    def atomic_write_increment(
        self,
        session_id: str,
        increment_id: str,
        increment_index: int,
        meta_updates: dict[str, Any],
        speaker_profiles: dict[str, dict],
        utterances: list[dict],
        checkpoint: dict | None = None,
    ) -> bool:
        """Atomic idempotent write via Lua script.
        Returns True if write was performed, False if duplicate (already processed).
        The Lua script checks HEXISTS before any writes -- if already processed,
        ALL writes are skipped, preventing RPUSH duplicates on retry."""
        result = self._redis.eval(
            self._ATOMIC_WRITE_LUA,
            5,  # number of KEYS
            self._key(session_id, "idem"),
            self._key(session_id, "meta"),
            self._key(session_id, "profiles"),
            self._key(session_id, f"utts:{increment_index}"),
            self._key(session_id, "chkpts"),
            increment_id,
            str(self._ttl),
            json.dumps(meta_updates),
            json.dumps(speaker_profiles),
            json.dumps(utterances),
            json.dumps(checkpoint) if checkpoint else "",
        )
        return bool(result)

    # -- Cleanup ---------------------------------------------------------------

    def cleanup_session(self, session_id: str) -> int:
        """Delete all keys for a session. Returns number of keys deleted."""
        pattern = f"session:{session_id}:*"
        keys = list(self._redis.scan_iter(match=pattern, count=100))
        if keys:
            return self._redis.delete(*keys)
        return 0
