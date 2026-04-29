"""Web Push notifications via VAPID (pywebpush)."""
import json
import logging
import os
from fastapi import APIRouter, Depends
from pydantic import BaseModel

import database as db
from deps import get_current_user

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/push", tags=["push"])

VAPID_CLAIMS = {"sub": "mailto:admin@frogtalk.xyz"}

# Tracks whether we've already logged the "Firebase not configured" warning
# so we don't spam the journal on every push attempt.
_firebase_init_warned = False


# ── VAPID key management ──────────────────────────────────────────────────────

def _generate_vapid_keys():
    """Generate a new VAPID EC key pair, store in DB config."""
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.backends import default_backend
    from cryptography.hazmat.primitives import serialization
    import base64

    private_key = ec.generate_private_key(ec.SECP256R1(), default_backend())
    private_pem = private_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.TraditionalOpenSSL,
        serialization.NoEncryption(),
    ).decode()
    pub_bytes = private_key.public_key().public_bytes(
        serialization.Encoding.X962,
        serialization.PublicFormat.UncompressedPoint,
    )
    public_key = base64.urlsafe_b64encode(pub_bytes).rstrip(b"=").decode()
    db.set_config("vapid_private_key", private_pem)
    db.set_config("vapid_public_key", public_key)
    return private_pem, public_key


def get_vapid_keys():
    priv = db.get_config("vapid_private_key")
    pub  = db.get_config("vapid_public_key")
    if priv and pub:
        return priv, pub
    return _generate_vapid_keys()


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/vapid-key")
async def vapid_public_key():
    _, pub = get_vapid_keys()
    return {"public_key": pub}


class PushSubscription(BaseModel):
    endpoint: str
    keys: dict  # {p256dh, auth}


class FCMSubscription(BaseModel):
    token: str
    platform: str = "android"


@router.post("/subscribe")
async def subscribe(sub: PushSubscription, current_user: dict = Depends(get_current_user)):
    db.save_push_subscription(
        current_user["id"],
        sub.endpoint,
        sub.keys.get("p256dh", ""),
        sub.keys.get("auth", ""),
    )
    return {"ok": True}


@router.delete("/unsubscribe")
async def unsubscribe(data: dict, current_user: dict = Depends(get_current_user)):
    endpoint = data.get("endpoint", "")
    if endpoint:
        db.delete_push_subscription(endpoint)
    return {"ok": True}


@router.post("/fcm-subscribe")
async def fcm_subscribe(sub: FCMSubscription, current_user: dict = Depends(get_current_user)):
    token = (sub.token or "").strip()
    if not token:
        return {"ok": False, "error": "missing token"}
    db.save_fcm_token(current_user["id"], token, sub.platform or "android")
    return {"ok": True}


@router.delete("/fcm-unsubscribe")
async def fcm_unsubscribe(data: dict, current_user: dict = Depends(get_current_user)):
    token = str(data.get("token") or "").strip()
    if token:
        db.delete_fcm_token(token)
    return {"ok": True}


def _get_firebase_app():
    """Return initialized firebase_admin app, or None if not configured."""
    global _firebase_init_warned
    try:
        import firebase_admin
        from firebase_admin import credentials
    except Exception:
        if not _firebase_init_warned:
            logger.warning("firebase-admin package not installed; Android FCM disabled")
            _firebase_init_warned = True
        return None

    if firebase_admin._apps:
        return firebase_admin.get_app()

    cred_path = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()
    if not cred_path or not os.path.exists(cred_path):
        if not _firebase_init_warned:
            logger.warning(
                "FIREBASE_SERVICE_ACCOUNT_JSON not set or file missing (path=%r); "
                "Android FCM push disabled. Calls/DMs will NOT ring on Android.",
                cred_path or "<unset>",
            )
            _firebase_init_warned = True
        return None
    try:
        project_id = os.getenv("FIREBASE_PROJECT_ID", "").strip() or None
        if project_id:
            app = firebase_admin.initialize_app(
                credentials.Certificate(cred_path),
                {"projectId": project_id},
            )
        else:
            app = firebase_admin.initialize_app(credentials.Certificate(cred_path))
        logger.info("firebase-admin initialized: project=%s", project_id or "<from-cred>")
        return app
    except Exception:
        logger.exception("Failed to initialize Firebase Admin SDK")
        return None


def _send_fcm(user_id: int, title: str, body: str, url: str = "/app", *,
              kind: str = "message", tag: str | None = None,
              require_interaction: bool = False, extra: dict | None = None):
    """Send FCM data messages to Android devices. Silent fail if not configured."""
    app = _get_firebase_app()
    if app is None:
        return
    try:
        from firebase_admin import messaging
    except Exception:
        return

    tokens = db.get_fcm_tokens(user_id, platform="android")
    if not tokens:
        if kind == "call":
            logger.info(
                "fcm call: user=%d kind=call SKIP no_android_tokens (caller will hit voicemail-equivalent)",
                user_id,
            )
        return

    data = {
        "title": str(title or "FrogTalk"),
        "body": str(body or ""),
        "url": str(url or "/app"),
        "kind": str(kind or "message"),
        "tag": str(tag or f"ft-{kind}"),
        "requireInteraction": "1" if require_interaction else "0",
    }
    if extra:
        for k, v in extra.items():
            if v is not None:
                data[str(k)] = str(v)

    ok_count = 0
    fail_count = 0
    for row in tokens:
        token = row.get("token")
        if not token:
            continue
        # Calls stay data-only so the on-device CallService can drive the
        # ring/full-screen flow. Everything else gets a hybrid payload —
        # data + notification + AndroidNotification — so the FCM SDK draws
        # a heads-up itself when the app is force-stopped or in deep Doze
        # and the data handler can't be woken to render its own.
        if kind == "call":
            msg = messaging.Message(
                token=token,
                data=data,
                android=messaging.AndroidConfig(
                    priority="high",
                    ttl=30,
                ),
            )
        else:
            msg = messaging.Message(
                token=token,
                data=data,
                notification=messaging.Notification(
                    title=str(title or "FrogTalk"),
                    body=str(body or ""),
                ),
                android=messaging.AndroidConfig(
                    priority="high",
                    ttl=120,
                    notification=messaging.AndroidNotification(
                        channel_id="frogtalk_general",
                        sound="default",
                        default_vibrate_timings=True,
                        visibility="public",
                        tag=str(tag or f"ft-{kind}"),
                    ),
                ),
            )
        try:
            messaging.send(msg, app=app)
            ok_count += 1
        except Exception as e:
            fail_count += 1
            # Unregister dead tokens so retries don't keep failing forever.
            txt = str(e).lower()
            if "registration-token-not-registered" in txt or "invalid-registration-token" in txt:
                db.delete_fcm_token(token)
                logger.info("fcm token invalid, removed: user=%d ...%s", user_id, token[-8:] if len(token) >= 8 else token)
            else:
                logger.warning("fcm send failed: user=%d kind=%s err=%s", user_id, kind, e)

    # Single structured log line per call — makes "did the call push leave
    # the server?" answerable from journalctl.
    logger.info(
        "fcm send: user=%d kind=%s tokens=%d ok=%d failed=%d",
        user_id, kind, len(tokens), ok_count, fail_count,
    )

    # ── iOS (FCM-delivered APNs alerts) ───────────────────────────────────────
    # Calls go via _send_apns_voip() instead so the device wakes from suspended
    # state and rings via PushKit/CallKit. Regular alerts use FCM with an
    # APNSConfig payload so we get a banner/sound just like Android.
    if kind != "call":
        ios_tokens = db.get_fcm_tokens(user_id, platform="ios")
        for row in ios_tokens:
            token = row.get("token")
            if not token:
                continue
            try:
                ios_msg = messaging.Message(
                    token=token,
                    data=data,
                    notification=messaging.Notification(
                        title=str(title or "FrogTalk"),
                        body=str(body or ""),
                    ),
                    apns=messaging.APNSConfig(
                        headers={"apns-priority": "10"},
                        payload=messaging.APNSPayload(
                            aps=messaging.Aps(
                                alert=messaging.ApsAlert(
                                    title=str(title or "FrogTalk"),
                                    body=str(body or ""),
                                ),
                                sound="default",
                                category=str(tag or f"ft-{kind}"),
                                mutable_content=True,
                                thread_id=str(tag or kind),
                            ),
                        ),
                    ),
                )
                messaging.send(ios_msg, app=app)
            except Exception as e:
                txt = str(e).lower()
                if "registration-token-not-registered" in txt or "invalid-registration-token" in txt:
                    db.delete_fcm_token(token)
                else:
                    logger.debug("fcm(ios) send failed: %s", e)
    else:
        # Cold-launch incoming-call ring on iOS goes through PushKit, not FCM.
        try:
            _send_apns_voip(user_id, data)
        except Exception:
            logger.exception("apns voip send failed")


def _send_apns_voip(user_id: int, payload: dict):
    """Send a VoIP push (PushKit) for cold-launch ringing on iOS.

    Requires APNS_KEY_PATH (.p8), APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID env
    vars. Topic must be `<bundle-id>.voip` per Apple's PushKit contract. Uses
    httpx for HTTP/2 — silent no-op if any prerequisite is missing.
    """
    key_path = os.getenv("APNS_KEY_PATH", "").strip()
    key_id   = os.getenv("APNS_KEY_ID", "").strip()
    team_id  = os.getenv("APNS_TEAM_ID", "").strip()
    bundle   = os.getenv("APNS_BUNDLE_ID", "xyz.frogtalk.app").strip()
    if not (key_path and key_id and team_id and os.path.exists(key_path)):
        return

    voip_tokens = db.get_fcm_tokens(user_id, platform="ios_voip")
    if not voip_tokens:
        return

    try:
        import time, jwt, httpx  # PyJWT + httpx (httpx supports HTTP/2 with `h2` extra)
    except Exception:
        logger.debug("apns voip deps missing (pyjwt/httpx)")
        return

    try:
        with open(key_path, "r") as f:
            private_key = f.read()
    except Exception:
        logger.debug("apns key unreadable: %s", key_path)
        return

    now = int(time.time())
    token = jwt.encode(
        {"iss": team_id, "iat": now},
        private_key,
        algorithm="ES256",
        headers={"kid": key_id, "alg": "ES256"},
    )

    use_sandbox = os.getenv("APNS_USE_SANDBOX", "0").strip() in ("1", "true", "yes")
    host = "https://api.sandbox.push.apple.com" if use_sandbox else "https://api.push.apple.com"

    headers = {
        "authorization": f"bearer {token}",
        "apns-topic": f"{bundle}.voip",
        "apns-push-type": "voip",
        "apns-priority": "10",
        "apns-expiration": "0",
    }
    body = json.dumps(payload).encode("utf-8")

    try:
        with httpx.Client(http2=True, timeout=10.0) as client:
            for row in voip_tokens:
                tok = row.get("token")
                if not tok:
                    continue
                try:
                    resp = client.post(f"{host}/3/device/{tok}", headers=headers, content=body)
                    if resp.status_code in (400, 410):
                        # 410 Gone = unregistered; 400 BadDeviceToken = malformed.
                        db.delete_fcm_token(tok)
                except Exception as e:
                    logger.debug("apns voip post failed: %s", e)
    except Exception:
        logger.exception("apns voip http2 client failed")


# ── Utility: send push to a user ──────────────────────────────────────────────

def send_push(user_id: int, title: str, body: str, url: str = "/app",
              icon: str = "/static/icons/icon-192.png", *,
              kind: str = "message", tag: str | None = None,
              require_interaction: bool = False, extra: dict | None = None):
    """Send a web push notification to all of a user's subscriptions. Silent fail.

    `kind` lets the service worker branch (e.g. 'call' to show Accept/Reject).
    `tag` groups/replaces related notifications (use per-call id so ringing pushes
    don't stack). `require_interaction` keeps the notification on screen until the
    user acts on it — essential for incoming calls."""
    try:
        from pywebpush import webpush
    except ImportError:
        webpush = None  # type: ignore[assignment]

    if webpush is not None:
        priv, _ = get_vapid_keys()
        subs = db.get_push_subscriptions(user_id)

        payload_dict = {
            "title": title,
            "body":  body,
            "url":   url,
            "icon":  icon,
            "kind":  kind,
            "tag":   tag or f"ft-{kind}",
            "requireInteraction": bool(require_interaction),
        }
        if extra:
            payload_dict.update(extra)
        payload = json.dumps(payload_dict)

        for sub in subs:
            try:
                webpush(
                    subscription_info={
                        "endpoint": sub["endpoint"],
                        "keys": {"p256dh": sub["p256dh"], "auth": sub["auth_key"]},
                    },
                    data=payload,
                    vapid_private_key=priv,
                    vapid_claims=VAPID_CLAIMS,
                )
            except Exception as e:
                resp = getattr(e, "response", None)
                if resp is not None and getattr(resp, "status_code", 0) in (404, 410):
                    db.delete_push_subscription(sub["endpoint"])
                else:
                    logger.debug("push failed: %s", e)

    # In parallel to web-push, also send native Android FCM if configured.
    try:
        _send_fcm(
            user_id,
            title,
            body,
            url,
            kind=kind,
            tag=tag,
            require_interaction=require_interaction,
            extra=extra,
        )
    except Exception:
        logger.exception("send_push: _send_fcm crashed for user=%d kind=%s", user_id, kind)


def has_any_push_target(user_id: int) -> bool:
    """Return True if the user has at least one push transport registered.

    Used by call signaling to short-circuit a hopeless ring (callee offline AND
    no FCM/APNs/web-push subscription) so the caller's UI can show
    \"unavailable\" instead of ringing forever.
    """
    try:
        if db.get_fcm_tokens(user_id, platform="android"):
            return True
    except Exception:
        pass
    try:
        if db.get_fcm_tokens(user_id, platform="ios"):
            return True
    except Exception:
        pass
    try:
        if db.get_push_subscriptions(user_id):
            return True
    except Exception:
        pass
    return False
