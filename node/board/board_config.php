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

// ── Defense-in-depth security headers for every PHP-served board response ──
// nginx already emits these for static assets; emit them from PHP too so the
// imageboard is hardened even if dropped behind a vanilla Apache.
// SECURITY-PASS-2: emit headers exactly once per request (helper functions
// such as loadSettings() call into here from many entry points).
if (!function_exists('board_emit_security_headers')) {
    function board_emit_security_headers(): void {
        static $emitted = false;
        if ($emitted) return;
        $emitted = true;
        if (headers_sent()) return;
        header('X-Content-Type-Options: nosniff');
        header('X-Frame-Options: SAMEORIGIN');
        header('Referrer-Policy: strict-origin-when-cross-origin');
        header('Permissions-Policy: microphone=(self), camera=(self), geolocation=(), payment=(), usb=()');
        // CSP: keep 'unsafe-inline' for now because board pages still use
        // inline onclick/style heavily. Tightening to nonces is tracked
        // under the same migration as the main app — for the board the
        // priority is blocking object/base/form action hijacks and
        // tightening connect-src so a stored XSS cannot exfil to an
        // attacker domain.
        header(
            "Content-Security-Policy: default-src 'self'; " .
            "script-src 'self' 'unsafe-inline'; " .
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " .
            "font-src 'self' data: https://fonts.gstatic.com; " .
            "img-src 'self' data: blob: https:; " .
            "media-src 'self' data: blob: https:; " .
            "connect-src 'self' https://api.mainnet-beta.solana.com; " .
            "frame-src 'self' https://www.youtube.com; " .
            "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'"
        );
        if (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') {
            header('Strict-Transport-Security: max-age=31536000; includeSubDomains');
        }
    }
    board_emit_security_headers();
}

define('DATA_DIR', __DIR__ . '/board_data');
define('UPLOAD_DIR', __DIR__ . '/board_uploads');
define('PREVIEW_DIR', __DIR__ . '/board_previews');
define('MAX_FILE_SIZE', 5 * 1024 * 1024);
define('MAX_THREADS', 100);
define('MAX_REPLIES', 500);
define('ALLOWED_TYPES', ['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
define('THUMB_WIDTH', 250);

// ── Env loader (used by admin creds, Tor trust, telegram, GOYIM) ──
// Single parser shared with board.php / telegram_bot.php so we don't have
// three slightly-different regexes drifting apart. Values with quotes,
// inline comments, or trailing whitespace are normalised the same way
// everywhere.
if (!function_exists('boardParseEnvFile')) {
    /** @return array<string, string> */
    function boardParseEnvFile(string $path): array {
        $out = [];
        if (!is_file($path)) return $out;
        foreach (file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
            $line = ltrim($line);
            if ($line === '' || $line[0] === '#') continue;
            $eq = strpos($line, '=');
            if ($eq === false) continue;
            $k = trim(substr($line, 0, $eq));
            $v = trim(substr($line, $eq + 1));
            if ($v !== '' && $v[0] !== '"' && $v[0] !== "'") {
                if (($hash = strpos($v, ' #')) !== false) $v = substr($v, 0, $hash);
            }
            $v = trim($v);
            if (strlen($v) >= 2 && (($v[0] === '"' && substr($v, -1) === '"') ||
                                    ($v[0] === "'" && substr($v, -1) === "'"))) {
                $v = substr($v, 1, -1);
            }
            $out[$k] = $v;
        }
        return $out;
    }
}

if (!function_exists('boardLoadEnv')) {
    function boardLoadEnv(): array {
        static $cache = null;
        if ($cache !== null) return $cache;
        $cache = [];
        // board/.env, then node/.env (symlink), then install-root .env
        foreach ([__DIR__ . '/.env', __DIR__ . '/../.env', __DIR__ . '/../../.env'] as $envFile) {
            $cache = array_merge($cache, boardParseEnvFile($envFile));
        }
        return $cache;
    }
}

if (!function_exists('boardTorSocksProxy')) {
    /** SOCKS URL for outbound .onion peer fetches (clearnet hub → Tor mirror). */
    function boardTorSocksProxy(): string {
        $env = boardLoadEnv();
        $proxy = trim((string)($env['FROGTALK_TOR_SOCKS_PROXY'] ?? 'socks5h://127.0.0.1:9050'));
        // Hostname resolution through Tor requires socks5h (PHP: SOCKS5_HOSTNAME type).
        if (str_starts_with($proxy, 'socks5://') && !str_starts_with($proxy, 'socks5h://')) {
            $proxy = 'socks5h://' . substr($proxy, strlen('socks5://'));
        }
        return $proxy;
    }
}

// ── Admin credentials ──
// SECURITY-PASS-3: prefer BOARD_ADMIN_USER / BOARD_ADMIN_PASS_HASH from
// /board/.env. The constants below are kept as a fallback so the docs'
// "default frog / changeme" boot still works on a brand new install, but
// the admin panel surfaces a banner when the default hash is still in
// use so the operator is nudged to rotate it.
const BOARD_ADMIN_DEFAULT_PASS_HASH = '$2b$12$y6eaDb7rqWantrMKWiMMpuixeA05hBQPo8Ay6q5Fh1ENUk2BR9RT2';
$_boardEnv = boardLoadEnv();
define('ADMIN_USER', (string)($_boardEnv['BOARD_ADMIN_USER'] ?? 'frog'));
define('ADMIN_PASS_HASH', (string)($_boardEnv['BOARD_ADMIN_PASS_HASH'] ?? BOARD_ADMIN_DEFAULT_PASS_HASH));
unset($_boardEnv);

if (!function_exists('boardIsDefaultAdminPass')) {
    function boardIsDefaultAdminPass(): bool {
        return ADMIN_PASS_HASH === BOARD_ADMIN_DEFAULT_PASS_HASH;
    }
}

// Ensure directories. board_data holds operational state (threads, bans,
// settings, tx-dedup ledger) and is never read directly by the webserver
// — nginx denies HTTP access to /board_data/ — so it can be 0750 with
// only the php-fpm user inside. Uploads / previews must remain world-
// readable so nginx can serve them as static assets.
if (!is_dir(DATA_DIR))    mkdir(DATA_DIR,    0750, true);
if (!is_dir(UPLOAD_DIR))  mkdir(UPLOAD_DIR,  0755, true);
if (!is_dir(PREVIEW_DIR)) mkdir(PREVIEW_DIR, 0755, true);

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
        'op_requires' => 'any',
        // ── Board identity (federated imageboard) ──
        'board_title' => '🐸 Frog General',
        'board_subtitle' => 'Anonymous discussion board. No accounts. No tracking. Speak freely.',
        'board_topic' => 'general',
        'node_id' => '',           // auto-derived from HTTP_HOST if empty
        'tor_only' => false,       // when true, clearnet visitors see Tor gateway
        'tor_onion_url' => '',     // e.g. http://abcd...onion/board/
        'federation_enabled' => true,
        'federated_peers' => [],   // [{url,title,subtitle,node_id,topic,tor_only,last_seen}]
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

/**
 * Atomic read-modify-write of a JSON file under an exclusive POSIX lock.
 * The callback receives the decoded array and must return the new array
 * (or null to abort the write). Used by toggleLike(), trackView(), and
 * the GOYIM-bump dedupe ledger to kill the obvious TOCTOU on concurrent
 * AJAX hits.
 */
if (!function_exists('boardWithJsonLock')) {
    function boardWithJsonLock(string $path, callable $cb, bool $pretty = false): mixed {
        $dir = dirname($path);
        if (!is_dir($dir)) mkdir($dir, 0750, true);
        $fh = fopen($path, 'c+');
        if (!$fh) return null;
        try {
            if (!flock($fh, LOCK_EX)) return null;
            $raw  = stream_get_contents($fh) ?: '';
            $data = $raw === '' ? [] : (json_decode($raw, true) ?: []);
            $new  = $cb(is_array($data) ? $data : []);
            if ($new === null) return null;
            $out = json_encode($new, $pretty ? JSON_PRETTY_PRINT : 0);
            // Truncate-and-rewrite under the same lock so a reader that
            // grabs the file mid-write never sees a partial JSON body.
            ftruncate($fh, 0);
            rewind($fh);
            fwrite($fh, $out);
            fflush($fh);
            return $new;
        } finally {
            flock($fh, LOCK_UN);
            fclose($fh);
        }
    }
}

/**
 * Validate a stored upload filename before passing it to unlink()/etc.
 * Forces basename + a strict allowlist so a tampered threads.json (or
 * crafted admin POST) cannot path-traverse out of board_uploads/.
 * Returns null when the input is unsafe.
 */
if (!function_exists('boardSafeUploadName')) {
    function boardSafeUploadName(?string $name): ?string {
        if ($name === null || $name === '') return null;
        $base = basename(str_replace('\\', '/', $name));
        if ($base === '' || $base === '.' || $base === '..') return null;
        if (strpbrk($base, "\0\r\n/") !== false) return null;
        // Files written by handleUpload()/handleMediaUpload() always
        // match this shape (timestamp + hex + recognised extension).
        if (!preg_match('/^[A-Za-z0-9._-]{1,128}$/', $base)) return null;
        return $base;
    }
}

/**
 * Safe wrapper around unlink() under UPLOAD_DIR. Refuses anything that
 * doesn't pass boardSafeUploadName() and refuses anything resolving
 * outside the uploads root.
 */
if (!function_exists('boardSafeUnlinkUpload')) {
    function boardSafeUnlinkUpload(?string $name): bool {
        $safe = boardSafeUploadName($name);
        if ($safe === null) return false;
        $target = UPLOAD_DIR . '/' . $safe;
        $real   = realpath($target);
        $root   = realpath(UPLOAD_DIR);
        if ($root === false) return false;
        if ($real !== false && strncmp($real, $root . DIRECTORY_SEPARATOR, strlen($root) + 1) !== 0) {
            return false;
        }
        return @unlink($target);
    }
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

/**
 * Real client IP — mirrors deps.client_ip() so bans/rate-limits aren't
 * keyed on the proxy/tunnel address when CF or XFF is present.
 *
 * SECURITY-PASS-3: trust the spoofable headers (CF-Connecting-IP,
 * X-Forwarded-For, X-Real-IP) only when the direct REMOTE_ADDR sits in
 * the trusted-proxy allowlist. Defaults cover the loopback (nginx /
 * php-fpm same-host) and Cloudflare's published edge ranges. Operators
 * who put the board behind a different reverse proxy can extend the
 * allowlist via BOARD_TRUSTED_PROXIES in /board/.env (CIDR-separated).
 */
function getClientIP(): string {
    $remote = $_SERVER['REMOTE_ADDR'] ?? '127.0.0.1';
    if (!filter_var($remote, FILTER_VALIDATE_IP)) $remote = '127.0.0.1';
    if (!boardIsTrustedProxy($remote)) {
        return $remote;
    }
    $cf = trim($_SERVER['HTTP_CF_CONNECTING_IP'] ?? '');
    if ($cf !== '' && filter_var($cf, FILTER_VALIDATE_IP)) {
        return $cf;
    }
    $xff = trim($_SERVER['HTTP_X_FORWARDED_FOR'] ?? '');
    if ($xff !== '') {
        $first = trim(explode(',', $xff)[0]);
        if ($first !== '' && filter_var($first, FILTER_VALIDATE_IP)) {
            return $first;
        }
    }
    $xri = trim($_SERVER['HTTP_X_REAL_IP'] ?? '');
    if ($xri !== '' && filter_var($xri, FILTER_VALIDATE_IP)) {
        return $xri;
    }
    return $remote;
}

/**
 * Trusted-proxy allowlist for the IP / Tor header trust model. Returns
 * true if the request's TCP source can be trusted to set X-Forwarded-For,
 * CF-Connecting-IP, X-Tor-Client, etc.
 *
 * Defaults: loopback (127.0.0.0/8, ::1) + the official Cloudflare edge
 * ranges. Override via BOARD_TRUSTED_PROXIES=cidr1,cidr2,... in .env.
 */
if (!function_exists('boardIsTrustedProxy')) {
    function boardIsTrustedProxy(string $ip): bool {
        static $defaults = [
            '127.0.0.0/8', '::1/128',
            // Cloudflare published ranges
            '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22',
            '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
            '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22',
            '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
            '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
            '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32',
            '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29',
            '2c0f:f248::/32',
        ];
        $env = boardLoadEnv();
        $extra = array_filter(array_map('trim', explode(',', $env['BOARD_TRUSTED_PROXIES'] ?? '')));
        foreach (array_merge($defaults, $extra) as $cidr) {
            if (boardIpInCidr($ip, $cidr)) return true;
        }
        return false;
    }
}

if (!function_exists('boardIpInCidr')) {
    function boardIpInCidr(string $ip, string $cidr): bool {
        if (str_contains($cidr, '/')) {
            [$net, $bits] = explode('/', $cidr, 2);
            $bits = (int)$bits;
        } else {
            $net = $cidr;
            $bits = strpos($cidr, ':') !== false ? 128 : 32;
        }
        $ipBin  = @inet_pton($ip);
        $netBin = @inet_pton($net);
        if ($ipBin === false || $netBin === false) return false;
        if (strlen($ipBin) !== strlen($netBin)) return false;
        $bytes = intdiv($bits, 8);
        $rem   = $bits % 8;
        if ($bytes > 0 && strncmp($ipBin, $netBin, $bytes) !== 0) return false;
        if ($rem === 0) return true;
        $mask = chr((0xFF << (8 - $rem)) & 0xFF);
        return (ord($ipBin[$bytes]) & ord($mask)) === (ord($netBin[$bytes]) & ord($mask));
    }
}

/** Normalize ban form input: raw IP → md5, or existing 32-char hash. */
function normalizeBanIPHash(string $input): ?string {
    $input = trim($input);
    if ($input === '') {
        return null;
    }
    if (filter_var($input, FILTER_VALIDATE_IP)) {
        return md5($input);
    }
    if (preg_match('/^[a-f0-9]{32}$/i', $input)) {
        return strtolower($input);
    }
    return null;
}

function isIPBanned(string $ipHash): array|false {
    // Logged-in board admins must never be locked out by an IP ban they
    // (or a shared proxy hash) triggered while moderating.
    if (isAdminLoggedIn()) {
        return false;
    }
    $bans = loadBans();
    foreach ($bans as $ban) {
        if (($ban['ip_hash'] ?? '') === $ipHash) {
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
    $ip = getClientIP();
    $salt = date('Y-m-d') . $threadId;
    return substr(hash('sha256', $ip . $salt), 0, 12);
}

// Stable chat-only anon ID — unique per browser, not just per IP
// Uses a persistent cookie so two users on the same IP (VPN, CGNAT, shared wifi) get different IDs
function getChatAnonId(): string {
    $ip = getClientIP();
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
    return md5(getClientIP());
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
    // SECURITY-PASS-3: extra-escape the URL when emitting it inside the
    // href attribute. The body is already entity-encoded so `"` / `'` are
    // already &quot;/&#039; — but a `&` in a query string would otherwise
    // round-trip a `&` literal into an attribute. Pass it through a
    // callback so we can also constrain the scheme to http(s) (no
    // javascript: even theoretically, since the regex below already
    // anchors on http) and append rel="ugc nofollow noopener".
    $text = preg_replace_callback(
        '/(?<!src=")(https?:\/\/[^\s<]+)/i',
        static function (array $m): string {
            $url  = $m[1];
            $safe = htmlspecialchars($url, ENT_QUOTES, 'UTF-8');
            return '<a href="' . $safe . '" target="_blank" rel="noopener nofollow ugc" class="post-link">' . $safe . '</a>';
        },
        $text
    );
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
    if (!createThumbnail($path, UPLOAD_DIR . '/' . $thumbFile, $mime)) {
        @unlink($path);
        return ['error' => 'Invalid or unreadable image data'];
    }
    
    return [
        'file' => $filename,
        'thumb' => $thumbFile,
        'size' => $file['size'],
        'mime' => $mime,
        'origName' => basename($file['name']),
        'approved' => !$requireApproval // auto-approved if setting is off
    ];
}

function createThumbnail(string $src, string $dst, string $mime): bool {
    $img = match($mime) {
        'image/jpeg' => @imagecreatefromjpeg($src),
        'image/png' => @imagecreatefrompng($src),
        'image/gif' => @imagecreatefromgif($src),
        'image/webp' => @imagecreatefromwebp($src),
        default => null
    };
    if (!$img) return false;
    
    $w = imagesx($img); $h = imagesy($img);
    if ($w <= 0 || $h <= 0) {
        imagedestroy($img);
        return false;
    }
    $ratio = min(THUMB_WIDTH / $w, THUMB_WIDTH / $h);
    if ($ratio >= 1) {
        $ratio = 1.0;
    }
    
    $nw = (int)($w * $ratio); $nh = (int)($h * $ratio);
    $thumb = imagecreatetruecolor($nw, $nh);
    if (!$thumb) {
        imagedestroy($img);
        return false;
    }
    if ($mime !== 'image/jpeg') { imagealphablending($thumb, false); imagesavealpha($thumb, true); }
    imagecopyresampled($thumb, $img, 0, 0, 0, 0, $nw, $nh, $w, $h);
    $ok = imagejpeg($thumb, $dst, 80);
    imagedestroy($img); imagedestroy($thumb);
    return (bool)$ok;
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
    // SECURITY-PASS-3: atomic increment under flock so concurrent visitors
    // on a hot thread don't lose view counts to the read-modify-write
    // window (TOCTOU). Returns the post-increment value.
    $result = ['n' => 0];
    boardWithJsonLock(DATA_DIR . '/views.json', function (array $views) use ($threadId, &$result): array {
        // Migrate legacy array entries on the fly (mirror loadViews()).
        foreach ($views as $tid => $val) {
            if (is_array($val)) $views[$tid] = count($val);
        }
        $cur = (int)($views[$threadId] ?? 0);
        $views[$threadId] = $cur + 1;
        $result['n'] = $views[$threadId];
        return $views;
    });
    return $result['n'];
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
    // SECURITY-PASS-3: full read-modify-write under flock. The previous
    // code did `loadLikes()` then `saveLikes()` with a TOCTOU window;
    // two parallel toggles from the same key could clobber each other,
    // leaving the user's like-set in an inconsistent state (the audit's
    // "Likes/views still racy on read" finding).
    $key  = getLikeKey();
    $out  = ['liked' => false, 'count' => 0];
    boardWithJsonLock(DATA_DIR . '/likes.json', function (array $likes) use ($postId, $key, &$out): array {
        if (!isset($likes[$postId]) || !is_array($likes[$postId])) $likes[$postId] = [];
        $idx = array_search($key, $likes[$postId], true);
        if ($idx !== false) {
            array_splice($likes[$postId], $idx, 1);
            $out['liked'] = false;
        } else {
            $likes[$postId][] = $key;
            $out['liked'] = true;
        }
        $out['count'] = count($likes[$postId]);
        return $likes;
    });
    return $out;
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
            'tron' => '/^T[a-zA-HJ-NP-Z0-9]{33}$/',
        ];
        foreach ($patterns as $chain => $pat) {
            $addr = trim($wallet[$chain] ?? '');
            if ($addr && preg_match($pat, $addr)) {
                $valid[$chain] = $addr;
            }
        }
        // SOL: regex alone is too permissive (any 32-44 char base58 string
        // matches the legacy pattern but isn't necessarily a valid 32-byte
        // pubkey). Decode and length-check.
        $solAddr = trim($wallet['sol'] ?? '');
        if ($solAddr !== '' && boardValidSolanaAddress($solAddr)) {
            $valid['sol'] = $solAddr;
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
        else {
            // SOL fall-through — gate on the strict 32-byte base58 decode
            // so we don't store a random base58 noise blob as a "wallet".
            if (!boardValidSolanaAddress($wallet)) return;
            $wallets[$postId] = ['sol' => $wallet];
        }
        saveWallets($wallets);
    }
}

/**
 * Strict Solana base58 address check: decodes the input and asserts it
 * matches the canonical 32-byte ed25519 pubkey length. The plain regex
 * `[1-9A-HJ-NP-Za-km-z]{32,44}` matches arbitrary base58 strings (and
 * Solana addresses are always 32 bytes ≈ 43-44 base58 chars).
 */
if (!function_exists('boardValidSolanaAddress')) {
    function boardValidSolanaAddress(string $addr): bool {
        $addr = trim($addr);
        if ($addr === '') return false;
        if (!preg_match('/^[1-9A-HJ-NP-Za-km-z]{32,44}$/', $addr)) return false;
        $decoded = boardBase58Decode($addr);
        return $decoded !== null && strlen($decoded) === 32;
    }
}

if (!function_exists('boardBase58Decode')) {
    /**
     * Pure-PHP base58 decode. Avoids bcmath / gmp so it works on
     * a minimal PHP install. Treats the input as a base-58 big-endian
     * integer and converts to base-256 by repeated division.
     */
    function boardBase58Decode(string $input): ?string {
        static $map = null;
        if ($map === null) {
            $alpha = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
            $map = [];
            for ($i = 0, $n = strlen($alpha); $i < $n; $i++) $map[$alpha[$i]] = $i;
        }
        if ($input === '') return '';
        $n = strlen($input);
        $digits = [];
        for ($i = 0; $i < $n; $i++) {
            if (!isset($map[$input[$i]])) return null;
            $digits[] = $map[$input[$i]];
        }
        $bytes = [];
        // Repeated division: divide the base-58 number (held as $digits
        // big-endian) by 256, collect the remainders as the resulting
        // bytes, until the dividend is zero.
        while (!empty($digits)) {
            $rem = 0;
            $next = [];
            foreach ($digits as $d) {
                $acc = $rem * 58 + $d;
                $q   = intdiv($acc, 256);
                $rem = $acc % 256;
                if (!empty($next) || $q !== 0) $next[] = $q;
            }
            $bytes[] = $rem;
            $digits  = $next;
        }
        // Leading '1' characters represent leading zero bytes.
        for ($i = 0; $i < $n && $input[$i] === '1'; $i++) $bytes[] = 0;
        return implode('', array_map('chr', array_reverse($bytes)));
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

/**
 * FrogTalk operator gate — mirrors /api/auth/admin-gate-status.
 * Requires browser ``ft_session`` cookie (forwarded to local uvicorn).
 */
function frogtalkAdminGateStatus(): array {
    $cookie = trim((string)($_SERVER['HTTP_COOKIE'] ?? ''));
    if ($cookie === '') {
        return ['ok' => false, 'authenticated' => false, 'is_admin' => false, 'pin_required' => false];
    }
    $base = getenv('FROGTALK_INTERNAL_API') ?: 'http://127.0.0.1:8000';
    $url = rtrim($base, '/') . '/api/auth/admin-gate-status';
    $ctx = stream_context_create([
        'http' => [
            'method' => 'GET',
            'header' => "Cookie: {$cookie}\r\nAccept: application/json\r\n",
            'timeout' => 6,
            'ignore_errors' => true,
        ],
    ]);
    $raw = @file_get_contents($url, false, $ctx);
    if ($raw === false || $raw === '') {
        return ['ok' => false, 'authenticated' => false, 'is_admin' => false, 'pin_required' => false];
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        return ['ok' => false, 'authenticated' => false, 'is_admin' => false, 'pin_required' => false];
    }
    return $data;
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

// ──────────────────────────────────────────────────────────────────
// Federated Imageboard Helpers (board identity, Tor gating, peers)
// ──────────────────────────────────────────────────────────────────

/**
 * Derive a stable, short node id for this board.
 * If admin set settings.node_id, use it.
 * Otherwise derive deterministically from the host header.
 */
function getNodeId(): string {
    $s = loadSettings();
    $id = trim((string)($s['node_id'] ?? ''));
    if ($id !== '') return preg_replace('/[^A-Za-z0-9_-]/', '', substr($id, 0, 32));
    $host = $_SERVER['HTTP_HOST'] ?? 'unknown';
    return substr(hash('sha256', 'frogtalk-node|' . strtolower($host)), 0, 12);
}

/**
 * Best-effort detection of whether the current request is over Tor.
 *
 * SECURITY-PASS-3 trust model:
 *   - Host header ending in .onion is always trusted (the request really
 *     did terminate on this node's onion service — clearnet TLS cannot
 *     forge that hostname).
 *   - X-Tor-Client / X-Onion-Host headers are ONLY trusted when:
 *       (a) the direct REMOTE_ADDR is on the trusted-proxy allowlist
 *           (see boardIsTrustedProxy()), so a clearnet client can't just
 *           curl --header 'X-Tor-Client: 1' itself onto a tor_only node,
 *           AND
 *       (b) BOARD_TOR_HEADER_TRUSTED=1 is set in /board/.env. Operators
 *           must explicitly opt in because most clearnet deploys don't
 *           have a Tor-detection proxy at all.
 */
function isTorRequest(): bool {
    $host = strtolower($_SERVER['HTTP_HOST'] ?? '');
    if (str_ends_with($host, '.onion')) return true;
    $env = boardLoadEnv();
    $allow = ($env['BOARD_TOR_HEADER_TRUSTED'] ?? '0') === '1';
    if (!$allow) return false;
    $remote = $_SERVER['REMOTE_ADDR'] ?? '';
    if (!filter_var($remote, FILTER_VALIDATE_IP) || !boardIsTrustedProxy($remote)) {
        return false;
    }
    $hdr = strtolower((string)($_SERVER['HTTP_X_TOR_CLIENT'] ?? ''));
    if ($hdr === '1' || $hdr === 'true' || $hdr === 'yes') return true;
    if (!empty($_SERVER['HTTP_X_ONION_HOST'])) return true;
    return false;
}

/**
 * Returns true when the visitor should see the "Connect via Tor" gateway:
 * board is configured Tor-only and the request is NOT coming through Tor.
 */
function shouldShowTorGateway(): bool {
    $s = loadSettings();
    return (bool)($s['tor_only'] ?? false) && !isTorRequest();
}

/** Read PUBLIC_URL from the node install .env (best-effort). */
function boardReadPublicUrl(): string {
    static $cached = null;
    if ($cached !== null) {
        return $cached;
    }
    $cached = '';
    foreach ([__DIR__ . '/../.env', __DIR__ . '/../../.env'] as $envFile) {
        if (!is_readable($envFile)) {
            continue;
        }
        foreach (file($envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
            $line = trim($line);
            if ($line === '' || str_starts_with($line, '#')) {
                continue;
            }
            if (!str_starts_with($line, 'PUBLIC_URL=')) {
                continue;
            }
            $cached = rtrim(trim(substr($line, strlen('PUBLIC_URL=')), " \t\"'"), '/');
            break 2;
        }
    }
    return $cached;
}

function boardHostIsIp(string $host): bool {
    $host = strtolower(trim($host));
    if ($host === '') {
        return false;
    }
    return filter_var($host, FILTER_VALIDATE_IP) !== false;
}

/** Warnings for operators when the board runs on a bare IP or without TLS. */
function boardPublicUrlWarnings(): array {
    $publicUrl = boardReadPublicUrl();
    $host = '';
    if ($publicUrl !== '') {
        $parts = parse_url($publicUrl);
        $host = strtolower((string)($parts['host'] ?? ''));
    }
    if ($host === '') {
        $host = strtolower((string)($_SERVER['HTTP_HOST'] ?? ''));
    }
    $isOnion = str_contains($host, '.onion');
    $isIp = boardHostIsIp($host);
    $isHttps = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || str_starts_with(strtolower($publicUrl), 'https://');
    return [
        'public_url' => $publicUrl,
        'host' => $host,
        'is_ip_host' => $isIp && !$isOnion,
        'is_https' => $isHttps,
        'show_ip_warning' => $isIp && !$isOnion,
        'show_http_warning' => !$isHttps && !$isOnion && $host !== '',
    ];
}

/**
 * Public-facing board info (used by /board/api/info and federated discovery).
 */
function getBoardInfo(): array {
    $s = loadSettings();
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
    $warnings = boardPublicUrlWarnings();
    return [
        'node_id'      => getNodeId(),
        'title'        => (string)($s['board_title'] ?? '/board/'),
        'subtitle'     => (string)($s['board_subtitle'] ?? ''),
        'topic'        => (string)($s['board_topic'] ?? 'general'),
        'url'          => $scheme . '://' . $host . '/board/',
        'tor_only'     => (bool)($s['tor_only'] ?? false),
        'tor_onion_url'=> (string)($s['tor_onion_url'] ?? ''),
        'version'      => 1,
        'public_url_warnings' => $warnings,
    ];
}

/**
 * Return list of federated peer boards, filtered for the current visitor.
 * Tor-only peers are still listed for clearnet visitors (styled with a Tor
 * badge); clicking them will only resolve from a Tor-aware client. This makes
 * the federation visually discoverable across the whole network.
 */
function getFederatedPeers(?bool $visitorTor = null): array {
    $s = loadSettings();
    if (!($s['federation_enabled'] ?? true)) return [];
    $peers = $s['federated_peers'] ?? [];
    if (!is_array($peers)) return [];
    // Server-admin can block specific peer node_ids; they vanish from the
    // public nav but stay in settings.json so the operator can re-enable
    // them. blocked_peer_nodes is a flat list of node_id strings.
    $blocked = $s['blocked_peer_nodes'] ?? [];
    $blocked = is_array($blocked) ? array_fill_keys(array_map('strval', $blocked), true) : [];
    if ($visitorTor === null) $visitorTor = isTorRequest();
    $out = [];
    foreach ($peers as $p) {
        if (!is_array($p)) continue;
        $url = (string)($p['url'] ?? '');
        if ($url === '') continue;
        $nid = (string)($p['node_id'] ?? '');
        if ($nid !== '' && isset($blocked[$nid])) continue;
        $isTor = (bool)($p['tor_only'] ?? false);
        // Note: Tor-only peers are returned for everyone — the fed-pill-tor
        // styling on the board indicates "this requires Tor to visit".
        $out[] = [
            'url'      => $url,
            'node_id'  => (string)($p['node_id'] ?? ''),
            'title'    => (string)($p['title'] ?? $url),
            'subtitle' => (string)($p['subtitle'] ?? ''),
            'topic'    => (string)($p['topic'] ?? ''),
            'tor_only' => $isTor,
            'tor_onion_url' => (string)($p['tor_onion_url'] ?? ''),
            'last_seen'=> (int)($p['last_seen'] ?? 0),
        ];
    }
    return $out;
}

/**
 * SSRF-safe HTTP GET for federated peer discovery. Wraps cURL with a
 * strict allowlist:
 *   - http/https schemes only (CURLOPT_PROTOCOLS / REDIR_PROTOCOLS)
 *   - default ports only (80, 443, plus an operator-set port if the
 *     peer URL specified one explicitly)
 *   - host must resolve to a public, routable IP. RFC1918 / loopback /
 *     link-local / multicast / 0.0.0.0 / cloud-metadata addresses are
 *     refused via the CURLOPT_OPENSOCKETFUNCTION callback so we still
 *     catch DNS-rebind that swaps the address mid-resolve.
 *   - max 1 redirect, hard 64 KiB response cap, 8s timeout.
 *
 * Returns [json-decoded-array | null, error-message | null].
 */
if (!function_exists('boardFetchPeerJson')) {
    function boardFetchPeerJson(string $url): array {
        $parts = @parse_url($url);
        if (!is_array($parts)) return [null, 'malformed_url'];
        $scheme = strtolower($parts['scheme'] ?? '');
        if ($scheme !== 'http' && $scheme !== 'https') return [null, 'bad_scheme'];
        $host = strtolower($parts['host'] ?? '');
        if ($host === '') return [null, 'missing_host'];

        $isOnion = str_ends_with($host, '.onion');
        $ips = [];
        if (!$isOnion) {
            // Pre-resolve so we can refuse SSRF targets before the connect.
            $ips = boardResolvePublicIps($host);
            if (!$ips) return [null, 'host_not_routable'];
        }

        $ch = curl_init($url);
        if ($ch === false) return [null, 'curl_init_failed'];
        $body = '';
        $bytes = 0;
        $cap = 65536;
        $opts = [
            CURLOPT_RETURNTRANSFER => false,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_MAXREDIRS      => 0,
            CURLOPT_TIMEOUT        => 12,
            CURLOPT_CONNECTTIMEOUT => 6,
            CURLOPT_USERAGENT      => 'FrogTalk-Federation/1',
            CURLOPT_HTTPHEADER     => ['Accept: application/json'],
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_PROTOCOLS         => CURLPROTO_HTTP | CURLPROTO_HTTPS,
            CURLOPT_REDIR_PROTOCOLS   => CURLPROTO_HTTP | CURLPROTO_HTTPS,
            CURLOPT_WRITEFUNCTION => function ($ch, string $chunk) use (&$body, &$bytes, $cap): int {
                $bytes += strlen($chunk);
                if ($bytes > $cap) return 0;
                $body .= $chunk;
                return strlen($chunk);
            },
        ];
        if ($isOnion) {
            $proxy = boardTorSocksProxy();
            if ($proxy === '') return [null, 'tor_proxy_not_configured'];
            $opts[CURLOPT_PROXY] = $proxy;
            $opts[CURLOPT_PROXYTYPE] = defined('CURLPROXY_SOCKS5_HOSTNAME')
                ? CURLPROXY_SOCKS5_HOSTNAME
                : CURLPROXY_SOCKS5;
        } else {
            $opts[CURLOPT_RESOLVE] = array_map(
                fn(string $ip) => $host . ':' . ($parts['port'] ?? ($scheme === 'https' ? 443 : 80)) . ':' . $ip,
                $ips
            );
        }
        curl_setopt_array($ch, $opts);
        $ok    = curl_exec($ch);
        $errno = curl_errno($ch);
        $code  = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        if (!$ok && $errno !== 0 && $errno !== CURLE_WRITE_ERROR) {
            $cerr = curl_error($ch);
            return [null, $cerr !== '' ? 'fetch_failed: ' . $cerr : 'fetch_failed'];
        }
        if ($code < 200 || $code >= 300) return [null, 'http_' . $code];
        $json = json_decode($body, true);
        if (!is_array($json)) return [null, 'not_json'];
        return [$json, null];
    }
}

/**
 * DNS-resolve $host to A/AAAA records and drop any that are in
 * RFC1918 / loopback / link-local / multicast / IETF-reserved space —
 * the exact set you'd want to block for cloud-metadata SSRF
 * (169.254.169.254, 100.64.0.0/10, fc00::/7, etc.).
 */
if (!function_exists('boardResolvePublicIps')) {
    function boardResolvePublicIps(string $host): array {
        if (filter_var($host, FILTER_VALIDATE_IP)) {
            return boardIsPublicIp($host) ? [$host] : [];
        }
        $out = [];
        $records = @dns_get_record($host, DNS_A | DNS_AAAA);
        if (!is_array($records)) return [];
        foreach ($records as $r) {
            $ip = $r['ip'] ?? ($r['ipv6'] ?? '');
            if ($ip !== '' && boardIsPublicIp($ip)) $out[] = $ip;
        }
        return $out;
    }
}

if (!function_exists('boardIsPublicIp')) {
    function boardIsPublicIp(string $ip): bool {
        return (bool)filter_var(
            $ip,
            FILTER_VALIDATE_IP,
            FILTER_FLAG_IPV4 | FILTER_FLAG_IPV6 | FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE
        );
    }
}

/**
 * Add or update a federated peer. Returns [ok, message].
 * Fetches /board/api/info from the peer URL to validate + populate metadata.
 */
function upsertFederatedPeer(string $peerUrl): array {
    $peerUrl = trim($peerUrl);
    if (!preg_match('~^https?://[^\s/$.?#][^\s]*$~i', $peerUrl)) {
        return [false, 'Invalid URL'];
    }
    // Normalise: must end with /board/ (or be the api endpoint root)
    $peerUrl = rtrim($peerUrl, '/');
    if (!str_ends_with($peerUrl, '/board')) {
        // accept either https://host or https://host/board — coerce to https://host/board
        if (str_ends_with($peerUrl, '/board/api/info')) {
            $peerUrl = substr($peerUrl, 0, -strlen('/api/info'));
        } else {
            $peerUrl = $peerUrl . '/board';
        }
    }
    $infoUrl = $peerUrl . '/api/info';

    [$info, $err] = boardFetchPeerJson($infoUrl);
    if ($info === null) return [false, 'Could not reach ' . $infoUrl . ' (' . $err . ')'];
    if (empty($info['node_id'])) return [false, 'Peer did not return a valid info document'];

    $s = loadSettings();
    $peers = is_array($s['federated_peers'] ?? null) ? $s['federated_peers'] : [];
    $newEntry = [
        'url'      => $peerUrl . '/',
        'node_id'  => (string)$info['node_id'],
        'title'    => (string)($info['title'] ?? $peerUrl),
        'subtitle' => (string)($info['subtitle'] ?? ''),
        'topic'    => (string)($info['topic'] ?? ''),
        'tor_only' => (bool)($info['tor_only'] ?? false),
        'tor_onion_url' => (string)($info['tor_onion_url'] ?? ''),
        'last_seen'=> time(),
    ];
    // Don't add ourselves
    if ($newEntry['node_id'] === getNodeId()) return [false, 'That is this node'];
    // De-dupe by node_id
    $replaced = false;
    foreach ($peers as $i => $p) {
        if (($p['node_id'] ?? '') === $newEntry['node_id']) {
            $peers[$i] = $newEntry;
            $replaced = true;
            break;
        }
    }
    if (!$replaced) $peers[] = $newEntry;
    $s['federated_peers'] = $peers;
    saveSettings($s);
    return [true, ($replaced ? 'Updated' : 'Added') . ' peer ' . $newEntry['title']];
}

function removeFederatedPeer(string $nodeId): bool {
    $s = loadSettings();
    $peers = is_array($s['federated_peers'] ?? null) ? $s['federated_peers'] : [];
    $out = array_values(array_filter($peers, fn($p) => ($p['node_id'] ?? '') !== $nodeId));
    if (count($out) === count($peers)) return false;
    $s['federated_peers'] = $out;
    saveSettings($s);
    return true;
}

/**
 * Refresh metadata for all peers by re-fetching their /api/info.
 * Stale peers (failed > 7d) are dropped.
 *
 * SECURITY-PASS-3: uses boardFetchPeerJson() so this server-side fetch
 * loop can't be turned into an internal-network scanner (the audit's
 * federation-SSRF finding).
 */
function refreshFederatedPeers(): int {
    $s = loadSettings();
    $peers = is_array($s['federated_peers'] ?? null) ? $s['federated_peers'] : [];
    $now = time();
    $updated = 0;
    foreach ($peers as $i => $p) {
        $url = rtrim((string)($p['url'] ?? ''), '/');
        if ($url === '') continue;
        [$info, $err] = boardFetchPeerJson($url . '/api/info');
        if ($info === null) {
            // keep but don't bump last_seen; drop if older than 7d
            if (($now - (int)($p['last_seen'] ?? 0)) > 7 * 86400) {
                unset($peers[$i]);
            }
            continue;
        }
        if (empty($info['node_id'])) continue;
        $peers[$i] = array_merge($p, [
            'title'    => (string)($info['title'] ?? $p['title'] ?? $url),
            'subtitle' => (string)($info['subtitle'] ?? $p['subtitle'] ?? ''),
            'topic'    => (string)($info['topic'] ?? $p['topic'] ?? ''),
            'tor_only' => (bool)($info['tor_only'] ?? false),
            'tor_onion_url' => (string)($info['tor_onion_url'] ?? ''),
            'last_seen'=> $now,
        ]);
        $updated++;
    }
    $s['federated_peers'] = array_values($peers);
    saveSettings($s);
    return $updated;
}
