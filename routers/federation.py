"""Federation and network discovery routes (phase-1 scaffold)."""
import os
import time
import asyncio
import json
import hashlib
import urllib.request
import urllib.error
import urllib.parse
from pathlib import Path
import tempfile
import shutil
import subprocess
from datetime import datetime
from fastapi import APIRouter, Header, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import database as db

router = APIRouter(tags=["federation"])


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


def _probe_url(base_url: str, timeout_s: float = 1.2) -> dict:
    start = time.perf_counter()
    target = _normalize_base_url(base_url)
    if not target:
        return {"ok": False, "latency_ms": None, "error": "missing_base_url"}
    try:
        req = urllib.request.Request(
            f"{target}/api/network/status",
            headers={"User-Agent": "FrogTalk-Probe/1.0"},
            method="GET",
        )
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            ok = 200 <= int(resp.status) < 300
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
    req = urllib.request.Request(
        feed_url,
        headers={"User-Agent": "FrogTalk-Updater/1.0", "Accept": "application/json"},
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
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
    req = urllib.request.Request(url, headers={"User-Agent": "FrogTalk-Updater/1.0"}, method="GET")
    with urllib.request.urlopen(req, timeout=timeout_s) as resp, open(target_path, "wb") as out:
        while True:
            chunk = resp.read(65536)
            if not chunk:
                break
            out.write(chunk)


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


def _current_user_from_header(x_session_token: str | None) -> dict | None:
    if not x_session_token:
        return None
    return db.get_user_by_token(x_session_token)


def _load_directory_entries(directory_url: str, timeout_s: float = 4.0) -> list[dict]:
    req = urllib.request.Request(
        directory_url,
        headers={"User-Agent": "FrogTalk-DirectorySync/1.0", "Accept": "application/json"},
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
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
    if not server_id or not base_url:
        return None
    display_name = str(item.get("display_name") or item.get("name") or server_id).strip()
    onion_url = str(item.get("onion_url") or item.get("onion") or "").strip()
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
    return {
        "server": {
            "server_id": local["server_id"],
            "display_name": local["display_name"],
            "base_url": local["base_url"],
            "onion_url": local["onion_url"],
            "federation_enabled": os.getenv("FROGTALK_FEDERATION_ENABLED", "0") in ("1", "true", "yes"),
            "tor_enabled": os.getenv("FROGTALK_TOR_ENABLED", "0") in ("1", "true", "yes"),
        }
    }


@router.get("/network/servers")
async def list_network_servers(request: Request, official_only: int = 0):
    rows = db.list_federation_servers(official_only=bool(official_only))
    local = db.get_or_create_local_server_identity()
    request_base = _normalize_base_url(str(request.base_url))
    local_base = _normalize_base_url(local.get("base_url") or request_base)
    if local_base and not any((s.get("server_id") == local["server_id"] or _normalize_base_url(s.get("base_url") or "") == local_base) for s in rows):
        rows.insert(0, {
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
        })
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
        target = server.get("base_url") or ""
        if include_onion and server.get("onion_url"):
            target = server.get("onion_url")
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
    official_only: int = 1,
    prefer_tor: int = 0,
    timeout_ms: int = 1200,
):
    probe = await probe_network_servers(
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
    current_user = _current_user_from_header(x_session_token)
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
        try:
            req = urllib.request.Request(
                f"{base}/api/network/build/local",
                headers={"User-Agent": "FrogTalk-BuildVerify/1.0", "Accept": "application/json"},
                method="GET",
            )
            with urllib.request.urlopen(req, timeout=2.5) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
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
    current_user = _current_user_from_header(x_session_token)
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
    current_user = _current_user_from_header(x_session_token)
    if not (current_user and current_user.get("is_admin")):
        return JSONResponse(status_code=403, content={"error": "Admin required"})
    return _check_update_once(auto_apply=False)


@router.post("/network/update/apply")
async def network_update_apply(
    body: UpdateApplyBody,
    x_session_token: str | None = Header(default=None),
):
    current_user = _current_user_from_header(x_session_token)
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
    current_user = _current_user_from_header(x_session_token)
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
    current_user = _current_user_from_header(x_session_token)
    is_admin = bool(current_user and current_user.get("is_admin"))
    if not (is_admin or _fed_token_ok(x_federation_token)):
        return JSONResponse(status_code=403, content={"error": "Not authorised"})
    result = await sync_official_directory_once()
    if not result.get("ok"):
        return JSONResponse(status_code=400, content=result)
    return result


@router.get("/identity/me")
async def identity_me(x_session_token: str | None = Header(default=None)):
    current_user = _current_user_from_header(x_session_token)
    if not current_user:
        return JSONResponse(status_code=401, content={"error": "Not authenticated"})
    ident = db.get_user_identity(current_user["id"]) or {}
    return {
        "id": ident.get("id"),
        "nickname": ident.get("nickname"),
        "global_user_id": ident.get("global_user_id"),
        "identity_pubkey": ident.get("identity_pubkey"),
    }


@router.put("/identity/me/pubkey")
async def set_identity_pubkey(
    body: IdentityPubKeyBody,
    x_session_token: str | None = Header(default=None),
):
    current_user = _current_user_from_header(x_session_token)
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
    current_user = _current_user_from_header(x_session_token)
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


@router.post("/federation/events/inbox")
async def federation_inbox(
    body: FederationInboxBody,
    x_federation_token: str | None = Header(default=None),
):
    if not _fed_token_ok(x_federation_token):
        return JSONResponse(status_code=401, content={"error": "Invalid federation token"})

    accepted = 0
    rejected = 0
    for ev in body.events:
        if db.insert_federation_inbox_event(ev):
            accepted += 1
        else:
            rejected += 1
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
    current_user = _current_user_from_header(x_session_token)
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


async def federation_inbox_processor():
    """Background task: apply inbox events with idempotency."""
    while True:
        await asyncio.sleep(5)
        try:
            events = db.list_federation_inbox_events(status="pending", limit=10)
            for ev in events:
                try:
                    # Idempotency: skip if already applied
                    if db.is_event_applied(ev["event_id"]):
                        db.mark_federation_inbox_event(ev["event_id"], "applied")
                        continue

                    event_type = ev.get("event_type", "")

                    # Dispatch to handler
                    if event_type.startswith("message."):
                        await _handle_message_event(ev)
                    elif event_type.startswith("room."):
                        await _handle_room_event(ev)
                    elif event_type.startswith("user."):
                        await _handle_user_event(ev)

                    db.mark_federation_inbox_event(ev["event_id"], "applied")
                except Exception as e:
                    print(f"[Federation] Inbox event {ev['event_id']} error: {e}")
                    db.mark_federation_inbox_event(ev["event_id"], "failed")
        except Exception as e:
            print(f"[Federation] Inbox processor error: {e}")


async def _handle_message_event(event: dict) -> None:
    """Handle incoming message event from remote server."""
    payload = event.get("payload") or {}
    # Example: sync message from remote server to local DB if room/DM exists
    # Implementation depends on message replication policy


async def _handle_room_event(event: dict) -> None:
    """Handle incoming room event (create/update/delete)."""
    payload = event.get("payload") or {}
    # Example: sync room metadata from remote server


async def _handle_user_event(event: dict) -> None:
    """Handle incoming user event (profile update, etc)."""
    payload = event.get("payload") or {}
    # Example: sync profile claims from remote server


# ──────────────────────────────────────────────────────────────
# Phase 6: Tor federation
# ──────────────────────────────────────────────────────────────

@router.get("/network/status/tor")
async def network_status_tor():
    """TOR-specific server identity endpoint."""
    local = db.get_or_create_local_server_identity()
    onion_url = os.getenv("FROGTALK_ONION_URL", "").strip()
    return {
        "server": {
            "server_id": local["server_id"],
            "display_name": local["display_name"],
            "base_url": local.get("base_url") or "",
            "onion_url": onion_url,
            "tor_enabled": bool(onion_url),
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
