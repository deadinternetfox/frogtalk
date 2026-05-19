"""Validation tests for channel profile/listing input hardening."""
from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from routers.directory import _sanitize_directory_tags  # noqa: E402
from routers.rooms import _normalize_room_banner, _normalize_room_icon, _sanitize_room_text  # noqa: E402


def test_room_icon_rejects_placeholder_ascii():
    with pytest.raises(ValueError):
        _normalize_room_icon("_")


def test_room_icon_accepts_absolute_path_image():
    out = _normalize_room_icon("/uploads/rooms/icon.webp?v=2")
    assert out == "/uploads/rooms/icon.webp?v=2"


@pytest.mark.parametrize(
    "value",
    [
        "javascript:alert(1)",
        "https://example.com/x) y",
        "/uploads/<bad>.png",
    ],
)
def test_room_banner_rejects_unsafe_values(value: str):
    with pytest.raises(ValueError):
        _normalize_room_banner(value)


def test_room_banner_accepts_safe_http_url():
    out = _normalize_room_banner("https://cdn.example.com/ch/banner.webp")
    assert out == "https://cdn.example.com/ch/banner.webp"


def test_room_text_strips_invisible_controls():
    raw = "\u2064does noone check these?\u202e"
    out = _sanitize_room_text(raw, max_len=64, multiline=False)
    assert out == "does noone check these?"


def test_directory_tags_are_normalized_and_deduped():
    tags = [" Social ", "social", "red-team", "xss!", "", "__"]
    out = _sanitize_directory_tags(tags)
    assert out == ["social", "red-team", "__"]
