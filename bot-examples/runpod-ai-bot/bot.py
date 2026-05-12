"""
RunPod-powered FrogTalk chat bot.

Independent reference implementation — runs anywhere, talks to FrogTalk
only via the public `/api/external/*` HTTP API. See README.md for the
full quickstart.

Author: example for FrogTalk bot SDK ecosystem.
License: MIT.
"""
from __future__ import annotations

import argparse
import logging
import os
import re
import sys
import time
from collections import deque
from typing import Iterable

import requests

try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:  # python-dotenv is optional; env still works without it
    pass


log = logging.getLogger("runpod-bot")


# ---------------------------------------------------------------------------
# FrogTalk client
# ---------------------------------------------------------------------------
class FrogTalkClient:
    """Tiny wrapper around the FrogTalk External API.

    Designed to mirror the shape of `node-telegram-bot-api` / botfather
    helpers: one method per endpoint we care about, dictionaries in &
    out, no opinions about polling cadence.
    """

    def __init__(self, server_url: str, bot_token: str, user_session: str | None = None):
        self.server = server_url.rstrip("/")
        self.bot_token = bot_token
        self.user_session = user_session
        self._session = requests.Session()

    def _bot_headers(self) -> dict:
        return {
            "X-API-Key": self.bot_token,
            "Accept": "application/json",
        }

    def _user_headers(self) -> dict:
        if not self.user_session:
            raise RuntimeError("User session token required for this call")
        return {
            "X-Session-Token": self.user_session,
            "Accept": "application/json",
        }

    # ----- External API (bot key) -----
    def me(self) -> dict:
        r = self._session.get(
            f"{self.server}/api/external/me",
            headers=self._bot_headers(), timeout=15,
        )
        r.raise_for_status()
        return r.json()

    def get_channel_messages(self, channel: str, *, limit: int = 50, before: int | None = None) -> list[dict]:
        params = {"limit": limit}
        if before is not None:
            params["before"] = before
        r = self._session.get(
            f"{self.server}/api/external/channels/{channel}/messages",
            headers=self._bot_headers(), params=params, timeout=15,
        )
        r.raise_for_status()
        return r.json().get("messages", [])

    def send_message(self, channel: str, content: str, *, reply_to: int | None = None) -> dict:
        r = self._session.post(
            f"{self.server}/api/external/channels/{channel}/messages",
            headers=self._bot_headers(),
            json={"content": content, "reply_to": reply_to},
            timeout=20,
        )
        # Surface server errors clearly — most common is 403 if the bot
        # key was minted before the perms fix.
        if r.status_code >= 400:
            log.error("send_message %s failed: %s %s", channel, r.status_code, r.text[:200])
            r.raise_for_status()
        return r.json()

    # ----- Developer API (user session) — botfather-style profile -----
    def update_bot_profile(self, bot_id: int, *, name: str | None = None,
                           avatar: str | None = None, description: str | None = None,
                           is_public: bool | None = None) -> dict:
        body = {k: v for k, v in {
            "name": name, "avatar": avatar,
            "description": description, "is_public": is_public,
        }.items() if v is not None}
        r = self._session.put(
            f"{self.server}/api/developer/bots/{bot_id}",
            headers=self._user_headers(), json=body, timeout=15,
        )
        r.raise_for_status()
        return r.json()

    def list_my_bots(self) -> list[dict]:
        r = self._session.get(
            f"{self.server}/api/developer/bots",
            headers=self._user_headers(), timeout=15,
        )
        r.raise_for_status()
        return r.json().get("bots", [])


# ---------------------------------------------------------------------------
# RunPod client
# ---------------------------------------------------------------------------
class RunPodClient:
    """Calls a RunPod serverless endpoint. Tries `/runsync` first and
    falls back to async `/run` → `/status/<id>` polling for endpoints
    that exceed the sync timeout."""

    def __init__(self, endpoint_id: str, api_key: str, *, sync_timeout: int = 25,
                 async_poll_timeout: int = 90, async_poll_interval: float = 1.5):
        self.endpoint_id = endpoint_id
        self.api_key = api_key
        self.sync_timeout = sync_timeout
        self.async_poll_timeout = async_poll_timeout
        self.async_poll_interval = async_poll_interval
        self.base = f"https://api.runpod.ai/v2/{endpoint_id}"
        self._session = requests.Session()

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    def complete(self, prompt: str, *, system: str | None = None) -> str:
        """Return a single completion string. Worker-specific shape —
        adjust to taste."""
        payload = build_runpod_request(prompt, system=system)
        # 1) Try /runsync.
        try:
            r = self._session.post(
                f"{self.base}/runsync",
                headers=self._headers(),
                json=payload,
                timeout=self.sync_timeout + 5,
            )
            if r.status_code < 400:
                data = r.json()
                if data.get("status") in (None, "COMPLETED"):
                    text = extract_runpod_text(data)
                    if text:
                        return text
                # Some workers return IN_QUEUE/IN_PROGRESS even from
                # /runsync if they hit the sync limit — fall through to
                # the async path with the job id.
                job_id = data.get("id")
                if job_id:
                    return self._await_async(job_id)
        except requests.RequestException as e:
            log.warning("runsync failed (%s), falling back to async", e)

        # 2) Async /run → /status loop.
        r = self._session.post(
            f"{self.base}/run",
            headers=self._headers(),
            json=payload,
            timeout=15,
        )
        r.raise_for_status()
        job_id = r.json()["id"]
        return self._await_async(job_id)

    def _await_async(self, job_id: str) -> str:
        deadline = time.time() + self.async_poll_timeout
        while time.time() < deadline:
            r = self._session.get(
                f"{self.base}/status/{job_id}",
                headers=self._headers(), timeout=15,
            )
            r.raise_for_status()
            data = r.json()
            status = data.get("status")
            if status == "COMPLETED":
                return extract_runpod_text(data) or "(empty reply)"
            if status in ("FAILED", "CANCELLED"):
                raise RuntimeError(f"RunPod job {status}: {data.get('error') or data}")
            time.sleep(self.async_poll_interval)
        raise TimeoutError(f"RunPod job {job_id} did not complete in {self.async_poll_timeout}s")


def build_runpod_request(prompt: str, *, system: str | None = None) -> dict:
    """Shape for an OpenAI-compatible / vLLM RunPod worker. Override
    this function if your worker uses a different input schema."""
    inp: dict = {
        "prompt": prompt,
        "max_tokens": 400,
        "temperature": 0.7,
    }
    if system:
        inp["system"] = system
    return {"input": inp}


def extract_runpod_text(data: dict) -> str | None:
    """Pull the model's text out of a RunPod response envelope. Workers
    are inconsistent — try a few shapes."""
    out = data.get("output")
    if out is None:
        return None
    if isinstance(out, str):
        return out.strip() or None
    if isinstance(out, dict):
        for key in ("text", "response", "completion", "generated_text", "output"):
            v = out.get(key)
            if isinstance(v, str) and v.strip():
                return v.strip()
        choices = out.get("choices")
        if isinstance(choices, list) and choices:
            c = choices[0]
            if isinstance(c, dict):
                msg = c.get("message")
                if isinstance(msg, dict) and isinstance(msg.get("content"), str):
                    return msg["content"].strip() or None
                if isinstance(c.get("text"), str):
                    return c["text"].strip() or None
    if isinstance(out, list) and out:
        first = out[0]
        if isinstance(first, str):
            return first.strip() or None
        if isinstance(first, dict):
            for key in ("text", "generated_text", "output"):
                v = first.get(key)
                if isinstance(v, str) and v.strip():
                    return v.strip()
    return None


# ---------------------------------------------------------------------------
# Bot loop
# ---------------------------------------------------------------------------
MENTION_RE_TEMPLATE = r"(?:^|[\s(])@{handle}(?=$|[\s.,!?;:)\u2026])"


class ChatBot:
    def __init__(self, frogtalk: FrogTalkClient, runpod: RunPodClient,
                 *, bot_name: str, channels: Iterable[str],
                 poll_interval: float = 2.0, max_context: int = 8):
        self.ft = frogtalk
        self.rp = runpod
        self.bot_name = bot_name
        self.bot_name_lower = bot_name.lower()
        self.channels = list(channels)
        self.poll_interval = poll_interval
        self.max_context = max_context
        # message ids the bot itself posted, so we know what counts as
        # "a reply to us" and to avoid self-reply loops.
        self.own_msg_ids: set[int] = set()
        # per-channel last_seen id so we don't replay history on
        # restart or on each poll
        self.last_seen: dict[str, int] = {ch: 0 for ch in self.channels}
        self.mention_re = re.compile(
            MENTION_RE_TEMPLATE.format(handle=re.escape(bot_name)),
            re.IGNORECASE,
        )
        self.last_send_at = 0.0
        self.min_send_gap = 1.0  # client-side cooldown

    # ----- main loop -----
    def run(self) -> None:
        # Seed last_seen so we don't immediately reply to old messages
        # on startup.
        for ch in self.channels:
            try:
                hist = self.ft.get_channel_messages(ch, limit=1)
                if hist:
                    self.last_seen[ch] = hist[-1]["id"]
                log.info("listening on #%s (last_seen=%s)", ch, self.last_seen[ch])
            except Exception as e:
                log.error("failed to seed #%s: %s", ch, e)

        log.info("ready — bot=%s channels=%s", self.bot_name, self.channels)
        while True:
            for ch in self.channels:
                try:
                    self._poll_channel(ch)
                except Exception:
                    log.exception("error polling #%s", ch)
            time.sleep(self.poll_interval)

    def _poll_channel(self, channel: str) -> None:
        msgs = self.ft.get_channel_messages(channel, limit=50)
        if not msgs:
            return
        # Server returns ascending; filter to genuinely new ones.
        new = [m for m in msgs if m["id"] > self.last_seen[channel]]
        if not new:
            return
        self.last_seen[channel] = max(m["id"] for m in new)
        # full local history slice for context
        history = msgs

        for m in new:
            if not self._should_reply(m):
                continue
            try:
                self._respond_to(channel, m, history)
            except Exception:
                log.exception("failed to respond to msg #%s in #%s", m.get("id"), channel)

    def _should_reply(self, m: dict) -> bool:
        # Never reply to ourselves.
        if m.get("is_bot") and m.get("nickname", "").lower() == self.bot_name_lower:
            return False
        if m.get("id") in self.own_msg_ids:
            return False
        content = m.get("content") or ""
        if self.mention_re.search(content):
            return True
        # Reply to replies of our messages.
        if m.get("reply_to") and m["reply_to"] in self.own_msg_ids:
            return True
        return False

    def _respond_to(self, channel: str, trigger: dict, history: list[dict]) -> None:
        # Client-side rate limit.
        now = time.time()
        if now - self.last_send_at < self.min_send_gap:
            time.sleep(self.min_send_gap - (now - self.last_send_at))

        prompt = self._build_prompt(trigger, history)
        log.info("#%s ← @%s (msg %s): generating reply",
                 channel, trigger.get("nickname"), trigger.get("id"))
        try:
            reply = self.rp.complete(prompt, system=self._system_prompt())
        except Exception as e:
            log.exception("RunPod call failed")
            reply = f"(sorry, my AI backend hiccuped: {e.__class__.__name__})"
        reply = self._sanitize(reply)
        if not reply:
            return
        result = self.ft.send_message(channel, reply, reply_to=trigger.get("id"))
        mid = result.get("message_id")
        if mid:
            self.own_msg_ids.add(mid)
            # Cap memory growth so a long-running bot doesn't leak.
            if len(self.own_msg_ids) > 5000:
                # Drop the oldest half — set ordering is insertion in
                # CPython 3.7+ for dicts but not sets; convert.
                keep = deque(self.own_msg_ids, maxlen=2500)
                self.own_msg_ids = set(keep)
        self.last_send_at = time.time()

    def _system_prompt(self) -> str:
        return (
            f"You are {self.bot_name}, a helpful chat bot in a FrogTalk channel. "
            "Keep replies concise (under ~200 words) and friendly. "
            "Don't pretend to be a human — you are a bot."
        )

    def _build_prompt(self, trigger: dict, history: list[dict]) -> str:
        ctx = history[-self.max_context:]
        lines = []
        for m in ctx:
            nick = m.get("nickname") or "user"
            tag = " [bot]" if m.get("is_bot") else ""
            content = (m.get("content") or "").strip()
            if not content:
                continue
            lines.append(f"{nick}{tag}: {content}")
        lines.append(f"{self.bot_name} [bot]:")
        return "\n".join(lines)

    def _sanitize(self, text: str) -> str:
        text = (text or "").strip()
        if not text:
            return ""
        # Strip a leading "bot-name:" if the model parroted the prompt.
        prefix = f"{self.bot_name}:"
        if text.lower().startswith(prefix.lower()):
            text = text[len(prefix):].lstrip()
        # FrogTalk caps at 4000 chars; leave headroom.
        if len(text) > 3500:
            text = text[:3497].rstrip() + "…"
        return text


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _env(name: str, default: str | None = None) -> str | None:
    v = os.getenv(name)
    if v is None or v.strip() == "":
        return default
    return v


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="RunPod-powered FrogTalk chat bot")
    p.add_argument("--server-url", default=_env("FROGTALK_SERVER", "https://frogtalk.xyz"))
    p.add_argument("--bot-token", default=_env("FROGTALK_BOT_TOKEN"))
    p.add_argument("--bot-name", default=_env("FROGTALK_BOT_NAME"))
    p.add_argument("--channels", default=_env("FROGTALK_CHANNELS", "general"),
                   help="Comma-separated channel names")
    p.add_argument("--runpod-endpoint", default=_env("RUNPOD_ENDPOINT_ID", "n9y6u6rkv73ayv"))
    p.add_argument("--runpod-key", default=_env("RUNPOD_API_KEY"))
    p.add_argument("--poll-interval", type=float, default=float(_env("POLL_INTERVAL", "2.0")))
    p.add_argument("--max-context", type=int, default=int(_env("MAX_CONTEXT", "8")))
    p.add_argument("--log-level", default=_env("LOG_LEVEL", "INFO"))

    # Profile-sync mode (botfather-style).
    p.add_argument("--update-profile", action="store_true",
                   help="Update the bot's profile and exit (uses FROGTALK_USER_SESSION)")
    p.add_argument("--bot-avatar", default=None)
    p.add_argument("--bot-description", default=None)
    p.add_argument("--is-public", dest="is_public", action="store_true", default=None)
    p.add_argument("--not-public", dest="is_public", action="store_false")

    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s | %(message)s",
    )

    if not args.bot_token:
        log.error("FROGTALK_BOT_TOKEN / --bot-token is required")
        return 2
    if not args.bot_name:
        log.error("FROGTALK_BOT_NAME / --bot-name is required (must match the bot's handle)")
        return 2

    ft = FrogTalkClient(args.server_url, args.bot_token,
                        user_session=_env("FROGTALK_USER_SESSION"))

    # Sanity check the bot token before doing anything else.
    try:
        me = ft.me()
        log.info("authenticated as %s (bot=%s)", me.get("user", {}).get("nickname"), me.get("is_bot"))
    except requests.HTTPError as e:
        log.error("bot token rejected: %s — %s", e, getattr(e.response, "text", "")[:200])
        return 3

    if args.update_profile:
        # Find the bot id by name.
        try:
            bots = ft.list_my_bots()
        except requests.HTTPError as e:
            log.error("Could not list bots (FROGTALK_USER_SESSION needed): %s", e)
            return 4
        match = next((b for b in bots if b["name"].lower() == args.bot_name.lower()), None)
        if not match:
            log.error("No bot named %r found on this account", args.bot_name)
            return 5
        result = ft.update_bot_profile(
            match["id"],
            avatar=args.bot_avatar,
            description=args.bot_description,
            is_public=args.is_public,
        )
        log.info("profile updated: %s", result)
        return 0

    if not args.runpod_key:
        log.error("RUNPOD_API_KEY / --runpod-key is required")
        return 2

    rp = RunPodClient(args.runpod_endpoint, args.runpod_key)

    channels = [c.strip() for c in args.channels.split(",") if c.strip()]
    bot = ChatBot(
        ft, rp,
        bot_name=args.bot_name,
        channels=channels,
        poll_interval=args.poll_interval,
        max_context=args.max_context,
    )
    try:
        bot.run()
    except KeyboardInterrupt:
        log.info("shutting down")
    return 0


if __name__ == "__main__":
    sys.exit(main())
