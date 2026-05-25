"""Optional federation mesh config (directory hub, seed peers, URL repairs).

Operators copy ``node/deploy/federation-mesh.example.json`` to a local path
(never commit secrets) and set ``FROGTALK_FEDERATION_MESH_FILE``. The FrogTalk
public fleet example lives in ``federation-mesh.frogtalk.example.json``.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

from public_url_policy import hostname_from_url, normalize_public_url

_log = logging.getLogger(__name__)

_MESH_CACHE: dict | None = None


def _truthy(raw: str | None) -> bool:
    return (raw or "").strip().lower() in ("1", "true", "yes", "on")


def _default_mesh_path() -> Path:
    return Path(__file__).resolve().parent / "deploy" / "federation-mesh.example.json"


def _resolve_mesh_path() -> Path | None:
    raw = (os.getenv("FROGTALK_FEDERATION_MESH_FILE") or "").strip()
    if raw:
        p = Path(raw).expanduser()
        return p if p.is_file() else None
    inline = (os.getenv("FROGTALK_FEDERATION_MESH_JSON") or "").strip()
    if inline:
        return None
    return None


def load_mesh_config(*, reload: bool = False) -> dict:
    """Return mesh config dict (empty sections if unset)."""
    global _MESH_CACHE
    if _MESH_CACHE is not None and not reload:
        return _MESH_CACHE

    data: dict[str, Any] = {
        "directory_hub_hosts": [],
        "ensure_peers": [],
        "clearnet_repairs": [],
        "fallback_peers": [],
    }

    inline = (os.getenv("FROGTALK_FEDERATION_MESH_JSON") or "").strip()
    if inline:
        try:
            parsed = json.loads(inline)
            if isinstance(parsed, dict):
                data = _normalize_mesh_dict(parsed)
        except json.JSONDecodeError as e:
            _log.warning("federation_mesh: invalid FROGTALK_FEDERATION_MESH_JSON: %s", e)
        _MESH_CACHE = data
        return data

    path = _resolve_mesh_path()
    if path is None:
        _MESH_CACHE = data
        return data

    try:
        with path.open(encoding="utf-8") as f:
            parsed = json.load(f)
        if isinstance(parsed, dict):
            data = _normalize_mesh_dict(parsed)
    except Exception as e:
        _log.warning("federation_mesh: could not read %s: %s", path, e)

    _MESH_CACHE = data
    return data


def _normalize_mesh_dict(raw: dict) -> dict:
    out = {
        "directory_hub_hosts": [],
        "ensure_peers": [],
        "clearnet_repairs": [],
        "fallback_peers": [],
    }
    hosts = raw.get("directory_hub_hosts")
    if isinstance(hosts, list):
        out["directory_hub_hosts"] = [
            str(h).strip().lower() for h in hosts if str(h).strip()
        ]
    for key in ("ensure_peers", "fallback_peers"):
        items = raw.get(key)
        if isinstance(items, list):
            out[key] = [p for p in items if isinstance(p, dict)]
    repairs = raw.get("clearnet_repairs")
    if isinstance(repairs, list):
        out["clearnet_repairs"] = [r for r in repairs if isinstance(r, dict)]
    return out


def directory_hub_hosts() -> list[str]:
    """Hostnames that identify this install as the official directory hub."""
    mesh = load_mesh_config()
    hosts = list(mesh.get("directory_hub_hosts") or [])
    if hosts:
        return hosts
    if _truthy(os.getenv("FROGTALK_FEDERATION_DIRECTORY_HUB")):
        for key in ("FROGTALK_SITE_URL", "SITE_URL", "PUBLIC_URL", "FROGTALK_BASE_URL"):
            host = hostname_from_url(os.getenv(key, ""))
            if host:
                hosts.append(host.lower())
        return list(dict.fromkeys(hosts))
    return []


def is_directory_hub() -> bool:
    """True when this node may seed mesh peers and run directory URL repairs."""
    if _truthy(os.getenv("FROGTALK_FEDERATION_DIRECTORY_HUB")):
        return True
    hub_hosts = set(directory_hub_hosts())
    if not hub_hosts:
        return False
    for key in ("FROGTALK_SITE_URL", "SITE_URL", "PUBLIC_URL", "FROGTALK_BASE_URL"):
        host = hostname_from_url(os.getenv(key, ""))
        if host and host.lower() in hub_hosts:
            return True
    try:
        import database as db

        local = db.get_or_create_local_server_identity() or {}
        base = normalize_public_url(str(local.get("base_url") or ""))
        host = hostname_from_url(base)
        if host and host.lower() in hub_hosts:
            return True
    except Exception:
        pass
    return False


def ensure_peers() -> list[dict]:
    return list(load_mesh_config().get("ensure_peers") or [])


def fallback_peers() -> list[dict]:
    mesh = load_mesh_config()
    fb = list(mesh.get("fallback_peers") or [])
    if fb:
        return fb
    return list(mesh.get("ensure_peers") or [])


def clearnet_repairs() -> list[dict]:
    return list(load_mesh_config().get("clearnet_repairs") or [])


def tor_mirror_server_ids() -> set[str]:
    """Server IDs from mesh config that are onion-primary directory rows."""
    out: set[str] = set()
    for item in ensure_peers():
        sid = str(item.get("server_id") or "").strip()
        if not sid:
            continue
        onion = (str(item.get("onion_url") or "").strip())
        base = normalize_public_url(str(item.get("base_url") or ""))
        transport = str(item.get("transport_preference") or "").strip().lower()
        if onion and (not base or transport == "onion"):
            out.add(sid)
    return out


def builtin_tor_mirror_peer() -> dict | None:
    """First onion-primary ensure_peer, for hybrid network picker injection."""
    for item in ensure_peers():
        sid = str(item.get("server_id") or "").strip()
        onion = str(item.get("onion_url") or "").strip()
        if not sid or not onion.startswith("http"):
            continue
        base = normalize_public_url(str(item.get("base_url") or ""))
        transport = str(item.get("transport_preference") or "").strip().lower()
        if base and transport != "onion":
            continue
        return dict(item)
    return None
