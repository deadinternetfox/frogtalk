"""
FrogTalk <-> Telegram Bridge Bot

This bot bridges messages between Telegram groups/channels and FrogTalk channels.
It uses the FrogTalk API with a bot token for authentication.

Environment variables:
- TELEGRAM_BOT_TOKEN: Your Telegram bot token from @BotFather
- FROGTALK_BOT_TOKEN: Your FrogTalk bot API key (e.g., bot_xxxx)
- FROGTALK_API_URL: FrogTalk server URL (default: https://frogtalk.xyz)

Setup:
1. Create a bot in FrogTalk developer settings
2. Get a Telegram bot token from @BotFather
3. Add both bots to the channels you want to bridge
4. Configure the bridge mappings
"""
import os
import asyncio
import json
import httpx
import logging
from datetime import datetime
from typing import Dict, Optional, List
from dataclasses import dataclass

# Telegram bot library
try:
    from telegram import Update, Bot
    from telegram.ext import Application, MessageHandler, CommandHandler, ContextTypes, filters
except ImportError:
    print("Please install python-telegram-bot: pip install python-telegram-bot")
    exit(1)

logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)

# Configuration
TELEGRAM_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
FROGTALK_TOKEN = os.getenv("FROGTALK_BOT_TOKEN", "")
FROGTALK_URL = os.getenv("FROGTALK_API_URL", "https://frogtalk.xyz")

# Bridge mappings: Telegram chat_id <-> FrogTalk room_name
BRIDGE_CONFIG_FILE = "telegram_bridge_config.json"


@dataclass
class BridgeMapping:
    telegram_chat_id: int
    telegram_chat_title: str
    frogtalk_room: str
    enabled: bool = True


class TelegramFrogTalkBridge:
    def __init__(self):
        self.mappings: Dict[int, BridgeMapping] = {}  # telegram_chat_id -> mapping
        self.frogtalk_rooms: Dict[str, BridgeMapping] = {}  # room_name -> mapping
        self.ws_connection = None
        self.http_client = httpx.AsyncClient(timeout=30.0)
        self.load_config()
    
    def load_config(self):
        """Load bridge configuration from file."""
        try:
            if os.path.exists(BRIDGE_CONFIG_FILE):
                with open(BRIDGE_CONFIG_FILE, 'r') as f:
                    data = json.load(f)
                    for mapping_data in data.get("mappings", []):
                        mapping = BridgeMapping(**mapping_data)
                        self.mappings[mapping.telegram_chat_id] = mapping
                        self.frogtalk_rooms[mapping.frogtalk_room] = mapping
                logger.info(f"Loaded {len(self.mappings)} bridge mappings")
        except Exception as e:
            logger.error(f"Failed to load config: {e}")
    
    def save_config(self):
        """Save bridge configuration to file."""
        try:
            data = {
                "mappings": [
                    {
                        "telegram_chat_id": m.telegram_chat_id,
                        "telegram_chat_title": m.telegram_chat_title,
                        "frogtalk_room": m.frogtalk_room,
                        "enabled": m.enabled
                    }
                    for m in self.mappings.values()
                ]
            }
            with open(BRIDGE_CONFIG_FILE, 'w') as f:
                json.dump(data, f, indent=2)
        except Exception as e:
            logger.error(f"Failed to save config: {e}")
    
    async def frogtalk_api(self, method: str, endpoint: str, data: dict = None) -> Optional[dict]:
        """Make FrogTalk API request."""
        url = f"{FROGTALK_URL}/api{endpoint}"
        headers = {"Authorization": f"Bearer {FROGTALK_TOKEN}"}
        
        try:
            if method == "GET":
                response = await self.http_client.get(url, headers=headers)
            elif method == "POST":
                response = await self.http_client.post(url, headers=headers, json=data)
            else:
                return None
            
            if response.status_code == 200:
                return response.json()
            else:
                logger.error(f"FrogTalk API error: {response.status_code} - {response.text}")
                return None
        except Exception as e:
            logger.error(f"FrogTalk API request failed: {e}")
            return None
    
    async def send_to_frogtalk(self, room_name: str, content: str, 
                               sender_name: str, media_url: str = None):
        """Send a message to FrogTalk channel via WebSocket or API."""
        # Format message with Telegram sender info
        formatted = f"[TG] {sender_name}: {content}"
        
        # Use API endpoint for bot messages
        result = await self.frogtalk_api("POST", f"/rooms/{room_name}/messages", {
            "content": formatted,
            "media_url": media_url
        })
        
        if result:
            logger.info(f"Sent to FrogTalk #{room_name}: {content[:50]}...")
        return result
    
    async def send_to_telegram(self, chat_id: int, content: str, 
                               sender_name: str, bot: Bot):
        """Send a message to Telegram chat."""
        try:
            formatted = f"🐸 <b>{sender_name}</b>: {content}"
            await bot.send_message(
                chat_id=chat_id,
                text=formatted,
                parse_mode='HTML'
            )
            logger.info(f"Sent to Telegram {chat_id}: {content[:50]}...")
        except Exception as e:
            logger.error(f"Failed to send to Telegram: {e}")
    
    # -----------------------------------------------------------------------
    # Telegram Handlers
    # -----------------------------------------------------------------------
    
    async def handle_telegram_message(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle incoming Telegram messages and forward to FrogTalk."""
        message = update.message
        if not message:
            return
        
        chat_id = message.chat_id
        
        # Check if this chat is bridged
        if chat_id not in self.mappings:
            return
        
        mapping = self.mappings[chat_id]
        if not mapping.enabled:
            return
        
        # Get sender info
        user = message.from_user
        sender_name = user.first_name
        if user.last_name:
            sender_name += f" {user.last_name}"
        if user.username:
            sender_name += f" (@{user.username})"
        
        # Handle different message types
        content = ""
        media_url = None
        
        if message.text:
            content = message.text
        elif message.caption:
            content = message.caption
        
        if message.photo:
            # Get largest photo
            photo = message.photo[-1]
            file = await context.bot.get_file(photo.file_id)
            media_url = file.file_path
            if not content:
                content = "[Photo]"
        elif message.video:
            file = await context.bot.get_file(message.video.file_id)
            media_url = file.file_path
            if not content:
                content = "[Video]"
        elif message.document:
            if not content:
                content = f"[File: {message.document.file_name}]"
        elif message.sticker:
            content = f"[Sticker: {message.sticker.emoji or '🐸'}]"
        elif message.voice:
            content = "[Voice message]"
        elif message.video_note:
            content = "[Video note]"
        
        if content:
            await self.send_to_frogtalk(
                mapping.frogtalk_room,
                content,
                sender_name,
                media_url
            )
    
    async def cmd_bridge(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Command to set up bridge: /bridge <frogtalk_room>"""
        message = update.message
        if not message:
            return
        
        # Check if user is admin
        chat_member = await context.bot.get_chat_member(message.chat_id, message.from_user.id)
        if chat_member.status not in ['creator', 'administrator']:
            await message.reply_text("❌ Only admins can configure the bridge.")
            return
        
        # Parse room name
        if not context.args or len(context.args) < 1:
            await message.reply_text(
                "Usage: /bridge <frogtalk_room_name>\n"
                "Example: /bridge general"
            )
            return
        
        room_name = context.args[0].lower().strip('#')
        
        # Create mapping
        mapping = BridgeMapping(
            telegram_chat_id=message.chat_id,
            telegram_chat_title=message.chat.title or "Private Chat",
            frogtalk_room=room_name,
            enabled=True
        )
        
        self.mappings[message.chat_id] = mapping
        self.frogtalk_rooms[room_name] = mapping
        self.save_config()
        
        await message.reply_text(
            f"✅ Bridge configured!\n\n"
            f"📱 Telegram: {message.chat.title}\n"
            f"🐸 FrogTalk: #{room_name}\n\n"
            f"Messages will now be synced between both platforms."
        )
    
    async def cmd_unbridge(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Command to remove bridge: /unbridge"""
        message = update.message
        if not message:
            return
        
        chat_member = await context.bot.get_chat_member(message.chat_id, message.from_user.id)
        if chat_member.status not in ['creator', 'administrator']:
            await message.reply_text("❌ Only admins can configure the bridge.")
            return
        
        if message.chat_id not in self.mappings:
            await message.reply_text("❌ This chat is not bridged.")
            return
        
        mapping = self.mappings.pop(message.chat_id)
        self.frogtalk_rooms.pop(mapping.frogtalk_room, None)
        self.save_config()
        
        await message.reply_text("✅ Bridge removed. Messages will no longer be synced.")
    
    async def cmd_status(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Command to check bridge status: /bridgestatus"""
        message = update.message
        if not message:
            return
        
        if message.chat_id not in self.mappings:
            await message.reply_text(
                "❌ This chat is not bridged.\n"
                "Use /bridge <room_name> to set up a bridge."
            )
            return
        
        mapping = self.mappings[message.chat_id]
        status = "✅ Enabled" if mapping.enabled else "⏸️ Paused"
        
        await message.reply_text(
            f"🌉 Bridge Status: {status}\n\n"
            f"📱 Telegram: {mapping.telegram_chat_title}\n"
            f"🐸 FrogTalk: #{mapping.frogtalk_room}"
        )
    
    async def cmd_pause(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Pause the bridge temporarily."""
        message = update.message
        if message.chat_id not in self.mappings:
            await message.reply_text("❌ This chat is not bridged.")
            return
        
        self.mappings[message.chat_id].enabled = False
        self.save_config()
        await message.reply_text("⏸️ Bridge paused. Use /resume to continue.")
    
    async def cmd_resume(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Resume a paused bridge."""
        message = update.message
        if message.chat_id not in self.mappings:
            await message.reply_text("❌ This chat is not bridged.")
            return
        
        self.mappings[message.chat_id].enabled = True
        self.save_config()
        await message.reply_text("▶️ Bridge resumed!")
    
    async def cmd_help(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Help command."""
        help_text = """
🐸 <b>FrogTalk Bridge Bot</b>

This bot bridges messages between Telegram and FrogTalk channels.

<b>Commands:</b>
/bridge &lt;room&gt; - Set up bridge to a FrogTalk room
/unbridge - Remove bridge from this chat
/bridgestatus - Check bridge status
/pause - Temporarily pause the bridge
/resume - Resume a paused bridge
/help - Show this help message

<b>How it works:</b>
1. Add this bot to your Telegram group
2. Use /bridge with your FrogTalk room name
3. Add the FrogTalk bot to the same room
4. Messages will sync automatically!

Made with 🐸 by FrogTalk
        """
        await update.message.reply_text(help_text, parse_mode='HTML')


async def main():
    """Start the Telegram bridge bot."""
    if not TELEGRAM_TOKEN:
        print("ERROR: TELEGRAM_BOT_TOKEN not set!")
        print("Get a token from @BotFather on Telegram")
        return
    
    if not FROGTALK_TOKEN:
        print("WARNING: FROGTALK_BOT_TOKEN not set!")
        print("Messages won't be sent to FrogTalk")
    
    bridge = TelegramFrogTalkBridge()
    
    # Create Telegram application
    app = Application.builder().token(TELEGRAM_TOKEN).build()
    
    # Add handlers
    app.add_handler(CommandHandler("bridge", bridge.cmd_bridge))
    app.add_handler(CommandHandler("unbridge", bridge.cmd_unbridge))
    app.add_handler(CommandHandler("bridgestatus", bridge.cmd_status))
    app.add_handler(CommandHandler("pause", bridge.cmd_pause))
    app.add_handler(CommandHandler("resume", bridge.cmd_resume))
    app.add_handler(CommandHandler("help", bridge.cmd_help))
    app.add_handler(CommandHandler("start", bridge.cmd_help))
    
    # Message handler (all non-command messages)
    app.add_handler(MessageHandler(
        filters.ALL & ~filters.COMMAND,
        bridge.handle_telegram_message
    ))
    
    logger.info("🐸 FrogTalk-Telegram Bridge starting...")
    logger.info(f"Loaded {len(bridge.mappings)} bridge mappings")
    
    # Start polling
    await app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    asyncio.run(main())
