"""Tests for [[DMSYS]] history import notices."""
import json

import dm_system_messages as dmsys


def test_dm_sys_content_json():
    raw = dmsys.dm_sys_content("history_locked", title="T", subtitle="S", icon="📥")
    assert raw.startswith(dmsys.DMSYS_PREFIX)
    meta = json.loads(raw[len(dmsys.DMSYS_PREFIX) :])
    assert meta["kind"] == "history_locked"
    assert meta["title"] == "T"


def test_maybe_history_sync_notice_travel_locked(monkeypatch):
    inserted = []

    def fake_insert(cid, uid, kind, **kw):
        inserted.append((cid, uid, kind, kw.get("title")))
        return 42

    monkeypatch.setattr(dmsys, "insert_dm_system_notice", fake_insert)
    out = dmsys.maybe_history_sync_notice(
        channel_id=7,
        actor_user_id=3,
        messages_applied=5,
        messages_offered=5,
        is_travel_import=True,
        source_label="frogtalk.xyz",
    )
    assert out["kind"] == "history_locked"
    assert inserted and inserted[0][2] == "history_locked"


def test_crypto_sync_content_peer_actor():
    raw = dmsys.crypto_sync_content(actor="peer", peer_nick="frog", self_nick="testy")
    meta = json.loads(raw[len(dmsys.DMSYS_PREFIX) :])
    assert meta["kind"] == "crypto_sync"
    assert "@frog" in meta["subtitle"]
    assert "Both sides synced" in meta["subtitle"]
    assert "@testy" not in meta["subtitle"]


def test_crypto_sync_content_self_actor():
    raw = dmsys.crypto_sync_content(actor="self", peer_nick="frog", self_nick="testy")
    meta = json.loads(raw[len(dmsys.DMSYS_PREFIX) :])
    assert "You refreshed" in meta["subtitle"]
    assert "@frog" in meta["subtitle"]


def test_crypto_sync_content_both_actor():
    raw = dmsys.crypto_sync_content(actor="both", peer_nick="frog", self_nick="testy")
    meta = json.loads(raw[len(dmsys.DMSYS_PREFIX) :])
    assert "you and @frog" in meta["subtitle"].lower()


def test_maybe_history_sync_notice_failed_import(monkeypatch):
    inserted = []

    def fake_insert(cid, uid, kind, **kw):
        inserted.append(kind)
        return 99

    monkeypatch.setattr(dmsys, "insert_dm_system_notice", fake_insert)
    out = dmsys.maybe_history_sync_notice(
        channel_id=2,
        actor_user_id=1,
        messages_applied=0,
        messages_offered=3,
        is_travel_import=False,
    )
    assert out["kind"] == "history_import_failed"
    assert "history_import_failed" in inserted
