"""Operator-configurable contact emails and node display identity."""
from __future__ import annotations

import os
import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from starlette.requests import Request

_EMAIL_RE = re.compile(r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$")

CONTACT_KEYS = {
    "security": "site.contact.security_email",
    "privacy": "site.contact.privacy_email",
    "support": "site.contact.support_email",
    "vapid": "site.contact.vapid_email",
}

DISPLAY_NAME_KEY = "federation.display_name"

# Official defaults replaced on self-hosted nodes via admin / env.
DEFAULT_EMAILS = {
    "security": "security@frogtalk.app",
    "privacy": "privacy@frogtalk.app",
    "support": "hello@frogtalk.app",
    "vapid": "admin@frogtalk.app",
}

ENV_EMAIL_KEYS = {
    "security": "FROGTALK_SECURITY_EMAIL",
    "privacy": "FROGTALK_PRIVACY_EMAIL",
    "support": "FROGTALK_SUPPORT_EMAIL",
    "vapid": "FROGTALK_VAPID_EMAIL",
}

# Local-part used in role@domain template addresses (support → hello@).
CONTACT_LOCAL_PARTS = {
    "security": "security",
    "privacy": "privacy",
    "support": "hello",
    "vapid": "admin",
}

# Placeholders in static HTML — always replaced with this node's configured contacts.
CONTACT_PLACEHOLDERS = {
    "__FT_CONTACT_SECURITY__": "security",
    "__FT_CONTACT_PRIVACY__": "privacy",
    "__FT_CONTACT_SUPPORT__": "support",
    "__FT_CONTACT_VAPID__": "vapid",
}

LEGACY_DEFAULT_EMAILS = {
    "security": "security@frogtalk.xyz",
    "privacy": "privacy@frogtalk.xyz",
    "support": "hello@frogtalk.xyz",
    "vapid": "admin@frogtalk.xyz",
}


def normalize_email(raw: str) -> str:
    return (raw or "").strip().lower()[:254]


def validate_email(raw: str) -> str | None:
    """Return error message if invalid, else None."""
    email = normalize_email(raw)
    if not email:
        return "Email cannot be empty"
    if not _EMAIL_RE.match(email):
        return "Invalid email address"
    return None


def _env_email(kind: str) -> str:
    key = ENV_EMAIL_KEYS.get(kind) or ""
    return normalize_email(os.getenv(key, ""))


def _db_email(kind: str) -> str:
    cfg_key = CONTACT_KEYS.get(kind) or ""
    if not cfg_key:
        return ""
    try:
        import database as db

        return normalize_email(db.get_config(cfg_key) or "")
    except Exception:
        return ""


def _node_domain_email(kind: str) -> str:
    """``role@<this node's public domain>`` — the sensible default for any node
    that isn't the official hub. So a Lilypad on ``example.com`` advertises
    ``privacy@example.com`` instead of leaking the official ``@frogtalk.app``."""
    local = CONTACT_LOCAL_PARTS.get(kind) or kind
    try:
        from public_url_policy import resolve_public_site_host

        host = (resolve_public_site_host() or "").strip().lower()
    except Exception:
        host = ""
    if host.startswith("www."):
        host = host[4:]
    if not host or "." not in host or host.endswith(".onion"):
        return ""
    candidate = f"{local}@{host}"
    return candidate if validate_email(candidate) is None else ""


def resolve_contact_email(kind: str) -> str:
    """Effective email for a contact role on this node.

    Priority: explicit DB config → env var → ``role@<node domain>`` →
    the official ``@frogtalk.app`` default (only when the node has no
    resolvable public domain, e.g. onion-only or pre-config)."""
    if kind not in DEFAULT_EMAILS:
        kind = "support"
    db_val = _db_email(kind)
    if db_val:
        return db_val
    env_val = _env_email(kind)
    if env_val:
        return env_val
    node_val = _node_domain_email(kind)
    if node_val:
        return node_val
    return DEFAULT_EMAILS[kind]


def resolve_site_contacts() -> dict[str, str]:
    return {kind: resolve_contact_email(kind) for kind in DEFAULT_EMAILS}


def resolve_display_name() -> str:
    try:
        import database as db

        cfg = (db.get_config(DISPLAY_NAME_KEY) or "").strip()
        if cfg:
            return cfg[:120]
        ident = db.get_or_create_local_server_identity() or {}
        name = str(ident.get("display_name") or "").strip()
        if name:
            return name[:120]
    except Exception:
        pass
    env_name = (os.getenv("FROGTALK_SERVER_NAME") or "").strip()
    if env_name:
        return env_name[:120]
    return "FrogTalk Node"


def get_operator_site_settings() -> dict:
    """Payload for server-admin GET config."""
    try:
        import database as db

        ident = db.get_or_create_local_server_identity() or {}
        server_id = str(ident.get("server_id") or "").strip()
        base_url = str(ident.get("base_url") or "").strip()
        onion_url = str(ident.get("onion_url") or "").strip()
    except Exception:
        server_id = base_url = onion_url = ""

    contacts = resolve_site_contacts()
    configured = {kind: bool(_db_email(kind)) for kind in DEFAULT_EMAILS}
    return {
        "display_name": resolve_display_name(),
        "server_id": server_id,
        "base_url": base_url,
        "onion_url": onion_url,
        "contacts": contacts,
        "contacts_configured_in_db": configured,
        "defaults": dict(DEFAULT_EMAILS),
    }


def set_operator_site_settings(
    *,
    display_name: str | None = None,
    security_email: str | None = None,
    privacy_email: str | None = None,
    support_email: str | None = None,
    vapid_email: str | None = None,
) -> dict:
    import database as db

    errors: dict[str, str] = {}
    updates: dict[str, str] = {}

    if display_name is not None:
        name = str(display_name or "").strip()[:120]
        if not name:
            errors["display_name"] = "Display name cannot be empty"
        else:
            db.set_config(DISPLAY_NAME_KEY, name)

    for kind, value in (
        ("security", security_email),
        ("privacy", privacy_email),
        ("support", support_email),
        ("vapid", vapid_email),
    ):
        if value is None:
            continue
        raw = str(value or "").strip()
        if not raw:
            db.set_config(CONTACT_KEYS[kind], "")
            continue
        err = validate_email(raw)
        if err:
            errors[kind + "_email"] = err
        else:
            norm = normalize_email(raw)
            db.set_config(CONTACT_KEYS[kind], norm)
            updates[kind] = norm

    if errors:
        return {"ok": False, "errors": errors}

    return {"ok": True, "site_settings": get_operator_site_settings(), "updated": updates}


def vapid_mailto_uri() -> str:
    return f"mailto:{resolve_contact_email('vapid')}"


def vapid_claims() -> dict[str, str]:
    return {"sub": vapid_mailto_uri()}


def _contact_template_addresses(kind: str) -> set[str]:
    """Known template addresses that may appear in static HTML before substitution."""
    local = CONTACT_LOCAL_PARTS.get(kind) or kind
    variants: set[str] = set()
    for domain in ("frogtalk.app", "frogtalk.xyz"):
        variants.add(f"{local}@{domain}")
    try:
        from public_url_policy import resolve_public_site_host

        host = (resolve_public_site_host() or "").strip().lower()
        if host and host not in ("frogtalk.app", "www.frogtalk.app", "frogtalk.xyz", "www.frogtalk.xyz"):
            variants.add(f"{local}@{host}")
    except Exception:
        pass
    default = DEFAULT_EMAILS.get(kind) or ""
    legacy = LEGACY_DEFAULT_EMAILS.get(kind) or ""
    if default:
        variants.add(default)
    if legacy:
        variants.add(legacy)
    return variants


def _apply_contact_replacement(out: str, old: str, current: str) -> str:
    if not old or not current or old not in out:
        return out
    out = out.replace(old, current)
    out = out.replace(f"mailto:{old}", f"mailto:{current}")
    return out


def substitute_contacts_in_text(text: str) -> str:
    """Replace contact placeholders and template emails with this node's configured values."""
    out = text or ""
    contacts = resolve_site_contacts()
    for placeholder, kind in CONTACT_PLACEHOLDERS.items():
        current = contacts.get(kind) or DEFAULT_EMAILS[kind]
        out = out.replace(placeholder, current)
    for kind in DEFAULT_EMAILS:
        current = contacts.get(kind) or DEFAULT_EMAILS[kind]
        for old in _contact_template_addresses(kind):
            out = _apply_contact_replacement(out, old, current)
    return out


def substitute_operator_content(text: str, *, request: Request | None = None) -> str:
    from public_url_policy import substitute_site_url_in_text

    body = substitute_site_url_in_text(text, request=request)
    return substitute_contacts_in_text(body)
