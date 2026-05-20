"""Regression tests for the "JSON API drops newlines / special chars"
issue. The send/edit paths used to call `.strip()` on the stored value,
which silently chopped leading newlines and whitespace from
multi-paragraph messages. The fix keeps `.strip()` for the empty-check
only and stores the original bytes verbatim.

These tests are deliberately small and run against the public router
helpers — they don't require a live server. The broader round-trip is
covered by integration tests against a running server, but THIS file
catches the regression at the function-signature level so a future
refactor that re-introduces `.strip()` fails CI.
"""
from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


def _read_source(path: str) -> str:
    with open(os.path.join(os.path.dirname(__file__), "..", path), "r", encoding="utf-8") as f:
        return f.read()


# ---------------------------------------------------------------------------
# Static guard: the stored-content `.strip()` patterns must stay out of
# the hot send / edit paths. We allow `.strip()` for empty-checks ONLY.
# ---------------------------------------------------------------------------

FORBIDDEN_PATTERNS = [
    # Channel REST send: must not store body.content.strip()
    ("routers/messages.py", "content = body.content.strip()"),
    # Channel REST edit: must not pass body.content.strip() to db.edit_message
    ("routers/messages.py", "db.edit_message(msg_id, current_user[\"id\"], body.content.strip("),
    # DM REST edit: must not pass body.content.strip() to db.edit_dm_message
    ("routers/dms.py", "body.content.strip())"),
    # WS message handler: must not store stripped content
    ("routers/ws.py", "content = str(data.get(\"content\", \"\")).strip()"),
    # Wall post / comment: must not store stripped content
    ("routers/wall.py", "body.content.strip())"),
]


@pytest.mark.parametrize("relpath,pattern", FORBIDDEN_PATTERNS)
def test_no_strip_on_stored_content(relpath, pattern):
    src = _read_source(relpath)
    assert pattern not in src, (
        f"{relpath} still contains `{pattern}` — stored content must be "
        "preserved, only the empty-check should use `.strip()`."
    )


# ---------------------------------------------------------------------------
# Display: .msg-content must declare `white-space: pre-wrap` so newlines
# render correctly in the chat bubble.
# ---------------------------------------------------------------------------

def test_msg_content_uses_pre_wrap():
    src = _read_source("static/index.html")
    # Find the production rule (the one that sets font-size:15px etc., not
    # the simple `.msg-content{color:...}` theme rule).
    assert "font-size:15px" in src
    line_index = src.find(".msg-content{font-size:15px")
    assert line_index != -1, "expected the production .msg-content rule"
    # Slice a window around the rule and check pre-wrap is in it.
    window = src[line_index:line_index + 400]
    assert "white-space:pre-wrap" in window or "white-space: pre-wrap" in window, \
        ".msg-content must declare white-space: pre-wrap"


# ---------------------------------------------------------------------------
# WS JSON-decode errors must emit an error frame rather than silently
# dropping the message.
# ---------------------------------------------------------------------------

def test_ws_invalid_json_emits_error_frame():
    src = _read_source("routers/ws.py")
    assert "\"error\": \"invalid_json\"" in src, (
        "WebSocket JSON-decode failures should send an error frame so the "
        "client knows a message was rejected."
    )
