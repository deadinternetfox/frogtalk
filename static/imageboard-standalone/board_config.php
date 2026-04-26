<?php
/**
 * Board Configuration & Shared Functions
 * Used by board.php, board_admin.php, board_chat.php, board_preview.php
 */

// ── Security: Harden session settings before any session_start() ──
if (session_status() === PHP_SESSION_NONE) {
    ini_set('session.cookie_httponly', '1');
    ini_set('session.cookie_samesite', 'Strict');
    ini_set('session.use_strict_mode', '1');
    ini_set('session.cookie_secure', !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off' ? '1' : '0');
}

define('DATA_DIR', __DIR__ . '/board_data');
define('UPLOAD_DIR', __DIR__ . '/board_uploads');
define('PREVIEW_DIR', __DIR__ . '/board_previews');
define('MAX_FILE_SIZE', 5 * 1024 * 1024);
define('MAX_THREADS', 100);
define('MAX_REPLIES', 500);
define('ALLOWED_TYPES', ['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
define('THUMB_WIDTH', 250);

// Admin credentials — password stored as bcrypt hash (never cleartext)
define('ADMIN_USER', 'frog');
define('ADMIN_PASS_HASH', '$2y$10$bJHz06VkLbXm83CJc2w1k.FIOZxKO0Q7gyKKwPi0O4Oszp.J4pIw.');

// Ensure directories
foreach ([DATA_DIR, UPLOAD_DIR, PREVIEW_DIR] as $dir) {
    if (!is_dir($dir)) mkdir($dir, 0755, true);
}

// ── Settings ──
function loadSettings(): array {
    $file = DATA_DIR . '/settings.json';
    $defaults = [
        'require_image_approval' => false,
        'board_locked' => false,
        'max_file_size_mb' => 5,
        'allowed_extensions' => 'jpg,png,gif,webp',
        'allow_images' => true,
        'allow_audio' => true,
        'allow_video' => true,
        'require_audio_approval' => false,
        'require_video_approval' => true,
        'rate_limit_seconds' => 15,
        'auto_ban_words' => '',
        'announcement' => '',
        'chat_enabled' => true,
        'threads_per_page' => 10,
        'replies_preview_count' => 3,
        'views_lifetime' => 0,  // accumulates views from pruned/deleted threads
        'max_media_size_mb' => 100,
        'op_requires' => 'any'
    ];
    if (!file_exists($file)) {
        file_put_contents($file, json_encode($defaults, JSON_PRETTY_PRINT));
        return $defaults;
    }
    return array_merge($defaults, json_decode(file_get_contents($file), true) ?: []);
}

function saveSettings(array $settings): void {
    file_put_contents(DATA_DIR . '/settings.json', json_encode($settings, JSON_PRETTY_PRINT), LOCK_EX);
}

// ── Threads ──
function loadThreads(): array {
    $file = DATA_DIR . '/threads.json';
    if (!file_exists($file)) return [];
    $data = json_decode(file_get_contents($file), true);
    return is_array($data) ? $data : [];
}

function saveThreads(array $threads): void {
    file_put_contents(DATA_DIR . '/threads.json', json_encode($threads, JSON_PRETTY_PRINT), LOCK_EX);
}

// ── Bans ──
function loadBans(): array {
    $file = DATA_DIR . '/bans.json';
    if (!file_exists($file)) return [];
    $data = json_decode(file_get_contents($file), true);
    return is_array($data) ? $data : [];
}

function saveBans(array $bans): void {
    file_put_contents(DATA_DIR . '/bans.json', json_encode($bans, JSON_PRETTY_PRINT), LOCK_EX);
}

function isIPBanned(string $ipHash): array|false {
    $bans = loadBans();
    foreach ($bans as $ban) {
        if ($ban['ip_hash'] === $ipHash) {
            if ($ban['expires'] === 0 || $ban['expires'] > time()) {
                return $ban;
            }
        }
    }
    return false;
}

// ── Image Approval Queue ──
function loadApprovalQueue(): array {
    $file = DATA_DIR . '/approval_queue.json';
    if (!file_exists($file)) return [];
    $data = json_decode(file_get_contents($file), true);
    return is_array($data) ? $data : [];
}

function saveApprovalQueue(array $queue): void {
    file_put_contents(DATA_DIR . '/approval_queue.json', json_encode($queue, JSON_PRETTY_PRINT), LOCK_EX);
}

// ── Chat Messages ──
function loadChat(): array {
    $file = DATA_DIR . '/chat.json';
    if (!file_exists($file)) return [];
    $data = json_decode(file_get_contents($file), true);
    return is_array($data) ? $data : [];
}

function saveChat(array $messages): void {
    // Keep only last 200 messages
    $messages = array_slice($messages, -200);
    file_put_contents(DATA_DIR . '/chat.json', json_encode($messages, JSON_PRETTY_PRINT), LOCK_EX);
}

// ── Moderation Log ──
function logModAction(string $action, string $details): void {
    $file = DATA_DIR . '/modlog.json';
    $log = file_exists($file) ? (json_decode(file_get_contents($file), true) ?: []) : [];
    $log[] = [
        'time' => time(),
        'action' => $action,
        'details' => $details
    ];
    $log = array_slice($log, -500); // Keep last 500
    file_put_contents($file, json_encode($log, JSON_PRETTY_PRINT), LOCK_EX);
}

// ── Helpers ──
function generatePostId(): string {
    return time() . substr(md5(uniqid(mt_rand(), true)), 0, 6);
}

function getAnonId(string $threadId = ''): string {
    $ip = $_SERVER['REMOTE_ADDR'] ?? '127.0.0.1';
    $salt = date('Y-m-d') . $threadId;
    return substr(hash('sha256', $ip . $salt), 0, 12);
}

// Stable chat-only anon ID — unique per browser, not just per IP
// Uses a persistent cookie so two users on the same IP (VPN, CGNAT, shared wifi) get different IDs
function getChatAnonId(): string {
    $ip = $_SERVER['REMOTE_ADDR'] ?? '127.0.0.1';
    $uid = $_COOKIE['swamp_uid'] ?? '';
    // If no cookie yet, generate one and set it (will apply on next request)
    if (empty($uid) || strlen($uid) < 16) {
        $uid = bin2hex(random_bytes(16));
        // Set cookie for 1 year, httponly, secure, samesite
        $opts = [
            'expires' => time() + 86400 * 365,
            'path' => '/',
            'httponly' => true,
            'samesite' => 'Lax',
        ];
        if (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') {
            $opts['secure'] = true;
        }
        setcookie('swamp_uid', $uid, $opts);
        $_COOKIE['swamp_uid'] = $uid; // make available immediately in this request
    }
    return substr(hash('sha256', $ip . $uid . 'swamp-chat-salt-v2'), 0, 12);
}

function getIPHash(): string {
    return md5($_SERVER['REMOTE_ADDR'] ?? '127.0.0.1');
}

// Per-session visitor ID for likes — unique per browser, not per IP.
// This prevents different users on the same IP/proxy from clobbering each other's likes.
function getLikeKey(): string {
    if (session_status() === PHP_SESSION_NONE) session_start();
    if (empty($_SESSION['visitor_id'])) {
        $_SESSION['visitor_id'] = bin2hex(random_bytes(16));
    }
    return $_SESSION['visitor_id'];
}

function timeAgo(int $ts): string {
    $diff = time() - $ts;
    if ($diff < 60) return $diff . 's ago';
    if ($diff < 3600) return floor($diff / 60) . 'm ago';
    if ($diff < 86400) return floor($diff / 3600) . 'h ago';
    return floor($diff / 86400) . 'd ago';
}

function formatFileSize(int $bytes): string {
    if ($bytes >= 1048576) return round($bytes / 1048576, 1) . ' MB';
    if ($bytes >= 1024) return round($bytes / 1024, 1) . ' KB';
    return $bytes . ' B';
}

function formatPostText(string $text, string $postId = ''): string {
    $text = htmlspecialchars($text, ENT_QUOTES, 'UTF-8');
    $lines = explode("\n", $text);
    $formatted = [];
    foreach ($lines as $line) {
        if (preg_match('/^&gt;(?!&gt;\d)/', $line)) {
            $formatted[] = '<span class="greentext">' . $line . '</span>';
        } elseif (preg_match('/^&gt;&gt;(\d+\w+)/', $line, $m)) {
            $formatted[] = '<a href="#p' . $m[1] . '" class="post-ref">&gt;&gt;' . $m[1] . '</a>' . substr($line, strlen('&gt;&gt;' . $m[1]));
        } else {
            $formatted[] = $line;
        }
    }
    $text = implode("\n", $formatted);
    $text = preg_replace('/(?<!src=")(https?:\/\/[^\s<]+)/i', '<a href="$1" target="_blank" rel="noopener" class="post-link">$1</a>', $text);
    // Scanner directives are intentionally disabled on Frog Board.
    $text = nl2br($text);
    return $text;
}

function handleUpload(array $file, bool $requireApproval = false): ?array {
    if ($file['error'] !== UPLOAD_ERR_OK) return null;
    if ($file['size'] > MAX_FILE_SIZE) return ['error' => 'File too large (max 5MB)'];
    
    $finfo = finfo_open(FILEINFO_MIME_TYPE);
    $mime = finfo_file($finfo, $file['tmp_name']);
    finfo_close($finfo);
    
    if (!in_array($mime, ALLOWED_TYPES)) return ['error' => 'Invalid file type'];
    
    $ext = match($mime) {
        'image/jpeg' => '.jpg', 'image/png' => '.png',
        'image/gif' => '.gif', 'image/webp' => '.webp', default => '.jpg'
    };
    
    $filename = time() . '_' . bin2hex(random_bytes(8)) . $ext;
    $path = UPLOAD_DIR . '/' . $filename;
    
    if (!move_uploaded_file($file['tmp_name'], $path)) {
        return ['error' => 'Upload failed'];
    }
    
    $thumbFile = 't_' . $filename;
    createThumbnail($path, UPLOAD_DIR . '/' . $thumbFile, $mime);
    
    return [
        'file' => $filename,
        'thumb' => $thumbFile,
        'size' => $file['size'],
        'mime' => $mime,
        'origName' => basename($file['name']),
        'approved' => !$requireApproval // auto-approved if setting is off
    ];
}

function createThumbnail(string $src, string $dst, string $mime): void {
    $img = match($mime) {
        'image/jpeg' => @imagecreatefromjpeg($src),
        'image/png' => @imagecreatefrompng($src),
        'image/gif' => @imagecreatefromgif($src),
        'image/webp' => @imagecreatefromwebp($src),
        default => null
    };
    if (!$img) { copy($src, $dst); return; }
    
    $w = imagesx($img); $h = imagesy($img);
    $ratio = min(THUMB_WIDTH / $w, THUMB_WIDTH / $h);
    if ($ratio >= 1) { copy($src, $dst); imagedestroy($img); return; }
    
    $nw = (int)($w * $ratio); $nh = (int)($h * $ratio);
    $thumb = imagecreatetruecolor($nw, $nh);
    if ($mime !== 'image/jpeg') { imagealphablending($thumb, false); imagesavealpha($thumb, true); }
    imagecopyresampled($thumb, $img, 0, 0, 0, 0, $nw, $nh, $w, $h);
    imagejpeg($thumb, $dst, 80);
    imagedestroy($img); imagedestroy($thumb);
}

// ── Media Upload (Audio / Video) ──────────────────────────────────────────────
define('MEDIA_ALLOWED_TYPES', [
    'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-wav',
    'video/webm', 'video/mp4', 'video/quicktime', 'video/x-matroska',
]);
define('MAX_MEDIA_SIZE', 100 * 1024 * 1024); // 100 MB

function handleMediaUpload(array $file, bool $requireApproval = true, int $maxSizeMb = 0): ?array {
    if ($file['error'] !== UPLOAD_ERR_OK) return null;
    $maxBytes = $maxSizeMb > 0 ? ($maxSizeMb * 1024 * 1024) : MAX_MEDIA_SIZE;
    if ($file['size'] > $maxBytes) return ['error' => 'Media file too large (max ' . ($maxSizeMb > 0 ? $maxSizeMb : 100) . 'MB)'];

    $finfo = finfo_open(FILEINFO_MIME_TYPE);
    $mime  = finfo_file($finfo, $file['tmp_name']);
    finfo_close($finfo);

    if (!in_array($mime, MEDIA_ALLOWED_TYPES)) {
        return ['error' => 'Unsupported media type. Use audio (webm/ogg/mp4/mp3/wav) or video (webm/mp4/mov)'];
    }

    // finfo may return 'video/webm' for audio-only WebM blobs recorded by the browser.
    // Override using browser-provided MIME or file extension when available.
    $origMime = strtolower(explode(';', $file['type'] ?? '')[0]);
    $origExt  = strtolower(pathinfo($file['name'] ?? '', PATHINFO_EXTENSION));
    $type = (strpos($mime, 'audio/') === 0) ? 'audio' : 'video';
    if ($type === 'video' && ((strpos($origMime, 'audio/') === 0) || in_array($origExt, ['mp3','ogg','wav','flac','aac','m4a']))) {
        $type = 'audio'; // browser-recorded audio WebM mis-detected as video by finfo
    }
    $ext  = match($mime) {
        'audio/webm'       => '.webm',
        'audio/ogg'        => '.ogg',
        'audio/mp4',
        'audio/mpeg'       => '.mp3',
        'audio/wav',
        'audio/x-wav'      => '.wav',
        'video/webm'       => '.webm',
        'video/mp4'        => '.mp4',
        'video/quicktime'  => '.mov',
        'video/x-matroska' => '.mkv',
        default            => '.bin',
    };

    $filename = $type . '_' . time() . '_' . bin2hex(random_bytes(8)) . $ext;
    $path     = UPLOAD_DIR . '/' . $filename;

    if (!move_uploaded_file($file['tmp_name'], $path)) {
        return ['error' => 'Media upload failed'];
    }

    return [
        'file'     => $filename,
        'type'     => $type,
        'mime'     => $mime,
        'size'     => $file['size'],
        'origName' => basename($file['name']),
        'approved' => !$requireApproval,
    ];
}

// Check if media (audio/video) is approved/visible
function isMediaVisible(?array $mediaData): bool {
    if (!$mediaData || empty($mediaData['file'])) return false;
    return ($mediaData['approved'] ?? true) === true;
}

// Check if image is viewable (approved or approval not required)
function isImageVisible(?array $imageData): bool {
    if (!$imageData) return false;
    return ($imageData['approved'] ?? true) === true;
}

// ── Views Tracking (total views per thread) ──
function loadViews(): array {
    $file = DATA_DIR . '/views.json';
    if (!file_exists($file)) return [];
    $data = json_decode(file_get_contents($file), true);
    if (!is_array($data)) return [];
    // Migrate old format (arrays of IP hashes) to counts
    $migrated = false;
    foreach ($data as $tid => $val) {
        if (is_array($val)) {
            $data[$tid] = count($val);
            $migrated = true;
        }
    }
    if ($migrated) {
        file_put_contents(DATA_DIR . '/views.json', json_encode($data), LOCK_EX);
    }
    return $data;
}

function saveViews(array $views): void {
    file_put_contents(DATA_DIR . '/views.json', json_encode($views), LOCK_EX);
}

function trackView(string $threadId): int {
    $views = loadViews();
    if (!isset($views[$threadId])) $views[$threadId] = 0;
    $views[$threadId]++;
    saveViews($views);
    return $views[$threadId];
}

function getViewCount(string $threadId): int {
    $views = loadViews();
    return (int)($views[$threadId] ?? 0);
}

function getTotalViews(): int {
    $settings = loadSettings();
    $total = (int)($settings['views_lifetime'] ?? 0);  // lifetime offset from pruned threads
    $views = loadViews();
    foreach ($views as $count) {
        $total += (int)$count;
    }
    return $total;
}

// ── Likes System (unique IPs per post) ──
function loadLikes(): array {
    $file = DATA_DIR . '/likes.json';
    if (!file_exists($file)) return [];
    $data = json_decode(file_get_contents($file), true);
    return is_array($data) ? $data : [];
}

function saveLikes(array $likes): void {
    file_put_contents(DATA_DIR . '/likes.json', json_encode($likes), LOCK_EX);
}

function toggleLike(string $postId): array {
    $likes = loadLikes();
    $key = getLikeKey();
    if (!isset($likes[$postId])) $likes[$postId] = [];

    $idx = array_search($key, $likes[$postId]);
    if ($idx !== false) {
        array_splice($likes[$postId], $idx, 1);
        $liked = false;
    } else {
        $likes[$postId][] = $key;
        $liked = true;
    }
    saveLikes($likes);
    return ['count' => count($likes[$postId]), 'liked' => $liked];
}

function getLikeCount(string $postId): int {
    $likes = loadLikes();
    return count($likes[$postId] ?? []);
}

function hasLiked(string $postId): bool {
    $likes = loadLikes();
    $key = getLikeKey();
    return in_array($key, $likes[$postId] ?? []);
}

function getThreadLikeScore(array $thread): int {
    $score = getLikeCount($thread['id']);
    foreach ($thread['replies'] ?? [] as $reply) {
        $score += getLikeCount($reply['id']);
    }
    return $score;
}

// ── Online Users Tracking ──
function trackOnlineUser(): void {
    $file = DATA_DIR . '/online.json';
    $data = file_exists($file) ? (json_decode(file_get_contents($file), true) ?: []) : [];
    $ipHash = getIPHash();
    $data[$ipHash] = time();
    // Prune stale entries (>5 min)
    $data = array_filter($data, fn($t) => (time() - $t) < 300);
    file_put_contents($file, json_encode($data), LOCK_EX);
}

function getOnlineCount(): int {
    $file = DATA_DIR . '/online.json';
    if (!file_exists($file)) return 0;
    $data = json_decode(file_get_contents($file), true) ?: [];
    return count(array_filter($data, fn($t) => (time() - $t) < 300));
}

// ── Wallet Linking (optional per poster) ──
function loadWallets(): array {
    $file = DATA_DIR . '/wallets.json';
    if (!file_exists($file)) return [];
    $data = json_decode(file_get_contents($file), true);
    return is_array($data) ? $data : [];
}

function saveWallets(array $wallets): void {
    file_put_contents(DATA_DIR . '/wallets.json', json_encode($wallets), LOCK_EX);
}

function linkWalletToPost(string $postId, string|array $wallet): void {
    $wallets = loadWallets();
    if (is_array($wallet)) {
        // Multi-chain: {eth: "0x...", btc: "1...", sol: "...", tron: "T..."}
        $valid = [];
        $patterns = [
            'eth'  => '/^0x[0-9a-fA-F]{40}$/',
            'btc'  => '/^([13][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[a-zA-HJ-NP-Z0-9]{25,62})$/',
            'sol'  => '/^[1-9A-HJ-NP-Za-km-z]{32,44}$/',
            'tron' => '/^T[a-zA-HJ-NP-Z0-9]{33}$/',
        ];
        foreach ($patterns as $chain => $pat) {
            $addr = trim($wallet[$chain] ?? '');
            if ($addr && preg_match($pat, $addr)) {
                $valid[$chain] = $addr;
            }
        }
        if (!empty($valid)) {
            $wallets[$postId] = $valid;
            saveWallets($wallets);
        }
    } else {
        // Legacy single address
        $wallet = trim($wallet);
        if (strlen($wallet) < 26 || strlen($wallet) > 128) return;
        if (!preg_match('/^(0x[0-9a-fA-F]{40}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[a-zA-HJ-NP-Z0-9]{25,62}|T[a-zA-HJ-NP-Z0-9]{33}|[1-9A-HJ-NP-Za-km-z]{32,44})$/', $wallet)) return;
        // Auto-detect chain for legacy single address
        if (str_starts_with($wallet, '0x')) $wallets[$postId] = ['eth' => $wallet];
        elseif (str_starts_with($wallet, 'bc1') || str_starts_with($wallet, '1') || str_starts_with($wallet, '3')) $wallets[$postId] = ['btc' => $wallet];
        elseif (str_starts_with($wallet, 'T')) $wallets[$postId] = ['tron' => $wallet];
        else $wallets[$postId] = ['sol' => $wallet];
        saveWallets($wallets);
    }
}

function getPostWallet(string $postId): ?string {
    $wallets = loadWallets();
    $w = $wallets[$postId] ?? null;
    if ($w === null) return null;
    // Backwards compat: if it's already an array, return the first address
    if (is_array($w)) {
        return $w['eth'] ?? $w['btc'] ?? $w['sol'] ?? $w['tron'] ?? null;
    }
    return $w;
}

function getPostWallets(string $postId): ?array {
    $wallets = loadWallets();
    $w = $wallets[$postId] ?? null;
    if ($w === null) return null;
    // Backwards compat: if it's a plain string, convert
    if (is_string($w)) {
        if (str_starts_with($w, '0x')) return ['eth' => $w];
        if (str_starts_with($w, 'bc1') || str_starts_with($w, '1') || str_starts_with($w, '3')) return ['btc' => $w];
        if (str_starts_with($w, 'T')) return ['tron' => $w];
        return ['sol' => $w];
    }
    return is_array($w) ? $w : null;
}

function walletIcon(string $addr): string {
    if (str_starts_with($addr, '0x')) return '🦊';
    if (str_starts_with($addr, 'bc1') || str_starts_with($addr, '1') || str_starts_with($addr, '3')) return '₿';
    if (str_starts_with($addr, 'T')) return '◎'; // TRON
    return '💰'; // SOL or unknown
}

// ── CSRF Token Protection ──
function generateCsrfToken(): string {
    if (session_status() === PHP_SESSION_NONE) session_start();
    if (empty($_SESSION['csrf_token'])) {
        $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
    }
    return $_SESSION['csrf_token'];
}

function verifyCsrfToken(?string $token): bool {
    if (session_status() === PHP_SESSION_NONE) session_start();
    if (empty($token) || empty($_SESSION['csrf_token'])) return false;
    return hash_equals($_SESSION['csrf_token'], $token);
}

function csrfField(): string {
    return '<input type="hidden" name="csrf_token" value="' . htmlspecialchars(generateCsrfToken()) . '">';
}

// ── AJAX Rate Limiting ──
function checkAjaxRateLimit(string $action, int $cooldown = 2): bool {
    $key = 'ajax_' . $action;
    $now = time();
    if (isset($_SESSION[$key]) && ($now - $_SESSION[$key]) < $cooldown) {
        return false;
    }
    $_SESSION[$key] = $now;
    return true;
}

// Admin auth check
function isAdminLoggedIn(): bool {
    if (session_status() === PHP_SESSION_NONE) session_start();
    // Auto-expire admin session after 4 hours
    if (($_SESSION['board_admin'] ?? false) === true) {
        if (time() - ($_SESSION['admin_login_time'] ?? 0) > 14400) {
            unset($_SESSION['board_admin'], $_SESSION['admin_login_time']);
            return false;
        }
        return true;
    }
    return false;
}

function adminLogin(string $user, string $pass): bool {
    // Rate limit login attempts (5 per minute)
    $now = time();
    $attempts = $_SESSION['login_attempts'] ?? [];
    $attempts = array_filter($attempts, fn($t) => ($now - $t) < 60);
    if (count($attempts) >= 5) return false;
    $attempts[] = $now;
    $_SESSION['login_attempts'] = $attempts;
    
    if ($user === ADMIN_USER && password_verify($pass, ADMIN_PASS_HASH)) {
        $_SESSION['board_admin'] = true;
        $_SESSION['admin_login_time'] = time();
        session_regenerate_id(true);
        return true;
    }
    return false;
}
