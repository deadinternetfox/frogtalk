"""Authenticated image proxy.

Channel custom themes used to let an owner set `bgImage` to any
`https://attacker.example/track.png`, which every viewer's browser then
fetched directly — leaking the viewer's IP, User-Agent, and Referer to
the owner. This router proxies those images through the server so:

  1. Viewers never make a request to a third-party host the channel
     owner controls — only to FrogTalk.
  2. We can enforce a size cap and an image-only content-type
     allowlist (and re-rasterize SVG to drop embedded `<script>`).
  3. Cached on disk so we don't refetch on every page load.

SSRF defenses:

  * Scheme allowlist: only http(s).
  * Hostname blacklist: localhost, *.local, *.internal.
  * Resolved-IP check: every redirect target is re-resolved and
    rejected if it lands on a private / loopback / link-local /
    reserved range.
  * Manual redirect handling (3 hops) so we can re-validate each
    target before fetching.
  * Hard timeout + response-size cap streamed during read.
"""
from __future__ import annotations

import hashlib
import ipaddress
import io
import socket
import time
from pathlib import Path
from typing import Optional, Tuple
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse, Response

from deps import get_current_user

router = APIRouter(prefix="/proxy", tags=["proxy"])

_MAX_BYTES = 8 * 1024 * 1024  # 8 MiB
_FETCH_TIMEOUT = 10.0           # seconds
_MAX_REDIRECTS = 3
_CACHE_TTL = 7 * 24 * 60 * 60   # 7 days
_CACHE_BYTES_LIMIT = 500 * 1024 * 1024  # 500 MiB total on disk
_CACHE_DIR = Path("data/proxy_cache")
_CACHE_DIR.mkdir(parents=True, exist_ok=True)

_ALLOWED_MIME = {
    "image/png", "image/jpeg", "image/jpg", "image/webp",
    "image/gif", "image/svg+xml", "image/avif",
}
# Output MIME for sanitised SVG (rasterised through Pillow).
_SVG_OUTPUT_MIME = "image/png"
_BLOCKED_HOST_SUFFIXES = (".local", ".internal", ".localhost", ".lan",
                          ".intranet", ".corp", ".home", ".lan", ".onion")
_BLOCKED_EXACT_HOSTS = {"localhost", "ip6-localhost", "ip6-loopback",
                        "broadcasthost"}


def _hostname_blocked(host: str) -> bool:
    h = (host or "").lower().strip().rstrip(".")
    if not h:
        return True
    if h in _BLOCKED_EXACT_HOSTS:
        return True
    if any(h.endswith(suf) for suf in _BLOCKED_HOST_SUFFIXES):
        return True
    return False


def _ip_blocked(ip_str: str) -> bool:
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return True
    # Block any address that isn't a routable public unicast address.
    if (ip.is_private or ip.is_loopback or ip.is_link_local
            or ip.is_multicast or ip.is_reserved
            or ip.is_unspecified):
        return True
    # Block IPv4-mapped IPv6 if the embedded v4 is private.
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        if _ip_blocked(str(ip.ipv4_mapped)):
            return True
    return False


def _resolve_and_check(host: str) -> Optional[str]:
    """Return the resolved IP if it's a public unicast address, else
    None. Resolves both v4 and v6; rejects on ANY mapping landing in a
    blocked range (avoids DNS rebinding to a public-and-private pair)."""
    try:
        infos = socket.getaddrinfo(host, None,
                                   proto=socket.IPPROTO_TCP)
    except (socket.gaierror, UnicodeError):
        return None
    ips = {ai[4][0] for ai in infos}
    if not ips:
        return None
    for ip in ips:
        if _ip_blocked(ip):
            return None
    # Return one (preferring v4 for predictability).
    for ip in ips:
        try:
            if isinstance(ipaddress.ip_address(ip), ipaddress.IPv4Address):
                return ip
        except ValueError:
            continue
    return next(iter(ips))


def _validate_url(url: str) -> Optional[str]:
    """Return an error string, or None if the URL is safe to fetch."""
    if not url or len(url) > 2048:
        return "URL is empty or too long"
    try:
        parsed = urlparse(url)
    except Exception:
        return "URL is malformed"
    if parsed.scheme.lower() not in ("http", "https"):
        return "Only http(s) URLs are supported"
    host = parsed.hostname or ""
    if _hostname_blocked(host):
        return f"Hostname '{host}' is not allowed"
    # Direct-IP URL: only run the literal check if `host` parses as an
    # IP. For real hostnames the resolver step below handles the check.
    try:
        ipaddress.ip_address(host)
        if _ip_blocked(host):
            return "Direct IP is in a private/reserved range"
    except ValueError:
        pass
    resolved = _resolve_and_check(host)
    if not resolved:
        return f"Hostname '{host}' resolves to a blocked address"
    return None


def _cache_path(url: str) -> Path:
    key = hashlib.sha256(url.encode("utf-8")).hexdigest()
    return _CACHE_DIR / key


def _meta_path(url: str) -> Path:
    return _cache_path(url).with_suffix(".meta")


def _cache_get(url: str) -> Optional[Tuple[bytes, str]]:
    body_p = _cache_path(url)
    meta_p = _meta_path(url)
    if not (body_p.exists() and meta_p.exists()):
        return None
    try:
        meta_raw = meta_p.read_text(encoding="utf-8")
        ts_str, mime = meta_raw.split("\n", 1)
        ts = int(ts_str)
        if time.time() - ts > _CACHE_TTL:
            return None
        return body_p.read_bytes(), mime.strip()
    except Exception:
        return None


def _cache_put(url: str, body: bytes, mime: str) -> None:
    body_p = _cache_path(url)
    meta_p = _meta_path(url)
    try:
        body_p.write_bytes(body)
        meta_p.write_text(f"{int(time.time())}\n{mime}", encoding="utf-8")
        _evict_if_over_limit()
    except OSError:
        pass


def _evict_if_over_limit() -> None:
    """LRU-ish eviction: if total cache bytes exceed limit, delete the
    oldest entries (by mtime) until under the limit. Cheap to run on
    every put because the cache typically stays well under the cap."""
    try:
        entries = []
        total = 0
        for p in _CACHE_DIR.iterdir():
            if p.suffix == ".meta":
                continue
            st = p.stat()
            entries.append((st.st_mtime, st.st_size, p))
            total += st.st_size
        if total <= _CACHE_BYTES_LIMIT:
            return
        entries.sort()  # oldest first
        for _mt, sz, p in entries:
            if total <= _CACHE_BYTES_LIMIT * 0.8:
                break
            try:
                p.unlink(missing_ok=True)
                meta = p.with_suffix(".meta")
                meta.unlink(missing_ok=True)
                total -= sz
            except OSError:
                continue
    except FileNotFoundError:
        pass


def _rasterize_svg(data: bytes) -> Tuple[bytes, str]:
    """Convert an SVG to PNG via Pillow if possible. SVG can embed
    `<script>`, `<foreignObject>` with HTML, external `xlink:href`, etc.
    — none of which we want a viewer's browser to execute. If Pillow
    can't render SVG on this host (it usually can't without cairosvg),
    we fall back to refusing the upload."""
    try:
        import cairosvg  # type: ignore
        png = cairosvg.svg2png(bytestring=data, output_width=2560)
        return png, "image/png"
    except Exception:
        # No cairosvg available — refuse rather than serve raw SVG.
        raise ValueError("SVG images are not supported on this server")


def _reencode_raster(data: bytes, src_mime: str) -> Tuple[bytes, str]:
    """Re-encode a raster image through Pillow. Strips EXIF, ICC, and
    any other ancillary chunks an attacker could use to fingerprint
    viewers. Caps the longest edge at 2560 px to keep cached bodies
    reasonable."""
    try:
        from PIL import Image, ImageOps
        img = Image.open(io.BytesIO(data))
        img.load()
        img = ImageOps.exif_transpose(img)
        max_side = 2560
        if max(img.size) > max_side:
            img.thumbnail((max_side, max_side))
        out = io.BytesIO()
        if src_mime in ("image/jpeg", "image/jpg"):
            if img.mode not in ("RGB", "L"):
                img = img.convert("RGB")
            img.save(out, format="JPEG", quality=85, optimize=True)
            return out.getvalue(), "image/jpeg"
        if src_mime == "image/webp":
            img.save(out, format="WEBP", quality=85)
            return out.getvalue(), "image/webp"
        if src_mime == "image/gif":
            # Preserve animation when re-saving.
            img.save(out, format="GIF", save_all=True)
            return out.getvalue(), "image/gif"
        if src_mime == "image/avif":
            # Re-encode AVIF to WebP — Pillow's AVIF writer needs
            # libheif which isn't always available on the host.
            if img.mode not in ("RGB", "RGBA"):
                img = img.convert("RGB")
            img.save(out, format="WEBP", quality=85)
            return out.getvalue(), "image/webp"
        # Default: PNG
        img.save(out, format="PNG", optimize=True)
        return out.getvalue(), "image/png"
    except Exception as e:
        raise ValueError(f"Could not re-encode image: {e}")


async def _fetch_with_redirects(url: str) -> Tuple[bytes, str]:
    """Fetch with manual redirect handling so every hop is re-validated
    against the SSRF allowlist. Returns (body, mime). Raises ValueError
    on policy failure or RuntimeError on transport failure."""
    seen = set()
    current = url
    for _hop in range(_MAX_REDIRECTS + 1):
        if current in seen:
            raise ValueError("Redirect loop")
        seen.add(current)
        err = _validate_url(current)
        if err:
            raise ValueError(err)

        async with httpx.AsyncClient(
            follow_redirects=False,
            timeout=_FETCH_TIMEOUT,
            headers={"User-Agent": "FrogTalk-ImageProxy/1.0",
                     "Accept": "image/*"},
        ) as client:
            try:
                async with client.stream("GET", current) as resp:
                    if resp.status_code in (301, 302, 303, 307, 308):
                        loc = resp.headers.get("location")
                        if not loc:
                            raise ValueError("Redirect without Location header")
                        # Resolve relative redirects against the current
                        # URL (httpx already returns absolute most of
                        # the time, but be defensive).
                        from urllib.parse import urljoin
                        current = urljoin(current, loc)
                        continue
                    if resp.status_code != 200:
                        raise RuntimeError(f"Upstream returned HTTP {resp.status_code}")
                    mime = (resp.headers.get("content-type") or "").split(";")[0].strip().lower()
                    if mime not in _ALLOWED_MIME:
                        raise ValueError(f"Disallowed content-type '{mime}'")
                    body = bytearray()
                    async for chunk in resp.aiter_bytes(chunk_size=64 * 1024):
                        body.extend(chunk)
                        if len(body) > _MAX_BYTES:
                            raise ValueError("Upstream body exceeded size cap")
                    return bytes(body), mime
            except httpx.HTTPError as e:
                raise RuntimeError(f"Upstream fetch failed: {e}")
    raise ValueError("Too many redirects")


@router.get("/image")
async def proxy_image(
    u: str = Query(..., min_length=1, max_length=2048),
    current_user: dict = Depends(get_current_user),
):
    """Proxy an image URL after SSRF / content-type / size validation.
    Cached on disk so the upstream only sees one fetch per URL per
    `_CACHE_TTL` window across the whole server."""
    # Cache hit short-circuits the entire fetch + re-encode path.
    cached = _cache_get(u)
    if cached:
        body, mime = cached
        return Response(
            content=body,
            media_type=mime,
            headers={
                "Cache-Control": "public, max-age=604800, immutable",
                "X-Proxy-Cache": "HIT",
                "Vary": "Accept",
            },
        )

    # Validate first so the cheap rejection path doesn't even touch the
    # network.
    err = _validate_url(u)
    if err:
        return JSONResponse(status_code=400, content={"error": err})

    try:
        body, mime = await _fetch_with_redirects(u)
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": str(e)})
    except RuntimeError as e:
        return JSONResponse(status_code=502, content={"error": str(e)})

    try:
        if mime == "image/svg+xml":
            body, mime = _rasterize_svg(body)
        else:
            body, mime = _reencode_raster(body, mime)
    except ValueError as e:
        return JSONResponse(status_code=415, content={"error": str(e)})

    _cache_put(u, body, mime)
    return Response(
        content=body,
        media_type=mime,
        headers={
            "Cache-Control": "public, max-age=604800, immutable",
            "X-Proxy-Cache": "MISS",
            "Vary": "Accept",
        },
    )
