"""Link preview (Open Graph) scraper for rich embeds with YouTube support."""
import re
import httpx
from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from typing import Optional
from deps import get_current_user

router = APIRouter(prefix="/preview", tags=["preview"])

# Cache previews in memory (simple TTL-less cache, max 500 entries)
_cache = {}
MAX_CACHE = 500

# Regex for OG meta tags
OG_REGEX = re.compile(r'<meta\s+(?:property|name)=["\']og:([^"\']+)["\']\s+content=["\']([^"\']*)["\']', re.IGNORECASE)
TITLE_REGEX = re.compile(r'<title[^>]*>([^<]+)</title>', re.IGNORECASE)
DESC_REGEX = re.compile(r'<meta\s+name=["\']description["\']\s+content=["\']([^"\']*)["\']', re.IGNORECASE)
FAVICON_REGEX = re.compile(r'<link[^>]+rel=["\'](?:icon|shortcut icon)["\'][^>]+href=["\']([^"\']+)["\']', re.IGNORECASE)

# YouTube URL patterns
YOUTUBE_PATTERNS = [
    re.compile(r'(?:https?://)?(?:www\.)?youtube\.com/watch\?v=([a-zA-Z0-9_-]{11})'),
    re.compile(r'(?:https?://)?(?:www\.)?youtube\.com/embed/([a-zA-Z0-9_-]{11})'),
    re.compile(r'(?:https?://)?(?:www\.)?youtube\.com/v/([a-zA-Z0-9_-]{11})'),
    re.compile(r'(?:https?://)?youtu\.be/([a-zA-Z0-9_-]{11})'),
    re.compile(r'(?:https?://)?(?:www\.)?youtube\.com/shorts/([a-zA-Z0-9_-]{11})'),
]

# Twitter/X patterns
TWITTER_PATTERN = re.compile(r'(?:https?://)?(?:www\.)?(?:twitter\.com|x\.com)/\w+/status/(\d+)')

# Spotify patterns
SPOTIFY_PATTERN = re.compile(r'(?:https?://)?open\.spotify\.com/(track|album|playlist)/([a-zA-Z0-9]+)')


def extract_youtube_id(url: str) -> Optional[str]:
    """Extract YouTube video ID from URL."""
    for pattern in YOUTUBE_PATTERNS:
        match = pattern.search(url)
        if match:
            return match.group(1)
    return None


def extract_twitter_id(url: str) -> Optional[str]:
    """Extract Twitter status ID from URL."""
    match = TWITTER_PATTERN.search(url)
    return match.group(1) if match else None


def extract_spotify_info(url: str) -> Optional[tuple]:
    """Extract Spotify type and ID from URL."""
    match = SPOTIFY_PATTERN.search(url)
    return (match.group(1), match.group(2)) if match else None


async def fetch_og_data(url: str) -> dict:
    """Fetch and parse OG meta tags from a URL."""
    if url in _cache:
        return _cache[url]
    
    # Check for YouTube
    yt_id = extract_youtube_id(url)
    if yt_id:
        result = {
            "type": "youtube",
            "video_id": yt_id,
            "title": "YouTube Video",
            "site_name": "YouTube",
            "image": f"https://img.youtube.com/vi/{yt_id}/maxresdefault.jpg",
            "embed_url": f"https://www.youtube.com/embed/{yt_id}",
            "url": url,
        }
        # Try to get actual title via noembed
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                resp = await client.get(f"https://noembed.com/embed?url=https://youtube.com/watch?v={yt_id}")
                if resp.status_code == 200:
                    data = resp.json()
                    result["title"] = data.get("title", "YouTube Video")
                    result["author"] = data.get("author_name", "")
        except:
            pass
        _cache[url] = result
        return result
    
    # Check for Twitter/X
    tw_id = extract_twitter_id(url)
    if tw_id:
        result = {
            "type": "twitter",
            "tweet_id": tw_id,
            "site_name": "Twitter/X",
            "url": url,
        }
        _cache[url] = result
        return result
    
    # Check for Spotify
    sp_info = extract_spotify_info(url)
    if sp_info:
        sp_type, sp_id = sp_info
        result = {
            "type": "spotify",
            "spotify_type": sp_type,
            "spotify_id": sp_id,
            "site_name": "Spotify",
            "embed_url": f"https://open.spotify.com/embed/{sp_type}/{sp_id}",
            "url": url,
        }
        _cache[url] = result
        return result
    
    # Standard OG fetch
    try:
        async with httpx.AsyncClient(timeout=5.0, follow_redirects=True) as client:
            resp = await client.get(url, headers={
                'User-Agent': 'Mozilla/5.0 (compatible; FrogTalk/1.0; +https://frogtalk.xyz)'
            })
            if resp.status_code != 200:
                return {}
            
            html = resp.text[:50000]  # Limit parsing to first 50KB
            
            # Extract OG tags
            og = {"type": "link"}
            for match in OG_REGEX.finditer(html):
                key, value = match.groups()
                og[key] = value.strip()
            
            # Fallback to standard title/description
            if 'title' not in og:
                title_match = TITLE_REGEX.search(html)
                if title_match:
                    og['title'] = title_match.group(1).strip()
            
            if 'description' not in og:
                desc_match = DESC_REGEX.search(html)
                if desc_match:
                    og['description'] = desc_match.group(1).strip()
            
            # Try to get favicon
            favicon_match = FAVICON_REGEX.search(html)
            if favicon_match:
                favicon = favicon_match.group(1)
                # Make absolute URL if relative
                if favicon.startswith('/'):
                    from urllib.parse import urlparse
                    parsed = urlparse(url)
                    favicon = f"{parsed.scheme}://{parsed.netloc}{favicon}"
                og['favicon'] = favicon
            
            # Set site name from URL if not present
            if 'site_name' not in og:
                from urllib.parse import urlparse
                og['site_name'] = urlparse(url).netloc
            
            og['url'] = url
            
            # Cache result
            if len(_cache) >= MAX_CACHE:
                _cache.pop(next(iter(_cache)))  # Remove oldest
            _cache[url] = og
            
            return og
    except Exception:
        return {}


@router.get("")
async def get_link_preview(
    url: str = Query(..., min_length=10, max_length=2000),
    _: dict = Depends(get_current_user),
):
    """Fetch OG metadata for a URL to display as a rich preview."""
    # Basic URL validation
    if not url.startswith(('http://', 'https://')):
        return JSONResponse(status_code=400, content={"error": "Invalid URL"})

    # SSRF guard. Reject any URL whose hostname resolves to a non-public
    # address (loopback, private RFC1918, link-local, multicast, reserved,
    # unspecified). Resolves once here so a malicious DNS record that points
    # at 127.0.0.1 / 10.x / 169.254.x / fc00::/7 etc. is blocked before we
    # ever issue the outbound HTTP request. The previous string-prefix
    # blacklist allowed both DNS-rebinding and false-positives like
    # `172.217.x.x` (Google) being blocked while `100.64.x.x` (CGNAT) and
    # most IPv6 private ranges slipped through.
    import ipaddress, socket
    from urllib.parse import urlparse
    parsed = urlparse(url)
    host = (parsed.hostname or "").strip()
    if not host:
        return JSONResponse(status_code=400, content={"error": "Invalid URL"})
    # Block obvious metadata hostnames up-front (cloud IMDS endpoints).
    bad_names = {"metadata.google.internal", "metadata.goog", "metadata"}
    if host.lower() in bad_names:
        return JSONResponse(status_code=400, content={"error": "Invalid URL"})
    try:
        infos = socket.getaddrinfo(host, None)
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid URL"})
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except Exception:
            return JSONResponse(status_code=400, content={"error": "Invalid URL"})
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_multicast or ip.is_reserved or ip.is_unspecified):
            return JSONResponse(status_code=400, content={"error": "Invalid URL"})

    og = await fetch_og_data(url)
    
    if not og:
        return {"preview": None}
    
    # Return enhanced preview with embed type
    preview = {
        "type": og.get("type", "link"),
        "url": url,
        "title": og.get('title', ''),
        "description": og.get('description', '')[:300] if og.get('description') else '',
        "image": og.get('image', ''),
        "site_name": og.get('site_name', ''),
        "favicon": og.get('favicon', ''),
    }
    
    # Add embed-specific fields
    if og.get("type") == "youtube":
        preview["video_id"] = og.get("video_id")
        preview["embed_url"] = og.get("embed_url")
        preview["author"] = og.get("author", "")
    elif og.get("type") == "spotify":
        preview["embed_url"] = og.get("embed_url")
        preview["spotify_type"] = og.get("spotify_type")
    elif og.get("type") == "twitter":
        preview["tweet_id"] = og.get("tweet_id")
    
    return {"preview": preview}
