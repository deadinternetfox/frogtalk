"""Device crypto transfer storage for node switch."""
import time
import uuid

import database as db


def test_store_and_take_device_crypto_transfer():
    db.init_db()
    nick = f"dct_{uuid.uuid4().hex[:10]}"
    uid = db.create_user(nick, "test-pass-123")
    assert uid
    th = "abc123tickethash"
    blob = "ZGF0YQ=="
    exp = int(time.time()) + 120
    assert db.store_device_crypto_transfer(uid, th, blob, exp)
    row = db.take_device_crypto_transfer(th)
    assert row
    assert row["blob_b64"] == blob
    assert int(row["user_id"]) == int(uid)
    assert db.take_device_crypto_transfer(th) is None


def test_expired_device_crypto_transfer_removed():
    db.init_db()
    nick = f"dctexp_{uuid.uuid4().hex[:10]}"
    uid = db.create_user(nick, "test-pass-456")
    assert uid
    th = "expiredhash"
    assert db.store_device_crypto_transfer(uid, th, "eA==", int(time.time()) - 10)
    assert db.take_device_crypto_transfer(th) is None
