<?php
/**
 * FrogTalk — Telegram Bot Integration
 * Forwards encrypted tips to the Telegram group/channel
 * 
 * SETUP:
 * 1. Message @BotFather on Telegram → /newbot → name it "PeasantHuntTipBot"
 * 2. Copy the bot token
 * 3. Add the bot to your group: https://t.me/goyimconz
 * 4. Get the chat ID (run getChatId() below or use https://api.telegram.org/bot<TOKEN>/getUpdates)
 * 5. Set the values in /var/www/html/.env:
 *      TELEGRAM_BOT_TOKEN=your_bot_token_here
 *      TELEGRAM_CHAT_ID=your_chat_id_here
 */

class PeasantHuntTelegramBot {
    private string $botToken;
    private string $chatId;
    private string $apiBase = 'https://api.telegram.org/bot';
    
    public function __construct() {
        $this->loadConfig();
    }
    
    private function loadConfig(): void {
        $envFile = __DIR__ . '/.env';
        $this->botToken = '';
        $this->chatId = '';
        
        if (file_exists($envFile)) {
            $content = file_get_contents($envFile);
            if (preg_match('/TELEGRAM_BOT_TOKEN=(.+)/', $content, $m)) {
                $this->botToken = trim($m[1]);
            }
            if (preg_match('/TELEGRAM_CHAT_ID=(.+)/', $content, $m)) {
                $this->chatId = trim($m[1]);
            }
        }
        
        // Fallback: check if polling bot saved the group chat ID
        if (empty($this->chatId) && !empty($this->botToken)) {
            $groupFile = __DIR__ . '/board_data/telegram_group.json';
            if (file_exists($groupFile)) {
                $data = json_decode(file_get_contents($groupFile), true);
                if (!empty($data['chat_id'])) {
                    $this->chatId = (string)$data['chat_id'];
                }
            }
        }
    }
    
    public function isConfigured(): bool {
        return !empty($this->botToken) && !empty($this->chatId);
    }
    
    /**
     * Send a new tip notification to the Telegram group
     */
    public function sendTipNotification(string $submissionId, string $timestamp, string $ipHash, string $sourcePage = 'unknown', string $category = 'unknown'): bool {
        if (!$this->isConfigured()) return false;

        $sourceLabel = match($sourcePage) {
            'declaration' => '📜 Declaration Page',
            'test_tip'    => '🧪 Test Page',
            default       => '🌐 ' . ucfirst($sourcePage),
        };

        $message = "🔐 *NEW ENCRYPTED INTEL RECEIVED*\n\n"
                 . "━━━━━━━━━━━━━━━━━━━━━\n"
                 . "📋 *ID:* `{$submissionId}`\n"
                 . "🕐 *Time:* {$timestamp}\n"
                 . "📌 *Source:* {$sourceLabel}\n"
                 . "🗂 *Category:* " . htmlspecialchars_decode($category) . "\n"
                 . "🌐 *IP Hash:* `" . substr($ipHash, 0, 12) . "...`\n"
                 . "━━━━━━━━━━━━━━━━━━━━━\n\n"
                 . "💡 _Decrypt:_ `php decrypt_tips.js`\n"
                 . "🔗 [Dashboard](https://frogtalk.xyz/)";
        
        return $this->sendMessage($message, 'Markdown');
    }
    
    /**
     * Send notification about a new board thread
     * If $imageData is provided and approved, sends photo with caption
     */
    public function sendNewThreadNotification(string $subject, string $comment, string $threadId, int $totalThreads, ?array $imageData = null): bool {
        if (!$this->isConfigured()) return false;
        
        $rawSubject = $subject;
        $subject = $this->escapeMarkdown($subject);
        $preview = $this->escapeMarkdown(mb_substr(strip_tags($comment), 0, 200));
        if (mb_strlen($comment) > 200) $preview .= '...';
        
        $hasImage = $imageData && !empty($imageData['file']);
        $imageApproved = $hasImage && ($imageData['approved'] ?? true) === true;
        $imagePending = $hasImage && !$imageApproved;
        
        $imageStatus = '';
        if ($imagePending) {
            $imageStatus = "\n🖼 *Image:* ⏳ Pending approval";
        } elseif ($imageApproved) {
            $imageStatus = "\n🖼 *Image:* ✅ Attached below";
        }
        
        $message = "📋 *NEW THREAD ON /board/*\n\n"
                 . "━━━━━━━━━━━━━━━━━━━━━\n"
                 . "📌 *Subject:* {$subject}\n"
                 . "🆔 *Thread:* `{$threadId}`\n"
                 . "🕐 *Time:* " . date('Y-m-d H:i:s') . " UTC{$imageStatus}\n"
                 . "━━━━━━━━━━━━━━━━━━━━━\n\n"
                 . "💬 _{$preview}_\n\n"
                 . "📊 Total threads: {$totalThreads}\n"
                 . "🔗 [View Thread](https://frogtalk.xyz/board?thread={$threadId})";
        
        $msgId = null;
        
        // If image is approved, send as photo with caption
        if ($imageApproved) {
            $imagePath = __DIR__ . '/board_uploads/' . $imageData['file'];
            if (file_exists($imagePath)) {
                $msgId = $this->sendPhotoGetId($imagePath, $message);
                if (!$msgId) {
                    // Fall back to text if photo fails
                    $msgId = $this->sendMessageGetId($message, 'Markdown', false);
                }
            }
        } elseif ($imagePending) {
            $msgId = $this->sendMessageGetId($message, 'Markdown', true);
        } else {
            $msgId = $this->sendMessageGetId($message, 'Markdown', false);
        }
        
        if ($msgId) {
            $this->storePendingThreadMessage($threadId, $msgId, $rawSubject, $comment, $threadId, $totalThreads);
            return true;
        }
        return false;
    }
    
    /**
     * Delete the Telegram notification for a thread (call when thread is deleted from board).
     */
    public function deleteThreadNotification(string $postId): void {
        if (!$this->isConfigured()) return;
        $pendingFile = __DIR__ . '/board_data/telegram_pending.json';
        if (!file_exists($pendingFile)) return;
        $pending = json_decode(file_get_contents($pendingFile), true) ?: [];
        if (empty($pending[$postId])) return;
        $msgId = (int)$pending[$postId]['message_id'];
        if ($msgId) $this->deleteMessage($msgId);
        unset($pending[$postId]);
        file_put_contents($pendingFile, json_encode($pending, JSON_PRETTY_PRINT), LOCK_EX);
    }
    
    /**
     * When an image is approved, delete the placeholder message and
     * send a new photo message with the full caption.
     */
    public function updateApprovedThreadImage(string $postId, array $imageData): bool {
        if (!$this->isConfigured()) return false;
        
        $pendingFile = __DIR__ . '/board_data/telegram_pending.json';
        if (!file_exists($pendingFile)) return false;
        
        $pending = json_decode(file_get_contents($pendingFile), true) ?: [];
        if (empty($pending[$postId])) return false;
        
        $entry    = $pending[$postId];
        $oldMsgId = (int)$entry['message_id'];
        $subject  = $entry['raw_subject'] ?? '';
        $comment  = $entry['comment'] ?? '';
        $threadId = $entry['thread_id'] ?? $postId;
        $total    = (int)($entry['total_threads'] ?? 0);
        
        $subjectEsc = $this->escapeMarkdown($subject);
        $preview    = $this->escapeMarkdown(mb_substr(strip_tags($comment), 0, 200));
        if (mb_strlen($comment) > 200) $preview .= '...';
        
        $caption = "📋 *NEW THREAD ON /board/*\n\n"
                 . "━━━━━━━━━━━━━━━━━━━━━\n"
                 . "📌 *Subject:* {$subjectEsc}\n"
                 . "🆔 *Thread:* `{$threadId}`\n"
                 . "🕐 *Time:* " . date('Y-m-d H:i:s') . " UTC\n🖼 *Image:* ✅ Approved\n"
                 . "━━━━━━━━━━━━━━━━━━━━━\n\n"
                 . "💬 _{$preview}_\n\n"
                 . "📊 Total threads: {$total}\n"
                 . "🔗 [View Thread](https://frogtalk.xyz/board?thread={$threadId})";
        
        // Delete placeholder, then send photo
        $this->deleteMessage($oldMsgId);
        
        $imagePath = __DIR__ . '/board_uploads/' . $imageData['file'];
        $sent = false;
        if (file_exists($imagePath)) {
            $sent = $this->sendPhoto($imagePath, $caption);
        }
        if (!$sent) {
            // Fallback: send text-only update
            $sent = $this->sendMessage($caption, 'Markdown', false);
        }
        
        // Remove from pending store
        unset($pending[$postId]);
        file_put_contents($pendingFile, json_encode($pending, JSON_PRETTY_PRINT), LOCK_EX);
        
        return $sent;
    }
    
    /**
     * Save a pending Telegram message_id so it can be updated on approval.
     */
    private function storePendingThreadMessage(string $postId, int $messageId, string $subject, string $comment, string $threadId, int $totalThreads): void {
        $dataDir = __DIR__ . '/board_data';
        if (!is_dir($dataDir)) mkdir($dataDir, 0755, true);
        $pendingFile = $dataDir . '/telegram_pending.json';
        $pending = file_exists($pendingFile) ? (json_decode(file_get_contents($pendingFile), true) ?: []) : [];
        $pending[$postId] = [
            'message_id'   => $messageId,
            'raw_subject'  => $subject,
            'comment'      => $comment,
            'thread_id'    => $threadId,
            'total_threads'=> $totalThreads,
            'time'         => time(),
        ];
        file_put_contents($pendingFile, json_encode($pending, JSON_PRETTY_PRINT), LOCK_EX);
    }
    
    /**
     * Delete a message from the group chat.
     */
    public function deleteMessage(int $messageId): void {
        $url = $this->apiBase . $this->botToken . '/deleteMessage';
        $ch = curl_init();
        curl_setopt_array($ch, [
            CURLOPT_URL        => $url,
            CURLOPT_POST       => true,
            CURLOPT_POSTFIELDS => json_encode(['chat_id' => $this->chatId, 'message_id' => $messageId]),
            CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT    => 10,
            CURLOPT_SSL_VERIFYPEER => true,
        ]);
        curl_exec($ch);
        curl_close($ch);
    }
    
    /**
     * Send a photo and return the message_id, or null on failure.
     */
    private function sendPhotoGetId(string $imagePath, string $caption = '', string $parseMode = 'Markdown'): ?int {
        if (!$this->isConfigured()) return null;
        $url = $this->apiBase . $this->botToken . '/sendPhoto';
        $payload = [
            'chat_id'    => $this->chatId,
            'photo'      => new \CURLFile($imagePath),
            'parse_mode' => $parseMode,
        ];
        if ($caption) $payload['caption'] = mb_substr($caption, 0, 1024);
        $ch = curl_init();
        curl_setopt_array($ch, [
            CURLOPT_URL            => $url,
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => $payload,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 30,
            CURLOPT_SSL_VERIFYPEER => true,
        ]);
        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if ($httpCode !== 200) {
            error_log("Telegram sendPhoto error: HTTP {$httpCode} — " . $response);
            return null;
        }
        $result = json_decode($response, true);
        if (($result['ok'] ?? false) !== true) return null;
        return (int)($result['result']['message_id'] ?? 0) ?: null;
    }
    
    /**
     * Send a photo with caption to the Telegram group
     */
    public function sendPhoto(string $imagePath, string $caption = '', string $parseMode = 'Markdown'): bool {
        if (!$this->isConfigured()) return false;
        
        $url = $this->apiBase . $this->botToken . '/sendPhoto';
        
        $payload = [
            'chat_id' => $this->chatId,
            'photo' => new \CURLFile($imagePath),
            'parse_mode' => $parseMode,
        ];
        
        // Telegram caption limit is 1024 chars
        if ($caption) {
            $payload['caption'] = mb_substr($caption, 0, 1024);
        }
        
        $ch = curl_init();
        curl_setopt_array($ch, [
            CURLOPT_URL => $url,
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $payload,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 30,
            CURLOPT_SSL_VERIFYPEER => true
        ]);
        
        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        
        if ($httpCode !== 200) {
            error_log("Telegram sendPhoto error: HTTP {$httpCode} — " . $response);
            return false;
        }
        
        $result = json_decode($response, true);
        return ($result['ok'] ?? false) === true;
    }
    
    /**
     * Send encrypted tip notification with encrypted content preview
     * The actual tip content is encrypted - we show metadata + encrypted hash
     */
    public function sendEncryptedTipAlert(string $submissionId, string $timestamp, string $ipHash, string $encryptedHash): bool {
        if (!$this->isConfigured()) return false;
        
        $message = "🔐 *ENCRYPTED TIP RECEIVED*\n\n"
                 . "━━━━━━━━━━━━━━━━━━━━━\n"
                 . "📋 *Submission ID:* `{$submissionId}`\n"
                 . "🕐 *Time:* {$timestamp}\n"
                 . "🔐 *Status:* End\\-to\\-End Encrypted\n"
                 . "🌐 *Source:* `" . substr($ipHash, 0, 12) . "...`\n"
                 . "🔑 *Content Hash:* `" . substr($encryptedHash, 0, 32) . "...`\n"
                 . "━━━━━━━━━━━━━━━━━━━━━\n\n"
                 . "⚠️ _Tip content is encrypted\\. Decrypt on server:_\n"
                 . "`php decrypt\\_tips\\.js`\n\n"
                 . "🐸 The swamp grows deeper\\.";
        
        return $this->sendMessage($message, 'MarkdownV2');
    }
    
    /**
     * Send a custom alert message
     */
    public function sendAlert(string $message): bool {
        if (!$this->isConfigured()) return false;
        return $this->sendMessage("⚠️ *PEASANT HUNT ALERT*\n\n" . $message, 'Markdown');
    }

    /**
     * Notify admin of a new Prezzy card order — action required
     */
    public function sendCardOrderNotification(
        string $orderId,
        float  $cardAmount,
        string $email,
        float  $goyimPaid,
        string $txHash
    ): bool {
        if (!$this->isConfigured()) return false;
        $goyimFmt = number_format((int)$goyimPaid);
        $msg  = "💳 *CARD ORDER \\#" . $orderId . " — ACTION REQUIRED*\n\n";
        $msg .= "💵 Card Amount: *NZD \\$" . number_format($cardAmount, 2) . "*\n";
        $msg .= "📧 Email: `" . $email . "`\n";
        $msg .= "🪙 GOYIM Paid: *" . $goyimFmt . " \\$GOYIM*\n";
        $msg .= "🔗 Tx: `" . $txHash . "`\n";
        $msg .= "[View on Solscan](https://solscan.io/tx/" . $txHash . ")\n\n";
        $msg .= "✅ *Purchase a Prezzy Virtual Visa for NZD \\$" . number_format($cardAmount, 2) . " and email the card code to the address above.*\n";
        $msg .= "[Treasury Admin](https://frogtalk.xyz/treasury?admin_orders=1)";
        $ok = $this->sendMessage($msg, 'Markdown');
        // Also DM admin personally
        $this->sendAdminDm($msg, 'Markdown');
        return $ok;
    }

    /**
     * Notify admin of a new bank transfer withdrawal — action required
     */
    public function sendBankTransferNotification(
        string $withdrawalId,
        float  $goyimPaid,
        string $currency,
        float  $fiatAmount,
        string $dest,
        string $txHash
    ): bool {
        if (!$this->isConfigured()) return false;
        $goyimFmt = number_format((int)$goyimPaid);
        $fiatFmt  = number_format($fiatAmount, 2);
        $msg  = "🏦 *BANK TRANSFER \\#" . $withdrawalId . " — ACTION REQUIRED*\n\n";
        $msg .= "🪙 GOYIM Paid: *" . $goyimFmt . " \\$GOYIM*\n";
        $msg .= "💵 Fiat Amount: *" . $currency . " " . $fiatFmt . "*\n";
        $msg .= "📨 Destination: `" . $dest . "`\n";
        $msg .= "🔗 Tx: `" . $txHash . "`\n";
        $msg .= "[View on Solscan](https://solscan.io/tx/" . $txHash . ")\n\n";
        $msg .= "✅ *Process bank transfer of " . $currency . " " . $fiatFmt . " to the destination above.*\n";
        $msg .= "[Treasury Admin](https://frogtalk.xyz/treasury)";
        $ok = $this->sendMessage($msg, 'Markdown');
        // Also DM admin personally
        $this->sendAdminDm($msg, 'Markdown');
        return $ok;
    }
    
    /**
     * Escape special characters for Telegram Markdown v1
     * Only need to escape _ * ` [ for v1
     */
    private function escapeMarkdown(string $text): string {
        return str_replace(
            ['_', '*', '`', '['],
            ['\\_', '\\*', '\\`', '\\['],
            $text
        );
    }
    
    /**
     * Get admin Telegram user ID (auto-captured when admin messages bot)
     */
    private function getAdminTgId(): ?int {
        $f = __DIR__ . '/board_data/admin_tg_id.txt';
        if (!file_exists($f)) return null;
        $id = (int)trim(file_get_contents($f));
        return $id > 0 ? $id : null;
    }
    
    /**
     * Send a direct message to the admin (@zubka007) if their ID is known.
     * The admin's ID is auto-captured the first time they interact with the bot.
     * Have the admin send /myid to the bot to register their ID.
     */
    public function sendAdminDm(string $msg, string $parseMode = 'Markdown'): bool {
        $adminId = $this->getAdminTgId();
        if (!$adminId || empty($this->botToken)) return false;
        $url = $this->apiBase . $this->botToken . '/sendMessage';
        $payload = [
            'chat_id'                  => $adminId,
            'text'                     => $msg,
            'parse_mode'               => $parseMode,
            'disable_web_page_preview' => true,
        ];
        $ch = curl_init();
        curl_setopt_array($ch, [
            CURLOPT_URL            => $url,
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => json_encode($payload),
            CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 10,
        ]);
        $resp = curl_exec($ch); curl_close($ch);
        return !empty(@json_decode($resp, true)['ok']);
    }
    
    /**
     * Core send message function
     */
    private function sendMessage(string $text, string $parseMode = 'Markdown', bool $disablePreview = true): bool {
        return $this->sendMessageGetId($text, $parseMode, $disablePreview) !== null;
    }
    
    /**
     * Send a message and return the Telegram message_id, or null on failure.
     */
    private function sendMessageGetId(string $text, string $parseMode = 'Markdown', bool $disablePreview = true): ?int {
        $url = $this->apiBase . $this->botToken . '/sendMessage';
        
        $payload = [
            'chat_id' => $this->chatId,
            'text' => $text,
            'parse_mode' => $parseMode,
            'disable_web_page_preview' => $disablePreview
        ];
        
        $ch = curl_init();
        curl_setopt_array($ch, [
            CURLOPT_URL => $url,
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => json_encode($payload),
            CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 10,
            CURLOPT_SSL_VERIFYPEER => true
        ]);
        
        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        
        if ($httpCode !== 200) {
            error_log("Telegram API error: HTTP {$httpCode} — " . $response);
            return null;
        }
        
        $result = json_decode($response, true);
        if (($result['ok'] ?? false) !== true) return null;
        return (int)($result['result']['message_id'] ?? 0) ?: null;
    }
    
    /**
     * Helper: Get chat ID from bot updates
     * Call this once after adding bot to group and sending a message
     */
    public function getChatId(): ?string {
        if (empty($this->botToken)) return null;
        
        $url = $this->apiBase . $this->botToken . '/getUpdates';
        $ch = curl_init();
        curl_setopt_array($ch, [
            CURLOPT_URL => $url,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 10
        ]);
        
        $response = curl_exec($ch);
        curl_close($ch);
        
        $data = json_decode($response, true);
        if (!empty($data['result'])) {
            foreach ($data['result'] as $update) {
                $chat = $update['message']['chat'] ?? $update['channel_post']['chat'] ?? null;
                if ($chat) {
                    return (string)$chat['id'];
                }
            }
        }
        return null;
    }
    
    /**
     * Set webhook for real-time tip forwarding
     */
    public function setWebhook(string $url): bool {
        if (empty($this->botToken)) return false;
        
        $apiUrl = $this->apiBase . $this->botToken . '/setWebhook';
        $ch = curl_init();
        curl_setopt_array($ch, [
            CURLOPT_URL => $apiUrl,
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => json_encode(['url' => $url]),
            CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 10
        ]);
        
        $response = curl_exec($ch);
        curl_close($ch);
        
        $result = json_decode($response, true);
        return ($result['ok'] ?? false) === true;
    }
}

// CLI helper - run: php telegram_bot.php test
if (php_sapi_name() === 'cli' && isset($argv[1])) {
    $bot = new PeasantHuntTelegramBot();
    
    switch ($argv[1]) {
        case 'test':
            if (!$bot->isConfigured()) {
                echo "❌ Bot not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env\n";
                exit(1);
            }
            $result = $bot->sendAlert("🧪 Test message from FrogTalk\nTimestamp: " . date('Y-m-d H:i:s'));
            echo $result ? "✅ Test message sent!\n" : "❌ Failed to send\n";
            break;
            
        case 'chatid':
            $chatId = $bot->getChatId();
            echo $chatId ? "Chat ID: {$chatId}\n" : "No chat found. Send a message in the group first.\n";
            break;
            
        case 'setup':
            echo "🐸 Telegram Bot Setup for FrogTalk\n";
            echo "================================================\n\n";
            echo "1. Open Telegram and message @BotFather\n";
            echo "2. Send /newbot\n";
            echo "3. Name: PeasantHuntTipBot\n";
            echo "4. Username: PeasantHuntTipBot (or similar)\n";
            echo "5. Copy the token\n";
            echo "6. Add to your .env file:\n";
            echo "   TELEGRAM_BOT_TOKEN=<your_token>\n\n";
            echo "7. Add the bot to your Telegram group\n";
            echo "8. Send any message in the group\n";
            echo "9. Run: php telegram_bot.php chatid\n";
            echo "10. Add to .env: TELEGRAM_CHAT_ID=<chat_id>\n";
            echo "11. Test: php telegram_bot.php test\n";
            break;
            
        default:
            echo "Usage: php telegram_bot.php [test|chatid|setup]\n";
    }
}
