# FrogTalk Bot Examples

This folder contains **independent, self-contained example bots** built
against the public [FrogTalk External API]. They are intended as
reference implementations for third-party developers — none of them are
part of the FrogTalk server itself, and they only talk to the server
over its documented HTTP API.

Each example ships with its own `README.md`, `requirements.txt`, and a
`.env.example` showing which credentials are needed.

## Examples

| Folder | What it does |
| --- | --- |
| [`runpod-ai-bot/`](./runpod-ai-bot/) | A channel chat bot that replies whenever it is `@`-mentioned, or when a user replies to one of its own messages. Uses a [RunPod] serverless endpoint as the LLM backend. |

## Writing your own bot

A FrogTalk bot is, at the protocol level, **any program that holds a
`bot_…` API key and calls the External API endpoints under
`/api/external/*`.** You do not need to ship code into the FrogTalk
codebase to publish a bot — it can run anywhere (your laptop, a VPS,
RunPod, a Cloud Function, a Raspberry Pi, …).

### 1. Create the bot in the FrogTalk app

1. Open **Settings → Developer → Bots**.
2. Click **+ Create Bot**, give it a unique handle (this is the name
   users will `@`-mention).
3. Copy the `bot_…` token that appears — it is shown **once**.
4. Click **Edit** on the bot row to set its avatar, description, and
   whether it appears in the public bot directory (botfather-style).
5. **Add the bot to a channel** — Settings → Developer → Bots →
   **Add to channel**. Bots cannot post until installed; uninstalled
   bots get `403 Bot is not a member of this channel`.

### 2. Authenticate every call

Send the token on **every** request, in either header form:

```http
X-API-Key: bot_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
# or
Authorization: Bearer bot_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 3. Poll for new messages

Bots **cannot** open a WebSocket — they poll. The recommended pattern
is to remember the highest message id you have seen, and on each tick
fetch the channel's recent history and act on anything newer:

```python
last_seen = 0
while True:
    r = requests.get(
        f"https://frogtalk.xyz/api/external/channels/{channel}/messages",
        headers={"X-API-Key": BOT_TOKEN},
        params={"limit": 50},
        timeout=15,
    )
    messages = r.json()["messages"]
    for m in messages:
        if m["id"] <= last_seen:
            continue
        last_seen = max(last_seen, m["id"])
        handle(m)
    time.sleep(2)
```

### 4. Reply

```python
requests.post(
    f"https://frogtalk.xyz/api/external/channels/{channel}/messages",
    headers={"X-API-Key": BOT_TOKEN},
    json={"content": "hello, world", "reply_to": m["id"]},
    timeout=15,
)
```

The server stamps the message with `is_bot: true` so the client renders
the `BOT` pill next to the bot's name in chat.

### 5. Profile 

`PUT /api/developer/bots/{bot_id}` accepts:

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string | unique handle (≤32 chars) |
| `avatar` | string | URL or `data:` URL |
| `description` | string | shown in bot directory (≤500) |
| `is_public` | bool | list publicly |

This endpoint uses your **user session**, not the bot key — typically
you'll use the in-app Edit modal. If you want to ship a botfather-style
CLI, hit the same endpoint with `apiFetch`-equivalent cookies.

## Bot etiquette

- **Rate limits** — `/messages` POST is capped at 30/minute per key.
  Stay well under that.
- **Don't spam mentions** — only respond when explicitly addressed.
- **Be transparent** — set a useful description so users know what
  data your bot processes.
- **Don't impersonate** — bot display names always render with the
  `BOT` pill; do not try to defeat that.

## License

The examples are MIT-licensed; do whatever you want with them.

[FrogTalk External API]: https://frogtalk.xyz/docs/api
[RunPod]: https://runpod.io
