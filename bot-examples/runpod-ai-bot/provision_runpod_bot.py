"""One-shot provisioning script for the example RunPod AI bot.

Usage (run on the FrogTalk server, in its venv):

    python provision_runpod_bot.py --owner-nick <admin-handle> [--bot-name runpod-ai]

Outputs the bot's `bot_…` API token on stdout — paste it into
/etc/frogtalk-runpod-bot.env. The token is shown ONCE; if you lose it
you must delete the bot and re-run this script.

This is the same flow the in-app "+ Create Bot" button performs, just
without the UI. We intentionally keep it as a separate executable so it
can be re-run safely (it bails out if the bot name is already taken).
"""
from __future__ import annotations

import argparse
import hashlib
import secrets
import sys

import database as db


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--owner-nick", required=True,
                   help="Nickname of the user who will own the bot")
    p.add_argument("--bot-name", default="runpod-ai",
                   help="Bot handle (must be unique, ≤32 chars)")
    p.add_argument("--description",
                   default="AI chat bot powered by a RunPod serverless LLM. "
                           "Mention me with @runpod-ai or reply to my messages.")
    p.add_argument("--is-public", action="store_true", default=True)
    args = p.parse_args()

    owner_id = db.get_user_id_by_nickname(args.owner_nick)
    if not owner_id:
        print(f"ERROR: no user with nickname {args.owner_nick!r}", file=sys.stderr)
        return 2
    owner = db.get_user_by_id(owner_id)

    # Bail if a bot with this name already exists on this account.
    existing = [b for b in db.get_user_bots(owner["id"]) if b["name"] == args.bot_name]
    if existing:
        print(f"ERROR: bot named {args.bot_name!r} already exists for {args.owner_nick}",
              file=sys.stderr)
        print("Delete it first via Settings → Developer → Bots, then re-run.",
              file=sys.stderr)
        return 3

    # Mint an API key with the same perm set the UI uses.
    token = "bot_" + secrets.token_urlsafe(32)
    key_hash = hashlib.sha256(token.encode()).hexdigest()
    key_id = db.create_api_key(
        owner["id"],
        f"Bot: {args.bot_name}",
        key_hash,
        ["read", "write", "dm", "bot"],
    )
    if not key_id:
        print("ERROR: failed to mint api key", file=sys.stderr)
        return 4

    bot_id = db.create_bot(
        owner_id=owner["id"],
        name=args.bot_name,
        api_key_id=key_id,
        avatar=None,
        description=args.description,
        is_public=1 if args.is_public else 0,
    )
    if not bot_id:
        print("ERROR: failed to create bot row", file=sys.stderr)
        return 5

    print(f"OK bot_id={bot_id} owner_id={owner['id']} name={args.bot_name}")
    print(f"TOKEN={token}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
