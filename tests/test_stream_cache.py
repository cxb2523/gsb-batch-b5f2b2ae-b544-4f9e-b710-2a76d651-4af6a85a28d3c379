"""v0.9.0 Room 12 — the Pantry: the LRU stream cache."""

import os
import time

import pytest

from hearth import config
from hearth.player import PlaybackCore
from hearth.stream_cache import StreamCache

from .test_app_smoke import make_hearth
from .test_crossfade import FakeHandle
from .test_models import make_track


@pytest.fixture
def cache(tmp_path):
    # 1 KB cap so eviction rounds are testable with tiny payloads.
    return StreamCache(tmp_path / "pantry", max_bytes=1024)


def test_miss_on_empty_cache(cache):
    assert cache.path_for("abc") is None
    assert cache.has("abc") is False


def test_store_then_hit(cache):
    assert cache.store("abc", b"fire") is not None
    assert cache.has("abc")
    assert cache.path_for("abc").read_bytes() == b"fire"


def test_store_overwrites_same_id(cache):
    cache.store("abc", b"first")
    cache.store("abc", b"second")
    assert cache.path_for("abc").read_bytes() == b"second"


def test_store_rejects_empty_and_bad_ids(cache):
    assert cache.store("", b"data") is None
    assert cache.store("../evil", b"data") is None
    assert cache.store("ok", b"") is None


def test_lru_evicts_coldest_first(tmp_path):
    cache = StreamCache(tmp_path / "pantry", max_bytes=1024 * 1024)  # roomy fill
    for name, size in (("old", 300), ("mid", 300), ("new", 300), ("big", 500)):
        cache.store(name, b"x" * size)   # 1400B total
    cache.max_bytes = 1024               # shrink the Pantry, then trim
    now = time.time()
    for name, age in (("old", 400), ("mid", 300), ("new", 200), ("big", 100)):
        os.utime(cache.root / f"{name}.audio", (now - age, now - age))
    removed = cache.trim(keep="big")
    assert removed == 2              # evict until back under cap
    assert not (cache.root / "old.audio").exists()   # coldest goes first
    assert not (cache.root / "mid.audio").exists()
    assert (cache.root / "new.audio").exists()
    assert (cache.root / "big.audio").exists()       # kept alive


def test_hit_touches_survival(cache):
    cache.store("keepme", b"x" * 400)
    cache.store("other", b"x" * 400)
    now = time.time()
    os.utime(cache.root / "keepme.audio", (now - 100, now - 100))
    os.utime(cache.root / "other.audio", (now - 50, now - 50))
    assert cache.path_for("keepme") is not None  # a play — touch lifts it to now
    cache.store("big", b"x" * 600)               # forces a trim round
    assert cache.has("keepme")                   # freshly touched, survives
    assert not cache.has("other")                # the coldest paid the bill


def test_trim_honors_cap(cache):
    for i in range(8):
        cache.store(f"t{i}", b"x" * 200)   # 8 × 200B > 1KB cap
    assert cache.size() <= 1024


def test_clear_is_a_full_broom(cache):
    cache.store("a", b"12345")
    cache.store("b", b"12345")
    removed = cache.clear()
    assert removed == 2
    assert cache.item_count() == 0
    assert cache.size() == 0


def test_broken_root_never_raises(tmp_path):
    blocker = tmp_path / "blocker"
    blocker.write_text("i am a file, not a directory")
    cache = StreamCache(blocker / "pantry", max_bytes=64)
    assert cache.store("a", b"data") is None      # mkdir under a file fails
    assert cache.path_for("a") is None
    assert cache.clear() == 0
    assert cache.size() == 0


def test_zero_data_and_zero_limit(cache):
    cache.store("a", b"data")
    assert StreamCache(cache.root, max_bytes=1).trim() >= 1


# --- PlaybackCore wiring: resolved direct URLs land in the Pantry ---
#
# Everything headless: fake backends/handles (test_player.py conventions),
# a real StreamCache on a tmp root, no network, no Qt multimedia.


class _Backend:
    """Headless stand-in for the Qt backend behind set_stream()."""

    def __init__(self):
        self.sources: list[str] = []
        self.played = 0

    def setSource(self, url):
        self.sources.append(str(url.toString() if hasattr(url, "toString") else url))

    def setPlaybackRate(self, rate):
        pass

    def play(self):
        self.played += 1

    def setPosition(self, ms):
        pass

    def position(self):
        return 0

    def stop(self):
        pass


def make_cached_core(tmp_path, monkeypatch, seconds: int = 0) -> PlaybackCore:
    """A core with a real Pantry attached (and crossfade armed if seconds)."""
    monkeypatch.setattr(config, "CROSSFADE_ENABLED", True)
    core = PlaybackCore()
    core.stream_cache = StreamCache(tmp_path / "pantry", max_bytes=1 << 20)
    if seconds:
        core.set_crossfade(seconds)
    return core


def test_set_stream_files_resolved_url(qapp, tmp_path, monkeypatch):
    core = make_cached_core(tmp_path, monkeypatch)
    core.start_queue([make_track(video_id="t0", title="Song 0")])
    core._player = _Backend()
    core.set_stream(core.engine.current, "https://example.com/t0")
    cached = core.stream_cache.path_for("t0")
    assert cached is not None
    assert cached.read_text(encoding="utf-8") == "https://example.com/t0"


def test_cached_stream_miss_then_hit(qapp, tmp_path, monkeypatch):
    core = make_cached_core(tmp_path, monkeypatch)
    track = make_track(video_id="t0")
    assert core.cached_stream(track) is None          # cold Pantry: a miss
    core.stream_cache.store("t0", b"https://example.com/t0")
    assert core.cached_stream(track) == "https://example.com/t0"
    assert core.cached_stream(None) is None           # no track, no lookup


def test_cache_hooks_are_noops_without_cache(qapp):
    core = PlaybackCore()
    assert core.stream_cache is None                  # flag off: never built
    assert core.cached_stream(make_track(video_id="t0")) is None
    core._cache_store("t0", "https://example.com/t0")  # silently nowhere


def test_prime_shadow_prewarms_the_pantry(qapp, tmp_path, monkeypatch):
    core = make_cached_core(tmp_path, monkeypatch, seconds=2)
    core.shadow_factory = FakeHandle
    queue = [make_track(video_id=f"t{i}", title=f"Song {i}") for i in range(3)]
    core.start_queue(queue)
    core._playing = True
    core.prime_shadow(queue[1], "https://example.com/t1")
    assert core._xf.state == "primed"
    cached = core.stream_cache.path_for("t1")
    assert cached is not None            # the pre-resolve fed the Pantry too
    assert cached.read_text(encoding="utf-8") == "https://example.com/t1"


def test_cache_write_failure_never_breaks_playback(qapp, tmp_path, monkeypatch):
    core = make_cached_core(tmp_path, monkeypatch, seconds=2)

    def boom(*_args, **_kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(core.stream_cache, "store", boom)
    core.start_queue([make_track(video_id="t0", title="Song 0")])
    core._player = _Backend()
    core.set_stream(core.engine.current, "https://example.com/t0")
    assert core._player.played == 1                     # playback unaffected
    assert core._playing
    # ...and a pre-warm with a sick Pantry still primes the shadow
    core.shadow_factory = FakeHandle
    core.enqueue(make_track(video_id="t1", title="Song 1"))
    core.prime_shadow(core.engine.upcoming[0], "https://example.com/t1")
    assert core._xf.state == "primed"


def test_cache_read_failure_is_just_a_miss(qapp, tmp_path, monkeypatch):
    core = make_cached_core(tmp_path, monkeypatch)

    def boom(*_args, **_kwargs):
        raise OSError("root vanished")

    monkeypatch.setattr(core.stream_cache, "path_for", boom)
    assert core.cached_stream(make_track(video_id="t0")) is None


def test_resolve_echo_files_fresh_url_without_reloading(qapp, tmp_path, monkeypatch):
    """Promotion echo: the app's late resolve refreshes the Pantry, not the source."""
    core = make_cached_core(tmp_path, monkeypatch, seconds=2)
    shadows: list[FakeHandle] = []

    def factory() -> FakeHandle:
        shadows.append(FakeHandle())
        return shadows[-1]

    core.shadow_factory = factory
    queue = [make_track(video_id=f"t{i}", title=f"Song {i}") for i in range(3)]
    core.start_queue(queue)
    core._playing = True
    core._xf_maybe_preresolve()
    core.prime_shadow(queue[1], "https://example.com/t1")
    core._on_end_of_media()
    for _ in range(20):                   # 2s ramp at 100ms ticks
        core._xf_tick()
    assert core.engine.current.video_id == "t1"
    # the echo of that advance lands: same track, fresher URL
    core.set_stream(queue[1], "https://example.com/t1-fresh")
    assert shadows[0].loaded == ["https://example.com/t1"]   # never reloaded
    cached = core.stream_cache.path_for("t1")
    assert cached.read_text(encoding="utf-8") == "https://example.com/t1-fresh"


# --- app wiring: the Pantry is consulted before any resolve job ---


def test_app_cache_is_opt_in(tmp_path, qapp):
    hearth = make_hearth(tmp_path)
    assert hearth.core.stream_cache is None          # flag off (default)
    hearth.shutdown()


def test_app_builds_pantry_under_data_dir(tmp_path, qapp, monkeypatch):
    monkeypatch.setattr(config, "STREAM_CACHE_ENABLED", True)
    hearth = make_hearth(tmp_path)
    assert hearth.core.stream_cache is not None
    assert hearth.core.stream_cache.root == tmp_path / "data" / "streams"
    hearth.shutdown()


def test_app_cache_hit_plays_without_resolve(tmp_path, qapp, monkeypatch):
    monkeypatch.setattr(config, "STREAM_CACHE_ENABLED", True)
    hearth = make_hearth(tmp_path)
    track = make_track(video_id="cached1", title="Cached Song")
    hearth.core.stream_cache.store("cached1", b"https://example.com/cached1")
    played: list[tuple] = []
    monkeypatch.setattr(
        hearth.core, "set_stream",
        lambda *args, **kwargs: played.append(args),
    )
    hearth._on_track_changed(track)
    # the cached direct link went straight to the player — no LoadJob,
    # no pool, not even in streaming-disabled test mode
    assert played == [(track, "https://example.com/cached1")]
    hearth.shutdown()


def test_app_cache_miss_falls_through_to_gate(tmp_path, qapp, monkeypatch):
    monkeypatch.setattr(config, "STREAM_CACHE_ENABLED", True)
    hearth = make_hearth(tmp_path)
    called: list[tuple] = []
    monkeypatch.setattr(
        hearth.core, "set_stream",
        lambda *args, **kwargs: called.append(args),
    )
    hearth._on_track_changed(make_track(video_id="cold1", title="Cold"))
    assert called == []        # miss + streaming disabled: nothing happens
    hearth.shutdown()
