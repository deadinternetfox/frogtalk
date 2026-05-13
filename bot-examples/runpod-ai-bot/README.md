# RunPod AI Bot for FrogTalk

A reference channel-chat bot for [FrogTalk](https://frogtalk.xyz) that
replies whenever it is `@`-mentioned, or when someone replies to one of
its own messages. The brain is a [RunPod] serverless endpoint — swap in
any chat model you like.

> This bot is an **example for third-party developers**. It is *not*
> shipped with the FrogTalk server. It only talks to the documented
> public API at `/api/external/*`.

## Features

- Polling-based — no WebSocket needed (bots can't open WS anyway).
- Replies to **@mentions** of its handle in any channel it's running in.
- Replies to **replies** of its own messages (so users can have a
  back-and-forth without re-tagging it every turn).
- Sends each turn as a proper `reply_to` so the UI shows the quoted
  parent.
- Calls RunPod via the async `/run` → `/status/<job_id>` polling loop
  (skipping `/runsync` so cold starts don't get double-billed when the
  sync request times out and falls back).
- **Single-turn reply hardening:** sends per-speaker stop sequences
  (e.g. `\nTesty:`, ` Testy:`, plus the standard `\nUser:` /
  `\nAssistant:`) to the worker, AND hard-truncates the model output at
  any other user's `Nick:` label — so a raw-text completion that
  hallucinates a multi-turn transcript still surfaces as a clean single
  reply.
- Filters its own previous `(empty reply)` / `(sorry, my AI backend
  hiccuped…)` placeholders out of the prompt so the model doesn't
  pattern-match on them and keep producing fresh failure stubs.
- Ships with an **uncensored** default system prompt (wild, no
  moralizing, no refusals, no "as an AI" disclaimers). Hard limits are
  kept narrow: no real-world violence against specific people, no CSAM,
  no doxxing, no targeted malware. Override `_system_prompt()` in
  `bot.py` if you want a tamer persona.
- **Model-agnostic chat-completions:** the bot sends the conversation
  to the worker as an OpenAI-style `messages=[{"role":"system",…},
  {"role":"user",…},…]` list, so the vLLM worker applies whatever
  chat template the loaded model needs. That means swapping in a
  different model (Qwen, Mistral-Small, Llama-2/3, MythoMax, etc.) does
  not require any code changes — the worker handles the templating.
  Default endpoint id `4l8b7h5dbvoqu2` points at a vLLM worker running
  `Gryphe/MythoMax-L2-13b` (a Llama-2 roleplay finetune chosen for
  its lack of RLHF refusal behaviour). For raw-completion workers
  there is still a fallback that wraps the prompt in Qwen-style
  ChatML, with `<|im_end|>` / `<|im_start|>` added to the stop list.
- **Refusal sanitizer + retry:** if the model still emits a canned
  safety refusal (`"I'm here to provide…"`, `"as an AI"`, `"let's keep
  it positive"`, etc.) the bot transparently retries once at higher
  temperature with a stronger jailbreak preface, and falls back to a
  stock irreverent line only if that also refuses. Stray
  `<!DOCTYPE>` / `</html>` / `\ufffd` artefacts the model sometimes
  hallucinates are stripped before posting.
- Renders with the `BOT` pill in chat (the server stamps `is_bot:true`).

## Quick start

```bash
cd bot-examples/runpod-ai-bot
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
$EDITOR .env          # fill in tokens
python bot.py
```

You'll need:

1. A **FrogTalk bot token** — open the FrogTalk app → Settings →
   Developer → Bots → **+ Create Bot**. Copy the `bot_…` value (shown
   once). Use the **Edit** button to set the bot's avatar and a short
   description (botfather-style).
2. A **RunPod endpoint id** and **API key** — both visible in your
   RunPod console. The example targets a chat-completion-style worker
   that accepts `{"input": {"prompt": "...", "stop": [...]}}` and
   returns one of the common output shapes:
   - `{"output": "text..."}`
   - `{"output": {"text": "..."}}` / `{"output": {"choices":[{"message":{"content":"..."}}]}}`
   - `{"output": [{"choices":[{"tokens":["text..."]}]}]}` (vLLM)
   `extract_runpod_text` in `bot.py` handles all of the above; override
   `build_runpod_request` / `extract_runpod_text` if your worker uses
   a different schema.

## Configuration

All settings can come from environment variables, a `.env` file, or
CLI flags. CLI > env > defaults.

| Variable | Flag | Default | Meaning |
| --- | --- | --- | --- |
| `FROGTALK_SERVER` | `--server-url` | `https://frogtalk.xyz` | Base URL of the FrogTalk server |
| `FROGTALK_BOT_TOKEN` | `--bot-token` | *(required)* | `bot_…` token issued in the app |
| `FROGTALK_BOT_NAME` | `--bot-name` | *(required)* | Handle the bot was registered as (used to detect `@mentions`) |
| `FROGTALK_CHANNELS` | `--channels` | *(empty)* | Comma-separated channels to listen in. Leave empty to auto-discover from the server. |
| `FROGTALK_AUTO_CHANNELS` | `--auto-channels` | `1` when `FROGTALK_CHANNELS` is empty | Pull the bot's installed-channel list from `GET /api/external/me/channels` and refresh every ~30s, so a server owner adding the bot to a new channel takes effect with no restart. |
| `RUNPOD_ENDPOINT_ID` | `--runpod-endpoint` | `4l8b7h5dbvoqu2` | RunPod serverless endpoint id (default points at a vLLM worker running `Gryphe/MythoMax-L2-13b`; swap freely) |
| `RUNPOD_API_KEY` | `--runpod-key` | *(required)* | `rpa_…` API key |
| `POLL_INTERVAL` | `--poll-interval` | `2.0` | Seconds between polls per channel |
| `MAX_CONTEXT` | `--max-context` | `8` | Recent messages to send as context |

### Profile sync (botfather-style)

You can update the bot's profile (avatar, description, public toggle)
from this CLI too — it uses a **user** session cookie though, not the
bot key, so it expects you to set `FROGTALK_USER_SESSION` to a valid
session token (visible in the app's localStorage after login). Profile
sync is optional; the simpler workflow is to just use the in-app
Settings → Developer → Bots → Edit dialog.

```bash
python bot.py \
  --update-profile \
  --bot-avatar https://example.com/bot.png \
  --bot-description "I'm a friendly assistant powered by RunPod." \
  --is-public
```

## How it works

```
┌──────────────────────────────────────────────────────────────────┐
│  bot.py main loop (per channel, every POLL_INTERVAL seconds)     │
│                                                                  │
│    GET /api/external/channels/<ch>/messages?limit=50             │
│      → for each message with id > last_seen:                     │
│          if @mention(me) OR reply_to in my_messages:             │
│              ctx = build_context(history)                        │
│              text = call_runpod(ctx)                             │
│              POST /api/external/channels/<ch>/messages           │
│                   {content: text, reply_to: m["id"]}             │
└──────────────────────────────────────────────────────────────────┘
```

Mention detection uses the same regex shape the FrogTalk client uses
client-side: `(^|\s|\()@<bot-name>(?=$|[\s.,!?;:)\u2026])`. Reply
detection compares `reply_to` against an in-memory set of message ids
the bot itself posted in this session.

## Safety

- Rate limited to ~30 msgs/min on the server side. The bot enforces
  its own ~1 reply per second cap to leave headroom.
- Refuses to reply to its own messages (no infinite-loop pingpong).
- Refuses to reply to anything older than `last_seen` at startup
  (avoids replaying history on restart).

## License

MIT.

[RunPod]: https://runpod.io
