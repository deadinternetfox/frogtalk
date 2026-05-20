"""Logging-redaction filter (9th-pass hardening).

Installs a single logging.Filter onto the root logger so every emitted
log record (frogtalk app, uvicorn.access, uvicorn.error, slowapi, etc.)
has sensitive substrings scrubbed before it lands on disk / journalctl.

What it scrubs
==============
- ``token=…``, ``bridge_token=…``, ``password=…``, ``pin=…``,
  ``current_password=…``, ``new_password=…`` query-string / form params.
- ``Authorization: Bearer …`` and ``X-Session-Token: …`` header lines.
- Anything that looks like a Telegram bot token (``\\d+:[A-Za-z0-9_-]{30,}``).
- Anything that looks like a Discord bot token (3 base64 chunks, dots).
- Bare 32+ char hex / urlsafe blobs that follow a sensitive keyword.
- IPv4 / IPv6 addresses → ``ip:<8-char sha256 prefix>`` so logs keep
  per-host correlation without storing raw client IPs.

Design notes
============
- Pure Python regex, no allocation when no match → cheap to leave on.
- Applied at the *Filter* layer, not the *Formatter* layer, so structured
  args are also rewritten before %-formatting (otherwise tokens passed
  via ``log.info("token=%s", t)`` would slip through).
- Idempotent: running the substitution twice produces the same string.
"""

from __future__ import annotations

import hashlib
import logging
import re
from typing import Iterable


_REDACTED = "<redacted>"


# Compiled once at import time.
_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    # query-string / form / json-ish key=value pairs
    (re.compile(
        r"(?i)\b(?:token|bridge_token|api[_-]?key|password|passwd|pwd|pin|"
        r"current_password|new_password|secret|access_token|refresh_token|"
        r"session_token|x-session-token|fcm_token|push_token)\s*[=:]\s*"
        r"['\"]?([A-Za-z0-9._\-+/=:]{4,})['\"]?",
    ), lambda m: m.group(0).replace(m.group(1), _REDACTED)),

    # Authorization: Bearer xyz
    (re.compile(r"(?i)(authorization\s*[:=]\s*(?:bearer|basic|token)\s+)([A-Za-z0-9._\-+/=]+)"),
     lambda m: m.group(1) + _REDACTED),

    # Telegram bot token format: 1234567890:AA...
    (re.compile(r"\b\d{6,}:[A-Za-z0-9_\-]{30,}\b"),
     lambda _m: _REDACTED),

    # Discord bot token format: <base64>.<base64>.<base64>
    (re.compile(r"\b[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{20,}\b"),
     lambda _m: _REDACTED),

    # Fernet ciphertext (begins with 'gAAAAA' base64) — drop entirely
    (re.compile(r"\bgAAAAA[A-Za-z0-9_\-=]{40,}\b"),
     lambda _m: _REDACTED),
)


# IPv4 / IPv6 hashed to a short stable prefix so log lines keep grouping
# without storing the raw IP. Loopback + 0.0.0.0 are kept verbatim because
# they're not PII and they're useful for debugging.
_IPV4_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
_IPV6_RE = re.compile(r"\b(?:[A-Fa-f0-9]{0,4}:){2,7}[A-Fa-f0-9]{0,4}\b")
_IP_KEEP = {"127.0.0.1", "0.0.0.0", "::1", "::"}


def _hash_ip(match: re.Match[str]) -> str:
    raw = match.group(0)
    if raw in _IP_KEEP:
        return raw
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:8]
    return f"ip:{digest}"


def redact(text: str) -> str:
    """Apply every redaction rule to *text* and return the scrubbed copy."""
    if not text or not isinstance(text, str):
        return text
    out = text
    for pat, repl in _PATTERNS:
        try:
            out = pat.sub(repl, out)
        except Exception:
            # Any pathological input shouldn't ever break a log call.
            continue
    out = _IPV4_RE.sub(_hash_ip, out)
    out = _IPV6_RE.sub(_hash_ip, out)
    return out


class RedactionFilter(logging.Filter):
    """Drop-in filter: rewrites msg + args in place, never raises."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            if isinstance(record.msg, str):
                record.msg = redact(record.msg)
            if record.args:
                if isinstance(record.args, dict):
                    record.args = {
                        k: redact(v) if isinstance(v, str) else v
                        for k, v in record.args.items()
                    }
                elif isinstance(record.args, tuple):
                    record.args = tuple(
                        redact(a) if isinstance(a, str) else a
                        for a in record.args
                    )
        except Exception:
            pass
        return True


_INSTALLED = False

def install(extra_loggers: Iterable[str] = ()) -> None:
    """Attach :class:`RedactionFilter` to the root logger and, defensively,
    to the named uvicorn / slowapi loggers so even loggers that bypass
    propagation get scrubbed. Safe to call repeatedly."""
    global _INSTALLED
    if _INSTALLED:
        return
    flt = RedactionFilter()
    logging.getLogger().addFilter(flt)
    for name in (
        "uvicorn", "uvicorn.access", "uvicorn.error",
        "fastapi", "starlette", "slowapi", "frogtalk",
        *extra_loggers,
    ):
        try:
            logging.getLogger(name).addFilter(flt)
        except Exception:
            continue
    _INSTALLED = True
