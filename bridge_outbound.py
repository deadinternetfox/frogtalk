"""
Outbound bridge forwarding helper.

Called from routers/ws.py + routers/messages.py whenever a USER sends a message
in a FrogTalk channel. Forwards to any Telegram / Discord bridges that allow
FrogTalk→remote mirroring (direction in {both, out}).

Bridge-originated messages never hit this path — they go through
routers/bridge.receive_bridge_message() which broadcasts directly — so there
is no loop-protection needed here.
"""
import asyncio
import logging

log = logging.getLogger("bridge.outbound")


def forward_user_message(room: str, nickname: str, content: str,
                         media_data: str | None = None,
                         sender_avatar: str | None = None,
                         *, ft_msg_id: int | None = None,
                         reply_to_ft_id: int | None = None,
                         media_blur: bool = False) -> None:
    """Fire-and-forget outbound forward to all bridged platforms.

    `ft_msg_id` / `reply_to_ft_id` are FrogTalk message-row ids. When the
    sending user was replying to a previous message we use
    `reply_to_ft_id` + `bridge_msg_map` to attach a native reply on the
    remote platform (Telegram's `reply_to_message_id`, Discord's reply
    reference, etc.).

    `media_blur` propagates the spoiler flag: Telegram renders the photo
    behind a tap-to-reveal overlay, Discord prefixes the attachment
    filename with `SPOILER_` which triggers the same UX in its client.
    """
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return  # no loop — should not happen in FastAPI handler, but be safe

    try:
        import bridge_telegram as btg
        loop.create_task(btg.forward_to_telegram(
            room, nickname, content, media_data,
            ft_msg_id=ft_msg_id, reply_to_ft_id=reply_to_ft_id,
            media_blur=media_blur,
        ))
    except Exception as e:
        log.debug("telegram forward skipped: %s", e)

    try:
        import bridge_discord as bdc
        loop.create_task(bdc.forward_to_discord(
            room, nickname, content, media_data,
            sender_avatar=sender_avatar,
            ft_msg_id=ft_msg_id, reply_to_ft_id=reply_to_ft_id,
            media_blur=media_blur,
        ))
    except Exception as e:
        log.debug("discord forward skipped: %s", e)


def forward_user_reaction(room: str, ft_msg_id: int, emoji: str,
                          counts: dict) -> None:
    """Fire-and-forget bridge mirroring for room-message reactions."""
    if not room or not ft_msg_id or not emoji:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return

    try:
        import bridge_telegram as btg
        loop.create_task(btg.forward_reaction_to_telegram(room, ft_msg_id, emoji, counts))
    except Exception as e:
        log.debug("telegram reaction forward skipped: %s", e)

    try:
        import bridge_discord as bdc
        loop.create_task(bdc.forward_reaction_to_discord(room, ft_msg_id, emoji, counts))
    except Exception as e:
        log.debug("discord reaction forward skipped: %s", e)
