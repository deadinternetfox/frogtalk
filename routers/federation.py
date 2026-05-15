"""Federation and network discovery routes (phase-1 scaffold)."""
import base64
import logging
import os
import time
import asyncio
import ipaddress
import json
import hashlib
import secrets
import socket
import urllib.request
import urllib.error
import urllib.parse
import httpx
from pathlib import Path
import tempfile
import shutil
import subprocess
from datetime import datetime, timezone
from fastapi import APIRouter, Header, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import database as db
import crypto_fed

router = APIRouter(tags=["federation"])
_log = logging.getLogger(__name__)


class ServerRegisterBody(BaseModel):
    server_id: str
    display_name: str
    base_url: str
    onion_url: str = ""
    region: str = ""
    official: bool = False
    trust_tier: str = "community"
    server_pubkey: str = ""
    capabilities: list[str] = []


class FederationInboxBody(BaseModel):
    events: list[dict]


class IdentityPubKeyBody(BaseModel):
    identity_pubkey: str


class BuildManifestBody(BaseModel):
    platform: str  # "web" | "desktop" | "android" | "ios"
    version: str
    build_hash: str
    signer: str = ""
    signature: str = ""
    official: bool = False


class FederationOutboxEventBody(BaseModel):
    event_type: str
    payload: dict


class PeerBuildVerifyBody(BaseModel):
    base_urls: list[str] = []


class UpdatePublishBody(BaseModel):
    version: str
    package_url: str
    package_sha256: str
    build_hash: str = ""
    notes: str = ""


class UpdateApplyBody(BaseModel):
    force: bool = False


def _normalize_base_url(url: str) -> str:
    return (url or "").strip().rstrip("/")


def enqueue_server_event(event_type: str, payload: dict) -> dict:
    local = db.get_or_create_local_server_identity()
    # Random suffix prevents same-millisecond collisions when multiple
    # events are enqueued in quick succession (e.g. burst of bot upserts
    # or message bridges). Origin+event_id is the idempotency key on
    # the receiving side, so a duplicate id would silently drop the
    # second event.
    event_id = f"evt_{int(time.time() * 1000):016x}_{secrets.token_hex(4)}"
    normalized_type = str(event_type or "").strip()
    if not normalized_type:
        return {"ok": False, "error": "missing_event_type"}

    event = {
        "event_id": event_id,
        "event_type": normalized_type,
        "event_version": 1,
        "origin_server_id": local["server_id"],
        "origin_time": datetime.utcnow().isoformat() + "Z",
        "actor_global_user_id": "server-admin",
        "payload": payload or {},
        "signature": "",
    }
    # Ed25519-sign every event so receivers can prove the origin_server_id
    # claim. Signature failures here are non-fatal (event still gets
    # enqueued unsigned) because we'd rather degrade open than drop
    # legitimate traffic if the local keystore is briefly unreadable;
    # peers with REQUIRE_SIGS=1 will then reject it.
    try:
        crypto_fed.sign_event(event)
    except Exception:
        _log.exception("failed to sign outbox event %s", event_id)
    if db.insert_federation_outbox_event(event):
        return {"ok": True, "event_id": event_id}
    return {"ok": False, "error": "enqueue_failed"}


def _tor_proxy_url() -> str:
    return (os.getenv("FROGTALK_TOR_SOCKS_PROXY") or "socks5://127.0.0.1:9050").strip()


def _url_uses_tor(url: str) -> bool:
    try:
        host = (urllib.parse.urlparse(url).hostname or "").strip().lower()
    except Exception:
        host = ""
    return host.endswith(".onion")


class _UnsafeURLError(ValueError):
    """Raised when a federation/peer URL fails the SSRF allowlist."""


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuses to auto-follow redirects.

    Otherwise an attacker-controlled peer URL could 302 us to
    ``http://169.254.169.254/`` after passing the initial IP check.
    Callers wanting to follow redirects must re-validate the new
    target URL through ``_assert_safe_url`` before re-issuing.
    """
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise _UnsafeURLError(f"redirects not allowed (got {code} -> {newurl})")


def _assert_safe_url(url: str) -> None:
    """SSRF allowlist for outbound federation/peer fetches.

    Tor (.onion) hosts skip the IP check — they can't resolve to a
    routable IP anyway, and we want to be able to talk to peer onions.
    Everything else: scheme must be http/https and every resolved
    address has to be a globally routable unicast IP.
    """
    try:
        parsed = urllib.parse.urlsplit(url)
    except Exception as exc:
        raise _UnsafeURLError(f"unparseable URL: {exc}") from exc
    scheme = (parsed.scheme or "").lower()
    if scheme not in ("http", "https"):
        raise _UnsafeURLError(f"scheme {scheme!r} not allowed")
    host = (parsed.hostname or "").strip()
    if not host:
        raise _UnsafeURLError("missing host")
    if host.lower().endswith(".onion"):
        # .onion hosts route via Tor; the IP filter doesn't apply.
        return
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise _UnsafeURLError(f"DNS failed for {host}: {exc}") from exc
    seen_any = False
    for family, _stype, _proto, _canon, sockaddr in infos:
        if not sockaddr:
            continue
        ip_str = sockaddr[0]
        try:
            ip = ipaddress.ip_address(ip_str)
        except ValueError:
            continue
        seen_any = True
        # Block any non-globally-routable address. is_global is the most
        # conservative check available; it rules out private, loopback,
        # link-local, multicast, reserved and unspecified ranges.
        if not ip.is_global:
            raise _UnsafeURLError(f"resolved IP {ip_str} for {host} is not globally routable")
    if not seen_any:
        raise _UnsafeURLError(f"no usable IPs for {host}")


def _fetch_url_bytes(
    url: str,
    *,
    timeout_s: float = 4.5,
    method: str = "GET",
    headers: dict | None = None,
    data: bytes | None = None,
) -> bytes:
    # SSRF allowlist runs first regardless of transport. We only do this
    # for outbound peer fetches — user-supplied URLs (link previews,
    # imageboard, etc.) have their own checks elsewhere.
    _assert_safe_url(url)
    if _url_uses_tor(url):
        # follow_redirects=False so a malicious onion can't bounce us
        # to a clearnet attacker target after the SSRF check passed.
        with httpx.Client(proxy=_tor_proxy_url(), timeout=timeout_s, follow_redirects=False) as client:
            resp = client.request(method, url, headers=headers, content=data)
            resp.raise_for_status()
            return resp.content

    req = urllib.request.Request(url, headers=headers or {}, data=data, method=method)
    opener = urllib.request.build_opener(_NoRedirectHandler())
    with opener.open(req, timeout=timeout_s) as resp:
        return resp.read()


def _select_peer_target(server: dict) -> str:
    # Prefer transport_preference already on the row (avoids per-peer DB roundtrip
    # when called in a hot loop). Fall back to a single SELECT only if missing.
    transport_raw = server.get("transport_preference")
    if transport_raw is None:
        transport_raw = db.get_federation_server_transport(str(server.get("server_id") or ""))
    transport = str(transport_raw or "auto").strip().lower()
    base_url = _normalize_base_url(str(server.get("base_url") or ""))
    onion_url = _normalize_base_url(str(server.get("onion_url") or ""))
    tor_enabled = _tor_mode_enabled()

    if transport == "onion" and onion_url:
        return onion_url
    if transport == "clearnet" and base_url:
        return base_url
    if transport == "auto" and tor_enabled and onion_url:
        return onion_url
    return base_url or onion_url


def _tor_mode_enabled() -> bool:
    return (os.getenv("FROGTALK_TOR_ENABLED", "0") or "0").strip().lower() in ("1", "true", "yes", "on")


def _server_advertises_onion_only(server: dict) -> bool:
    onion_url = _normalize_base_url(str(server.get("onion_url") or ""))
    if not onion_url:
        return False
    if not _normalize_base_url(str(server.get("base_url") or "")):
        return True
    transport = str(server.get("transport_preference") or "").strip().lower()
    return transport == "onion"


def _public_server_target(server: dict) -> str:
    onion_url = _normalize_base_url(str(server.get("onion_url") or ""))
    base_url = _normalize_base_url(str(server.get("base_url") or ""))
    if _server_advertises_onion_only(server):
        return onion_url or base_url
    return base_url or onion_url


def _public_server_view(server: dict, *, onion_only: bool | None = None) -> dict:
    public = dict(server)
    onion_url = _normalize_base_url(str(public.get("onion_url") or ""))
    base_url = _normalize_base_url(str(public.get("base_url") or ""))
    if onion_only is None:
        onion_only = _server_advertises_onion_only(public)
    public["onion_url"] = onion_url
    public["base_url"] = "" if (onion_only and onion_url) else base_url
    return public


def _probe_url(base_url: str, timeout_s: float = 1.2) -> dict:
    start = time.perf_counter()
    target = _normalize_base_url(base_url)
    if not target:
        return {"ok": False, "latency_ms": None, "error": "missing_base_url"}
    try:
        _fetch_url_bytes(
            f"{target}/api/network/status",
            timeout_s=timeout_s,
            headers={"User-Agent": "FrogTalk-Probe/1.0"},
            method="GET",
        )
        ok = True
        latency_ms = int((time.perf_counter() - start) * 1000)
        return {"ok": ok, "latency_ms": latency_ms, "error": None if ok else "status_not_ok"}
    except urllib.error.URLError as e:
        return {"ok": False, "latency_ms": None, "error": str(e.reason)}
    except Exception as e:
        return {"ok": False, "latency_ms": None, "error": str(e)}


def _local_web_build_info() -> dict:
    """Compute deterministic web bundle hash for legitimacy checks across servers."""
    root = Path(__file__).resolve().parent.parent
    files = [root / "static" / "index.html"]
    js_dir = root / "static" / "js"
    if js_dir.exists():
        files.extend(sorted(js_dir.glob("*.js"), key=lambda p: p.name.lower()))

    h = hashlib.sha256()
    for fp in files:
        if not fp.exists() or not fp.is_file():
            continue
        h.update(fp.name.encode("utf-8", errors="ignore"))
        with open(fp, "rb") as f:
            while True:
                chunk = f.read(65536)
                if not chunk:
                    break
                h.update(chunk)

    version = os.getenv("FROGTALK_WEB_BUILD_VERSION", "web-prod")
    build_hash = h.hexdigest()
    official = db.is_official_build("web", version, build_hash)
    return {
        "platform": "web",
        "version": version,
        "build_hash": build_hash,
        "official": bool(official),
    }


def _get_update_feed_url() -> str:
    return (os.getenv("FROGTALK_UPDATE_FEED_URL", "https://frogtalk.xyz/api/network/updates/latest") or "").strip()


def _fetch_update_manifest(feed_url: str, timeout_s: float = 4.0) -> dict:
    raw = _fetch_url_bytes(
        feed_url,
        timeout_s=timeout_s,
        headers={"User-Agent": "FrogTalk-Updater/1.0", "Accept": "application/json"},
        method="GET",
    ).decode("utf-8", errors="replace")
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ValueError("invalid update manifest")
    return payload


def _sha256_of_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(65536)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def _download_update_package(url: str, target_path: str, timeout_s: float = 15.0) -> None:
    raw = _fetch_url_bytes(url, timeout_s=timeout_s, headers={"User-Agent": "FrogTalk-Updater/1.0"}, method="GET")
    with open(target_path, "wb") as out:
        out.write(raw)


def _apply_package_archive(archive_path: str) -> dict:
    install_dir = (os.getenv("FROGTALK_INSTALL_DIR", "/opt/frogtalk") or "/opt/frogtalk").strip()
    service_name = (os.getenv("FROGTALK_SERVICE_NAME", "frogtalk") or "frogtalk").strip()

    work_dir = tempfile.mkdtemp(prefix="frogtalk-update-")
    try:
        shutil.unpack_archive(archive_path, work_dir)
        entries = [e for e in Path(work_dir).iterdir()]
        src_root = entries[0] if len(entries) == 1 and entries[0].is_dir() else Path(work_dir)
        rsync_cmd = [
            "rsync", "-a", "--delete",
            "--exclude", ".env",
            "--exclude", "data/",
            "--exclude", "venv/",
            "--exclude", ".venv/",
            f"{str(src_root).rstrip('/')}/",
            f"{install_dir.rstrip('/')}/",
        ]
        cp = subprocess.run(rsync_cmd, capture_output=True, text=True)
        if cp.returncode != 0:
            return {"ok": False, "error": f"rsync_failed: {cp.stderr.strip()}"}

        pip_bin = f"{install_dir.rstrip('/')}/venv/bin/pip"
        if Path(pip_bin).exists() and Path(f"{install_dir.rstrip('/')}/requirements.txt").exists():
            subprocess.run([pip_bin, "install", "-r", f"{install_dir.rstrip('/')}/requirements.txt"], capture_output=True, text=True)

        rc = subprocess.run(["systemctl", "restart", service_name], capture_output=True, text=True)
        if rc.returncode != 0:
            return {"ok": False, "error": f"restart_failed: {rc.stderr.strip()}"}
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


def _check_update_once(auto_apply: bool = False) -> dict:
    feed_url = _get_update_feed_url()
    local = _local_web_build_info()
    now = str(int(time.time()))

    if not feed_url:
        return {"ok": False, "error": "update_feed_not_configured"}

    # Self-loop guard: if the configured feed URL points back at this very
    # server (the common case on the main site itself), skip the outbound
    # HTTPS round-trip. With a single uvicorn worker this would otherwise
    # deadlock the event loop on itself via nginx loopback. Read the local
    # feed config rows directly instead — semantically identical.
    try:
        from urllib.parse import urlparse as _urlparse
        feed_host = (_urlparse(feed_url).hostname or "").lower()
        own_hosts = {"127.0.0.1", "localhost", "::1"}
        try:
            local_ident = db.get_or_create_local_server_identity() or {}
            own_base = (local_ident.get("base_url") or "").strip()
            if own_base:
                own_hosts.add((_urlparse(own_base).hostname or "").lower())
        except Exception:
            pass
        env_host = (_urlparse(os.getenv("FROGTALK_PUBLIC_BASE_URL", "") or "").hostname or "").lower()
        if env_host:
            own_hosts.add(env_host)
        if feed_host and feed_host in own_hosts:
            latest = {
                "version": db.get_config("update.feed.version") or "",
                "package_url": db.get_config("update.feed.package_url") or "",
                "package_sha256": db.get_config("update.feed.package_sha256") or "",
                "build_hash": db.get_config("update.feed.build_hash") or "",
                "notes": db.get_config("update.feed.notes") or "",
                "published_at": db.get_config("update.feed.published_at") or "",
            }
            db.set_config("update.last_checked_at", now)
            db.set_config("update.last_error", "")
            return {
                "ok": True,
                "feed_url": feed_url,
                "local": local,
                "latest": latest,
                "update_available": False,
                "applied": None,
                "self_loop_skipped": True,
            }
    except Exception:
        pass

    try:
        latest = _fetch_update_manifest(feed_url)
    except Exception as e:
        db.set_config("update.last_checked_at", now)
        db.set_config("update.last_error", str(e))
        return {"ok": False, "error": str(e), "local": local}

    latest_hash = str(latest.get("build_hash") or "").strip().lower()
    local_hash = str(local.get("build_hash") or "").strip().lower()
    update_available = bool(latest_hash and local_hash and latest_hash != local_hash)

    db.set_config("update.last_checked_at", now)
    db.set_config("update.last_error", "")
    db.set_config("update.latest.version", str(latest.get("version") or ""))
    db.set_config("update.latest.package_url", str(latest.get("package_url") or ""))
    db.set_config("update.latest.package_sha256", str(latest.get("package_sha256") or ""))
    db.set_config("update.latest.build_hash", str(latest.get("build_hash") or ""))
    db.set_config("update.available", "1" if update_available else "0")

    applied = None
    if update_available and auto_apply:
        pkg_url = str(latest.get("package_url") or "").strip()
        pkg_sha = str(latest.get("package_sha256") or "").strip().lower()
        if pkg_url and pkg_sha:
            tmp = tempfile.mktemp(prefix="frogtalk-update-", suffix=".tar.gz")
            try:
                _download_update_package(pkg_url, tmp)
                got_sha = _sha256_of_file(tmp).lower()
                if got_sha != pkg_sha:
                    applied = {"ok": False, "error": "sha256_mismatch"}
                else:
                    applied = _apply_package_archive(tmp)
            except Exception as e:
                applied = {"ok": False, "error": str(e)}
            finally:
                try:
                    os.remove(tmp)
                except Exception:
                    pass
            db.set_config("update.last_apply_at", str(int(time.time())))
            db.set_config("update.last_apply_status", "ok" if applied and applied.get("ok") else (applied or {}).get("error", "failed"))

    return {
        "ok": True,
        "feed_url": feed_url,
        "local": local,
        "latest": latest,
        "update_available": update_available,
        "applied": applied,
    }


def _fed_token_ok(token: str | None) -> bool:
    expected = os.getenv("FROGTALK_FEDERATION_TOKEN", "").strip()
    if not expected:
        return False
    return (token or "").strip() == expected


async def _current_user_from_header(x_session_token: str | None) -> dict | None:
    # Threadpool-hop so the sync sqlite lookup doesn't block the event
    # loop on hot federation routes (peer ping, build verify, etc.
    # all call this on every request).
    if not x_session_token:
        return None
    return await asyncio.to_thread(db.get_user_by_token, x_session_token)


def _load_directory_entries(directory_url: str, timeout_s: float = 4.0) -> list[dict]:
    raw = _fetch_url_bytes(
        directory_url,
        timeout_s=timeout_s,
        headers={"User-Agent": "FrogTalk-DirectorySync/1.0", "Accept": "application/json"},
        method="GET",
    ).decode("utf-8", errors="replace")
    payload = json.loads(raw)
    if isinstance(payload, list):
        return [p for p in payload if isinstance(p, dict)]
    if isinstance(payload, dict):
        servers = payload.get("servers")
        if isinstance(servers, list):
            return [p for p in servers if isinstance(p, dict)]
    return []


def _coerce_server_row(item: dict) -> dict | None:
    server_id = str(item.get("server_id") or item.get("id") or "").strip()
    base_url = _normalize_base_url(str(item.get("base_url") or item.get("url") or "").strip())
    onion_url = str(item.get("onion_url") or item.get("onion") or "").strip()
    if not server_id or not (base_url or onion_url):
        return None
    display_name = str(item.get("display_name") or item.get("name") or server_id).strip()
    region = str(item.get("region") or "").strip()
    server_pubkey = str(item.get("server_pubkey") or item.get("pubkey") or "").strip()
    caps = item.get("capabilities")
    if not isinstance(caps, list):
        caps = []
    return {
        "server_id": server_id,
        "display_name": display_name,
        "base_url": base_url,
        "onion_url": onion_url,
        "region": region,
        "server_pubkey": server_pubkey,
        "capabilities": [str(c).strip() for c in caps if str(c).strip()],
    }


async def sync_official_directory_once(directory_url: str | None = None) -> dict:
    url = (directory_url or os.getenv("FROGTALK_OFFICIAL_DIRECTORY_URL", "")).strip()
    if not url:
        return {"ok": False, "imported": 0, "skipped": 0, "error": "directory_url_not_set"}

    try:
        entries = await asyncio.to_thread(_load_directory_entries, url)
    except Exception as e:
        return {"ok": False, "imported": 0, "skipped": 0, "error": str(e)}

    imported = 0
    skipped = 0
    for item in entries:
        row = _coerce_server_row(item)
        if not row:
            skipped += 1
            continue
        db.upsert_federation_server(
            server_id=row["server_id"],
            display_name=row["display_name"],
            base_url=row["base_url"],
            onion_url=row["onion_url"],
            region=row["region"],
            official=True,
            trust_tier="official",
            server_pubkey=row["server_pubkey"],
            capabilities=row["capabilities"],
        )
        imported += 1

    db.set_config("federation.official_directory_last_sync", str(int(time.time())))
    return {
        "ok": True,
        "directory_url": url,
        "imported": imported,
        "skipped": skipped,
        "total": len(entries),
    }


@router.get("/network/status")
async def network_status():
    local = db.get_or_create_local_server_identity()
    public = _public_server_view(local, onion_only=_tor_mode_enabled())
    # Expose the local node's federation signing pubkey so peer admins
    # can pin it when registering us. We never expose the private key.
    try:
        local_pubkey_pem = crypto_fed.get_local_public_key_pem()
        local_pubkey_fp = crypto_fed.get_local_public_key_fingerprint()
    except Exception:
        local_pubkey_pem = ""
        local_pubkey_fp = ""
    return {
        "server": {
            "server_id": public["server_id"],
            "display_name": public["display_name"],
            "base_url": public["base_url"],
            "onion_url": public["onion_url"],
            "federation_enabled": os.getenv("FROGTALK_FEDERATION_ENABLED", "0") in ("1", "true", "yes"),
            "tor_enabled": os.getenv("FROGTALK_TOR_ENABLED", "0") in ("1", "true", "yes"),
            "federation_pubkey_pem": local_pubkey_pem,
            "federation_pubkey_fingerprint": local_pubkey_fp,
        }
    }


@router.get("/network/servers")
async def list_network_servers(request: Request, official_only: int = 0):
    rows = [_public_server_view(row) for row in db.list_federation_servers(official_only=bool(official_only))]
    local = db.get_or_create_local_server_identity()
    request_base = _normalize_base_url(str(request.base_url))
    local_base = _normalize_base_url(local.get("base_url") or request_base)
    local_public = _public_server_view({
        "server_id": local["server_id"],
        "display_name": local["display_name"],
        "base_url": local_base,
        "onion_url": local.get("onion_url") or "",
        "region": "",
        "official": 1,
        "trust_tier": "official",
        "capabilities": ["federation-v1"],
        "enabled": 1,
        "last_seen": None,
    }, onion_only=_tor_mode_enabled())
    local_target = _public_server_target(local_public)
    if local_target and not any((s.get("server_id") == local["server_id"] or _public_server_target(s) == local_target) for s in rows):
        rows.insert(0, local_public)
    return {"servers": rows}


@router.get("/network/probe")
async def probe_network_servers(
    request: Request,
    official_only: int = 0,
    timeout_ms: int = 1200,
    include_onion: int = 0,
):
    timeout_ms = max(200, min(timeout_ms, 5000))
    servers = (await list_network_servers(request=request, official_only=official_only)).get("servers", [])

    async def probe_one(server: dict):
        target = server.get("onion_url") if (include_onion and server.get("onion_url")) else _public_server_target(server)
        result = await asyncio.to_thread(_probe_url, target, timeout_ms / 1000.0)
        return {
            **server,
            "probe_target": target,
            "healthy": bool(result.get("ok")),
            "latency_ms": result.get("latency_ms"),
            "probe_error": result.get("error"),
        }

    probed = await asyncio.gather(*[probe_one(s) for s in servers]) if servers else []
    probed.sort(key=lambda s: (not s.get("healthy"), s.get("latency_ms") or 999999, -(s.get("official") or 0)))
    return {"servers": probed}


@router.get("/network/auto-select")
async def auto_select_network_server(
    request: Request,
    official_only: int = 1,
    prefer_tor: int = 0,
    timeout_ms: int = 1200,
):
    probe = await probe_network_servers(
        request=request,
        official_only=official_only,
        timeout_ms=timeout_ms,
        include_onion=prefer_tor,
    )
    candidates = probe.get("servers", [])

    def score(s: dict) -> float:
        if not s.get("healthy"):
            return -1_000_000
        latency = s.get("latency_ms") or 999999
        official_bonus = 100 if (s.get("official") or 0) else 0
        trust_bonus = 40 if s.get("trust_tier") == "official" else (15 if s.get("trust_tier") == "community" else 0)
        tor_bonus = 20 if (prefer_tor and s.get("onion_url")) else 0
        return official_bonus + trust_bonus + tor_bonus - (latency / 10.0)

    healthy = [c for c in candidates if c.get("healthy")]
    if not healthy:
        return {"selected": None, "candidates": candidates}

    selected = max(healthy, key=score)
    return {"selected": selected, "candidates": candidates}


@router.get("/network/build/local")
async def network_local_build_status():
    """Return local web bundle hash and official status for trust UI."""
    return _local_web_build_info()


@router.post("/network/build/verify-peers")
async def network_verify_peer_builds(
    body: PeerBuildVerifyBody,
    x_session_token: str | None = Header(default=None),
):
    """Verify peer server bundle hash matches this server's current web build."""
    current_user = await _current_user_from_header(x_session_token)
    if not current_user:
        return JSONResponse(status_code=401, content={"error": "Not authenticated"})

    local = _local_web_build_info()
    local_hash = local.get("build_hash") or ""

    seen = set()
    targets: list[str] = []
    for raw in body.base_urls or []:
        url = _normalize_base_url(raw)
        if not url or url in seen:
            continue
        seen.add(url)
        targets.append(url)

    # Detect the server's own public base URL to short-circuit loopback requests.
    # Prefer explicit env vars, then fall back to persisted federation identity.
    own_public = ""
    if not own_public:
        try:
            local_ident = db.get_or_create_local_server_identity() or {}
            own_public = _public_server_target(
                _public_server_view(local_ident, onion_only=_tor_mode_enabled())
            ).rstrip("/").lower()
        except Exception:
            own_public = ""

    results = []
    for base in targets:
        entry = {
            "base_url": base,
            "reachable": False,
            "same_hash": False,
            "remote_hash": "",
            "remote_version": "",
            "remote_official": False,
            "error": None,
        }
        # If the peer URL points at this server itself, skip the outbound
        # HTTP round-trip (which loopbacks through nginx and often times out)
        # and just reuse the already-computed local build info directly.
        is_self = bool(own_public and base.rstrip("/").lower() == own_public)
        if not is_self:
            # Also treat 127.0.0.1 / localhost targets as self.
            try:
                from urllib.parse import urlparse as _up
                _h = _up(base).hostname or ""
                is_self = _h in ("127.0.0.1", "::1", "localhost")
            except Exception:
                pass
        if is_self:
            entry["reachable"] = True
            entry["remote_hash"] = local_hash
            entry["remote_version"] = local.get("version") or ""
            entry["remote_official"] = bool(local.get("official"))
            entry["same_hash"] = True
            results.append(entry)
            continue
        try:
            raw = _fetch_url_bytes(
                f"{base}/api/network/build/local",
                timeout_s=5.0,
                headers={"User-Agent": "FrogTalk-BuildVerify/1.0", "Accept": "application/json"},
                method="GET",
            ).decode("utf-8", errors="replace")
            payload = json.loads(raw)
            remote_hash = str(payload.get("build_hash") or "")
            entry["reachable"] = True
            entry["remote_hash"] = remote_hash
            entry["remote_version"] = str(payload.get("version") or "")
            entry["remote_official"] = bool(payload.get("official"))
            entry["same_hash"] = bool(local_hash and remote_hash and remote_hash == local_hash)
        except Exception as e:
            entry["error"] = str(e)
        results.append(entry)

    return {
        "local": local,
        "results": results,
    }


def run_update_check_background() -> dict:
    """Used by app background task for fleet update sync."""
    auto = (os.getenv("FROGTALK_AUTO_UPDATE_ENABLED", "1") or "1").strip().lower() in ("1", "true", "yes")
    return _check_update_once(auto_apply=auto)


@router.get("/network/updates/latest")
async def network_updates_latest():
    """Main site release feed consumed by federation servers."""
    return {
        "version": db.get_config("update.feed.version") or "",
        "package_url": db.get_config("update.feed.package_url") or "",
        "package_sha256": db.get_config("update.feed.package_sha256") or "",
        "build_hash": db.get_config("update.feed.build_hash") or "",
        "notes": db.get_config("update.feed.notes") or "",
        "published_at": db.get_config("update.feed.published_at") or "",
    }


@router.post("/network/updates/publish")
async def network_updates_publish(
    body: UpdatePublishBody,
    x_session_token: str | None = Header(default=None),
):
    """Publish release metadata on main site for all federation nodes."""
    current_user = await _current_user_from_header(x_session_token)
    if not (current_user and current_user.get("is_admin")):
        return JSONResponse(status_code=403, content={"error": "Admin required"})

    db.set_config("update.feed.version", body.version.strip())
    db.set_config("update.feed.package_url", body.package_url.strip())
    db.set_config("update.feed.package_sha256", body.package_sha256.strip().lower())
    db.set_config("update.feed.build_hash", body.build_hash.strip().lower())
    db.set_config("update.feed.notes", body.notes.strip())
    db.set_config("update.feed.published_at", datetime.utcnow().isoformat() + "Z")
    return {"ok": True}


@router.get("/network/update/status")
async def network_update_status():
    local = _local_web_build_info()
    latest = {
        "version": db.get_config("update.latest.version") or "",
        "package_url": db.get_config("update.latest.package_url") or "",
        "package_sha256": db.get_config("update.latest.package_sha256") or "",
        "build_hash": db.get_config("update.latest.build_hash") or "",
    }
    return {
        "feed_url": _get_update_feed_url(),
        "auto_update_enabled": (os.getenv("FROGTALK_AUTO_UPDATE_ENABLED", "1") or "1").strip().lower() in ("1", "true", "yes"),
        "local": local,
        "latest": latest,
        "update_available": (db.get_config("update.available") or "0") == "1",
        "last_checked_at": db.get_config("update.last_checked_at") or "",
        "last_error": db.get_config("update.last_error") or "",
        "last_apply_at": db.get_config("update.last_apply_at") or "",
        "last_apply_status": db.get_config("update.last_apply_status") or "",
    }


@router.post("/network/update/check")
async def network_update_check(
    x_session_token: str | None = Header(default=None),
):
    current_user = await _current_user_from_header(x_session_token)
    if not (current_user and current_user.get("is_admin")):
        return JSONResponse(status_code=403, content={"error": "Admin required"})
    return _check_update_once(auto_apply=False)


@router.post("/network/update/apply")
async def network_update_apply(
    body: UpdateApplyBody,
    x_session_token: str | None = Header(default=None),
):
    current_user = await _current_user_from_header(x_session_token)
    if not (current_user and current_user.get("is_admin")):
        return JSONResponse(status_code=403, content={"error": "Admin required"})
    status = _check_update_once(auto_apply=True)
    if not status.get("ok"):
        return JSONResponse(status_code=400, content=status)
    if status.get("applied") and not status["applied"].get("ok"):
        return JSONResponse(status_code=400, content=status)
    return status


@router.post("/network/servers/register")
async def register_network_server(
    body: ServerRegisterBody,
    x_federation_token: str | None = Header(default=None),
    x_session_token: str | None = Header(default=None),
):
    current_user = await _current_user_from_header(x_session_token)
    is_admin = bool(current_user and current_user.get("is_admin"))
    if not (is_admin or _fed_token_ok(x_federation_token)):
        return JSONResponse(status_code=403, content={"error": "Not authorised"})
    db.upsert_federation_server(
        server_id=body.server_id,
        display_name=body.display_name,
        base_url=body.base_url,
        onion_url=body.onion_url,
        region=body.region,
        official=body.official,
        trust_tier=body.trust_tier,
        server_pubkey=body.server_pubkey,
        capabilities=body.capabilities,
    )
    return {"ok": True}


@router.post("/network/servers/sync-official")
async def sync_official_directory(
    x_federation_token: str | None = Header(default=None),
    x_session_token: str | None = Header(default=None),
):
    current_user = await _current_user_from_header(x_session_token)
    is_admin = bool(current_user and current_user.get("is_admin"))
    if not (is_admin or _fed_token_ok(x_federation_token)):
        return JSONResponse(status_code=403, content={"error": "Not authorised"})
    result = await sync_official_directory_once()
    if not result.get("ok"):
        return JSONResponse(status_code=400, content=result)
    return result


@router.get("/identity/me")
async def identity_me(x_session_token: str | None = Header(default=None)):
    current_user = await _current_user_from_header(x_session_token)
    if not current_user:
        return JSONResponse(status_code=401, content={"error": "Not authenticated"})
    ident = db.get_user_identity(current_user["id"]) or {}
    return {
        "id": ident.get("id"),
        "nickname": ident.get("nickname"),
        "display_name": ident.get("display_name"),
        "global_user_id": ident.get("global_user_id"),
        "identity_pubkey": ident.get("identity_pubkey"),
    }


@router.put("/identity/me/pubkey")
async def set_identity_pubkey(
    body: IdentityPubKeyBody,
    x_session_token: str | None = Header(default=None),
):
    current_user = await _current_user_from_header(x_session_token)
    if not current_user:
        return JSONResponse(status_code=401, content={"error": "Not authenticated"})
    pubkey = (body.identity_pubkey or "").strip()
    if len(pubkey) < 16 or len(pubkey) > 8192:
        return JSONResponse(status_code=400, content={"error": "Invalid identity_pubkey length"})
    db.set_identity_pub_key(current_user["id"], pubkey)
    return {"ok": True}


@router.get("/identity/me/claim")
async def get_my_identity_claim(
    ttl_seconds: int = 3600,
    x_session_token: str | None = Header(default=None),
):
    current_user = await _current_user_from_header(x_session_token)
    if not current_user:
        return JSONResponse(status_code=401, content={"error": "Not authenticated"})
    claim = db.build_signed_profile_claim(current_user["id"], ttl_seconds=ttl_seconds)
    if not claim:
        return JSONResponse(status_code=404, content={"error": "Identity not found"})
    return claim


@router.get("/identity/users/{user_id}/claim")
async def get_user_identity_claim(
    user_id: int,
    ttl_seconds: int = 3600,
    x_federation_token: str | None = Header(default=None),
):
    if not _fed_token_ok(x_federation_token):
        return JSONResponse(status_code=401, content={"error": "Invalid federation token"})
    claim = db.build_signed_profile_claim(user_id, ttl_seconds=ttl_seconds)
    if not claim:
        return JSONResponse(status_code=404, content={"error": "Identity not found"})
    return claim


def _insert_inbox_events_sync(events: list[dict]) -> tuple[int, int]:
    accepted = 0
    rejected = 0
    # Configurable per-deploy. We default to 0 (off) so the next deploy
    # can roll out signing-capable clients across the federation without
    # immediately rejecting unsigned events from peers that haven't
    # upgraded yet. Flip to 1 after one release of soak.
    require_sigs = (os.getenv("FROGTALK_FEDERATION_REQUIRE_SIGS", "0").strip().lower()
                    in ("1", "true", "yes", "on"))
    now = datetime.now(tz=timezone.utc)
    skew_seconds = 3600   # ±1h max clock skew accepted
    grace_seconds = 60    # allow tiny re-orderings against the monotonic watermark

    for ev in events:
        origin = str(ev.get("origin_server_id") or "").strip()
        if not origin:
            rejected += 1
            continue

        # ---- Time window check (replay defence, applies even without sigs) ----
        origin_time_str = str(ev.get("origin_time") or "").strip()
        if not origin_time_str:
            # Tolerate legacy peers that pre-date the outbox origin_time
            # column. Stamping with the current time keeps the monotonic
            # progression check meaningful while letting valid traffic
            # through during a rolling federation upgrade. The replay
            # window below still bounds out-of-skew clocks; this branch
            # is the only place where we synthesize a timestamp.
            origin_time_str = now.isoformat().replace("+00:00", "Z")
            ev["origin_time"] = origin_time_str
        try:
            # Normalize the "Z" suffix that enqueue_server_event emits;
            # fromisoformat in <3.11 doesn't accept it.
            ts = origin_time_str.replace("Z", "+00:00")
            origin_dt = datetime.fromisoformat(ts)
            if origin_dt.tzinfo is None:
                origin_dt = origin_dt.replace(tzinfo=timezone.utc)
        except Exception:
            rejected += 1
            continue
        if abs((now - origin_dt).total_seconds()) > skew_seconds:
            rejected += 1
            continue

        # ---- Monotonic progression per origin ----
        try:
            prev_max = db.get_federation_origin_max_time(origin)
            if prev_max:
                prev_ts = prev_max.replace("Z", "+00:00")
                prev_dt = datetime.fromisoformat(prev_ts)
                if prev_dt.tzinfo is None:
                    prev_dt = prev_dt.replace(tzinfo=timezone.utc)
                if (origin_dt - prev_dt).total_seconds() < -grace_seconds:
                    rejected += 1
                    continue
        except Exception:
            # On any parse error from prior watermark, fall through to
            # signature/dedup checks rather than reject; watermark gets
            # overwritten on success below.
            pass

        # ---- Ed25519 verification (when peer pubkey pinned) ----
        pubkey_pem = db.get_federation_server_pubkey(origin)
        if pubkey_pem:
            if not crypto_fed.verify_event(ev, pubkey_pem):
                rejected += 1
                continue
        elif require_sigs:
            # No pinned key + strict mode = reject. We never trust a
            # signer pubkey supplied on the wire (TOFU is too dangerous
            # with federated bots).
            rejected += 1
            continue

        if db.insert_federation_inbox_event(ev):
            accepted += 1
            try:
                db.update_federation_origin_max_time(origin, origin_time_str)
            except Exception:
                _log.exception("failed to bump origin progress for %s", origin)
        else:
            rejected += 1
    return accepted, rejected


@router.post("/federation/events/inbox")
async def federation_inbox(
    body: FederationInboxBody,
    x_federation_token: str | None = Header(default=None),
):
    if not _fed_token_ok(x_federation_token):
        return JSONResponse(status_code=401, content={"error": "Invalid federation token"})

    # Run all SQLite writes on a worker thread so the event loop stays
    # responsive to user requests even when peers spam events.
    accepted, rejected = await asyncio.to_thread(_insert_inbox_events_sync, body.events)
    return {"accepted": accepted, "rejected": rejected}


# ──────────────────────────────────────────────────────────────
# Phase 4: Build trust and badges
# ──────────────────────────────────────────────────────────────

@router.post("/federation/manifests/register")
async def register_build_manifest(
    body: BuildManifestBody,
    x_federation_token: str | None = Header(default=None),
):
    """Register official or community build hash for verification."""
    if not (body.official and _fed_token_ok(x_federation_token)):
        if not body.official:
            pass  # Community builds can self-register
        else:
            return JSONResponse(status_code=403, content={"error": "Not authorised"})

    ok = db.register_build_manifest(
        platform=body.platform,
        version=body.version,
        build_hash=body.build_hash,
        signer=body.signer,
        signature=body.signature,
        official=bool(body.official),
    )
    if not ok:
        return JSONResponse(status_code=400, content={"error": "Manifest registration failed"})
    return {"ok": True}


@router.get("/federation/manifests/verify")
async def verify_build_manifest(
    platform: str,
    version: str,
    build_hash: str,
):
    """Check if build hash is registered as official."""
    official = db.is_official_build(platform, version, build_hash)
    return {"platform": platform, "version": version, "build_hash": build_hash, "official": bool(official)}


@router.get("/federation/manifests/list")
async def list_build_manifests(
    platform: str = "",
):
    """List registered build manifests (official or community)."""
    rows = db.list_build_manifests(platform=platform if platform else None)
    return {"manifests": rows}


# ──────────────────────────────────────────────────────────────
# Phase 5: Federation replication
# ──────────────────────────────────────────────────────────────

@router.post("/federation/events/emit")
async def emit_federation_event(
    body: FederationOutboxEventBody,
    x_session_token: str | None = Header(default=None),
):
    """Emit a federation event to local outbox (internal endpoint for app actions)."""
    current_user = await _current_user_from_header(x_session_token)
    if not current_user:
        return JSONResponse(status_code=401, content={"error": "Not authenticated"})

    local = db.get_or_create_local_server_identity()
    event_id = f"evt_{int(time.time() * 1000):016x}"

    event = {
        "event_id": event_id,
        "event_type": body.event_type,
        "event_version": 1,
        "origin_server_id": local["server_id"],
        "origin_time": datetime.utcnow().isoformat() + "Z",
        "actor_global_user_id": current_user.get("global_user_id") or "",
        "payload": body.payload,
        "signature": "",  # Signing happens in background task
    }

    if db.insert_federation_outbox_event(event):
        return {"ok": True, "event_id": event_id}
    return JSONResponse(status_code=400, content={"error": "Failed to emit event"})


@router.get("/federation/events/outbox")
async def federation_outbox_pull(
    since: str = "",
    x_federation_token: str | None = Header(default=None),
):
    """Pull outbox events with cursor-based pagination."""
    if not _fed_token_ok(x_federation_token):
        return JSONResponse(status_code=401, content={"error": "Invalid federation token"})

    rows = db.list_federation_outbox_events(since_cursor=since if since else None)
    next_cursor = f"evt_{int(time.time() * 1000):016x}" if rows else None
    return {
        "events": rows,
        "next_cursor": next_cursor,
    }


async def federation_inbox_processor() -> int:
    """Process one inbox batch with idempotency. Returns events processed.

    DB reads/writes are pushed onto worker threads so the single uvicorn event
    loop stays responsive while we drain federation events. The async handlers
    themselves may hit the DB synchronously but each call is short.
    """
    try:
        events = await asyncio.to_thread(
            db.list_federation_inbox_events, "pending", 20
        )
    except Exception:
        _log.exception("Inbox processor list error")
        return 0

    processed = 0
    for row in events:
        event_id = str(row.get("event_id") or "")
        try:
            payload = {}
            raw_payload = row.get("payload_json")
            if isinstance(raw_payload, str) and raw_payload.strip():
                try:
                    payload = json.loads(raw_payload)
                except Exception:
                    payload = {}

            event = {
                "event_id": event_id,
                "event_type": str(row.get("event_type") or ""),
                "origin_server_id": str(row.get("origin_server_id") or ""),
                "payload": payload,
            }

            event_type = event["event_type"]
            if event_type.startswith("message."):
                await _handle_message_event(event)
            elif event_type.startswith("dm."):
                await _handle_dm_event(event)
            elif event_type.startswith("room."):
                await _handle_room_event(event)
            elif event_type.startswith("user."):
                await _handle_user_event(event)
            elif event_type.startswith("social."):
                await _handle_social_event(event)
            elif event_type.startswith("friend."):
                await _handle_friend_event(event)
            elif event_type.startswith("server."):
                await _handle_server_event(event)
            elif event_type.startswith("sticker."):
                await _handle_sticker_event(event)
            elif event_type.startswith("bot."):
                await _handle_bot_event(event)

            await asyncio.to_thread(db.mark_federation_inbox_event, event_id, "applied")
            processed += 1
        except Exception:
            _log.exception("Inbox event %s error", event_id)
            try:
                await asyncio.to_thread(db.mark_federation_inbox_event, event_id, "failed")
            except Exception:
                pass
    return processed


def _outbox_collect_targets_sync() -> tuple[str, list[str], list[dict]]:
    """Gather (local_server_id, peer_targets, pending_events) in one thread hop."""
    local = db.get_or_create_local_server_identity()
    local_server_id = str(local.get("server_id") or "")
    local_base = _normalize_base_url(
        (os.getenv("FROGTALK_BASE_URL") or os.getenv("PUBLIC_URL") or local.get("base_url") or "")
    ).lower()
    local_onion = _normalize_base_url(str(local.get("onion_url") or "")).lower()

    own_hosts = {"localhost", "127.0.0.1", "::1"}
    for raw in (
        local_base,
        local_onion,
        _normalize_base_url(os.getenv("FROGTALK_PUBLIC_BASE_URL", "")),
        _normalize_base_url(os.getenv("FROGTALK_BASE_URL", "")),
    ):
        try:
            host = (urllib.parse.urlparse(raw).hostname or "").strip().lower()
            if host:
                own_hosts.add(host)
        except Exception:
            pass

    peers = db.list_federation_servers(official_only=False)
    targets: list[str] = []
    seen_targets: set[str] = set()
    for srv in peers:
        if not srv.get("enabled"):
            continue
        if str(srv.get("server_id") or "") == local_server_id:
            continue
        # transport_preference is on the row already; no extra query.
        target = _select_peer_target(srv)
        if not target:
            continue
        normalized_target = _normalize_base_url(target)
        t_lower = normalized_target.lower()
        if local_base and t_lower == local_base:
            continue
        if local_onion and t_lower == local_onion:
            continue

        try:
            target_host = (urllib.parse.urlparse(normalized_target).hostname or "").strip().lower()
        except Exception:
            target_host = ""
        if target_host in own_hosts:
            continue

        if t_lower in seen_targets:
            continue
        seen_targets.add(t_lower)
        targets.append(normalized_target)

    if not targets:
        return local_server_id, targets, []
    events = db.list_federation_outbox_events(status="pending", limit=50)
    return local_server_id, targets, events


async def federation_outbox_processor() -> int:
    """Push pending outbox events to known peers (best-effort).

    Optimized:
      • Batches up to BATCH_SIZE events into a single POST per peer (the
        inbox endpoint already accepts an events list with idempotent dedup
        on event_id, so batching is safe).
      • Pushes to all peers in parallel via asyncio.gather so a slow Tor
        peer cannot block the clearnet peer.
      • Marks all events delivered in one bulk UPDATE.

    Returns the number of events marked delivered this tick.
    """
    fed_token = (os.getenv("FROGTALK_FEDERATION_TOKEN") or "").strip()
    if not fed_token:
        return 0

    try:
        local_server_id, targets, events = await asyncio.to_thread(_outbox_collect_targets_sync)
    except Exception:
        _log.exception("Outbox collect error")
        return 0

    if not targets or not events:
        return 0

    BATCH_SIZE = 25
    batch = events[:BATCH_SIZE]
    envelopes: list[dict] = []
    for row in batch:
        event_id = str(row.get("event_id") or "")
        if not event_id:
            continue
        payload: dict = {}
        raw_payload = row.get("payload_json")
        if isinstance(raw_payload, str) and raw_payload.strip():
            try:
                payload = json.loads(raw_payload)
            except Exception:
                payload = {}
        envelopes.append({
            "event_id": event_id,
            "event_type": str(row.get("event_type") or ""),
            "origin_server_id": local_server_id,
            "origin_time": str(row.get("origin_time") or ""),
            "signature": str(row.get("signature") or ""),
            "payload": payload,
        })

    if not envelopes:
        return 0

    body = json.dumps({"events": envelopes}).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "FrogTalk-FederationPush/1.0",
        "x-federation-token": fed_token,
    }

    async def _push(base: str) -> tuple[bool, bool]:
        """Returns (delivered, payload_too_large).

        ``payload_too_large`` lets the caller mark the batch as ``failed``
        in the outbox so we stop infinitely retrying media-bloated events
        that no peer will ever accept. (Page cache thrash from those
        retries was the dominant cause of social slowness.)
        """
        try:
            raw = await asyncio.to_thread(
                _fetch_url_bytes,
                f"{base}/api/federation/events/inbox",
                timeout_s=8.0,
                method="POST",
                data=body,
                headers=headers,
            )
            # Any successful HTTP exchange means the peer has the batch
            # (newly-accepted OR rejected as duplicate — both are final).
            try:
                json.loads(raw.decode("utf-8", errors="replace") or "{}")
            except Exception:
                pass
            return True, False
        except httpx.HTTPStatusError as e:  # Tor path
            status = getattr(e.response, "status_code", 0)
            return False, status == 413
        except urllib.error.HTTPError as e:  # clearnet path
            return False, getattr(e, "code", 0) == 413
        except Exception:
            return False, False

    results = await asyncio.gather(*[_push(t) for t in targets])
    delivered_anywhere = any(ok for ok, _ in results)
    too_large_everywhere = bool(results) and all(too_big for _, too_big in results)

    event_ids = [e["event_id"] for e in envelopes]

    if too_large_everywhere and not delivered_anywhere:
        # Every peer rejected this batch as too large. Stop retrying it
        # forever — mark the batch failed so it stops thrashing the DB.
        try:
            await asyncio.to_thread(db.mark_outbox_events_failed, event_ids)
            _log.warning(
                "Outbox batch (%d events) marked failed: all peers returned 413.",
                len(event_ids),
            )
        except Exception:
            _log.exception("mark_outbox_events_failed error")
        return 0

    if not delivered_anywhere:
        # Every peer is unreachable — leave events pending; outer loop's
        # idle_sleep throttles retries automatically.
        return 0

    try:
        await asyncio.to_thread(db.bulk_mark_outbox_events_sent, event_ids)
    except Exception:
        _log.exception("Bulk mark outbox sent error")
        return 0
    return len(event_ids)


async def _handle_message_event(event: dict) -> None:
    """Handle incoming replicated room message event."""
    if event.get("event_type") != "message.created":
        return
    payload = event.get("payload") or {}
    db.save_federated_room_message(str(event.get("event_id") or ""), payload)


async def _handle_room_event(event: dict) -> None:
    """Handle incoming room event (create/update/delete)."""
    payload = event.get("payload") or {}
    event_type = str(event.get("event_type") or "")
    room_name = str(payload.get("room_name") or "").strip()
    if not room_name:
        return

    room = db.get_room_by_name(room_name)
    if not room:
        owner = db.get_or_create_federation_system_user()
        room_id = db.create_room(room_name, "Federated room", "public", owner, None)
        if room_id is None:
            room = db.get_room_by_name(room_name)
        else:
            room = db.get_room_by_name(room_name)
    if not room:
        return

    if event_type.startswith("room.music."):
        await _handle_room_music_event(room_name, event_type, payload)
        return

    nickname = str(payload.get("nickname") or "").strip()
    if not nickname:
        return

    user = _ensure_local_user_by_nickname(nickname)
    if not user:
        return

    if event_type == "room.member.joined":
        db.join_room(user["id"], room["id"])
    elif event_type == "room.member.left":
        with db._conn() as con:
            con.execute("DELETE FROM room_members WHERE room_id=? AND user_id=?", (room["id"], user["id"]))
            con.commit()


def _set_music_anchor(room_name: str, track_id: int, started_unix: float | int | None) -> None:
    if started_unix is None:
        return
    try:
        from routers import rooms as rooms_router
        rooms_router.set_music_head_anchor(room_name, int(track_id), float(started_unix))
    except Exception:
        pass


def _clear_music_anchor(room_name: str) -> None:
    try:
        from routers import rooms as rooms_router
        rooms_router.clear_music_head_anchor(room_name)
    except Exception:
        pass


async def _broadcast_music_ws(room_name: str, message: dict) -> None:
    try:
        from ws_manager import manager
        await manager.broadcast_room(room_name, message)
    except Exception:
        pass


async def _handle_room_music_event(room_name: str, event_type: str, payload: dict) -> None:
    if event_type == "room.music.track.added":
        provider = str(payload.get("provider") or "").strip()
        video_id = str(payload.get("video_id") or "").strip()
        url = str(payload.get("url") or "").strip()
        if not provider or not video_id or not url:
            return
        submitter_nick = str(payload.get("submitter_nick") or "federation_sync").strip() or "federation_sync"
        submitter = _ensure_local_user_by_nickname(submitter_nick)
        submitter_id = int(submitter["id"]) if submitter else int(db.get_or_create_federation_system_user())
        track_id = db.music_add_track(
            room_name=room_name,
            submitter_id=submitter_id,
            submitter_nick=submitter_nick,
            provider=provider,
            video_id=video_id,
            url=url,
            title=str(payload.get("title") or ""),
            thumbnail=str(payload.get("thumbnail") or ""),
            duration=int(payload.get("duration") or 0),
        )
        if bool(payload.get("make_current")):
            _set_music_anchor(room_name, int(track_id), payload.get("start_unix"))
        await _broadcast_music_ws(room_name, {
            "type": "music_track_added",
            "room": room_name,
            "track": {
                "id": track_id,
                "room_name": room_name,
                "submitter_id": submitter_id,
                "submitter_nick": submitter_nick,
                "provider": provider,
                "video_id": video_id,
                "url": url,
                "title": str(payload.get("title") or ""),
                "thumbnail": str(payload.get("thumbnail") or ""),
                "duration": int(payload.get("duration") or 0),
                "played": 0,
            },
        })
        return

    if event_type == "room.music.track.removed":
        provider = str(payload.get("provider") or "").strip()
        video_id = str(payload.get("video_id") or "").strip()
        url = str(payload.get("url") or "").strip()
        removed_id = None
        with db._conn() as con:
            row = con.execute(
                """
                SELECT id FROM music_queue
                WHERE room_name=? AND played=0 AND provider=? AND video_id=? AND url=?
                ORDER BY id ASC
                LIMIT 1
                """,
                (room_name, provider, video_id, url),
            ).fetchone()
            if row:
                removed_id = int(row["id"])
                con.execute("DELETE FROM music_queue WHERE id=?", (removed_id,))
                con.commit()
        if removed_id is not None:
            if bool(payload.get("removed_was_head")):
                next_current = db.music_get_current(room_name)
                if next_current:
                    _set_music_anchor(room_name, int(next_current["id"]), payload.get("next_start_unix") or time.time())
                else:
                    _clear_music_anchor(room_name)
            await _broadcast_music_ws(room_name, {
                "type": "music_track_removed",
                "room": room_name,
                "track_id": removed_id,
            })
        return

    if event_type == "room.music.track.skipped":
        current = db.music_get_current(room_name)
        skipped_id = None
        if current:
            skipped_id = int(current["id"])
            db.music_mark_played(skipped_id, room_name)
        next_current = db.music_get_current(room_name)
        if next_current:
            _set_music_anchor(room_name, int(next_current["id"]), payload.get("next_start_unix") or time.time())
        else:
            _clear_music_anchor(room_name)
        await _broadcast_music_ws(room_name, {
            "type": "music_track_skipped",
            "room": room_name,
            "track_id": skipped_id,
        })
        return

    if event_type == "room.music.queue.cleared":
        db.music_clear_queue(room_name)
        _clear_music_anchor(room_name)
        await _broadcast_music_ws(room_name, {"type": "music_queue_cleared", "room": room_name})
        return

    if event_type == "room.music.dj_only.changed":
        db.room_set_dj_only(room_name, 1 if payload.get("dj_only") else 0)
        await _broadcast_music_ws(room_name, {
            "type": "music_dj_only_changed",
            "room": room_name,
            "dj_only": bool(payload.get("dj_only")),
        })
        return


async def _handle_user_event(event: dict) -> None:
    """Handle incoming federated user profile claim/update."""
    payload = event.get("payload") or {}
    if event.get("event_type") not in ("user.profile.updated", "user.created"):
        return
    gid = str(payload.get("global_user_id") or "").strip()
    db.upsert_federation_user_profile(
        global_user_id=gid,
        nickname=str(payload.get("nickname") or "").strip(),
        display_name=str(payload.get("display_name") or ""),
        avatar=str(payload.get("avatar") or ""),
        bio=str(payload.get("bio") or ""),
        identity_pubkey=str(payload.get("identity_pubkey") or ""),
        origin_server_id=str(event.get("origin_server_id") or ""),
    )

    # Only mirror profile fields into the local `users` table when the
    # event's global_user_id matches an EXISTING local user. We deliberately
    # do NOT match by nickname (which would let a federated peer with the
    # same nickname as a real local account silently rewrite that account's
    # status_msg / bio / avatar) and we deliberately do NOT auto-create
    # local users from profile events (the federation_user_profiles
    # directory above is the proper home for foreign user records — the
    # local `users` table should only hold real accounts on this node).
    if not gid:
        return
    local_user = None
    try:
        with db._conn() as con:
            row = con.execute(
                "SELECT id FROM users WHERE global_user_id=? LIMIT 1",
                (gid,),
            ).fetchone()
            if row:
                local_user = {"id": row["id"] if hasattr(row, "keys") else row[0]}
    except Exception:
        local_user = None
    if not local_user:
        return

    allowed_presence = {"online", "away", "dnd", "invisible"}
    presence = str(payload.get("presence") or "").strip().lower()
    if presence not in allowed_presence:
        presence = None
    display_name_raw = "".join(
        ch for ch in str(payload.get("display_name") or "")
        if ch == " " or ch.isprintable()
    ).strip()[:32]

    # Use COALESCE/NULLIF semantics so an empty/missing field in the
    # payload doesn't blow away an existing local value. This is
    # critical for status_msg: a brief moment where the originating
    # device sends an empty status (e.g. between a music-takeover
    # restore and the next manual edit) would otherwise propagate the
    # blank to every reflecting peer.
    status_msg_in = str(payload.get("status_msg") or "")[:128]
    mood_in = str(payload.get("mood") or "")[:100]
    avatar_in = str(payload.get("avatar") or "")
    bio_in = str(payload.get("bio") or "")

    with db._conn() as con:
        base_sql = """
            UPDATE users
            SET display_name = COALESCE(NULLIF(?, ''), display_name),
                avatar       = COALESCE(NULLIF(?, ''), avatar),
                bio          = COALESCE(NULLIF(?, ''), bio),
                status_msg   = COALESCE(NULLIF(?, ''), status_msg),
                mood         = COALESCE(NULLIF(?, ''), mood),
                presence     = COALESCE(?, presence),
                identity_pubkey = COALESCE(NULLIF(?, ''), identity_pubkey)
        """
        params = [
            display_name_raw,
            avatar_in,
            bio_in,
            status_msg_in,
            mood_in,
            presence,
            str(payload.get("identity_pubkey") or ""),
        ]

        # Only apply CSS when explicitly present in payload to avoid
        # wiping an existing style from profile updates that don't carry it.
        if "custom_css" in payload:
            css = str(payload.get("custom_css") or "")[:10240]
            base_sql += ", custom_css=?"
            params.append(css)

        base_sql += " WHERE id=?"
        params.append(local_user["id"])
        con.execute(base_sql, params)
        con.commit()

    # Push live profile changes (including presence/status) to connected clients
    # so channel member sidebars update without a manual refresh. Only fire
    # this when the event actually corresponds to a local user (matched by
    # global_user_id above); otherwise we'd be broadcasting profile updates
    # for foreign users that local clients can't render via the local-user
    # id channel anyway.
    try:
        from ws_manager import manager
        await manager.broadcast_all({
            "type": "profile_update",
            "user_id": local_user["id"],
            "nickname": str(payload.get("nickname") or "").strip(),
            "display_name": display_name_raw or None,
            "avatar": avatar_in,
            "presence": (presence or str(payload.get("presence") or "").strip().lower() or "online"),
            "status_msg": status_msg_in,
        })
    except Exception:
        pass


def _ensure_local_user_by_nickname(nickname: str) -> dict | None:
    nick = (nickname or "").strip()
    if not nick:
        return None
    user = db.get_user_by_nick(nick)
    if user:
        return user
    uid = db.create_user(nick, secrets.token_urlsafe(24))
    if uid is None:
        return db.get_user_by_nick(nick)
    return db.get_user_by_id(uid)


async def _handle_dm_event(event: dict) -> None:
    """Handle incoming federated DM events."""
    if event.get("event_type") != "dm.message.created":
        return
    payload = event.get("payload") or {}
    sender_nick = str(payload.get("sender_nickname") or "").strip()
    peer_nick = str(payload.get("peer_nickname") or "").strip()
    if not sender_nick or not peer_nick:
        return
    sender = _ensure_local_user_by_nickname(sender_nick)
    peer = _ensure_local_user_by_nickname(peer_nick)
    if not sender or not peer:
        return

    channel_id = db.get_or_create_dm(sender["id"], peer["id"])
    msg_id = db.send_dm_message(
        channel_id,
        sender["id"],
        str(payload.get("content") or ""),
        payload.get("media_data"),
        payload.get("media_type"),
        payload.get("media_name"),
        payload.get("reply_to"),
        media_blur=int(payload.get("media_blur") or 0),
        view_once=int(payload.get("view_once") or 0),
    )

    dm_broadcast = {
        "type": "dm_message",
        "id": msg_id,
        "channel_id": channel_id,
        "sender_id": sender["id"],
        "sender_nick": sender["nickname"],
        "sender_avatar": sender.get("avatar"),
        "content": str(payload.get("content") or ""),
        "media_type": payload.get("media_type"),
        "media_name": payload.get("media_name"),
        "has_media": bool(payload.get("media_data")),
        "media_blur": int(payload.get("media_blur") or 0),
        "view_once": int(payload.get("view_once") or 0),
        "reply_to": payload.get("reply_to"),
        "edited": False,
        "deleted": False,
        "reactions": {},
        "created_at": str(payload.get("created_at") or datetime.utcnow().isoformat()),
    }
    try:
        from ws_manager import manager
        await manager.send_to_user(peer["id"], dm_broadcast)
    except Exception:
        pass
    try:
        from routers.push import send_push
        # PRIVACY: never include plaintext content in the push body. E2E
        # is opt-in per device; forwarding the body would leak it to the
        # tray on devices that don't have the passphrase.
        send_push(
            peer["id"], "FrogTalk", f"💬 New message from {sender['nickname']}", "/app",
            extra={"from_nickname": sender["nickname"]},
        )
    except Exception:
        pass


async def _handle_friend_event(event: dict) -> None:
    payload = event.get("payload") or {}
    event_type = str(event.get("event_type") or "")

    # Sound events use different keys — handle them before the from/to guard.
    if event_type in ("friend.sound.created", "friend.sound.deleted"):
        from_nick = None  # handled inside the blocks below
        to_nick = None
    else:
        from_nick = str(payload.get("from_nickname") or "").strip()
        to_nick = str(payload.get("to_nickname") or "").strip()
        if not from_nick or not to_nick:
            return

        from_user = _ensure_local_user_by_nickname(from_nick)
        to_user = _ensure_local_user_by_nickname(to_nick)
        if not from_user or not to_user:
            return

    if event_type == "friend.requested":
        db.send_friend_request(from_user["id"], to_user["id"])
        try:
            from ws_manager import manager
            await manager.send_to_user(to_user["id"], {
                "type": "friend_notify",
                "action": "request",
                "from": from_nick,
                "from_avatar": from_user.get("avatar"),
            })
        except Exception:
            pass
        try:
            from routers.push import send_push
            send_push(
                to_user["id"], "👥 Friend Request",
                f"{from_nick} wants to be friends", "/app",
                kind="friend_request",
                extra={"from_nickname": ""},
            )
        except Exception:
            pass
        return

    if event_type == "friend.accepted":
        db.accept_friend_request(from_user["id"], to_user["id"])
        try:
            from ws_manager import manager
            await manager.send_to_user(from_user["id"], {
                "type": "friend_notify",
                "action": "accept",
                "from": to_nick,
                "from_avatar": to_user.get("avatar"),
            })
        except Exception:
            pass
        try:
            from routers.push import send_push
            send_push(
                from_user["id"], "👥 Friend Accepted",
                f"{to_nick} accepted your friend request", "/app",
                kind="friend_accepted",
                extra={"from_nickname": ""},
            )
        except Exception:
            pass

    if event_type == "friend.sound.created":
        owner_nick = str(payload.get("owner_nick") or "").strip()
        friend_nick = str(payload.get("friend_nick") or "").strip()
        kind = str(payload.get("kind") or "").strip()
        file_data_b64 = str(payload.get("file_data_b64") or "").strip()
        filename = str(payload.get("filename") or "sound.bin").strip()
        content_type = str(payload.get("content_type") or "application/octet-stream").strip()
        file_ext = str(payload.get("file_ext") or Path(filename).suffix).strip().lower()
        if not owner_nick or not friend_nick or kind not in ("msg", "ring") or not file_data_b64:
            return
        owner = _ensure_local_user_by_nickname(owner_nick)
        friend = _ensure_local_user_by_nickname(friend_nick)
        if not owner or not friend:
            return
        try:
            raw = base64.b64decode(file_data_b64)
        except Exception:
            return
        if not raw:
            return
        sound_root = Path(os.getenv("FROGTALK_FRIEND_SOUND_DIR", "data/friend_sounds"))
        target_dir = sound_root / str(owner["id"]) / str(friend["id"]) / kind
        try:
            target_dir.mkdir(parents=True, exist_ok=True)
        except Exception:
            return
        import uuid as _uuid
        target_path = target_dir / f"{_uuid.uuid4().hex}{file_ext or '.bin'}"
        try:
            target_path.write_bytes(raw)
        except Exception:
            return
        try:
            db.add_friend_sound_asset(
                owner_user_id=owner["id"],
                friend_user_id=friend["id"],
                kind=kind,
                filename=filename,
                content_type=content_type,
                file_path=str(target_path),
                file_size=len(raw),
                is_active=1,
            )
        except Exception:
            try:
                target_path.unlink(missing_ok=True)
            except Exception:
                pass
        return

    if event_type == "friend.sound.deleted":
        owner_nick = str(payload.get("owner_nick") or "").strip()
        friend_nick = str(payload.get("friend_nick") or "").strip()
        kind = str(payload.get("kind") or "").strip()
        if not owner_nick or not friend_nick or kind not in ("msg", "ring"):
            return
        owner = _ensure_local_user_by_nickname(owner_nick)
        friend = _ensure_local_user_by_nickname(friend_nick)
        if not owner or not friend:
            return
        try:
            active = db.get_active_friend_sound_asset(owner["id"], friend["id"], kind)
            if active:
                deleted = db.delete_friend_sound_asset(owner["id"], active["id"])
                if deleted:
                    fp = Path(str(deleted.get("file_path") or ""))
                    if fp.exists() and fp.is_file():
                        try:
                            fp.unlink()
                        except Exception:
                            pass
        except Exception:
            pass
        return


async def _handle_social_event(event: dict) -> None:
    """Handle incoming social follow/post events."""
    payload = event.get("payload") or {}
    event_type = str(event.get("event_type") or "")

    if event_type == "social.post.created":
        author_nick = str(payload.get("nickname") or "").strip()
        author = _ensure_local_user_by_nickname(author_nick)
        if not author:
            return
        # Use existing DB helper so post appears in feed/explore as normal.
        db.create_wall_post(
            author["id"],
            str(payload.get("content") or ""),
            payload.get("media_data"),
            payload.get("media_type"),
            str(payload.get("privacy") or "public"),
            1 if bool(payload.get("allow_comments", True)) else 0,
            payload.get("track_title") or None,
            payload.get("track_room") or None,
            payload.get("track_mood") or None,
        )
        return

    if event_type == "social.story.created":
        author_nick = str(payload.get("nickname") or "").strip()
        author = _ensure_local_user_by_nickname(author_nick)
        if not author:
            return
        media_data = payload.get("media_data")
        if not media_data:
            return
        privacy = str(payload.get("privacy") or "public")
        if privacy not in ("public", "followers"):
            privacy = "public"
        db.create_story(
            author["id"],
            str(media_data),
            str(payload.get("media_type") or "application/octet-stream"),
            str(payload.get("caption") or ""),
            privacy,
        )
        # Notify locally connected clients so chat-avatar story rings
        # update live for users on this node when the poster lives on
        # a federated peer.
        try:
            from ws_manager import manager
            await manager.broadcast_all({
                "type": "story_posted",
                "user_id": author["id"],
                "nickname": author["nickname"],
            })
        except Exception:
            pass
        return

    if event_type == "social.story.deleted":
        author_nick = str(payload.get("nickname") or "").strip()
        author = _ensure_local_user_by_nickname(author_nick)
        if not author:
            return
        story_id = payload.get("story_id")
        try:
            sid = int(story_id)
        except Exception:
            return
        with db._conn() as con:
            con.execute("DELETE FROM stories WHERE id=? AND user_id=?", (sid, author["id"]))
            con.commit()
        return

    if event_type == "social.follow.changed":
        follower_nick = str(payload.get("follower_nickname") or "").strip()
        following_nick = str(payload.get("following_nickname") or "").strip()
        action = str(payload.get("action") or "").strip().lower()
        follower = _ensure_local_user_by_nickname(follower_nick)
        following = _ensure_local_user_by_nickname(following_nick)
        if not follower or not following:
            return
        if action == "follow":
            db.follow_user(follower["id"], following["id"])
        elif action == "unfollow":
            db.unfollow_user(follower["id"], following["id"])
        return

    if event_type == "social.repost.created":
        actor_nick = str(payload.get("actor_nickname") or "").strip()
        owner_nick = str(payload.get("owner_nickname") or "").strip()
        if not actor_nick or not owner_nick:
            return
        actor = _ensure_local_user_by_nickname(actor_nick)
        owner = _ensure_local_user_by_nickname(owner_nick)
        if not actor or not owner or actor["id"] == owner["id"]:
            return

        post_id = payload.get("post_id")
        try:
            post_id_int = int(post_id)
        except Exception:
            post_id_int = None
        if post_id_int is not None and post_id_int <= 0:
            post_id_int = None

        quote = str(payload.get("quote") or "").strip() or None
        notif_id = db.add_social_notification(
            user_id=owner["id"],
            actor_id=actor["id"],
            kind="repost",
            post_id=post_id_int,
            preview=(quote[:140] if quote else None),
        )
        if notif_id is None:
            return

        unread = db.get_social_notification_unread_count(owner["id"])
        try:
            from ws_manager import manager
            await manager.send_to_user(owner["id"], {
                "type": "social_notification",
                "event": "repost",
                "id": notif_id,
                "actor": actor_nick,
                "actor_avatar": str(payload.get("actor_avatar") or actor.get("avatar") or ""),
                "post_id": post_id_int,
                "preview": (quote[:140] if quote else None),
                "unread": unread,
            })
        except Exception:
            _log.debug("federated repost notif WS push failed", exc_info=True)

    if event_type == "social.comment.created":
        actor_nick = str(payload.get("actor_nickname") or "").strip()
        owner_nick = str(payload.get("owner_nickname") or "").strip()
        if not actor_nick or not owner_nick:
            return
        actor = _ensure_local_user_by_nickname(actor_nick)
        owner = _ensure_local_user_by_nickname(owner_nick)
        if not actor or not owner or actor["id"] == owner["id"]:
            return

        post_id = payload.get("post_id")
        comment_id = payload.get("comment_id")
        try:
            post_id_int = int(post_id)
        except Exception:
            post_id_int = None
        try:
            comment_id_int = int(comment_id)
        except Exception:
            comment_id_int = None
        preview = str(payload.get("preview") or "").strip() or None

        notif_id = db.add_social_notification(
            user_id=owner["id"],
            actor_id=actor["id"],
            kind="comment",
            post_id=post_id_int,
            comment_id=comment_id_int,
            preview=(preview[:140] if preview else None),
        )
        if notif_id is None:
            return

        unread = db.get_social_notification_unread_count(owner["id"])
        try:
            from ws_manager import manager
            await manager.send_to_user(owner["id"], {
                "type": "social_notification",
                "event": "comment",
                "id": notif_id,
                "actor": actor_nick,
                "actor_avatar": str(payload.get("actor_avatar") or actor.get("avatar") or ""),
                "post_id": post_id_int,
                "comment_id": comment_id_int,
                "preview": (preview[:140] if preview else None),
                "unread": unread,
            })
        except Exception:
            _log.debug("federated comment notif WS push failed", exc_info=True)

    if event_type == "social.reaction.changed":
        actor_nick = str(payload.get("actor_nickname") or "").strip()
        owner_nick = str(payload.get("owner_nickname") or "").strip()
        emoji = str(payload.get("emoji") or "").strip()
        active = bool(payload.get("active"))
        if not actor_nick or not owner_nick:
            return
        actor = _ensure_local_user_by_nickname(actor_nick)
        owner = _ensure_local_user_by_nickname(owner_nick)
        if not actor or not owner or actor["id"] == owner["id"]:
            return

        post_id = payload.get("post_id")
        try:
            post_id_int = int(post_id)
        except Exception:
            post_id_int = None
        if post_id_int is not None and post_id_int <= 0:
            post_id_int = None

        if active:
            notif_id = db.add_social_notification(
                user_id=owner["id"],
                actor_id=actor["id"],
                kind="like",
                post_id=post_id_int,
                emoji=(emoji[:8] if emoji else None),
            )
            if notif_id is None:
                return
            unread = db.get_social_notification_unread_count(owner["id"])
            try:
                from ws_manager import manager
                await manager.send_to_user(owner["id"], {
                    "type": "social_notification",
                    "event": "like",
                    "id": notif_id,
                    "actor": actor_nick,
                    "actor_avatar": str(payload.get("actor_avatar") or actor.get("avatar") or ""),
                    "post_id": post_id_int,
                    "emoji": (emoji[:8] if emoji else None),
                    "unread": unread,
                })
            except Exception:
                _log.debug("federated reaction notif WS push failed", exc_info=True)
        else:
            removed = db.remove_social_like_notification(owner["id"], actor["id"], post_id_int)
            if removed:
                unread = db.get_social_notification_unread_count(owner["id"])
                try:
                    from ws_manager import manager
                    await manager.send_to_user(owner["id"], {
                        "type": "social_notification",
                        "event": "unlike",
                        "actor": actor_nick,
                        "post_id": post_id_int,
                        "unread": unread,
                    })
                except Exception:
                    _log.debug("federated unlike notif WS push failed", exc_info=True)


async def _handle_sticker_event(event: dict) -> None:
    """Apply incoming sticker.pack.upsert / sticker.pack.delete events.

    Foreign packs are stored locally with origin_server_id + foreign_pack_id
    set so subsequent updates/deletes find the same row.
    """
    payload = event.get("payload") or {}
    event_type = str(event.get("event_type") or "")
    origin = str(event.get("origin_server_id") or "").strip()
    foreign_pack_id = int(payload.get("pack_id") or 0)
    if not origin or not foreign_pack_id:
        return

    def _apply() -> None:
        with db._conn() as con:
            # Ensure schema (foreign nodes may have older DB).
            for _ddl in (
                "ALTER TABLE sticker_packs ADD COLUMN origin_server_id TEXT DEFAULT NULL",
                "ALTER TABLE sticker_packs ADD COLUMN foreign_pack_id INTEGER DEFAULT NULL",
            ):
                try: con.execute(_ddl)
                except Exception: pass

            row = con.execute(
                "SELECT id FROM sticker_packs WHERE origin_server_id=? AND foreign_pack_id=?",
                (origin, foreign_pack_id),
            ).fetchone()

            if event_type == "sticker.pack.delete":
                if row:
                    pid = int(row["id"])
                    con.execute("DELETE FROM stickers WHERE pack_id=?", (pid,))
                    con.execute("DELETE FROM user_sticker_packs WHERE pack_id=?", (pid,))
                    con.execute("DELETE FROM sticker_packs WHERE id=?", (pid,))
                return

            # upsert
            name = str(payload.get("name") or "").strip() or "Imported Pack"
            desc = str(payload.get("description") or "")[:200]
            is_public = int(payload.get("is_public") or 1)
            # Owner mapping: use a synthetic system user (-1) so foreign packs
            # never appear as a local user's pack but still satisfy the FK
            # contract loosely via the public-browse path. We don't enforce
            # FK in stickers tables (no PRAGMA foreign_keys=ON globally).
            owner_id = -1
            if row:
                pid = int(row["id"])
                con.execute(
                    "UPDATE sticker_packs SET name=?, description=?, is_public=? WHERE id=?",
                    (name, desc, is_public, pid),
                )
                con.execute("DELETE FROM stickers WHERE pack_id=?", (pid,))
            else:
                cur = con.execute(
                    "INSERT INTO sticker_packs (name, description, owner_id, is_public, "
                    "origin_server_id, foreign_pack_id) VALUES (?, ?, ?, ?, ?, ?)",
                    (name, desc, owner_id, is_public, origin, foreign_pack_id),
                )
                pid = int(cur.lastrowid)
            for s in (payload.get("stickers") or []):
                try:
                    # Effects come over the wire as either an already-encoded
                    # JSON string (from the DB column) or a dict (older peers).
                    # Re-validate before persisting — federation is an
                    # untrusted boundary; the local `validate_sticker_effects`
                    # is the only thing that gets to write the column.
                    fx_raw = s.get("effects")
                    fx_json = None
                    try:
                        from routers.gifs import validate_sticker_effects as _vfx
                        if isinstance(fx_raw, str) and fx_raw.strip():
                            import json as _j
                            fx_raw = _j.loads(fx_raw)
                        fx_norm = _vfx(fx_raw)
                        if fx_norm:
                            import json as _j2
                            fx_json = _j2.dumps(fx_norm)
                    except Exception:
                        fx_json = None
                    con.execute(
                        "INSERT INTO stickers (pack_id, name, image_data, emoji, effects) VALUES (?, ?, ?, ?, ?)",
                        (pid, str(s.get("name") or ""), str(s.get("image_data") or ""), str(s.get("emoji") or ""), fx_json),
                    )
                except Exception:
                    continue

    try:
        await asyncio.to_thread(_apply)
    except Exception:
        _log.exception("sticker federation apply failed (origin=%s pack=%s)", origin, foreign_pack_id)


async def _handle_bot_event(event: dict) -> None:
    """Apply incoming bot.upsert / bot.delete catalog events.

    Federated public bots are mirrored locally with owner_id=-1 so peer
    users can browse them in the Bot Directory and install them into
    local channels. The bot's *runtime* (API key, message-sending) lives
    on the origin server; we only replicate the catalog metadata here.
    """
    payload = event.get("payload") or {}
    event_type = str(event.get("event_type") or "")
    origin = str(event.get("origin_server_id") or "").strip()
    foreign_bot_id = int(payload.get("bot_id") or 0)
    if not origin or not foreign_bot_id:
        return

    def _apply() -> None:
        # Ensure schema (older peers may not have the federation columns yet).
        with db._conn() as con:
            for _ddl in (
                "ALTER TABLE bots ADD COLUMN origin_server_id TEXT DEFAULT NULL",
                "ALTER TABLE bots ADD COLUMN foreign_bot_id INTEGER DEFAULT NULL",
                "ALTER TABLE bots ADD COLUMN owner_nickname TEXT DEFAULT NULL",
            ):
                try: con.execute(_ddl)
                except Exception: pass

        if event_type == "bot.delete":
            db.delete_federated_bot(origin, foreign_bot_id)
            return

        # upsert
        name = str(payload.get("name") or "").strip() or f"bot{foreign_bot_id}"
        avatar = payload.get("avatar") or None
        desc = str(payload.get("description") or "")[:280]
        is_public = int(payload.get("is_public") or 0)
        owner_nick = str(payload.get("owner_nickname") or "")
        if not is_public:
            # Origin flipped it private — drop the mirror.
            db.delete_federated_bot(origin, foreign_bot_id)
            return
        # Honor this node's ban list — if an admin has already banned
        # this federated bot, refuse to re-mirror it and ensure any
        # stale row is gone.
        if db.is_federated_bot_banned(origin, foreign_bot_id):
            db.delete_federated_bot(origin, foreign_bot_id)
            return
        db.upsert_federated_bot(
            origin, foreign_bot_id,
            name=name, avatar=avatar, description=desc,
            owner_nickname=owner_nick, is_public=1,
        )

    try:
        await asyncio.to_thread(_apply)
    except Exception:
        _log.exception("bot federation apply failed (origin=%s bot=%s)", origin, foreign_bot_id)


async def _handle_server_event(event: dict) -> None:
    payload = event.get("payload") or {}
    event_type = str(event.get("event_type") or "")
    if event_type == "server.channel_retention.updated":
        _log.warning("Ignoring remote channel retention settings update event")
        return
    if event_type != "server.channel_retention.pruned":
        return

    source_server = str(event.get("source_server") or "unknown")
    deleted_count = int(payload.get("deleted_count") or 0)
    directory_days = int(payload.get("directory_active_days") or 30)
    auto_delete_days = int(payload.get("auto_delete_days") or 0)
    _log.info(
        "Federation prune report from %s: deleted=%s (directory_active_days=%s, auto_delete_days=%s)",
        source_server,
        deleted_count,
        directory_days,
        auto_delete_days,
    )


# ──────────────────────────────────────────────────────────────
# Phase 6: Tor federation
# ──────────────────────────────────────────────────────────────

@router.get("/network/status/tor")
async def network_status_tor():
    """TOR-specific server identity endpoint."""
    local = db.get_or_create_local_server_identity()
    public = _public_server_view(local, onion_only=True)
    return {
        "server": {
            "server_id": public["server_id"],
            "display_name": public["display_name"],
            "base_url": public.get("base_url") or "",
            "onion_url": public.get("onion_url") or "",
            "tor_enabled": bool(public.get("onion_url")),
            "federation_enabled": True,
        }
    }


@router.post("/network/servers/register-transport")
async def register_transport_preference(
    server_id: str,
    transport: str,  # "clearnet" | "onion" | "auto"
    x_federation_token: str | None = Header(default=None),
):
    """Register preferred transport for communicating with a peer server."""
    if not _fed_token_ok(x_federation_token):
        return JSONResponse(status_code=401, content={"error": "Invalid federation token"})

    if transport not in ("clearnet", "onion", "auto"):
        return JSONResponse(status_code=400, content={"error": "Invalid transport"})

    db.set_federation_server_transport(server_id, transport)
    return {"ok": True}


@router.get("/federation/failover/status")
async def federation_failover_status(
    x_federation_token: str | None = Header(default=None),
):
    """Report current failover state and backup servers."""
    if not _fed_token_ok(x_federation_token):
        return JSONResponse(status_code=401, content={"error": "Invalid federation token"})

    servers = db.list_federation_servers()
    healthy_servers = []
    for srv in servers:
        if srv.get("enabled"):
            healthy_servers.append({
                "server_id": srv["server_id"],
                "base_url": srv.get("base_url"),
                "onion_url": srv.get("onion_url"),
                "transport": db.get_federation_server_transport(srv["server_id"]),
                "last_seen": srv.get("last_seen"),
            })

    return {
        "healthy_servers": healthy_servers,
        "primary": healthy_servers[0] if healthy_servers else None,
    }
