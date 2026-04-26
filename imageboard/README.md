# Imageboard Standalone

This is a standalone copy of the imageboard stack extracted from the main project.

## Runtime Requirement

- PHP 8.0+ (the board code uses modern PHP functions and syntax)

## Included

- `board.php` (main board)
- `board_admin.php` (admin panel)
- `board_chat.php` (chat API)
- `board_likes.php` (likes API)
- `board_preview.php` (OG preview image generator)
- `board_config.php` (shared config/helpers)
- `telegram_bot.php` (optional Telegram notifications)
- Runtime directories: `board_data/`, `board_uploads/`, `board_previews/`

## Quick Start (local)

1. Go into this folder.
2. Optionally create `.env` from `.env.example`.
3. Start PHP built-in server:

```bash
php -S 127.0.0.1:8080 router.php
```

4. Open:

- Board: `http://127.0.0.1:8080/board`
- Admin: `http://127.0.0.1:8080/board/admin`

## Notes

- First run creates `board_data/settings.json` automatically.
- Telegram notifications are skipped unless `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set in `.env`.
- External OSINT scanner widgets are not part of this standalone Frog Board package.
