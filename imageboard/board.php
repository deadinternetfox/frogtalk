<?php
/**
 * FrogTalk — Frog Channel — Anonymous Image Board
 * Features: 4chan-style posting, image approval, live chat, YouTube embeds,
 *           greentext, threaded replies, per-thread OG preview images
 */
// Force fresh HTML for WebView/Android/Electron clients that aggressively
// cache the board shell. Static assets (CSS/JS/images) are still cached by
// nginx; only this PHP page is forced no-store.
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');
header('Expires: 0');
session_start();
require_once __DIR__ . '/board_config.php';

// ═══ $GOYIM Board Config (from .env) ═══
(function() {
    $ev = __DIR__ . '/.env';
    $cfg = [
        'GOYIM_TOKEN_CONTRACT' => '',
        'GOYIM_TREASURY'       => '',      // Solana wallet address to receive bumps
        'GOYIM_ADMIN_WALLET'   => '',      // Solana wallet that can boost for free
        'GOYIM_BUMP_WEIGHT'    => '3600',  // seconds per 1000 GOYIM tipped
        'GOYIM_MIN_TOKENS'     => '1',     // minimum $GOYIM to show holder badge
    ];
    if (file_exists($ev)) {
        foreach (file($ev, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $l) {
            if (str_starts_with(ltrim($l), '#')) continue;
            [$k, $v] = array_pad(explode('=', $l, 2), 2, '');
            $k = trim($k); $v = trim($v, " \t\n\r\0\x0B\"'");
            if (array_key_exists($k, $cfg)) $cfg[$k] = $v;
        }
    }
    $ca = ($cfg['GOYIM_TOKEN_CONTRACT'] === 'PLACEHOLDER_NOT_DEPLOYED_YET') ? '' : $cfg['GOYIM_TOKEN_CONTRACT'];
    define('BOARD_GOYIM_CA',           $ca);
    define('BOARD_GOYIM_TREASURY',     $cfg['GOYIM_TREASURY']);
    define('BOARD_GOYIM_ADMIN_WALLET', $cfg['GOYIM_ADMIN_WALLET']);
    define('BOARD_GOYIM_MIN_TOKENS',   (float)($cfg['GOYIM_MIN_TOKENS'] ?: 1));
    define('BOARD_GOYIM_BUMP_WEIGHT',  (int)($cfg['GOYIM_BUMP_WEIGHT'] ?: 3600));
})();

$settings = loadSettings();
$ipHash = getIPHash();

// Check if user is banned
$ban = isIPBanned($ipHash);
$isBanned = $ban !== false;

// Rate limiting
function checkRateLimit(): bool {
    $settings = loadSettings();
    $now = time();
    $key = 'last_post_time';
    $limit = $settings['rate_limit_seconds'] ?? 15;
    if (isset($_SESSION[$key]) && ($now - $_SESSION[$key]) < $limit) {
        return false;
    }
    $_SESSION[$key] = $now;
    return true;
}

// Auto-ban word check
function checkBanWords(string $text): bool {
    $settings = loadSettings();
    $words = array_filter(array_map('trim', explode(',', $settings['auto_ban_words'] ?? '')));
    foreach ($words as $word) {
        if (!empty($word) && stripos($text, $word) !== false) return true;
    }
    return false;
}

// ═══ TEMP UPLOAD (preview before posting) — must be before main POST handler to bypass rate limit ═══
if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_GET['action'] ?? '') === 'temp_upload') {
    header('Content-Type: application/json');
    $tempDir = UPLOAD_DIR . '/temp';
    if (!is_dir($tempDir)) mkdir($tempDir, 0755, true);
    foreach (glob($tempDir . '/*') ?: [] as $tf) {
        if (is_file($tf) && filemtime($tf) < time() - 3600) @unlink($tf);
    }
    if (empty($_FILES['file']) || $_FILES['file']['error'] !== UPLOAD_ERR_OK) {
        echo json_encode(['error' => 'Upload error']);
        exit;
    }
    $tf = $_FILES['file'];
    $maxBytes = (int)(($settings['max_media_size_mb'] ?? 100)) * 1024 * 1024;
    if ($tf['size'] > $maxBytes) { echo json_encode(['error' => 'Too large']); exit; }
    $finfo = finfo_open(FILEINFO_MIME_TYPE);
    $mime  = finfo_file($finfo, $tf['tmp_name']);
    finfo_close($finfo);
    $allowed = array_merge(MEDIA_ALLOWED_TYPES, ALLOWED_TYPES);
    if (!in_array($mime, $allowed)) { echo json_encode(['error' => 'Unsupported type']); exit; }
    $ext  = preg_replace('/[^a-z0-9]/i', '', pathinfo($tf['name'] ?? 'file', PATHINFO_EXTENSION)) ?: 'bin';
    $name = 'tmp_' . time() . '_' . bin2hex(random_bytes(8)) . '.' . $ext;
    if (!move_uploaded_file($tf['tmp_name'], $tempDir . '/' . $name)) {
        echo json_encode(['error' => 'Save failed']);
        exit;
    }
    echo json_encode(['url' => '/board_uploads/temp/' . $name]);
    exit;
}

// Handle POST
$error = '';
if ($_SERVER['REQUEST_METHOD'] === 'POST' && !$isBanned && !$settings['board_locked']) {
    $action = $_POST['action'] ?? '';
    
    // CSRF protection for form submissions (not AJAX — those use rate limiting)
    if (in_array($action, ['new_thread', 'reply']) && !verifyCsrfToken($_POST['csrf_token'] ?? null)) {
        $error = 'Session expired. Please refresh and try again.';
    } elseif (!checkRateLimit()) {
        $error = 'Slow down. Wait ' . ($settings['rate_limit_seconds'] ?? 15) . ' seconds between posts.';
    } else {
        $requireApproval       = $settings['require_image_approval'] ?? false;
        $requireAudioApproval  = $settings['require_audio_approval'] ?? false;
        $requireVideoApproval  = $settings['require_video_approval'] ?? true;
        // Admin posts bypass the moderation queue entirely
        if (isAdminLoggedIn()) { $requireApproval = false; $requireAudioApproval = false; $requireVideoApproval = false; }
        
        if ($action === 'new_thread') {
            $subject = trim($_POST['subject'] ?? '');
            $comment = trim($_POST['comment'] ?? '');
            $opRequires = $settings['op_requires'] ?? 'any';
            $_opHasComment = !empty($comment);
            $_opHasImage   = !empty($_FILES['images']['name'][0] ?? '');
            $_opHasMedia   = !empty($_FILES['media']['name'] ?? '');
            if ($opRequires === 'comment' && !$_opHasComment) {
                $error = 'New threads must include a comment.';
            } elseif ($opRequires === 'image' && !$_opHasImage) {
                $error = 'New threads must include an image.';
            } elseif ($opRequires === 'image_or_media' && !$_opHasImage && !$_opHasMedia) {
                $error = 'New threads must include an image or voice/video note.';
            } elseif ($opRequires === 'comment_and_image' && (!$_opHasComment || !$_opHasImage)) {
                $error = !$_opHasComment ? 'New threads must include a comment.' : 'New threads must include an image.';
            } elseif (!$_opHasComment && !$_opHasImage && !$_opHasMedia) {
                $error = 'Post must have a comment, image, or voice/video note.';
            } elseif (checkBanWords($comment . ' ' . $subject)) {
                $error = 'Your post contains blocked content.';
            } else {
                $threads = loadThreads();
                $postId = generatePostId();
                
                $imagesData = [];
                $imageData  = null;
                if (!empty($_FILES['images']['name'][0] ?? '')) {
                    if (!($settings['allow_images'] ?? true)) {
                        $error = 'Image uploads are currently disabled.';
                    } else {
                        $fileCount = count($_FILES['images']['name']);
                        for ($fi = 0; $fi < min($fileCount, 5); $fi++) {
                            if (empty($_FILES['images']['name'][$fi]) || $_FILES['images']['error'][$fi] !== UPLOAD_ERR_OK) continue;
                            $singleFile = [
                                'name'     => $_FILES['images']['name'][$fi],
                                'type'     => $_FILES['images']['type'][$fi],
                                'tmp_name' => $_FILES['images']['tmp_name'][$fi],
                                'error'    => $_FILES['images']['error'][$fi],
                                'size'     => $_FILES['images']['size'][$fi],
                            ];
                            $uploaded = handleUpload($singleFile, $requireApproval);
                            if (isset($uploaded['error'])) { $error = $uploaded['error']; $imagesData = []; break; }
                            $imagesData[] = $uploaded;
                        }
                        $imageData = $imagesData[0] ?? null;
                    }
                }

                $mediaData = null;
                if (empty($error) && !empty($_FILES['media']['name'] ?? '')) {
                    $mimeType = $_FILES['media']['type'] ?? '';
                    $mediaExt = strtolower(pathinfo($_FILES['media']['name'], PATHINFO_EXTENSION));
                    $isAudioUpload = (strpos($mimeType,'audio/') === 0) || in_array($mediaExt,['mp3','ogg','wav','flac','aac','m4a']);
                    $isVideoUpload = (strpos($mimeType,'video/') === 0) || in_array($mediaExt,['mp4','mov','avi','mkv']);
                    if ($isAudioUpload && !($settings['allow_audio'] ?? true)) {
                        $error = 'Audio uploads are currently disabled.';
                    } elseif ($isVideoUpload && !($settings['allow_video'] ?? true)) {
                        $error = 'Video uploads are currently disabled.';
                    } else {
                        $requireThisApproval = $isAudioUpload ? $requireAudioApproval : $requireVideoApproval;
                        $mediaData = handleMediaUpload($_FILES['media'], $requireThisApproval, (int)($settings['max_media_size_mb'] ?? 100));
                        if (isset($mediaData['error'])) { $error = $mediaData['error']; $mediaData = null; }
                    }
                }
                
                if (empty($error)) {
                    $walletData = [
                        'eth'  => trim($_POST['wallet_eth'] ?? $_POST['wallet_address'] ?? ''),
                        'btc'  => trim($_POST['wallet_btc'] ?? ''),
                        'sol'  => trim($_POST['wallet_sol'] ?? ''),
                        'tron' => trim($_POST['wallet_tron'] ?? ''),
                    ];
                    $thread = [
                        'id' => $postId,
                        'subject' => htmlspecialchars($subject, ENT_QUOTES, 'UTF-8'),
                        'comment' => $comment,
                        'image' => $imageData,
                        'images' => $imagesData,
                        'media' => $mediaData,
                        'time' => time(),
                        'anonId' => getAnonId($postId),
                        'ip_hash' => $ipHash,
                        'replies' => [],
                        'bump' => time(),
                        'sticky' => false,
                        'locked' => false,
                        'capcode' => isAdminLoggedIn() ? 'admin' : null
                    ];
                    $hasAny = array_filter($walletData, fn($v) => $v !== '');
                    if (!empty($hasAny)) {
                        linkWalletToPost($postId, $walletData);
                    }
                    // Flag $GOYIM holder status on post when SOL wallet provided
                    if ($walletData['sol'] && BOARD_GOYIM_CA) {
                        $holderInfo = checkGoyimHolder($walletData['sol']);
                        $thread['is_holder']      = $holderInfo['holder'];
                        $thread['goyim_balance']  = $holderInfo['balance'];
                    }
                    
                    array_unshift($threads, $thread);
                    if (count($threads) > MAX_THREADS) {
                        // Preserve view counts from threads about to be pruned
                        $prunedSlice = array_slice($threads, MAX_THREADS);
                        $allViews = loadViews();
                        $pruneViewOffset = 0;
                        foreach ($prunedSlice as $pt) {
                            $pruneViewOffset += (int)($allViews[$pt['id']] ?? 0);
                        }
                        if ($pruneViewOffset > 0) {
                            $s = loadSettings();
                            $s['views_lifetime'] = ($s['views_lifetime'] ?? 0) + $pruneViewOffset;
                            saveSettings($s);
                        }
                        $threads = array_slice($threads, 0, MAX_THREADS);
                    }
                    
                    saveThreads($threads);
                    // Clear preview cache
                    @unlink(PREVIEW_DIR . '/og_' . $postId . '.png');
                    
                    // Notify Telegram about new thread
                    try {
                        require_once __DIR__ . '/telegram_bot.php';
                        $tgBot = new PeasantHuntTelegramBot();
                        if ($tgBot->isConfigured()) {
                            $sent = $tgBot->sendNewThreadNotification(
                                $subject ?: 'New Thread',
                                $comment,
                                $postId,
                                count($threads),
                                $imageData
                            );
                            error_log('Telegram thread notification ' . ($sent ? 'SENT' : 'FAILED') . " for thread {$postId}");
                        } else {
                            error_log('Telegram bot not configured — CHAT_ID or TOKEN missing from .env');
                        }
                    } catch (Throwable $e) {
                        error_log('Telegram thread notification error: ' . $e->getMessage());
                    }
                    
                    header('Location: /board?thread=' . $postId . '&post=' . $postId . '#p' . $postId);
                    exit;
                }
            }
        } elseif ($action === 'reply') {
            $threadId = $_POST['thread_id'] ?? '';
            $comment = trim($_POST['comment'] ?? '');
            
            if (empty($comment) && empty($_FILES['images']['name'][0] ?? '') && empty($_FILES['media']['name'] ?? '')) {
                $error = 'Reply must have a comment, image, or voice/video note.';
            } elseif (checkBanWords($comment)) {
                $error = 'Your post contains blocked content.';
            } else {
                $threads = loadThreads();
                $found = false;
                
                foreach ($threads as &$thread) {
                    if ($thread['id'] === $threadId) {
                        $found = true;
                        
                        if ($thread['locked'] ?? false) {
                            $error = 'This thread is locked.';
                            break;
                        }
                        
                        $postId = generatePostId();
                        $imagesData = [];
                        $imageData  = null;
                        if (!empty($_FILES['images']['name'][0] ?? '')) {
                            if (!($settings['allow_images'] ?? true)) {
                                $error = 'Image uploads are currently disabled.';
                            } else {
                                $fileCount = count($_FILES['images']['name']);
                                for ($fi = 0; $fi < min($fileCount, 5); $fi++) {
                                    if (empty($_FILES['images']['name'][$fi]) || $_FILES['images']['error'][$fi] !== UPLOAD_ERR_OK) continue;
                                    $singleFile = [
                                        'name'     => $_FILES['images']['name'][$fi],
                                        'type'     => $_FILES['images']['type'][$fi],
                                        'tmp_name' => $_FILES['images']['tmp_name'][$fi],
                                        'error'    => $_FILES['images']['error'][$fi],
                                        'size'     => $_FILES['images']['size'][$fi],
                                    ];
                                    $uploaded = handleUpload($singleFile, $requireApproval);
                                    if (isset($uploaded['error'])) { $error = $uploaded['error']; $imagesData = []; break; }
                                    $imagesData[] = $uploaded;
                                }
                                $imageData = $imagesData[0] ?? null;
                            }
                        }

                        $mediaData = null;
                        if (empty($error) && !empty($_FILES['media']['name'] ?? '')) {
                            $mimeType = $_FILES['media']['type'] ?? '';
                            $mediaExt = strtolower(pathinfo($_FILES['media']['name'], PATHINFO_EXTENSION));
                            $isAudioUpload = (strpos($mimeType,'audio/') === 0) || in_array($mediaExt,['mp3','ogg','wav','flac','aac','m4a']);
                            $isVideoUpload = (strpos($mimeType,'video/') === 0) || in_array($mediaExt,['mp4','mov','avi','mkv']);
                            if ($isAudioUpload && !($settings['allow_audio'] ?? true)) {
                                $error = 'Audio uploads are currently disabled.';
                            } elseif ($isVideoUpload && !($settings['allow_video'] ?? true)) {
                                $error = 'Video uploads are currently disabled.';
                            } else {
                                $requireThisApproval = $isAudioUpload ? $requireAudioApproval : $requireVideoApproval;
                                $mediaData = handleMediaUpload($_FILES['media'], $requireThisApproval, (int)($settings['max_media_size_mb'] ?? 100));
                                if (isset($mediaData['error'])) { $error = $mediaData['error']; $mediaData = null; }
                            }
                        }
                        
                        if (empty($error)) {
                            if (count($thread['replies']) >= MAX_REPLIES) {
                                $error = 'Thread reply limit reached.';
                            } else {
                                $walletData = [
                                    'eth'  => trim($_POST['wallet_eth'] ?? $_POST['wallet_address'] ?? ''),
                                    'btc'  => trim($_POST['wallet_btc'] ?? ''),
                                    'sol'  => trim($_POST['wallet_sol'] ?? ''),
                                    'tron' => trim($_POST['wallet_tron'] ?? ''),
                                ];
                                $reply = [
                                    'id' => $postId,
                                    'comment' => $comment,
                                    'image' => $imageData,
                                    'images' => $imagesData,
                                    'media' => $mediaData,
                                    'time' => time(),
                                    'anonId' => getAnonId($threadId),
                                    'ip_hash' => $ipHash,
                                    'capcode' => isAdminLoggedIn() ? 'admin' : null
                                ];
                                $hasAny = array_filter($walletData, fn($v) => $v !== '');
                                if (!empty($hasAny)) {
                                    linkWalletToPost($postId, $walletData);
                                }
                                // Flag $GOYIM holder status on reply when SOL wallet provided
                                if ($walletData['sol'] && BOARD_GOYIM_CA) {
                                    $holderInfo = checkGoyimHolder($walletData['sol']);
                                    $reply['is_holder']     = $holderInfo['holder'];
                                    $reply['goyim_balance'] = $holderInfo['balance'];
                                }
                                $thread['replies'][] = $reply;
                                if (stripos($comment, '#sage') === false) {
                                    $thread['bump'] = time();
                                }
                                
                                // Sort: stickies first, then by engagement-weighted score
                                $sortLikes = loadLikes();
                                usort($threads, function($a, $b) use ($sortLikes) {
                                    $aSticky = (bool)($a['sticky'] ?? false);
                                    $bSticky = (bool)($b['sticky'] ?? false);
                                    if ($aSticky && !$bSticky) return -1;
                                    if (!$aSticky && $bSticky) return 1;
                                    return threadSortScore($b, $sortLikes) <=> threadSortScore($a, $sortLikes);
                                });
                                
                                saveThreads($threads);
                                // Clear preview cache for this thread
                                @unlink(PREVIEW_DIR . '/og_' . $threadId . '.png');
                                header('Location: /board?thread=' . $threadId . '&post=' . $postId . '#p' . $postId);
                                exit;
                            }
                        }
                        break;
                    }
                }
                unset($thread);
                if (!$found) $error = 'Thread not found.';
            }
        }
    }
}

// Load threads for display
$threads = loadThreads();

/**
 * Returns true if the post has any user-visible content.
 * Used to suppress posts whose ONLY content was pending/rejected media.
 * Admins can always see pending-media posts so they can approve them.
 */
function postHasVisibleContent(array $post, bool $isAdmin = false): bool {
    if (!empty(trim($post['comment'] ?? ''))) return true;
    // Has image data (approved or pending — pending still means content exists)
    $imgs = (!empty($post['images']) && is_array($post['images'])) ? $post['images'] : [];
    if (empty($imgs) && !empty($post['image'])) $imgs = [$post['image']];
    if (!empty($imgs)) return true;
    // Has media data (approved or pending)
    if (!empty($post['media'])) return true;
    return false;
}

// Hot post class helper
function hotClass(string $postId): string {
    $count = getLikeCount($postId);
    if ($count >= 1000) return 'hot-1000';
    if ($count >= 100) return 'hot-100';
    if ($count >= 10) return 'hot-10';
    return '';
}

function boostClass(float $goyimTips): string {
    if ($goyimTips >= 500) return 'boost-3';
    if ($goyimTips >= 100) return 'boost-2';
    if ($goyimTips >= 1)   return 'boost-1';
    return '';
}

/**
 * Check if a Solana wallet holds $GOYIM tokens via Solana mainnet RPC.
 * Returns ['holder' => bool, 'balance' => float].
 */
function checkGoyimHolder(string $wallet): array {
    if (!BOARD_GOYIM_CA || !$wallet) return ['holder' => false, 'balance' => 0];
    // Basic Solana address sanity check
    if (!preg_match('/^[1-9A-HJ-NP-Za-km-z]{32,44}$/', $wallet)) {
        return ['holder' => false, 'balance' => 0];
    }
    $rpc = 'https://api.mainnet-beta.solana.com';
    $payload = json_encode([
        'jsonrpc' => '2.0', 'id' => 1,
        'method'  => 'getTokenAccountsByOwner',
        'params'  => [
            $wallet,
            ['mint' => BOARD_GOYIM_CA],
            ['encoding' => 'jsonParsed']
        ]
    ]);
    $ch = curl_init($rpc);
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => $payload,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
        CURLOPT_TIMEOUT        => 8,
    ]);
    $res = curl_exec($ch);
    curl_close($ch);
    if (!$res) return ['holder' => false, 'balance' => 0];
    $data = json_decode($res, true);
    $balance = 0.0;
    foreach (($data['result']['value'] ?? []) as $acct) {
        $balance += (float)($acct['account']['data']['parsed']['info']['tokenAmount']['uiAmount'] ?? 0);
    }
    $minTokens = defined('BOARD_GOYIM_MIN_TOKENS') ? (float)BOARD_GOYIM_MIN_TOKENS : 1.0;
    return ['holder' => $balance >= $minTokens, 'balance' => $balance];
}

/** Render the live boost badge span (replaces static ::before pseudo badge) */
function boostBadgeHtml(float $tips, int $bump): string {
    if ($tips < 1) return '';
    $tier   = $tips >= 500 ? 3 : ($tips >= 100 ? 2 : 1);
    $labels = ['', 'BOOSTED', 'ON FIRE', 'INFERNO'];
    return '<span class="boost-badge boost-badge-' . $tier . '" data-boost-until="' . $bump . '" data-goyim-total="' . round($tips) . '">🔥 ' . $labels[$tier] . '<span class="boost-timer"></span></span>';
}

/**
 * Thread sort score — Futaba/4chan bump order + engagement enhancement.
 *
 * Base = bump timestamp (last non-sage reply or OP creation time; GOYIM direct
 *        extension already baked in via the bump handler).
 * + log2(goyim_tips + 1) × 5400s  — token prestige; 1G≈01.5h, 100G≈10h, 1000G≈15h cap
 * + log2(thread_likes + 1) × 7200s — community love (total over OP + all replies)
 * + log2(reply_count + 1) × 1200s  — discussion depth (replies already bump; this adds longevity)
 * + log2(views + 1) × 120s         — tiny discovery signal; cannot be gamed to top placement
 *
 * All weights are in seconds so scores live in epoch-time space.
 * Stickies are handled separately by callers; this function ignores them.
 */
function threadSortScore(array $t, array $likesData): float {
    $bump  = (float)($t['bump'] ?? $t['time'] ?? 0);
    // Count likes across OP + every reply in the thread
    $likes = count($likesData[$t['id']] ?? []);
    foreach ($t['replies'] ?? [] as $r) {
        $likes += count($likesData[$r['id']] ?? []);
    }
    $replies = count($t['replies'] ?? []);
    $views   = getViewCount($t['id']);
    $goyim   = max(0.0, (float)($t['goyim_tips'] ?? 0));

    return $bump
         + log($goyim   + 1, 2) * 5400.0
         + log($likes   + 1, 2) * 7200.0
         + log($replies + 1, 2) * 1200.0
         + log($views   + 1, 2) * 120.0;
}

/**
 * Render post images — single container or multi-image carousel — with
 * pending/admin controls. Supports both new 'images' array and legacy 'image'.
 */
function renderPostImages(array $post, bool $isAdmin, string $threadId = '', bool $isReply = false): string {
    $imgs = (!empty($post['images']) && is_array($post['images'])) ? $post['images'] : [];
    if (empty($imgs) && !empty($post['image'])) $imgs = [$post['image']];
    if (empty($imgs)) return '';

    $vis  = array_values(array_filter($imgs, 'isImageVisible'));
    $pend = array_values(array_filter($imgs, fn($im) => !isImageVisible($im)));
    $html = '';
    $retUrl = htmlspecialchars($_SERVER['REQUEST_URI'] ?? '/board', ENT_QUOTES, 'UTF-8');
    $pid    = htmlspecialchars($post['id'], ENT_QUOTES, 'UTF-8');
    $tid    = htmlspecialchars($threadId, ENT_QUOTES, 'UTF-8');
    $replyV = $isReply ? '1' : '0';

    if ($vis) {
        if (count($vis) === 1) {
            $img = $vis[0];
            $html .= '<div class="post-image-container">';
            $html .= '<div class="post-image-info">' . htmlspecialchars($img['origName'] ?? 'image', ENT_QUOTES, 'UTF-8') . ' (' . formatFileSize($img['size'] ?? 0) . ')</div>';
            $html .= '<img src="/board_uploads/' . htmlspecialchars($img['thumb'], ENT_QUOTES, 'UTF-8') . '" data-full="/board_uploads/' . htmlspecialchars($img['file'], ENT_QUOTES, 'UTF-8') . '" alt="post image" onclick="expandImage(this)" loading="lazy">';
            $html .= '</div>';
        } else {
            $n = count($vis);
            $html .= '<div class="post-carousel" id="car-' . $pid . '">';
            $html .= '<div class="car-slides">';
            foreach ($vis as $ci => $img) {
                $active = $ci === 0 ? ' active' : '';
                $html .= '<div class="car-slide' . $active . '">';
                $html .= '<div class="post-image-info">' . htmlspecialchars($img['origName'] ?? 'image', ENT_QUOTES, 'UTF-8') . ' (' . formatFileSize($img['size'] ?? 0) . ') <span class="car-counter">' . ($ci + 1) . '/' . $n . '</span></div>';
                $html .= '<img src="/board_uploads/' . htmlspecialchars($img['thumb'], ENT_QUOTES, 'UTF-8') . '" data-full="/board_uploads/' . htmlspecialchars($img['file'], ENT_QUOTES, 'UTF-8') . '" alt="post image" onclick="expandImage(this)" loading="lazy">';
                $html .= '</div>';
            }
            $html .= '<button type="button" class="car-prev" onclick="carNav(\'' . $pid . '\',-1)">&#8249;</button>';
            $html .= '<button type="button" class="car-next" onclick="carNav(\'' . $pid . '\',1)">&#8250;</button>';
            $html .= '</div>'; // .car-slides
            $html .= '<div class="car-dots">';
            foreach ($vis as $ci => $_) {
                $html .= '<span class="car-dot' . ($ci === 0 ? ' active' : '') . '" onclick="carGoto(\'' . $pid . '\',' . $ci . ')"></span>';
            }
            $html .= '</div></div>'; // .car-dots + .post-carousel
        }
    }

    if ($pend) {
        // Build pending list with original indices in the images array
        $pendWithIdx = [];
        foreach ($imgs as $idx => $im) {
            if (!isImageVisible($im)) $pendWithIdx[] = ['idx' => $idx, 'img' => $im];
        }

        if ($isAdmin) {
            foreach ($pendWithIdx as $pi => $item) {
                $imgIdx  = $item['idx'];
                $pimg    = $item['img'];
                $imgNum  = $pi + 1;
                $total   = count($pendWithIdx);
                $label   = $total > 1 ? 'Image ' . $imgNum . '/' . $total : 'Image';
                $html .= '<div class="admin-pending-preview" style="margin-bottom:6px;">';
                if (!empty($pimg['thumb'])) {
                    $html .= '<img src="/board_uploads/' . htmlspecialchars($pimg['thumb'], ENT_QUOTES, 'UTF-8') . '" alt="pending" loading="lazy">';
                } else {
                    $html .= '<div style="width:120px;height:90px;background:rgba(255,140,0,0.08);border-radius:4px;display:flex;align-items:center;justify-content:center;color:#ff8c00;font-size:24px;">📸</div>';
                }
                $html .= '<div class="admin-pending-overlay">';
                $html .= '<span class="pending-label">🕐 ' . htmlspecialchars($label, ENT_QUOTES, 'UTF-8') . ' PENDING</span>';
                $html .= '<div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:center;">';
                $common = '<input type="hidden" name="action" value="__ACTION__">'
                        . '<input type="hidden" name="post_id" value="' . $pid . '">'
                        . '<input type="hidden" name="img_index" value="' . (int)$imgIdx . '">'
                        . ($isReply ? '<input type="hidden" name="thread_id" value="' . $tid . '">' : '')
                        . '<input type="hidden" name="is_reply" value="' . $replyV . '">'
                        . '<input type="hidden" name="return_url" value="' . $retUrl . '">';
                $html .= '<form method="POST" action="/board/admin">' . str_replace('__ACTION__', 'approve_image', $common) . '<button class="approve-overlay-btn">✅ Approve</button></form>';
                $html .= '<form method="POST" action="/board/admin">' . str_replace('__ACTION__', 'reject_image', $common) . '<button class="reject-overlay-btn">❌ Reject</button></form>';
                $html .= '</div></div></div>';
            }
        } else {
            $label = count($pendWithIdx) > 1 ? count($pendWithIdx) . ' images' : 'Image';
            $html .= '<div class="image-pending"><div><span class="pending-icon">🕐</span><span>' . $label . ' pending<br>admin approval</span></div></div>';
        }
    }

    return $html;
}

// Sort: stickies first, then by engagement-weighted score (Futaba bump + likes + views + GOYIM prestige)
$likesData = loadLikes();
usort($threads, function($a, $b) use ($likesData) {
    $aSticky = (bool)($a['sticky'] ?? false);
    $bSticky = (bool)($b['sticky'] ?? false);
    if ($aSticky && !$bSticky) return -1;
    if (!$aSticky && $bSticky) return 1;
    $sa = threadSortScore($a, $likesData);
    $sb = threadSortScore($b, $likesData);
    return $sb <=> $sa;
});

$threadCount = count($threads);
$totalPosts = $threadCount;
foreach ($threads as $t) $totalPosts += count($t['replies'] ?? []);

// Pagination
$threadsPerPage = max(1, (int)($settings['threads_per_page'] ?? 10));
$repliesPreview = max(0, (int)($settings['replies_preview_count'] ?? 3));
$totalPages = max(1, (int)ceil($threadCount / $threadsPerPage));
$currentPage = max(1, min($totalPages, (int)($_GET['page'] ?? 1)));
$pageThreads = array_slice($threads, ($currentPage - 1) * $threadsPerPage, $threadsPerPage);

// Handle AJAX like toggle
if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['action'] ?? '') === 'like') {
    header('Content-Type: application/json');
    if (!checkAjaxRateLimit('like', 1)) {
        echo json_encode(['error' => 'Too fast']);
        exit;
    }
    $postId = $_POST['post_id'] ?? '';
    if (!$isBanned && !empty($postId)) {
        $result = toggleLike($postId);
        // If liking a thread OP (not a reply), bump the thread
        if ($result['liked']) {
            $bumpThreads = loadThreads();
            foreach ($bumpThreads as &$bt) {
                if ($bt['id'] === $postId) {
                    $bt['bump'] = time();
                    saveThreads($bumpThreads);
                    break;
                }
            }
            unset($bt);
        }
        echo json_encode($result);
    } else {
        echo json_encode(['error' => 'Cannot like']);
    }
    exit;
}

// Handle wallet link AJAX
if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['action'] ?? '') === 'link_wallet') {
    header('Content-Type: application/json');
    if (!checkAjaxRateLimit('wallet', 3)) {
        echo json_encode(['error' => 'Too fast']);
        exit;
    }
    $postId = preg_replace('/[^a-zA-Z0-9]/', '', $_POST['post_id'] ?? '');
    $wallet = $_POST['wallet'] ?? '';
    if (!empty($postId) && preg_match('/^0x[0-9a-fA-F]{40}$/', $wallet)) {
        linkWalletToPost($postId, $wallet);
        echo json_encode(['success' => true, 'wallet' => strtolower($wallet)]);
    } else {
        echo json_encode(['error' => 'Invalid wallet']);
    }
    exit;
}

// Handle get wallet AJAX
if ($_SERVER['REQUEST_METHOD'] === 'GET' && ($_GET['action'] ?? '') === 'get_wallet') {
    header('Content-Type: application/json');
    $postId = $_GET['post_id'] ?? '';
    $wallet = getPostWallet($postId);
    $wallets = getPostWallets($postId);
    echo json_encode(['wallet' => $wallet, 'wallets' => $wallets]);
    exit;
}

// ═══ GOYIM BUMP ACTION ═══
if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['action'] ?? '') === 'goyim_bump') {
    header('Content-Type: application/json');
    if ($isBanned) { echo json_encode(['error' => 'Banned']); exit; }
    if (!checkAjaxRateLimit('goyim_bump', 10)) { echo json_encode(['error' => 'Too fast']); exit; }
    // Pre-launch: only admin (session or admin wallet) can boost until $GOYIM token is live
    $isAdminForBump = isAdminLoggedIn();
    $bumperWallet   = trim($_POST['wallet'] ?? '');
    $isAdminWallet  = BOARD_GOYIM_ADMIN_WALLET && $bumperWallet === BOARD_GOYIM_ADMIN_WALLET;
    if (!BOARD_GOYIM_CA && !$isAdminForBump && !$isAdminWallet) {
        echo json_encode(['error' => 'Boost goes live when $GOYIM launches — admin only for now']); exit;
    }
    $threadId = trim($_POST['thread_id'] ?? '');
    $amount   = max(0, (float)($_POST['amount'] ?? 0));
    if (empty($threadId) || $amount <= 0) { echo json_encode(['error' => 'Invalid request']); exit; }
    $ts = loadThreads();
    $found = false; $newTips = 0;
    foreach ($ts as &$t) {
        if ($t['id'] === $threadId) {
            $t['goyim_tips'] = round(($t['goyim_tips'] ?? 0) + $amount, 2);
            // Each 1000 GOYIM extends the bump timestamp by BOARD_GOYIM_BUMP_WEIGHT seconds
            $boostSecs = (int) round(($amount / 1000) * BOARD_GOYIM_BUMP_WEIGHT);
            $t['bump']  = max(time(), ($t['bump'] ?? 0)) + $boostSecs;
            $newTips = $t['goyim_tips'];
            $found = true;
            break;
        }
    }
    unset($t);
    if (!$found) { echo json_encode(['error' => 'Thread not found']); exit; }
    saveThreads($ts);
    echo json_encode(['ok' => true, 'goyim_tips' => $newTips]);
    exit;
}

// ═══ CHECK GOYIM HOLDER (AJAX) ═══
if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['action'] ?? '') === 'check_goyim_holder') {
    header('Content-Type: application/json');
    $wallet = trim($_POST['wallet'] ?? '');
    if (!$wallet) {
        echo json_encode(['holder' => false, 'balance' => 0, 'error' => 'No wallet provided']);
        exit;
    }
    $result = checkGoyimHolder($wallet);
    echo json_encode($result);
    exit;
}

// ═══ LIVE REFRESH API ═══
if ($_SERVER['REQUEST_METHOD'] === 'GET' && ($_GET['action'] ?? '') === 'live_index') {
    header('Content-Type: application/json');
    $page = max(1, (int)($_GET['page'] ?? 1));
    $allThreads = loadThreads();
    $likesData = loadLikes();
    // Sort: sticky first, then by requested sort mode
    $sortMode = (($_GET['sort'] ?? 'frog') === 'bump') ? 'bump' : 'frog';
    if ($sortMode === 'bump') {
        usort($allThreads, function($a, $b) {
            $aSticky = (bool)($a['sticky'] ?? false);
            $bSticky = (bool)($b['sticky'] ?? false);
            if ($aSticky && !$bSticky) return -1;
            if (!$aSticky && $bSticky) return 1;
            $aB = $a['bump'] ?? $a['time'] ?? 0;
            $bB = $b['bump'] ?? $b['time'] ?? 0;
            return $bB <=> $aB;
        });
    } else {
        usort($allThreads, function($a, $b) use ($likesData) {
            $aSticky = (bool)($a['sticky'] ?? false);
            $bSticky = (bool)($b['sticky'] ?? false);
            if ($aSticky && !$bSticky) return -1;
            if (!$aSticky && $bSticky) return 1;
            return threadSortScore($b, $likesData) <=> threadSortScore($a, $likesData);
        });
    }
    $tpp = $settings['threads_per_page'] ?? 10;
    $total = count($allThreads);
    $totalPg = max(1, (int)ceil($total / $tpp));
    $page = min($page, $totalPg);
    $slice = array_slice($allThreads, ($page - 1) * $tpp, $tpp);
    $out = [];
    foreach ($slice as $t) {
        $replyCount = count($t['replies'] ?? []);
        $out[] = [
            'id' => $t['id'],
            'subject' => $t['subject'] ?? '',
            'comment' => mb_substr(strip_tags($t['comment'] ?? ''), 0, 300),
            'time' => $t['time'],
            'timeAgo' => timeAgo($t['time']),
            'replyCount' => $replyCount,
            'views' => getViewCount($t['id']),
            'likes' => getLikeCount($t['id']),
            'sticky' => $t['sticky'] ?? false,
            'locked' => $t['locked'] ?? false,
            'hasImage' => !empty($t['image']),
            'thumb' => ($t['image'] && isImageVisible($t['image'])) ? '/board_uploads/' . $t['image']['thumb'] : null,
            'goyimTips' => round($t['goyim_tips'] ?? 0, 0),
            'bump' => $t['bump'] ?? $t['time'] ?? 0,
        ];
    }
    echo json_encode(['threads' => $out, 'page' => $page, 'totalPages' => $totalPg, 'totalThreads' => $total, 'online' => getOnlineCount()]);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'GET' && ($_GET['action'] ?? '') === 'live_thread') {
    header('Content-Type: application/json');
    $tid = $_GET['thread'] ?? '';
    $allThreads = loadThreads();
    $found = null;
    foreach ($allThreads as $t) { if ($t['id'] === $tid) { $found = $t; break; } }
    if (!$found) { echo json_encode(['error' => 'Thread not found']); exit; }
    $replies = [];
    foreach ($found['replies'] as $r) {
        $replies[] = [
            'id' => $r['id'],
            'comment' => formatPostText($r['comment'], $r['id']),
            'time' => $r['time'],
            'timeFormatted' => date('m/d/y(D)H:i:s', $r['time']),
            'anonId' => $r['anonId'],
            'hasImage' => !empty($r['image']),
            'thumb' => ($r['image'] && isImageVisible($r['image'])) ? '/board_uploads/' . $r['image']['thumb'] : null,
            'fullImage' => ($r['image'] && isImageVisible($r['image'])) ? '/board_uploads/' . $r['image']['file'] : null,
            'imageName' => $r['image']['origName'] ?? null,
            'imageSize' => isset($r['image']['size']) ? formatFileSize($r['image']['size']) : null,
            'wallet' => getPostWallet($r['id']),
            'hasMedia'      => !empty($r['media']),
            'mediaType'     => $r['media']['type'] ?? null,
            'mediaUrl'      => (!empty($r['media']) && isMediaVisible($r['media'])) ? '/board_uploads/' . $r['media']['file'] : null,
            'mediaPending'  => !empty($r['media']) && !($r['media']['approved'] ?? true),
            'mediaOrigName' => $r['media']['origName'] ?? null,
        ];
    }
    // OP image data (for live refresh to catch approved images)
    $opImage = null;
    if ($found['image']) {
        $opImage = [
            'visible' => isImageVisible($found['image']),
            'thumb' => isImageVisible($found['image']) ? '/board_uploads/' . $found['image']['thumb'] : null,
            'full' => isImageVisible($found['image']) ? '/board_uploads/' . $found['image']['file'] : null,
            'name' => $found['image']['origName'] ?? 'image',
            'size' => isset($found['image']['size']) ? formatFileSize($found['image']['size']) : '?',
        ];
    }
    echo json_encode([
        'id' => $found['id'],
        'replyCount' => count($found['replies']),
        'views' => getViewCount($found['id']),
        'likes' => getLikeCount($found['id']),
        'opImage' => $opImage,
        'replies' => $replies,
    ]);
    exit;
}

// Track online users
trackOnlineUser();
$onlineCount = getOnlineCount();

// Allowed media accept string for file inputs
$_allowImages = $settings['allow_images'] ?? true;
$_allowAudio  = $settings['allow_audio']  ?? true;
$_allowVideo  = $settings['allow_video']  ?? true;
$_mAccept = implode(',', array_filter([$_allowAudio ? 'audio/*' : null, $_allowVideo ? 'video/*' : null]));
$_anyMedia = $_allowImages || $_allowAudio || $_allowVideo;

// Total views across all threads
$totalViews = getTotalViews();

// View mode
$viewThread = $_GET['thread'] ?? null;
$viewMode = $_GET['mode'] ?? 'index'; // 'index' or 'catalog'
$isCatalog = ($viewMode === 'catalog');
$singleThread = null;
$threadViewCount = 0;
if ($viewThread) {
    foreach ($threads as $t) {
        if ($t['id'] === $viewThread) {
            $singleThread = $t;
            $threadViewCount = trackView($viewThread);
            break;
        }
    }
    if (!$singleThread) {
        http_response_code(404);
    }
}

$isAdmin = isAdminLoggedIn();

// Build dynamic OG tags
$baseUrl = (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off' ? 'https' : 'http') . '://' . ($_SERVER['HTTP_HOST'] ?? 'localhost');
$ogTitle = '🐸 Frog Channel';
$ogDesc = 'Anonymous image board. ' . count($threads) . ' threads active. Post frogs, discuss topics, share media. No accounts, no tracking.';
$ogImage = $baseUrl . '/board_preview.php?board=index';
$ogUrl = $baseUrl . '/board';
$ogType = 'website';

if ($singleThread) {
    $subj = $singleThread['subject'] ?: 'Anonymous Thread';
    $replyC = count($singleThread['replies'] ?? []);
    $likeC = getLikeCount($singleThread['id']);
    $viewC = getViewCount($singleThread['id']);
    $ogTitle = $subj . ' — Frog Channel #' . $singleThread['id'];
    $ogDesc = mb_substr(strip_tags($singleThread['comment']), 0, 200);
    if (mb_strlen($singleThread['comment']) > 200) $ogDesc .= '...';
    $ogDesc .= " · {$replyC} replies · {$viewC} views · {$likeC} 🐸";
    // Use thread's actual image for richer social preview, fall back to generated
    if ($singleThread['image'] && ($singleThread['image']['approved'] ?? true) && !empty($singleThread['image']['file'])) {
        $ogImage = $baseUrl . '/board_uploads/' . $singleThread['image']['file'];
    } else {
        $ogImage = $baseUrl . '/board_preview.php?thread=' . $singleThread['id'];
    }
    $ogUrl = $baseUrl . '/board?thread=' . $singleThread['id'];
    $ogType = 'article';

    // ═══ ?post=POSTID — Discord-friendly per-reply OG tags ═══
    // Discord strips URL anchors (#pXXX) before fetching, so we support ?post=ID
    // as a query param that PHP can read and serve reply-specific OG metadata.
    $viewPost = preg_replace('/[^a-f0-9]/i', '', $_GET['post'] ?? '');
    if ($viewPost) {
        $specificPost = null;
        foreach ($singleThread['replies'] ?? [] as $r) {
            if ($r['id'] === $viewPost) { $specificPost = $r; break; }
        }
        if ($specificPost) {
            $rText = mb_substr(strip_tags($specificPost['comment'] ?? ''), 0, 220);
            if (mb_strlen($specificPost['comment'] ?? '') > 220) $rText .= '…';
            $ogTitle = 'Re: ' . ($singleThread['subject'] ?: 'Anonymous Thread') . ' — Frog Channel';
            $ogDesc  = $rText ?: '(image post)';
            // Prefer reply image, fall back to thread-level image
            if (!empty($specificPost['image']['file']) && ($specificPost['image']['approved'] ?? true)) {
                $ogImage = $baseUrl . '/board_uploads/' . $specificPost['image']['file'];
            }
            $ogUrl = $baseUrl . '/board?thread=' . $singleThread['id'] . '&post=' . $specificPost['id'];
        }
    }

    // ═══ Build backlinks map (which posts reply to which) ═══
    $backlinks = [];
    // Scan OP comment for refs
    if (preg_match_all('/>>([a-z0-9]+)/i', $singleThread['comment'], $m)) {
        foreach ($m[1] as $refId) {
            $backlinks[$refId][] = $singleThread['id'];
        }
    }
    // Scan all replies
    foreach ($singleThread['replies'] as $r) {
        if (preg_match_all('/>>([a-z0-9]+)/i', $r['comment'], $m)) {
            foreach ($m[1] as $refId) {
                $backlinks[$refId][] = $r['id'];
            }
        }
    }
    // Deduplicate
    foreach ($backlinks as &$bl) $bl = array_unique($bl);
    unset($bl);
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <!-- Critical: prevent FOUC white flash before style.css loads -->
    <style>html,body{background:#0a0e0a;color:#00ff41;}</style>
    <title><?= $singleThread ? htmlspecialchars(($singleThread['subject'] ?: 'Thread') . ' — Frog Channel') : 'Frog Channel' ?></title>
    
    <meta name="title" content="<?= htmlspecialchars($ogTitle) ?>">
    <meta name="description" content="<?= htmlspecialchars($ogDesc) ?>">
    <meta name="robots" content="index, follow">
    
    <meta property="og:type" content="<?= $ogType ?>">
    <meta property="og:url" content="<?= htmlspecialchars($ogUrl) ?>">
    <meta property="og:title" content="<?= htmlspecialchars($ogTitle) ?>">
    <meta property="og:description" content="<?= htmlspecialchars($ogDesc) ?>">
    <meta property="og:image" content="<?= htmlspecialchars($ogImage) ?>">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:site_name" content="Frog Channel">
    
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="<?= htmlspecialchars($ogTitle) ?>">
    <meta name="twitter:description" content="<?= htmlspecialchars($ogDesc) ?>">
    <meta name="twitter:image" content="<?= htmlspecialchars($ogImage) ?>">
    <link rel="canonical" href="<?= htmlspecialchars($ogUrl) ?>">
    
    <meta name="theme-color" content="#00ff41">
    <meta name="csrf-token" content="<?= htmlspecialchars(generateCsrfToken()) ?>">
    <link rel="icon" type="image/x-icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🐸</text></svg>">
    <!-- style.css merged inline -->
    <style>
        .board-container { max-width: 960px; margin: 0 auto; padding: 0 15px; }
        .board-header { text-align: center; padding: 20px 15px 20px; }
        .board-header h2 { color: #00ff41; font-family: 'Courier New', monospace; font-size: 2em; text-shadow: 0 0 20px rgba(0,255,65,0.4); margin: 0 0 5px; }
        .board-header .board-subtitle { color: #6baf6b; font-size: 13px; }
        .board-stats { display: flex; gap: 8px; justify-content: center; align-items: center; flex-wrap: wrap; margin-top: 12px; padding: 8px 16px; background: rgba(0,255,65,0.03); border: 1px solid rgba(0,255,65,0.08); border-radius: 6px; font-size: 12px; color: #4a8f4a; }
        .board-stats .stat-item { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
        .board-stats .stat-sep { color: #1a3a1a; }
        .board-stats span.stat-val { color: #00ff41; font-weight: bold; }
        .board-stats .online-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #00ff41; box-shadow: 0 0 6px rgba(0,255,65,0.6); animation: pulseDot 2s infinite; }
        .board-stats .stat-moderated { color: #ff8c00; }
        @keyframes pulseDot { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        
        /* Announcement */
        .board-announcement { background: rgba(255,140,0,0.08); border: 1px solid rgba(255,140,0,0.3); border-radius: 6px; padding: 10px 15px; margin-bottom: 15px; color: #ffaa33; font-size: 13px; }
        .board-announcement strong { color: #ff8c00; }
        
        /* Tip dropbox disclaimer */
        .tip-disclaimer { background: rgba(0,255,65,0.04); border: 1px solid rgba(0,255,65,0.15); border-radius: 6px; padding: 12px 16px; margin-bottom: 15px; display: flex; align-items: flex-start; gap: 12px; }
        .tip-disclaimer .tip-icon { font-size: 1.6em; flex-shrink: 0; margin-top: 2px; }
        .tip-disclaimer .tip-text { font-size: 12px; color: #6baf6b; line-height: 1.6; }
        .tip-disclaimer .tip-text strong { color: #00ff41; }
        .tip-disclaimer .tip-text a { color: #5fffaf; text-decoration: none; font-weight: bold; }
        .tip-disclaimer .tip-text a:hover { text-decoration: underline; color: #7fffcf; }
        
        /* Ban notice */
        .ban-notice { background: linear-gradient(135deg, rgba(255,0,0,0.08), rgba(80,0,0,0.15)); border: 1px solid rgba(255,68,68,0.5); border-left: 4px solid #ff4444; border-radius: 8px; padding: 24px 28px; margin-bottom: 24px; position: relative; overflow: hidden; }
        .ban-notice::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 1px; background: linear-gradient(90deg, transparent, rgba(255,68,68,0.6), transparent); }
        .ban-notice-icon { font-size: 2em; margin-bottom: 10px; }
        .ban-notice h3 { color: #ff4444; font-family: 'Courier New', monospace; font-size: 1.1em; letter-spacing: 2px; margin-bottom: 14px; text-shadow: 0 0 12px rgba(255,68,68,0.4); }
        .ban-notice-row { display: flex; gap: 8px; align-items: baseline; margin-bottom: 6px; font-family: 'Courier New', monospace; font-size: 13px; }
        .ban-notice-row .label { color: rgba(255,100,100,0.6); min-width: 80px; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; }
        .ban-notice-row .value { color: #ff8888; }
        .ban-notice-footer { margin-top: 16px; padding-top: 14px; border-top: 1px solid rgba(255,68,68,0.2); color: rgba(255,120,120,0.6); font-size: 11px; font-family: 'Courier New', monospace; letter-spacing: 0.5px; }
        
        /* Post form */
        .post-form-container { background: rgba(0,0,0,0.5); border: 1px solid rgba(0,255,65,0.2); border-radius: 8px; padding: 0; margin-bottom: 25px; overflow: hidden; }
        .form-toggle-header { display: flex; align-items: center; justify-content: space-between; cursor: pointer; user-select: none; padding: 12px 20px; margin: 0; color: #00ff41; font-size: 14px; letter-spacing: 1px; transition: background 0.2s; }
        .form-toggle-header:hover { background: rgba(0,255,65,0.05); }
        .form-toggle-caret { font-size: 16px; transition: transform 0.2s; flex-shrink: 0; opacity: 0.7; transform: rotate(180deg); }
        .form-toggle-header.collapsed .form-toggle-caret { transform: rotate(0deg); }
        .reply-form-wrap { border: 1px solid rgba(0,255,65,0.18); border-radius: 8px; overflow: hidden; margin-top: 6px; }
        .thread-nav-bar { padding:6px 2px; font-family:'Courier New',monospace; font-size:12px; color:#3a5a3a; }
        .thread-nav-link { color:#5fffaf; text-decoration:none; }
        .thread-nav-link:hover { text-decoration:underline; }
        .thread-nav-sep { color:#3a5a3a; margin:0 4px; }
        body[data-theme="read"] .thread-nav-link { color:#7a3a10; }
        body[data-theme="read"] .thread-nav-sep { color:#b0a090; }
        .reply-form-wrap .form-toggle-header { width: 100%; background: rgba(0,0,0,0.4); border: none; border-radius: 0; font-family: 'Courier New', monospace; }
        .reply-form-wrap .form-toggle-header:hover { background: rgba(0,255,65,0.06); }
        .reply-form-wrap #replyFormBody { border-top: 1px solid rgba(0,255,65,0.1); }
        .form-collapsible { padding: 0 20px 20px; }
        .form-collapsible.collapsed { display: none; }
        .form-row { margin-bottom: 10px; }
        .form-row input[type="text"], .form-row textarea { width: 100%; background: rgba(0,255,65,0.04); border: 1px solid rgba(0,255,65,0.2); border-radius: 4px; color: #b0ffb0; font-family: 'Courier New', monospace; font-size: 13px; padding: 8px 12px; box-sizing: border-box; }
        .form-row input[type="text"]:focus, .form-row textarea:focus { outline: none; border-color: #00ff41; box-shadow: 0 0 5px rgba(0,255,65,0.2); }
        .form-row textarea { min-height: 80px; resize: vertical; }
        .form-row input::placeholder, .form-row textarea::placeholder { color: #4d8f4d; opacity: 1; }
        .form-error { display: none; color: #e05040; font-size: 11px; font-family: 'Courier New', monospace; margin-bottom: 6px; padding: 4px 8px; background: rgba(220,60,40,0.07); border-left: 2px solid rgba(220,60,40,0.5); border-radius: 2px; animation: fadeInDown 0.15s ease; }
        /* Upload progress bar */
        .upload-progress-wrap { display:none; margin:4px 0 8px; }
        .upload-progress-bar-track { height:5px; background:rgba(0,255,65,0.08); border:1px solid rgba(0,255,65,0.18); border-radius:3px; overflow:hidden; }
        .upload-progress-bar-fill { height:100%; width:0%; background:linear-gradient(90deg,#00c830,#5fffaf); border-radius:3px; transition:width 0.12s ease; }
        .upload-progress-label { margin-top:4px; font-size:11px; font-family:'Courier New',monospace; color:#5fffaf; letter-spacing:0.3px; }
        body[data-theme="read"] .upload-progress-bar-track { background:rgba(92,61,14,0.07); border-color:rgba(92,61,14,0.2); }
        body[data-theme="read"] .upload-progress-bar-fill { background:linear-gradient(90deg,#a06020,#d4a070); }
        body[data-theme="read"] .upload-progress-label { color:#7a4018; }
        .form-error.visible { display: block; }
        @keyframes fadeInDown { from { opacity:0; transform:translateY(-4px); } to { opacity:1; transform:translateY(0); } }
        .form-bottom { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
        .file-label { display: inline-flex; align-items: center; gap: 6px; background: rgba(0,255,65,0.06); border: 1px solid rgba(0,255,65,0.2); border-radius: 4px; padding: 6px 12px; color: #6baf6b; font-size: 12px; cursor: pointer; transition: all 0.2s; }
        .file-label:hover { border-color: #00ff41; color: #00ff41; }
        .file-label input { display: none; }
        .file-name { color: #33ff33; font-size: 11px; }
        .post-btn { background: #00ff41; color: #0a0e0a; border: none; border-radius: 4px; padding: 8px 20px; font-family: 'Courier New', monospace; font-weight: bold; font-size: 13px; cursor: pointer; transition: all 0.2s; }
        .post-btn:hover { box-shadow: 0 0 15px rgba(0,255,65,0.4); transform: translateY(-1px); }
        .form-hint { color: #3a6f3a; font-size: 11px; margin-left: auto; }
        
        .board-msg { padding: 10px 15px; border-radius: 6px; margin-bottom: 15px; font-size: 13px; }
        .board-msg.error { background: rgba(255,0,0,0.1); border: 1px solid rgba(255,0,0,0.3); color: #ff6b6b; }
        
        /* Thread */
        .thread { background: rgba(0,0,0,0.4); border: 1px solid rgba(0,255,65,0.1); border-radius: 8px; margin-bottom: 15px; overflow: hidden; }
        .thread.sticky { border-color: rgba(255,140,0,0.3); }
        .thread.locked { opacity: 0.85; }
        .thread-op { padding: 15px; border-bottom: 1px solid rgba(0,255,65,0.08); position: relative; overflow: hidden; }
        .post-header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; font-size: 12px; }
        .post-subject { color: #00ff41; font-weight: bold; font-size: 14px; }
        .post-anon { color: #33ff33; font-weight: bold; }
        .post-name-admin { color: #ff3333; font-weight: bold; }
        .capcode-admin { background: #cc0000; color: #ffffff; font-size: 10px; padding: 1px 6px; border-radius: 2px; font-weight: bold; letter-spacing: 0.5px; font-family: 'Courier New', monospace; white-space: nowrap; }
        .post-anon-id { color: #4a8f4a; font-size: 11px; background: rgba(0,255,65,0.06); padding: 1px 5px; border-radius: 3px; }
        .post-time { color: #3a6f3a; font-size: 11px; }
        .post-no { color: #4a8f4a; font-size: 11px; cursor: pointer; }
        .post-no:hover { color: #00ff41; }
        .post-badge { font-size: 10px; padding: 1px 6px; border-radius: 3px; }
        .badge-sticky { background: #ff8c00; color: white; }
        .badge-locked { background: #ff4444; color: white; }
        
        .post-image-container { float: left; margin: 0 15px 10px 0; }
        .post-carousel { float: left; margin: 0 15px 10px 0; position: relative; max-width: 100%; }
        .car-slides { position: relative; max-width: 100%; }
        .car-slide { display: none; }
        .car-slide.active { display: block; }
        .car-prev, .car-next { position: absolute; top: 50%; transform: translateY(-50%); background: rgba(0,0,0,0.75); border: 1px solid rgba(0,255,65,0.45); color: #00ff41; font-size: 22px; line-height: 1; padding: 4px 10px; cursor: pointer; z-index: 3; border-radius: 3px; font-family: monospace; transition: background 0.15s; user-select: none; }
        .car-prev:hover, .car-next:hover { background: rgba(0,255,65,0.18); }
        .car-prev { left: 2px; }
        .car-next { right: 2px; }
        .car-dots { text-align: center; padding: 4px 0 0; clear: both; }
        .car-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: rgba(0,255,65,0.2); margin: 0 2px; cursor: pointer; border: 1px solid rgba(0,255,65,0.4); transition: background 0.15s; }
        .car-dot.active { background: #00ff41; }
        .car-counter { color: #4a8f4a; font-size: 10px; font-style: italic; margin-left: 4px; }
        .post-image-container img { border: 1px solid rgba(0,255,65,0.2); border-radius: 3px; cursor: pointer; max-width: 250px; transition: opacity 0.2s; }
        .post-image-container img:hover { opacity: 0.85; }
        .post-image-info { font-size: 10px; color: #3a6f3a; margin-top: 2px; }
        .replies-hidden-note { padding: 5px 15px; font-size: 12px; color: #4a8f4a; }
        
        /* Pending image placeholder */
        .image-pending { display: flex; align-items: center; justify-content: center; width: 200px; height: 150px; background: rgba(255,140,0,0.05); border: 2px dashed rgba(255,140,0,0.3); border-radius: 5px; color: #ff8c00; font-size: 12px; text-align: center; float: left; margin: 0 15px 10px 0; }
        .image-pending span { display: block; }
        .image-pending .pending-icon { font-size: 2em; margin-bottom: 5px; }
        /* Admin pending image preview */
        .admin-pending-preview { position: relative; float: left; margin: 0 15px 10px 0; }
        .admin-pending-preview img { max-width: 200px; max-height: 200px; border-radius: 5px; border: 2px solid rgba(255,140,0,0.5); opacity: 0.7; }
        .admin-pending-overlay { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; border-radius: 5px; }
        .admin-pending-overlay .pending-label { color: #ff8c00; font-size: 10px; font-family: 'Courier New', monospace; letter-spacing: 1px; margin-bottom: 4px; }
        .admin-pending-overlay form { display: inline; }
        .admin-pending-overlay button { padding: 4px 12px; border-radius: 3px; cursor: pointer; font-size: 11px; font-family: 'Courier New', monospace; border: 1px solid; }
        .admin-pending-overlay .approve-overlay-btn { background: rgba(0,255,65,0.15); border-color: rgba(0,255,65,0.4); color: #00ff41; }
        .admin-pending-overlay .approve-overlay-btn:hover { background: rgba(0,255,65,0.3); }
        .admin-pending-overlay .reject-overlay-btn { background: rgba(255,60,60,0.15); border-color: rgba(255,60,60,0.4); color: #ff6b6b; }
        .admin-pending-overlay .reject-overlay-btn:hover { background: rgba(255,60,60,0.3); }
        /* ── Standalone approve / reject buttons (media pending, catalog, etc.) ── */
        .approve-overlay-btn, .reject-overlay-btn {
            display: inline-flex; align-items: center; gap: 4px;
            padding: 4px 12px; border-radius: 4px; cursor: pointer;
            font-size: 12px; font-family: 'Courier New', monospace; font-weight: bold;
            border: 1px solid; transition: background 0.15s, box-shadow 0.15s, transform 0.1s;
            letter-spacing: 0.4px;
        }
        .approve-overlay-btn:active, .reject-overlay-btn:active { transform: scale(0.97); }
        .approve-overlay-btn {
            background: rgba(0,255,65,0.1); border-color: rgba(0,255,65,0.45); color: #00ff41;
            box-shadow: 0 0 6px rgba(0,255,65,0.08);
        }
        .approve-overlay-btn:hover {
            background: rgba(0,255,65,0.22); border-color: rgba(0,255,65,0.7);
            box-shadow: 0 0 10px rgba(0,255,65,0.18);
        }
        .reject-overlay-btn {
            background: rgba(255,60,60,0.1); border-color: rgba(255,60,60,0.45); color: #ff6b6b;
            box-shadow: 0 0 6px rgba(255,60,60,0.06);
        }
        .reject-overlay-btn:hover {
            background: rgba(255,60,60,0.22); border-color: rgba(255,60,60,0.7);
            box-shadow: 0 0 10px rgba(255,60,60,0.18);
        }
        /* Read mode overrides */
        body[data-theme="read"] .approve-overlay-btn {
            background: rgba(30,130,30,0.1); border-color: rgba(30,130,30,0.5); color: #1e6e1e;
            box-shadow: none;
        }
        body[data-theme="read"] .approve-overlay-btn:hover {
            background: rgba(30,130,30,0.2); border-color: rgba(30,130,30,0.8);
        }
        body[data-theme="read"] .reject-overlay-btn {
            background: rgba(180,30,30,0.1); border-color: rgba(180,30,30,0.5); color: #a01818;
            box-shadow: none;
        }
        body[data-theme="read"] .reject-overlay-btn:hover {
            background: rgba(180,30,30,0.2); border-color: rgba(180,30,30,0.8);
        }
        
        .post-comment { color: #b0ffb0; font-size: 13px; line-height: 1.7; word-wrap: break-word; overflow-wrap: break-word; }
        .post-comment a { color: #5fffaf; text-decoration: none; transition: color 0.15s; word-break: break-all; }
        .post-comment a:visited { color: #3fbf8f; }
        .post-comment a:hover { color: #7fffcf; text-decoration: underline; }
        .post-comment a:active { color: #00ff41; }
        .post-comment .greentext { color: #789922; }
        .post-comment .post-ref { color: #5fffaf; text-decoration: none; }
        .post-comment .post-ref:hover { text-decoration: underline; color: #7fffcf; }
        .post-comment .yt-embed { margin: 10px 0; clear: both; display: inline-block; max-width: 100%; }
        .post-comment .yt-embed .yt-toggle { position: relative; display: inline-block; cursor: pointer; }
        .post-comment .yt-embed .yt-thumb { display: block; max-width: 320px; width: 100%; border-radius: 4px; border: 1px solid rgba(0,255,65,0.2); }
        .post-comment .yt-embed .yt-play-overlay { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; background: rgba(0,0,0,0.45); border-radius: 4px; transition: background 0.2s; }
        .post-comment .yt-embed .yt-toggle:hover .yt-play-overlay { background: rgba(0,0,0,0.22); }
        .post-comment .yt-embed .yt-play-btn { font-size: 30px; color: #ff3333; text-shadow: 0 0 12px rgba(255,0,0,0.5); }
        .post-comment .yt-embed .yt-show-label { font-family: 'Courier New', monospace; font-size: 9px; color: #8aff8a; letter-spacing: 1px; }
        .post-comment .yt-embed .yt-hide-btn { display: block; background: rgba(255,0,0,0.1); border: 1px solid rgba(255,0,0,0.3); color: #ff7777; font-family: 'Courier New', monospace; font-size: 9px; padding: 3px 8px; cursor: pointer; margin-bottom: 4px; border-radius: 2px; }
        .post-comment .yt-embed .yt-frame-wrap iframe { max-width: 100%; border-radius: 5px; border: 1px solid rgba(0,255,65,0.15); }
        
        /* Backlinks — inline inside post-header after No. */
        .post-backlinks { display: inline; font-size: 11px; margin-left: 4px; }
        .post-backlinks a { color: #5fffaf; text-decoration: none; margin-right: 4px; }
        .post-backlinks a:hover { text-decoration: underline; color: #7fffcf; }

        /* Post highlight on URL hash */
        .post-highlight { animation: postHighlight 2s ease-out; }
        @keyframes postHighlight {
            0% { background: rgba(95,255,175,0.15); box-shadow: inset 0 0 20px rgba(95,255,175,0.08); }
            100% { background: transparent; box-shadow: none; }
        }

        /* Floating post preview on hover */
        .post-preview-float {
            position: absolute;
            z-index: 15000;
            max-width: 520px;
            min-width: 280px;
            background: #0a0e0a;
            border: 1px solid rgba(95,255,175,0.3);
            border-radius: 6px;
            padding: 10px 14px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.7);
            pointer-events: none;
            font-size: 12px;
        }
        .post-preview-float .post-header { margin-bottom: 6px; }
        .post-preview-float .post-comment { color: #b0ffb0; font-size: 12px; line-height: 1.5; max-height: 200px; overflow: hidden; }
        .post-preview-float .post-image-container { float: left; margin: 0 10px 6px 0; }
        .post-preview-float .post-image-container img { max-width: 120px; max-height: 120px; border-radius: 3px; }
        .post-preview-float .post-actions, .post-preview-float .admin-controls, .post-preview-float .share-wrapper { display: none; }
        
        .thread-footer { display: flex; align-items: center; gap: 6px; padding: 8px 12px; background: rgba(0,0,0,0.25); border-top: 1px solid rgba(0,255,65,0.07); flex-wrap: wrap; font-size: 12px; }
        .tf-stats { display: inline-flex; align-items: center; gap: 6px; color: #4a8f4a; font-size: 11px; white-space: nowrap; }
        .tf-stats .ts-num { color: #00ff41; font-weight: bold; }
        .tf-sep { color: rgba(0,255,65,0.2); }
        .thread-link { color: #5fffaf; text-decoration: none; font-size: 11px; margin-left: auto; white-space: nowrap; transition: color 0.15s; flex-shrink: 0; }
        .thread-link:hover { color: #7fffcf; text-decoration: underline; }
        
        .reply { padding: 12px 15px 12px 30px; border-top: 1px solid rgba(0,255,65,0.05); position: relative; }
        .reply::before { content: ''; position: absolute; left: 15px; top: 0; bottom: 0; width: 2px; background: rgba(0,255,65,0.1); }
        .reply:nth-child(even) { background: rgba(0,255,65,0.015); }
        
        .reply-toggle { background: rgba(0,255,65,0.05); border: 1px solid rgba(0,255,65,0.22); color: #6baf6b; padding: 3px 12px; border-radius: 4px; cursor: pointer; font-size: 11px; font-family: 'Courier New', monospace; transition: all 0.2s; white-space: nowrap; }
        .reply-toggle:hover { border-color: #00ff41; color: #00ff41; background: rgba(0,255,65,0.1); }
        
        .quick-reply { display: none; padding: 12px 15px; border-top: 1px solid rgba(0,255,65,0.1); background: rgba(0,0,0,0.3); }
        .quick-reply.active { display: block; }
        .quick-reply .form-row textarea { min-height: 60px; }
        /* ── Voice Notes & Video Clips — Post Display ── */
        .post-media { clear: both; margin: 7px 0 4px; }
        .post-voice-note { display: inline-flex; flex-direction: column; gap: 4px; background: rgba(0,255,65,0.035); border: 1px solid rgba(0,255,65,0.18); border-radius: 8px; padding: 7px 10px 6px; max-width: 420px; width: fit-content; min-width: 220px; box-sizing: border-box; }
        .pvn-row { display: flex; align-items: center; gap: 8px; }
        .pvn-icon { font-size: 15px; flex-shrink: 0; line-height: 1; }
        .pvn-audio { flex: 1; min-width: 0; }
        .pvn-audio audio { width: 100%; height: 32px; display: block; max-width: 360px; }
        .pvn-label { font-size: 10px; color: #4a8f4a; font-family: 'Courier New', monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-left: 2px; }
        .post-video-clip { max-width: 440px; width: 100%; margin: 6px 0; box-sizing: border-box; }
        .post-video-clip video { width: 100%; max-height: 280px; border: 1px solid rgba(0,255,65,0.22); border-radius: 6px; background: #000; display: block; }
        .pvc-label { font-size: 10px; color: #4a8f4a; font-family: 'Courier New', monospace; margin-top: 3px; }
        /* ── Media player theme tinting (frog) ── */
        .pvn-audio audio, .post-video-clip video { accent-color: #00d435; }
        .pvn-audio audio::-webkit-media-controls-panel,
        .post-video-clip video::-webkit-media-controls-panel { background: rgba(8,18,8,0.93); }
        .pvn-audio audio::-webkit-media-controls-time-remaining-display,
        .pvn-audio audio::-webkit-media-controls-current-time-display,
        .post-video-clip video::-webkit-media-controls-time-remaining-display,
        .post-video-clip video::-webkit-media-controls-current-time-display { color: #6ad46a; }
        /* Green-tint the play/pause/mute/fullscreen icons on frog's dark panel (Chromium) */
        body:not([data-theme="read"]) .pvn-audio audio::-webkit-media-controls-play-button,
        body:not([data-theme="read"]) .pvn-audio audio::-webkit-media-controls-mute-button,
        body:not([data-theme="read"]) .post-video-clip video::-webkit-media-controls-play-button,
        body:not([data-theme="read"]) .post-video-clip video::-webkit-media-controls-mute-button,
        body:not([data-theme="read"]) .post-video-clip video::-webkit-media-controls-fullscreen-button,
        body:not([data-theme="read"]) .post-video-clip video::-webkit-media-controls-overflow-button {
            filter: brightness(0) saturate(100%) invert(62%) sepia(96%) saturate(420%) hue-rotate(88deg) brightness(108%);
        }
        /* ── Media Recorder Bar ── */
        .media-rec-bar { display: block; margin-top: 8px; }
        .media-rec-bar-label { display: flex; align-items: center; justify-content: space-between; width: 100%; font-size: 10px; color: #4a8f4a; font-family: 'Courier New', monospace; letter-spacing: 0.8px; text-transform: uppercase; padding: 7px 10px; cursor: pointer; background: none; border: none; text-align: left; box-sizing: border-box; transition: color 0.15s; }
        .media-rec-bar-label:hover { color: #00ff41; }
        .mrb-caret { font-size: 12px; transition: transform 0.2s; display: inline-block; margin-left: auto; }
        .media-rec-bar-label.collapsed .mrb-caret { transform: rotate(-90deg); }
        .mrb-body { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 0; }
        .mrb-body.collapsed { display: none; }
        .mrb-btn { display: inline-flex; align-items: center; justify-content: center; gap: 5px; background: rgba(0,255,65,0.05); border: 1px solid rgba(0,255,65,0.2); border-radius: 4px; padding: 6px 12px; color: #6baf6b; font-size: 12px; cursor: pointer; font-family: 'Courier New', monospace; transition: all 0.2s; white-space: nowrap; min-height: 32px; box-sizing: border-box; }
        .mrb-btn:hover { border-color: #00ff41; color: #00ff41; background: rgba(0,255,65,0.08); }
        @keyframes mrbPulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
        .mrb-btn.recording { border-color: #ff4444; color: #ff4444; background: rgba(255,68,68,0.06); animation: mrbPulse 1s infinite; }
        .mrb-status { font-size: 11px; color: #4a8f4a; font-family: 'Courier New', monospace; padding: 0 2px; min-width: 60px; }
        .mrb-status.rec-active { color: #ff8080; }
        .mrb-preview { display: none; flex-direction: column; gap: 6px; margin-top: 6px; width: 100%; }
        .mrb-preview.visible { display: flex; }
        .mrb-preview video { width: 100%; max-height: 110px; background: #000; border-radius: 4px; border: 1px solid rgba(0,255,65,0.15); display: block; }
        /* custom audio player */
        .mrb-aplayer { display:block; background:rgba(0,255,65,0.04); border:1px solid rgba(0,255,65,0.18); border-radius:5px; padding:4px 6px; width:100%; box-sizing:border-box; }
        .mrb-aplayer audio, .mrb-aplayer video { display:block; width:100%; border-radius:3px; }
        /* legacy custom-player elements (kept for old cached DOM) */
        .mrb-aplay { flex-shrink:0; background:none; border:1px solid rgba(0,255,65,0.5); color:#00ff41; border-radius:50%; width:28px; height:28px; cursor:pointer; font-size:10px; display:flex; align-items:center; justify-content:center; transition:all 0.15s; padding:0; }
        .mrb-aplay:hover { background:rgba(0,255,65,0.12); }
        .mrb-aprog { flex:1; background:rgba(0,255,65,0.1); height:3px; border-radius:2px; overflow:hidden; cursor:pointer; }
        .mrb-abar  { height:100%; background:#00ff41; width:0; transition:width 0.1s linear; }
        .mrb-atime { font-size:11px; color:#4a8f4a; font-family:'Courier New',monospace; flex-shrink:0; min-width:32px; text-align:right; }
        .mrb-cancel { display: inline-flex; align-items: center; justify-content: center; background: none; border: 1px solid rgba(255,68,68,0.3); color: #ff6b6b; border-radius: 4px; padding: 5px 10px; font-size: 11px; cursor: pointer; font-family: 'Courier New', monospace; flex-shrink: 0; white-space: nowrap; min-height: 32px; box-sizing: border-box; transition: all 0.2s; }
        .mrb-cancel:hover { background: rgba(255,68,68,0.1); border-color: #ff4444; }
        input[type=file].mrb-file-hidden { display: none !important; }
        .wallet-toggle-btn { display:inline-flex; align-items:center; gap:5px; background:none; border:1px solid rgba(246,133,27,0.25); border-radius:3px; color:#7a5a2a; font-family:'Courier New',monospace; font-size:10px; padding:2px 8px; cursor:pointer; margin-top:6px; transition:all 0.2s; }
        .wallet-toggle-btn:hover { border-color:rgba(246,133,27,0.6); color:#f6851b; }
        .wallet-toggle-btn .wtb-arrow { transition:transform 0.2s; display:inline-block; }
        .wallet-toggle-btn.open .wtb-arrow { transform:rotate(180deg); }
        .wallet-connect-collapsible { display:none; }
        
        /* Admin inline controls */
        .admin-controls { display: inline-flex; gap: 4px; margin-left: 8px; }
        .admin-controls button { background: none; border: 1px solid rgba(255,68,68,0.3); color: #ff6b6b; padding: 1px 6px; border-radius: 3px; cursor: pointer; font-size: 10px; font-family: 'Courier New', monospace; }
        .admin-controls button:hover { background: rgba(255,68,68,0.1); border-color: #ff4444; }
        .admin-controls button.approve-btn { border-color: rgba(0,255,65,0.3); color: #00ff41; }
        .admin-controls button.approve-btn:hover { background: rgba(0,255,65,0.1); }
        
        /* Likes & Views */
        .post-actions { display: flex; align-items: center; gap: 12px; margin-top: 8px; clear: both; padding-top: 6px; }
        .like-btn { background: rgba(0,255,65,0.04); border: 1px solid rgba(0,255,65,0.15); border-radius: 4px; padding: 3px 10px; color: #6baf6b; font-size: 12px; cursor: pointer; font-family: 'Courier New', monospace; transition: all 0.2s; display: inline-flex; align-items: center; gap: 4px; }
        .like-btn:hover { border-color: #00ff41; color: #00ff41; background: rgba(0,255,65,0.08); transform: scale(1.05); }
        .like-btn.liked { border-color: #00ff41; color: #00ff41; background: rgba(0,255,65,0.12); text-shadow: 0 0 8px rgba(0,255,65,0.3); }
        .like-btn.liked:hover { background: rgba(255,68,68,0.08); border-color: #ff6b6b; color: #ff6b6b; }
        .like-count { font-weight: bold; }
        .view-count { color: #4a8f4a; font-size: 11px; display: inline-flex; align-items: center; gap: 3px; }
        .thread-footer .like-btn { padding: 2px 8px; font-size: 11px; }
        .thread-footer .view-count { font-size: 11px; }
        .thread-footer .tip-btn { padding: 2px 8px; font-size: 11px; }
        .thread-footer .goyim-bump-btn { padding: 2px 8px; font-size: 11px; }
        @keyframes likePopAnim { 0% { transform: scale(1); } 50% { transform: scale(1.3); } 100% { transform: scale(1); } }
        .like-pop { animation: likePopAnim 0.3s ease; }
        
        /* Share button */
        .share-wrap { position: relative; display: inline-block; }
        .share-btn { display: inline-flex; align-items: center; justify-content: center; gap: 4px; background: rgba(95,255,175,0.06); border: 1px solid rgba(95,255,175,0.2); border-radius: 4px; padding: 3px 10px; color: #5fffaf; font-size: 12px; cursor: pointer; font-family: 'Courier New', monospace; transition: all 0.2s; }
        .share-btn:hover { border-color: #7fffcf; color: #7fffcf; background: rgba(95,255,175,0.12); transform: scale(1.05); }
        .thread-footer .share-btn { padding: 2px 8px; font-size: 11px; }
        .share-dropdown { display: none; position: absolute; bottom: 100%; left: 0; margin-bottom: 6px; background: #0a0e0a; border: 1px solid rgba(0,255,65,0.25); border-radius: 6px; padding: 6px 0; min-width: 180px; z-index: 5000; box-shadow: 0 -4px 20px rgba(0,0,0,0.5); }
        .share-dropdown.active { display: block; animation: shareIn 0.15s ease-out; }
        @keyframes shareIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
        .share-dropdown a, .share-dropdown button { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 14px; background: none; border: none; color: #b0ffb0; font-size: 12px; font-family: 'Courier New', monospace; cursor: pointer; text-decoration: none; text-align: left; transition: background 0.15s; }
        .share-dropdown a:hover, .share-dropdown button:hover { background: rgba(0,255,65,0.06); color: #00ff41; text-decoration: none; }
        .share-dropdown .share-icon { width: 16px; text-align: center; font-size: 13px; flex-shrink: 0; }
        .share-dropdown .share-sep { height: 1px; background: rgba(0,255,65,0.1); margin: 4px 0; }
        .share-copied { color: #00ff41 !important; }
        
        /* Wallet / MetaMask */
        .wallet-connect-row { display: flex; align-items: center; gap: 8px; margin-top: 6px; flex-wrap: wrap; }
        .metamask-btn { display: inline-flex; align-items: center; gap: 6px; background: rgba(246,133,27,0.08); border: 1px solid rgba(246,133,27,0.3); border-radius: 4px; padding: 5px 12px; color: #f6851b; font-size: 12px; cursor: pointer; font-family: 'Courier New', monospace; transition: all 0.2s; }
        .metamask-btn:hover { border-color: #f6851b; background: rgba(246,133,27,0.15); }
        .metamask-btn.connected { border-color: #00ff41; color: #00ff41; background: rgba(0,255,65,0.06); }
        .metamask-btn svg { width: 16px; height: 16px; }
        .wallet-addr-display { font-size: 11px; color: #f6851b; background: rgba(246,133,27,0.06); padding: 2px 8px; border-radius: 3px; font-family: 'Courier New', monospace; }
        .wallet-addr-hidden { display: none; }
        .wallet-mm-panel { background: rgba(246,133,27,0.04); border: 1px solid rgba(246,133,27,0.2); border-radius: 6px; padding: 10px 12px; margin-top: 6px; width: 100%; box-sizing: border-box; }
        .wallet-mm-panel .wmp-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
        .wallet-mm-panel .wmp-row:last-child { margin-bottom: 0; }
        .wallet-mm-panel .wmp-label { color: #4a8f4a; font-size: 10px; text-transform: uppercase; min-width: 50px; }
        .wallet-mm-panel .wmp-value { color: #f6851b; font-family: 'Courier New', monospace; font-size: 12px; }
        .wallet-mm-panel .wmp-chain-tag { display: inline-flex; align-items: center; gap: 4px; background: rgba(0,255,65,0.06); border: 1px solid rgba(0,255,65,0.15); border-radius: 3px; padding: 2px 8px; font-size: 11px; color: #00ff41; font-family: 'Courier New', monospace; }
        .wallet-mm-panel .wmp-btn { background: none; border: 1px solid rgba(246,133,27,0.3); color: #f6851b; font-size: 10px; padding: 2px 8px; border-radius: 3px; cursor: pointer; font-family: 'Courier New', monospace; transition: all 0.2s; }
        .wallet-mm-panel .wmp-btn:hover { border-color: #f6851b; background: rgba(246,133,27,0.1); }
        .wallet-mm-manual { display: none; margin-top: 6px; width: 100%; box-sizing: border-box; }
        .wallet-chain-inputs { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
        .wci-row { display: flex; align-items: center; gap: 6px; }
        .wci-label { min-width: 52px; font-size: 11px; color: #4a8f4a; font-family: 'Courier New', monospace; white-space: nowrap; }
        .wci-input { flex: 1; background: rgba(246,133,27,0.04); border: 1px solid rgba(246,133,27,0.15); border-radius: 3px; color: #f6851b; font-family: 'Courier New', monospace; font-size: 11px; padding: 5px 8px; box-sizing: border-box; }
        .wci-input:focus { border-color: rgba(246,133,27,0.4); outline: none; }
        .wci-input[readonly] { opacity: 0.7; cursor: default; }
        .wallet-reveal-row { display: flex; align-items: center; justify-content: flex-end; margin-bottom: 4px; }
        .wallet-reveal-btn { background: none; border: 1px solid rgba(0,255,65,0.18); border-radius: 3px; color: #3a6a3a; font-size: 10px; font-family: 'Courier New', monospace; padding: 3px 9px; cursor: pointer; transition: all 0.2s; }
        .wallet-reveal-btn:hover { border-color: rgba(0,255,65,0.45); color: #00ff41; }
        .wallet-disconnect { background: none; border: 1px solid rgba(255,68,68,0.3); color: #ff6b6b; padding: 3px 10px; border-radius: 4px; cursor: pointer; font-size: 11px; font-family: 'Courier New', monospace; transition: all 0.2s; margin-left: auto; white-space: nowrap; }
        .wallet-disconnect:hover { background: rgba(255,68,68,0.12); border-color: #ff4444; color: #ff4444; box-shadow: 0 0 6px rgba(255,68,68,0.2); }
        .wallet-balance { font-size: 11px; color: #00ff41; font-family: 'Courier New', monospace; background: rgba(0,255,65,0.06); padding: 2px 8px; border-radius: 3px; }
        .wallet-bar { display: none; align-items: center; gap: 10px; padding: 9px 14px; margin-bottom: 12px; background: linear-gradient(90deg, rgba(246,133,27,0.05) 0%, rgba(0,10,0,0.4) 100%); border: 1px solid rgba(246,133,27,0.2); border-left: 3px solid rgba(246,133,27,0.5); border-radius: 6px; font-size: 12px; flex-wrap: wrap; position: relative; }
        .wallet-bar.active { display: flex; }
        .wallet-bar .wb-icon { font-size: 14px; flex-shrink: 0; }
        .wallet-bar .wb-addr { color: #f6851b; font-family: 'Courier New', monospace; cursor: pointer; font-weight: bold; letter-spacing: 0.5px; position: relative; user-select: none; }
        .wallet-bar .wb-addr:hover { color: #ffaa55; text-shadow: 0 0 8px rgba(246,133,27,0.4); }
        .wallet-bar .wb-addr::after { content: ' ▾'; font-size: 9px; opacity: 0.6; }
        .wallet-bar .wb-bal { color: #00ff41; font-weight: bold; font-family: 'Courier New', monospace; background: rgba(0,255,65,0.07); padding: 2px 8px; border-radius: 3px; font-size: 11px; }
        .wallet-bar .wb-network { color: #f6851b; font-size: 10px; background: rgba(246,133,27,0.08); border: 1px solid rgba(246,133,27,0.2); padding: 2px 7px; border-radius: 3px; font-family: 'Courier New', monospace; }
        .wb-menu { position: absolute; top: calc(100% + 6px); left: 0; z-index: 9999; background: #0a0e0a; border: 1px solid rgba(246,133,27,0.4); border-radius: 6px; min-width: 160px; box-shadow: 0 4px 16px rgba(0,0,0,0.6); overflow: hidden; }
        .wb-menu-item { display: block; padding: 7px 12px; font-size: 11px; font-family: 'Courier New', monospace; color: #ccc; cursor: pointer; white-space: nowrap; transition: background 0.15s, color 0.15s; }
        .wb-menu-item:hover { background: rgba(246,133,27,0.1); color: #f6851b; }
        .wb-menu-sep { border-top: 1px solid rgba(246,133,27,0.15); margin: 2px 0; }
        .wb-menu-label { display: block; padding: 5px 12px 3px; font-size: 9px; font-family: 'Courier New', monospace; color: #4a8f4a; text-transform: uppercase; letter-spacing: 1px; }
        .wb-chain-item { display: flex; align-items: center; gap: 6px; padding: 6px 12px; font-size: 11px; font-family: 'Courier New', monospace; color: #ccc; cursor: pointer; transition: background 0.15s; }
        .wb-chain-item:hover { background: rgba(246,133,27,0.08); color: #f6851b; }
        .wb-chain-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
        .post-wallet { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; color: #f6851b; background: rgba(246,133,27,0.06); padding: 1px 6px; border-radius: 3px; font-family: 'Courier New', monospace; cursor: pointer; transition: all 0.2s; }
        .post-wallet:hover { background: rgba(246,133,27,0.12); }

        /* $GOYIM holder badge on individual posts */
        .goyim-holder-badge { display: inline-flex; align-items: center; gap: 3px; font-size: 10px; font-weight: bold; color: #00ff41; background: rgba(0,255,65,0.08); border: 1px solid rgba(0,255,65,0.35); padding: 1px 7px; border-radius: 3px; font-family: 'Courier New', monospace; letter-spacing: 0.5px; }
        .goyim-holder-badge .gbadge-bal { color: #ffa500; font-size: 9px; opacity: 0.8; }
        /* Subtle green gradient glow on posts from $GOYIM holders */
        .holder-post { border-left: 2px solid rgba(0,255,65,0.5) !important; background: linear-gradient(90deg, rgba(0,255,65,0.04) 0%, transparent 40%) !important; }
        .holder-post .post-header::before { content: ''; display: none; }
        
        /* Tip button */
        .tip-btn { display: inline-flex; align-items: center; gap: 4px; background: rgba(246,133,27,0.06); border: 1px solid rgba(246,133,27,0.25); border-radius: 4px; padding: 3px 10px; color: #f6851b; font-size: 12px; cursor: pointer; font-family: 'Courier New', monospace; transition: all 0.2s; }
        .tip-btn:hover { border-color: #f6851b; background: rgba(246,133,27,0.15); transform: scale(1.05); }
        .tip-btn:active { transform: scale(0.95); }
        .reply-scroll-btn { display: inline-flex; align-items: center; gap: 4px; background: rgba(98,160,68,0.07); border: 1px solid rgba(98,160,68,0.3); border-radius: 4px; padding: 3px 10px; color: #62a044; font-size: 12px; cursor: pointer; font-family: 'Courier New', monospace; transition: all 0.2s; }
        .reply-scroll-btn:hover { border-color: #62a044; background: rgba(98,160,68,0.18); transform: scale(1.05); }
        .reply-scroll-btn:active { transform: scale(0.95); }
        /* ═══ GOYIM BUMP BUTTON ═══ */
        .goyim-bump-btn { display: inline-flex; align-items: center; gap: 4px; background: rgba(255,165,0,0.06); border: 1px solid rgba(255,165,0,0.3); border-radius: 4px; padding: 3px 10px; color: #ffa500; font-size: 12px; cursor: pointer; font-family: 'Courier New', monospace; transition: all 0.2s; }
        .goyim-bump-btn:hover { border-color: #ffa500; background: rgba(255,165,0,0.15); transform: scale(1.05); }
        .goyim-bump-btn .gbump-count { color: #cc7700; margin-left: 2px; font-size: 10px; }
        /* GOYIM bump modal */
        .gbump-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.85); z-index: 12000; justify-content: center; align-items: center; }
        .gbump-overlay.active { display: flex; }
        .gbump-modal { background: #080c08; border: 1px solid rgba(255,165,0,0.5); border-radius: 10px; padding: 26px; max-width: 400px; width: 92%; }
        .gbump-modal h3 { color: #ffa500; font-family: 'Courier New',monospace; font-size: 15px; letter-spacing: 2px; margin: 0 0 6px; text-align: center; }
        .gbump-modal .gbump-sub { color: #6a6040; font-family: 'Courier New',monospace; font-size: 10px; text-align: center; margin: 0 0 14px; line-height: 1.6; }
        .gbump-amounts { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; margin-bottom: 12px; }
        .gbump-amt { background: rgba(255,165,0,0.06); border: 1px solid rgba(255,165,0,0.25); border-radius: 5px; padding: 7px 14px; color: #ffa500; cursor: pointer; font-family: 'Courier New',monospace; font-size: 12px; transition: all 0.2s; }
        .gbump-amt:hover, .gbump-amt.selected { background: rgba(255,165,0,0.2); border-color: #ffa500; }
        .gbump-custom { width: 100%; background: rgba(255,165,0,0.04); border: 1px solid rgba(255,165,0,0.2); border-radius: 4px; color: #ffa500; font-family: 'Courier New',monospace; font-size: 13px; padding: 7px 12px; margin-bottom: 10px; box-sizing: border-box; text-align: center; }
        .gbump-custom::placeholder { color: rgba(255,165,0,0.3); }
        .gbump-send-btn { width: 100%; padding: 10px; background: #ffa500; color: #0a0e0a; border: none; border-radius: 5px; font-family: 'Courier New',monospace; font-weight: bold; font-size: 14px; cursor: pointer; transition: background 0.2s; margin-top: 4px; letter-spacing: 1px; }
        .gbump-send-btn:hover { background: #ffb733; }
        .gbump-send-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .gbump-info-box { background: rgba(255,165,0,0.05); border: 1px solid rgba(255,165,0,0.15); border-radius: 4px; padding: 8px 10px; margin-bottom: 12px; font-family: 'Courier New',monospace; font-size: 10px; color: #7a6040; line-height: 1.7; }
        .gbump-close { text-align: center; margin-top: 12px; color: #4a6a3a; font-family: 'Courier New',monospace; font-size: 12px; cursor: pointer; }
        .gbump-close:hover { color: #00ff41; }
        .gbump-status { font-family: 'Courier New',monospace; font-size: 12px; text-align: center; min-height: 16px; margin: 8px 0 0; }
        .tip-modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); z-index: 11000; justify-content: center; align-items: center; }
        .tip-modal-overlay.active { display: flex; }
        .tip-modal { background: #0a0e0a; border: 1px solid rgba(246,133,27,0.4); border-radius: 10px; padding: 25px; max-width: 420px; width: 90%; text-align: center; }
        .tip-modal h3 { color: #f6851b; margin: 0 0 12px; font-family: 'Courier New', monospace; }
        .tip-chain-selector { display: flex; gap: 6px; justify-content: center; margin: 10px 0 14px; flex-wrap: wrap; }
        .tip-chain-btn { background: rgba(246,133,27,0.04); border: 1px solid rgba(246,133,27,0.15); border-radius: 6px; padding: 6px 12px; color: #6baf6b; cursor: pointer; font-family: 'Courier New', monospace; font-size: 11px; transition: all 0.2s; display: flex; align-items: center; gap: 4px; }
        .tip-chain-btn:hover { border-color: rgba(246,133,27,0.4); background: rgba(246,133,27,0.08); }
        .tip-chain-btn.active { border-color: #f6851b; color: #f6851b; background: rgba(246,133,27,0.12); box-shadow: 0 0 8px rgba(246,133,27,0.15); }
        .tip-chain-btn .chain-dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; }
        .tip-chain-btn.disabled { opacity: 0.3; cursor: not-allowed !important; pointer-events: none; }
        .tip-chain-current { font-size: 11px; color: #4a8f4a; margin: 0 0 8px; font-family: 'Courier New', monospace; }
        .tip-chain-current span { color: #f6851b; }
        .tip-modal .tip-amounts { display: flex; gap: 8px; justify-content: center; margin: 12px 0; flex-wrap: wrap; }
        .tip-modal .tip-amount { background: rgba(246,133,27,0.06); border: 1px solid rgba(246,133,27,0.25); border-radius: 6px; padding: 8px 14px; color: #f6851b; cursor: pointer; font-family: 'Courier New', monospace; font-size: 13px; transition: all 0.2s; }
        .tip-modal .tip-amount:hover, .tip-modal .tip-amount.selected { background: rgba(246,133,27,0.2); border-color: #f6851b; }
        .tip-modal .tip-custom { width: 100%; background: rgba(246,133,27,0.04); border: 1px solid rgba(246,133,27,0.2); border-radius: 4px; color: #f6851b; font-family: 'Courier New', monospace; font-size: 13px; padding: 8px 12px; margin: 10px 0; box-sizing: border-box; text-align: center; }
        .tip-modal .tip-custom::placeholder { color: rgba(246,133,27,0.3); }
        .tip-modal .tip-send-btn { width: 100%; padding: 10px; background: #f6851b; color: #0a0e0a; border: none; border-radius: 6px; font-family: 'Courier New', monospace; font-weight: bold; font-size: 14px; cursor: pointer; margin-top: 8px; transition: background 0.2s; }
        .tip-modal .tip-send-btn:hover { background: #ff9b40; }
        .tip-modal .tip-close { color: #4a8f4a; font-size: 12px; cursor: pointer; margin-top: 12px; display: inline-block; }
        .tip-modal .tip-close:hover { color: #00ff41; }

        /* Expanded image */
        .expanded-img { max-width: 90vw; max-height: 85vh; position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 10000; border: 2px solid #00ff41; border-radius: 5px; box-shadow: 0 0 40px rgba(0,0,0,0.9); cursor: zoom-out; }
        .img-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.85); z-index: 9999; cursor: zoom-out; }
        .clearfix::after { content: ''; display: table; clear: both; }
        
        /* Board footer */
        .board-footer { text-align: center; padding: 30px 15px; color: #3a6f3a; font-size: 12px; }
        .board-footer a { color: #4a8f4a; text-decoration: none; }
        .board-footer a:hover { color: #00ff41; }
        .footer-online { color: #4a8f4a; }
        .footer-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #00ff41; vertical-align: middle; box-shadow: 0 0 4px rgba(0,255,65,0.5); }
        
        /* Pagination */
        .board-pagination { text-align: center; padding: 15px 10px; margin: 10px 0; border-top: 1px solid rgba(0,255,65,0.1); border-bottom: 1px solid rgba(0,255,65,0.1); background: rgba(0,10,0,0.3); }
        .board-pagination .page-btn { display: inline-block; padding: 4px 10px; margin: 0 2px; color: #4a8f4a; text-decoration: none; font-family: monospace; font-size: 13px; border: 1px solid rgba(0,255,65,0.15); background: rgba(0,20,0,0.4); transition: all 0.2s; cursor: pointer; }
        .board-pagination .page-btn:hover { color: #00ff41; border-color: rgba(0,255,65,0.4); background: rgba(0,40,0,0.5); text-shadow: 0 0 8px rgba(0,255,65,0.3); }
        .board-pagination .page-btn.current { color: #00ff41; border-color: #00ff41; background: rgba(0,60,0,0.5); font-weight: bold; text-shadow: 0 0 10px rgba(0,255,65,0.4); }
        .board-pagination .page-btn.disabled { color: #2a4f2a; border-color: rgba(0,255,65,0.06); cursor: default; }
        .board-pagination .page-ellipsis { display: inline-block; padding: 4px 6px; color: #3a6f3a; font-family: monospace; }
        .board-pagination .page-info { display: inline-block; margin-left: 12px; color: #3a6f3a; font-size: 11px; font-family: monospace; }

        .empty-board { text-align: center; padding: 60px 20px; color: #3a6f3a; }

        /* ═══ VIEW MODE + SORT TOGGLE ═══ */
        .view-mode-bar { display: flex; align-items: center; gap: 5px; margin-bottom: 12px; flex-wrap: wrap; background: rgba(0,8,0,0.35); border: 1px solid rgba(0,255,65,0.08); border-radius: 6px; padding: 6px 10px; }
        .vmb-mobile-toggle { display: none; width: 100%; align-items: center; justify-content: space-between; background: rgba(0,8,0,0.35); border: 1px solid rgba(0,255,65,0.08); border-radius: 6px; padding: 8px 12px; margin-bottom: 6px; color: #4a8f4a; font-size: 11px; font-family: 'Courier New', monospace; letter-spacing: 0.8px; text-transform: uppercase; cursor: pointer; box-sizing: border-box; }
        #vmbToggleArrow { font-size: 16px; line-height: 1; }
        .vmb-mobile-toggle:hover { color: #00ff41; border-color: rgba(0,255,65,0.2); }
        @media (max-width: 768px) {
            .vmb-mobile-toggle { display: flex; }
            .view-mode-bar.vmb-collapsed { display: none !important; }
        }
        .media-pending-small { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: #6baf6b; background: rgba(0,255,65,0.03); border: 1px dashed rgba(0,255,65,0.12); border-radius: 4px; padding: 4px 8px; margin: 4px 0 6px; font-family: 'Courier New', monospace; }
        .media-pending-admin { flex-wrap: wrap; gap: 6px; color: #ff8c00; border-color: rgba(255,140,0,0.3); background: rgba(255,140,0,0.04); }
        .view-mode-btn { display: inline-flex; align-items: center; gap: 5px; background: rgba(0,20,0,0.4); border: 1px solid rgba(0,255,65,0.12); border-radius: 4px; padding: 5px 13px; color: #4a8f4a; font-family: 'Courier New', monospace; font-size: 12px; cursor: pointer; text-decoration: none; transition: all 0.2s; white-space: nowrap; }
        .view-mode-btn:hover { border-color: rgba(0,255,65,0.4); color: #00ff41; background: rgba(0,40,0,0.5); }
        .view-mode-btn.active { color: #00ff41; border-color: rgba(0,255,65,0.55); background: rgba(0,50,0,0.5); font-weight: bold; text-shadow: 0 0 8px rgba(0,255,65,0.3); }
        .view-mode-sep { color: #1a3a1a; font-size: 10px; }
        .sort-mode-sep2 { width: 1px; height: 16px; background: rgba(0,255,65,0.12); margin: 0 3px; align-self: center; flex-shrink: 0; }
        .sort-mode-label { font-size: 9px; color: #2a5a2a; font-family: 'Courier New', monospace; text-transform: uppercase; letter-spacing: 1px; padding: 0 2px; white-space: nowrap; }
        .sort-mode-btn { display: inline-flex; align-items: center; gap: 4px; background: rgba(0,20,0,0.4); border: 1px solid rgba(0,255,65,0.1); border-radius: 4px; padding: 5px 10px; color: #3a6a3a; font-family: 'Courier New', monospace; font-size: 11px; cursor: pointer; transition: all 0.2s; white-space: nowrap; }
        .sort-mode-btn:hover { border-color: rgba(0,255,65,0.35); color: #00ff41; background: rgba(0,40,0,0.5); }
        .sort-mode-btn.active { color: #00ff41; border-color: rgba(0,210,65,0.55); background: rgba(0,45,0,0.55); font-weight: bold; text-shadow: 0 0 8px rgba(0,255,65,0.3); box-shadow: inset 0 0 8px rgba(0,255,65,0.04); }
        /* ─── Theme selector ─── */
        .theme-sep { width: 1px; height: 16px; background: rgba(0,255,65,0.12); margin: 0 4px; align-self: center; flex-shrink: 0; }
        .theme-label { font-size: 9px; color: #2a5a2a; font-family: 'Courier New', monospace; text-transform: uppercase; letter-spacing: 1px; padding: 0 2px; white-space: nowrap; }
        .theme-select { background: rgba(0,20,0,0.4); border: 1px solid rgba(0,255,65,0.12); border-radius: 4px; padding: 4px 22px 4px 8px; color: #4a8f4a; font-family: 'Courier New', monospace; font-size: 11px; cursor: pointer; transition: all 0.2s; -webkit-appearance: none; appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%234a8f4a'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 7px center; white-space: nowrap; min-height: 28px; }
        .theme-select:hover { border-color: rgba(0,255,65,0.4); color: #00ff41; }
        .theme-select:focus { outline: none; border-color: rgba(0,255,65,0.5); }
        .theme-select option { background: #060e06; color: #00ff41; }
        /* ─── READ MODE THEME ─── */
        body[data-theme="read"] { background: #f2ece0 !important; color: #2c2010 !important; }
        body[data-theme="read"] #matrix-canvas, body[data-theme="read"] #star-canvas { opacity: 0 !important; pointer-events: none !important; }
        body[data-theme="read"] .top-nav { background: #e8e0cf !important; border-top: none !important; border-bottom: 1px solid #cfc4ae !important; box-shadow: none !important; }
        body[data-theme="read"] .nav-branding .logo { color: #4a3018 !important; text-shadow: none !important; }
        body[data-theme="read"] .nav-branding .tagline { color: #7a6040 !important; }
        body[data-theme="read"] .nav-link { color: #4a3018 !important; text-shadow: none !important; border-color: rgba(92,61,14,0.3) !important; background: transparent !important; box-shadow: none !important; }
        body[data-theme="read"] .nav-link:hover { color: #2c1808 !important; text-shadow: none !important; border-color: rgba(92,61,14,0.55) !important; background: rgba(92,61,14,0.06) !important; box-shadow: none !important; }
        body[data-theme="read"] .nav-minimize-btn { background: #e4d8c4 !important; border-color: #cfc4ae !important; color: #7a6040 !important; box-shadow: none !important; backdrop-filter: none !important; }
        body[data-theme="read"] .nav-minimize-btn:hover { background: #d8cbb4 !important; border-color: #a07030 !important; color: #4a3018 !important; box-shadow: none !important; }
        body[data-theme="read"] .nav-dropdown { background: #ede4d2 !important; border-color: #d8c8ae !important; box-shadow: 0 4px 12px rgba(0,0,0,0.12) !important; }
        body[data-theme="read"] .nav-dropdown a, body[data-theme="read"] .nav-dropdown li a { color: #4a3018 !important; text-shadow: none !important; }
        body[data-theme="read"] .nav-dropdown a:hover, body[data-theme="read"] .nav-dropdown li a:hover { background: #e0d4c0 !important; color: #2c1808 !important; }
        body[data-theme="read"] .inner-wrap { background: transparent !important; }
        body[data-theme="read"] .thread { background: #fff8ee !important; }
        body[data-theme="read"] .thread:not(.boost-1):not(.boost-2):not(.boost-3) { border-color: #d8c8ae !important; box-shadow: 0 1px 4px rgba(0,0,0,0.08) !important; }
        body[data-theme="read"] .thread { border-left-color: #d8c8ae !important; }
        body[data-theme="read"] .thread.sticky { border-color: #c07020 !important; }
        body[data-theme="read"] .thread-op { border-bottom-color: #e0d0ba !important; }
        body[data-theme="read"] .thread-reply { background: #f4ede0 !important; border-color: #d8c8ae !important; }
        body[data-theme="read"] .post-comment { color: #2c2010 !important; font-size: 14px !important; line-height: 1.85 !important; }
        body[data-theme="read"] .post-comment .greentext { color: #5a7020 !important; }
        body[data-theme="read"] .post-comment a, body[data-theme="read"] .post-comment .post-ref { color: #7a3a10 !important; }
        body[data-theme="read"] .post-comment a:hover, body[data-theme="read"] .post-comment .post-ref:hover { color: #b05010 !important; text-decoration: underline; }
        body[data-theme="read"] .post-subject { color: #5c2e08 !important; text-shadow: none !important; }
        body[data-theme="read"] .post-anon { color: #374a10 !important; }
        body[data-theme="read"] .post-anon-id { color: #6a5838 !important; background: rgba(92,61,14,0.08) !important; }
        body[data-theme="read"] .post-time, body[data-theme="read"] .post-no { color: #9a8060 !important; }
        body[data-theme="read"] .post-no:hover { color: #5c2e08 !important; }
        body[data-theme="read"] .post-image-container img { border-color: #d8c8ae !important; }
        body[data-theme="read"] .post-backlinks a { color: #7a3a10 !important; }
        body[data-theme="read"] .thread-footer { background: #ede4d2 !important; border-top-color: #d8c8ae !important; }
        body[data-theme="read"] .tf-stats { color: #7a6848 !important; }
        body[data-theme="read"] .tf-stats .ts-num { color: #5c2e08 !important; }
        body[data-theme="read"] .thread-link { color: #7a3a10 !important; }
        body[data-theme="read"] #backToBoard { color: #7a3a10 !important; }
        body[data-theme="read"] .post-voice-note { background: rgba(92,61,14,0.04) !important; border-color: #d8c8ae !important; }
        body[data-theme="read"] .pvn-label { color: #7a6848 !important; }
        body[data-theme="read"] .post-video-clip video { border-color: #d8c8ae !important; }
        body[data-theme="read"] .pvc-label { color: #7a6848 !important; }
        body[data-theme="read"] .post-image-info { color: #7a6848 !important; }
        body[data-theme="read"] .replies-hidden-note { color: #7a6848 !important; }
        body[data-theme="read"] .tip-disclaimer { background: rgba(92,61,14,0.05) !important; border-color: #d8c8ae !important; }
        body[data-theme="read"] .tip-disclaimer .tip-text { color: #6a5030 !important; }
        body[data-theme="read"] .tip-disclaimer .tip-text strong { color: #3e2008 !important; }
        body[data-theme="read"] .tip-disclaimer .tip-text a { color: #7a3a10 !important; }
        body[data-theme="read"] .tip-disclaimer .tip-text a:hover { color: #4a1e04 !important; }
        body[data-theme="read"] .pvn-audio audio, body[data-theme="read"] .post-video-clip video { accent-color: #8a6a30; }
        body[data-theme="read"] .pvn-audio audio::-webkit-media-controls-panel,
        body[data-theme="read"] .post-video-clip video::-webkit-media-controls-panel { background: rgba(238,226,206,0.97); }
        body[data-theme="read"] .pvn-audio audio::-webkit-media-controls-time-remaining-display,
        body[data-theme="read"] .pvn-audio audio::-webkit-media-controls-current-time-display,
        body[data-theme="read"] .post-video-clip video::-webkit-media-controls-time-remaining-display,
        body[data-theme="read"] .post-video-clip video::-webkit-media-controls-current-time-display { color: #5c3a10; }
        /* Warm brown icons on read mode's parchment panel */
        body[data-theme="read"] .pvn-audio audio::-webkit-media-controls-play-button,
        body[data-theme="read"] .pvn-audio audio::-webkit-media-controls-mute-button,
        body[data-theme="read"] .post-video-clip video::-webkit-media-controls-play-button,
        body[data-theme="read"] .post-video-clip video::-webkit-media-controls-mute-button,
        body[data-theme="read"] .post-video-clip video::-webkit-media-controls-fullscreen-button,
        body[data-theme="read"] .post-video-clip video::-webkit-media-controls-overflow-button {
            filter: brightness(0) saturate(100%) invert(28%) sepia(55%) saturate(520%) hue-rotate(12deg) brightness(82%);
        }
        body[data-theme="read"] .reply.hot-10 { border-left-color: rgba(160,80,30,0.35) !important; }
        body[data-theme="read"] .reply.hot-100 { border-left-color: rgba(180,100,20,0.45) !important; background: rgba(92,61,14,0.025) !important; }
        body[data-theme="read"] .reply.hot-1000 { border-left-color: rgba(200,60,20,0.45) !important; background: rgba(92,30,10,0.030) !important; }
        body[data-theme="read"] .view-mode-bar { background: #ede4d2 !important; border-color: #d8c8ae !important; }
        body[data-theme="read"] .view-mode-btn { background: #e4d8c4 !important; border-color: #cfc4ae !important; color: #4a3018 !important; text-shadow: none !important; }
        body[data-theme="read"] .view-mode-btn:hover { background: #d8cbb4 !important; color: #2c1808 !important; }
        body[data-theme="read"] .view-mode-btn.active { background: #d0c0a0 !important; border-color: #a89060 !important; color: #2c1808 !important; box-shadow: none !important; text-shadow: none !important; }
        body[data-theme="read"] .sort-mode-btn { background: #e4d8c4 !important; border-color: #cfc4ae !important; color: #6a5838 !important; text-shadow: none !important; }
        body[data-theme="read"] .sort-mode-btn:hover { color: #2c1808 !important; background: #d8cbb4 !important; }
        body[data-theme="read"] .sort-mode-btn.active { background: #d0c0a0 !important; border-color: #a89060 !important; color: #2c1808 !important; box-shadow: none !important; text-shadow: none !important; }
        body[data-theme="read"] .sort-mode-label, body[data-theme="read"] .theme-label { color: #9a8060 !important; }
        body[data-theme="read"] .sort-mode-sep2, body[data-theme="read"] .theme-sep { background: #d8c8ae !important; }
        body[data-theme="read"] .theme-select { background-color: #e4d8c4 !important; border-color: #cfc4ae !important; color: #4a3018 !important; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%234a3018'/%3E%3C/svg%3E") !important; }
        body[data-theme="read"] .theme-select option { background: #f2ece0 !important; color: #2c2010 !important; }
        body[data-theme="read"] .post-form-container { background: #ede4d2 !important; border-color: #d8c8ae !important; }
        body[data-theme="read"] .post-form-container::before, body[data-theme="read"] .post-form-container::after { opacity: 0 !important; }
        body[data-theme="read"] .quick-reply { background: #ede4d2 !important; border-top-color: #d8c8ae !important; }
        body[data-theme="read"] input[type=text], body[data-theme="read"] input[type=email], body[data-theme="read"] textarea { background: #fffaf2 !important; border-color: #d8c8ae !important; color: #2c2010 !important; }
        body[data-theme="read"] .post-preview-float { background: #fff8ee !important; border-color: #d8c8ae !important; box-shadow: 0 4px 20px rgba(0,0,0,0.12) !important; }
        body[data-theme="read"] .post-preview-float .post-comment { color: #2c2010 !important; }
        body[data-theme="read"] .mrb-aplayer { background: rgba(92,61,14,0.06) !important; border-color: #d8c8ae !important; }
        body[data-theme="read"] .mrb-aplay { border-color: #a89060 !important; color: #5c2e08 !important; }
        body[data-theme="read"] .mrb-aprog { background: rgba(92,61,14,0.12) !important; }
        body[data-theme="read"] .mrb-abar { background: #a07030 !important; }
        body[data-theme="read"] .mrb-atime { color: #7a6040 !important; }
        /* ── Read mode: top nav item active states ── */
        body[data-theme="read"] .nav-item .nav-link.active,
        body[data-theme="read"] .nav-item.active > .nav-link { color: #2c1808 !important; }
        /* ── Read mode: atmospheric FX off ── */
        body[data-theme="read"] .occult-symbols,
        body[data-theme="read"] .scanlines,
        body[data-theme="read"] .vignette,
        body[data-theme="read"] .sigil-watermark,
        body[data-theme="read"] .matrix-bg,
        body[data-theme="read"] .header-bg-overlay { opacity: 0 !important; pointer-events: none !important; }
        /* ── Read mode: live bar ── */
        body[data-theme="read"] .live-bar { background: #ede4d2 !important; border-color: #d8c8ae !important; color: #4a3018 !important; }
        body[data-theme="read"] .live-bar .refresh-btn { background: #e4d8c4 !important; border-color: #cfc4ae !important; color: #4a3018 !important; }
        body[data-theme="read"] .live-bar .refresh-btn:hover { background: #d8cbb4 !important; color: #2c1808 !important; border-color: #a89060 !important; }
        body[data-theme="read"] .live-bar .auto-label { color: #7a6040 !important; }
        body[data-theme="read"] .live-bar .auto-label input[type="checkbox"] { border-color: rgba(92,61,14,0.3) !important; background: #f2ece0 !important; }
        body[data-theme="read"] .live-bar .auto-label input[type="checkbox"]:checked { background: #e4d8c4 !important; border-color: #a07030 !important; }
        body[data-theme="read"] .live-bar .auto-label input[type="checkbox"]:checked::after { color: #7a3a10 !important; }
        body[data-theme="read"] .live-bar .live-status { color: #7a6040 !important; }
        body[data-theme="read"] .live-bar .live-dot { background: #a07030 !important; }
        body[data-theme="read"] .live-bar .live-dot.active { background: #c07020 !important; box-shadow: 0 0 6px rgba(192,112,32,0.4) !important; }
        /* ── Read mode: action buttons ── */
        body[data-theme="read"] .reply-toggle { background: rgba(92,46,8,0.05) !important; border-color: rgba(92,46,8,0.18) !important; color: #5c3818 !important; text-shadow: none !important; }
        body[data-theme="read"] .reply-toggle:hover { background: rgba(92,46,8,0.1) !important; border-color: #a07030 !important; color: #2c1808 !important; }
        body[data-theme="read"] .reply { border-top-color: rgba(92,61,14,0.08) !important; }
        body[data-theme="read"] .reply::before { background: rgba(92,61,14,0.15) !important; }
        body[data-theme="read"] .like-btn { background: rgba(92,46,8,0.05) !important; border-color: rgba(92,46,8,0.15) !important; color: #5c3818 !important; text-shadow: none !important; }
        body[data-theme="read"] .like-btn:hover { background: rgba(92,46,8,0.1) !important; border-color: #a07030 !important; color: #2c1808 !important; }
        body[data-theme="read"] .like-btn.liked { border-color: #a07030 !important; color: #7a3a10 !important; background: rgba(92,46,8,0.1) !important; text-shadow: none !important; }
        body[data-theme="read"] .share-btn { background: rgba(92,46,8,0.05) !important; border-color: rgba(92,46,8,0.15) !important; color: #5c3818 !important; text-shadow: none !important; box-shadow: none !important; outline: none !important; }
        body[data-theme="read"] .share-btn:hover { background: rgba(92,46,8,0.1) !important; color: #2c1808 !important; border-color: #a07030 !important; box-shadow: none !important; transform: none !important; outline: none !important; }
        body[data-theme="read"] .share-btn:focus, body[data-theme="read"] .share-btn:active { box-shadow: none !important; outline: none !important; border-color: rgba(92,46,8,0.25) !important; }
        body[data-theme="read"] .share-dropdown { background: #ede4d2 !important; border-color: #d8c8ae !important; box-shadow: 0 -4px 12px rgba(0,0,0,0.1) !important; }
        body[data-theme="read"] .share-dropdown a, body[data-theme="read"] .share-dropdown button { color: #4a3018 !important; }
        body[data-theme="read"] .share-dropdown a:hover, body[data-theme="read"] .share-dropdown button:hover { background: rgba(92,46,8,0.08) !important; color: #2c1808 !important; }
        body[data-theme="read"] .share-dropdown .share-sep { background: #d8c8ae !important; }
        body[data-theme="read"] .share-copied { color: #5c7020 !important; }
        body[data-theme="read"] .share-dropdown { background: #ede4d2 !important; border-color: #d8c8ae !important; box-shadow: 0 -4px 12px rgba(0,0,0,0.1) !important; }
        body[data-theme="read"] .share-dropdown a, body[data-theme="read"] .share-dropdown button { color: #4a3018 !important; }
        body[data-theme="read"] .share-dropdown a:hover, body[data-theme="read"] .share-dropdown button:hover { background: rgba(92,46,8,0.08) !important; color: #2c1808 !important; }
        body[data-theme="read"] .share-dropdown .share-sep { background: #d8c8ae !important; }
        body[data-theme="read"] .share-copied { color: #5c7020 !important; }
        /* ── Read mode: catalog ── */
        body[data-theme="read"] .catalog-card { background: #fdf7ee !important; border-color: #d8c8ae !important; box-shadow: 0 1px 4px rgba(0,0,0,0.07) !important; }
        body[data-theme="read"] .catalog-card:hover { border-color: #a89060 !important; box-shadow: 0 3px 10px rgba(0,0,0,0.13) !important; }
        body[data-theme="read"] .catalog-thumb { background: #f0e8d8 !important; }
        body[data-theme="read"] .catalog-thumb-none { color: #c0a070 !important; }
        body[data-theme="read"] .catalog-subject { color: #5c2e08 !important; text-shadow: none !important; }
        body[data-theme="read"] .catalog-comment { color: #3a2010 !important; }
        body[data-theme="read"] .catalog-info { background: transparent !important; }
        body[data-theme="read"] .catalog-stats { color: #7a6040 !important; background: #f4ede0 !important; border-top-color: #e0d0ba !important; }
        body[data-theme="read"] .catalog-stats .cs-val { color: #5c2e08 !important; }
        /* ── Read mode: media rec bar ── */
        body[data-theme="read"] .media-rec-bar { background: transparent !important; border: none !important; }
        body[data-theme="read"] .media-rec-bar-label { color: #7a6040 !important; }
        body[data-theme="read"] .mrb-body { background: transparent !important; }
        body[data-theme="read"] .mrb-btn { background: #e4d8c4 !important; border-color: #cfc4ae !important; color: #4a3018 !important; }
        body[data-theme="read"] .mrb-btn:hover { background: #d8cbb4 !important; }
        body[data-theme="read"] .mrb-status { color: #7a6040 !important; }
        /* ── Read mode: board stats bar ── */
        body[data-theme="read"] .board-subtitle { color: #7a6848 !important; }
        body[data-theme="read"] .tagline { color: #7a6848 !important; }
        body[data-theme="read"] .board-stats { background: rgba(92,61,14,0.04) !important; border-color: rgba(92,61,14,0.12) !important; color: #7a6040 !important; }
        body[data-theme="read"] .board-stats { color: #7a6040 !important; background: rgba(92,61,14,0.04) !important; border-color: rgba(92,61,14,0.12) !important; }
        body[data-theme="read"] .board-stats .stat-val { color: #5c2e08 !important; }
        body[data-theme="read"] .board-stats .stat-sep { color: #c0a880 !important; }
        body[data-theme="read"] .board-stats .online-dot { background: #c07020 !important; box-shadow: 0 0 5px rgba(192,112,32,0.4) !important; animation: none !important; }
        body[data-theme="read"] .board-stats .stat-moderated { color: #b06020 !important; }
        body[data-theme="read"] .board-stats .stat-moderated { color: #a06010 !important; }
        body[data-theme="read"] .board-msg { background: rgba(92,46,8,0.06) !important; border-color: rgba(92,46,8,0.2) !important; color: #4a3018 !important; }
        body[data-theme="read"] .board-msg.error { background: rgba(140,30,10,0.08) !important; border-color: rgba(140,30,10,0.25) !important; color: #6a1808 !important; }
        /* ── Read mode: wallet widget ── */
        body[data-theme="read"] .wallet-widget-btn { background: #e4d8c4 !important; border-color: #cfc4ae !important; color: #4a3018 !important; text-shadow: none !important; }
        body[data-theme="read"] .wallet-widget-btn:hover { background: #d8cbb4 !important; border-color: #a07030 !important; box-shadow: none !important; }
        body[data-theme="read"] .wallet-widget-btn.connected { border-color: rgba(92,61,14,0.4) !important; color: #5c2e08 !important; background: rgba(92,61,14,0.06) !important; box-shadow: none !important; }
        body[data-theme="read"] .wallet-widget-btn.connected::before { background: rgba(160,112,48,0.55) !important; animation: none !important; }
        body[data-theme="read"] .wallet-widget-btn.connected:hover { background: rgba(92,61,14,0.1) !important; box-shadow: 0 0 8px rgba(160,112,48,0.2) !important; border-color: #a07030 !important; }
        body[data-theme="read"] .wallet-panel { background: #ede4d2 !important; border-color: #d8c8ae !important; box-shadow: 0 4px 20px rgba(0,0,0,0.12) !important; color: #2c2010 !important; }
        /* ── Read mode: wallet panel (wp-*) internals ── */
        body[data-theme="read"] .wp-header { background: rgba(92,61,14,0.06) !important; border-bottom-color: #d8c8ae !important; }
        body[data-theme="read"] .wp-dot { background: #a07030 !important; box-shadow: none !important; }
        body[data-theme="read"] .wp-label { color: #9a7050 !important; }
        body[data-theme="read"] .wp-disconnect { border-color: rgba(160,40,20,0.3) !important; color: #8a4030 !important; }
        body[data-theme="read"] .wp-disconnect:hover { border-color: rgba(160,40,20,0.6) !important; color: #cc4030 !important; background: rgba(160,40,20,0.08) !important; box-shadow: none !important; }
        body[data-theme="read"] .wp-address { color: #7a4018 !important; text-shadow: none !important; }
        body[data-theme="read"] .wp-copy-btn { border-color: rgba(92,61,14,0.2) !important; color: #9a7050 !important; }
        body[data-theme="read"] .wp-copy-btn:hover { border-color: rgba(92,61,14,0.45) !important; color: #5c2e08 !important; background: rgba(92,61,14,0.06) !important; }
        body[data-theme="read"] .wp-network-tag { color: #7a4018 !important; background: rgba(92,46,8,0.08) !important; border-color: rgba(92,46,8,0.2) !important; }
        body[data-theme="read"] .wp-switch-btn { border-color: rgba(92,61,14,0.2) !important; color: #7a6040 !important; }
        body[data-theme="read"] .wp-switch-btn:hover { border-color: rgba(92,61,14,0.45) !important; color: #4a3018 !important; background: rgba(92,61,14,0.06) !important; }
        body[data-theme="read"] .wp-network-list { border-top-color: rgba(92,61,14,0.12) !important; }
        body[data-theme="read"] .wp-net-item { color: rgba(92,61,14,0.65) !important; }
        body[data-theme="read"] .wp-net-item:hover { background: rgba(92,61,14,0.07) !important; color: #4a3018 !important; }
        body[data-theme="read"] .wp-net-item.active { color: #5c2e08 !important; }
        body[data-theme="read"] .wp-balance-label { color: #9a8060 !important; }
        body[data-theme="read"] .wp-balance-value { color: #5c2e08 !important; }
        body[data-theme="read"] .wp-expand-btn { background: rgba(92,61,14,0.04) !important; border-top-color: rgba(92,61,14,0.12) !important; border-bottom-color: rgba(92,61,14,0.12) !important; color: #9a8060 !important; }
        body[data-theme="read"] .wp-expand-btn:hover, body[data-theme="read"] .wp-expand-btn.active { background: rgba(92,61,14,0.08) !important; color: #5c2e08 !important; }
        body[data-theme="read"] .all-balances-panel::-webkit-scrollbar-thumb { background: rgba(92,61,14,0.2) !important; }
        body[data-theme="read"] .balance-row { color: rgba(92,46,8,0.75) !important; }
        body[data-theme="read"] .wp-drag-handle span { background: rgba(92,61,14,0.18) !important; }
        /* ── Read mode: mobile bottom-sheet wallet panel ── */
        @media (max-width: 768px) {
            body[data-theme="read"] .wallet-panel {
                background: #f0e8d8 !important;
                border-top: 2px solid #d8c8ae !important;
                border-top-color: #d8c8ae !important;
                box-shadow: 0 -4px 20px rgba(0,0,0,0.08) !important;
            }
        }
        body[data-theme="read"] .balance-row:hover { background: rgba(92,61,14,0.06) !important; }
        /* ── Read mode: wallet-bar (connected wallet status bar) ── */
        body[data-theme="read"] .wallet-bar { background: linear-gradient(90deg, rgba(160,80,30,0.06), #ede4d2) !important; border-color: rgba(160,80,30,0.25) !important; border-left-color: rgba(160,80,30,0.5) !important; }
        body[data-theme="read"] .wallet-bar .wb-bal { color: #5c2e08 !important; background: rgba(92,46,8,0.08) !important; }
        body[data-theme="read"] .wallet-bar .wb-addr { color: #a05010 !important; text-shadow: none !important; }
        body[data-theme="read"] .wallet-bar .wb-addr:hover { color: #7a3808 !important; text-shadow: none !important; }
        body[data-theme="read"] .wallet-bar .wb-network { color: #7a4018 !important; background: rgba(92,46,8,0.06) !important; border-color: rgba(92,46,8,0.2) !important; }
        /* ── Read mode: wallet dropdown menu ── */
        body[data-theme="read"] .wb-menu { background: #ede4d2 !important; border-color: #d8c8ae !important; box-shadow: 0 4px 16px rgba(0,0,0,0.12) !important; }
        body[data-theme="read"] .wb-menu-item { color: #4a3018 !important; }
        body[data-theme="read"] .wb-menu-item:hover { background: rgba(92,46,8,0.08) !important; color: #2c1808 !important; }
        body[data-theme="read"] .wb-menu-label { color: #9a8060 !important; }
        body[data-theme="read"] .wb-menu-sep { border-top-color: #d8c8ae !important; }
        body[data-theme="read"] .wb-chain-item { color: #4a3018 !important; }
        body[data-theme="read"] .wb-chain-item:hover { background: rgba(92,46,8,0.06) !important; color: #2c1808 !important; }
        /* ── Read mode: post form wallet section ── */
        body[data-theme="read"] .wallet-connect-row { color: #4a3018 !important; }
        body[data-theme="read"] .wallet-toggle-btn { background: #e4d8c4 !important; border-color: #cfc4ae !important; color: #4a3018 !important; }
        body[data-theme="read"] .wallet-toggle-btn:hover { border-color: #a07030 !important; color: #2c1808 !important; }
        body[data-theme="read"] .wallet-mm-panel { background: rgba(92,61,14,0.04) !important; border-color: #d8c8ae !important; }
        body[data-theme="read"] .wallet-mm-panel .wmp-label { color: #9a8060 !important; }
        body[data-theme="read"] .wallet-mm-panel .wmp-value { color: #5c2e08 !important; }
        body[data-theme="read"] .wallet-mm-panel .wmp-btn { background: #e4d8c4 !important; border-color: #cfc4ae !important; color: #4a3018 !important; }
        body[data-theme="read"] .wallet-mm-panel .wmp-btn:hover { background: #d8cbb4 !important; border-color: #a07030 !important; }
        body[data-theme="read"] .wallet-mm-panel .wmp-chain-tag { background: rgba(92,46,8,0.08) !important; border-color: rgba(92,46,8,0.2) !important; color: #7a4018 !important; }
        body[data-theme="read"] .wci-label { color: #9a8060 !important; }
        body[data-theme="read"] .wci-input { background: #fffaf2 !important; border-color: #d8c8ae !important; color: #2c2010 !important; }
        body[data-theme="read"] .wci-input:focus { border-color: rgba(160,112,48,0.5) !important; }
        body[data-theme="read"] .metamask-btn { background: rgba(92,61,14,0.05) !important; border-color: #cfc4ae !important; color: #7a4018 !important; }
        body[data-theme="read"] .metamask-btn:hover { background: rgba(92,61,14,0.1) !important; border-color: #a07030 !important; }
        body[data-theme="read"] .metamask-btn.connected { background: rgba(92,61,14,0.08) !important; border-color: rgba(92,61,14,0.4) !important; color: #5c2e08 !important; }
        body[data-theme="read"] .wallet-addr-display { color: #7a4018 !important; background: rgba(92,61,14,0.06) !important; }
        body[data-theme="read"] .wallet-reveal-btn { background: #e4d8c4 !important; border-color: #cfc4ae !important; color: #4a3018 !important; }
        body[data-theme="read"] .wallet-reveal-btn:hover { border-color: #a07030 !important; color: #5c2e08 !important; }
        body[data-theme="read"] .wallet-balance { color: #5c2e08 !important; background: rgba(92,46,8,0.08) !important; }
        body[data-theme="read"] .wallet-mm-manual { color: #4a3018 !important; }
        body[data-theme="read"] .wallet-connect-collapsible label { color: #4a3018 !important; }
        body[data-theme="read"] .wallet-mm-manual p { color: #7a6040 !important; }
        body[data-theme="read"] .qr-wallet-fields label { color: #4a3018 !important; }
        body[data-theme="read"] .post-wallet { color: #7a4018 !important; background: rgba(92,61,14,0.06) !important; }
        body[data-theme="read"] .post-wallet:hover { background: rgba(92,61,14,0.12) !important; }
        /* ── Read mode: action buttons ── */
        body[data-theme="read"] .goyim-bump-btn { background: rgba(92,46,8,0.05) !important; border-color: rgba(92,46,8,0.2) !important; color: #5c3818 !important; text-shadow: none !important; }
        body[data-theme="read"] .goyim-bump-btn:hover { background: rgba(92,46,8,0.1) !important; border-color: #a07030 !important; color: #2c1808 !important; }
        body[data-theme="read"] .goyim-bump-btn .gbump-count { color: #7a5020 !important; }
        body[data-theme="read"] .tip-btn { background: rgba(92,61,14,0.05) !important; border-color: rgba(92,61,14,0.2) !important; color: #7a4018 !important; }
        body[data-theme="read"] .tip-btn:hover { background: rgba(92,61,14,0.1) !important; border-color: #a07030 !important; color: #5c2e08 !important; }
        body[data-theme="read"] .reply-scroll-btn { background: rgba(92,61,14,0.05) !important; border-color: rgba(92,61,14,0.2) !important; color: #7a4018 !important; }
        body[data-theme="read"] .reply-scroll-btn:hover { background: rgba(92,61,14,0.1) !important; border-color: #a07030 !important; color: #5c2e08 !important; }
        /* ── Read mode: file label ── */
        body[data-theme="read"] .file-label { background: rgba(92,61,14,0.05) !important; border-color: #cfc4ae !important; color: #7a6040 !important; }
        body[data-theme="read"] .file-label:hover { background: rgba(92,61,14,0.1) !important; border-color: #a07030 !important; color: #4a3018 !important; }
        /* ── Read mode: form hint ── */
        body[data-theme="read"] .form-hint { color: #9a8060 !important; }
        /* ── Read mode: input/textarea focus glow ── */
        body[data-theme="read"] input[type=text]:focus,
        body[data-theme="read"] input[type=number]:focus,
        body[data-theme="read"] input[type=email]:focus,
        body[data-theme="read"] textarea:focus { outline: none !important; border-color: rgba(160,112,48,0.5) !important; box-shadow: 0 0 0 2px rgba(160,112,48,0.15) !important; }
        /* ── Read mode: share dropdown ── */
        /* (fully handled in action buttons section above) */
        /* ── Read mode: post badge (sticky/pinned/locked) ── */
        body[data-theme="read"] .post-badge { background: rgba(92,61,14,0.1) !important; border-color: rgba(92,61,14,0.25) !important; color: #7a4018 !important; }
        /* ── Read mode: board announcement ── */
        body[data-theme="read"] .board-announcement { background: rgba(92,61,14,0.06) !important; border-color: rgba(92,61,14,0.2) !important; color: #4a3018 !important; }
        /* ── Read mode: board footer ── */
        body[data-theme="read"] .board-footer { color: #9a8060 !important; }
        body[data-theme="read"] .board-footer a { color: #7a6040 !important; }
        body[data-theme="read"] .board-footer a:hover { color: #4a3018 !important; }
        body[data-theme="read"] .footer-online { color: #7a6040 !important; }
        body[data-theme="read"] .footer-dot { background: #a07030 !important; box-shadow: none !important; }
        body[data-theme="read"] .board-footer::before { color: rgba(92,61,14,0.06) !important; }
        body[data-theme="read"] .board-footer::after { background: linear-gradient(90deg, transparent, rgba(92,61,14,0.15), transparent) !important; }
        /* ── Read mode: pagination ── */
        body[data-theme="read"] .board-pagination { border-top-color: rgba(92,61,14,0.12) !important; border-bottom-color: rgba(92,61,14,0.12) !important; background: rgba(92,61,14,0.03) !important; }
        body[data-theme="read"] .board-pagination .page-btn { color: #7a6040 !important; border-color: rgba(92,61,14,0.2) !important; background: rgba(92,61,14,0.04) !important; text-shadow: none !important; }
        body[data-theme="read"] .board-pagination .page-btn:hover { color: #4a3018 !important; border-color: #a07030 !important; background: rgba(92,61,14,0.08) !important; }
        body[data-theme="read"] .board-pagination .page-btn.current { color: #4a3018 !important; border-color: #a07030 !important; background: rgba(92,61,14,0.12) !important; font-weight: bold; text-shadow: none !important; box-shadow: none !important; }
        body[data-theme="read"] .board-pagination .page-btn.disabled { color: #b0a090 !important; border-color: rgba(92,61,14,0.08) !important; }
        body[data-theme="read"] .board-pagination .page-ellipsis { color: #9a8060 !important; }
        body[data-theme="read"] .board-pagination .page-info { color: #9a8060 !important; }
        /* ── Read mode: katsa result cards (if embedded) ── */
        body[data-theme="read"] .katsa-result-card { background: #fff8ee !important; border-color: #d8c8ae !important; }
        body[data-theme="read"] .katsa-result-header { background: rgba(92,61,14,0.06) !important; border-bottom-color: #d8c8ae !important; }
        body[data-theme="read"] .katsa-result-title { color: #5c2e08 !important; text-shadow: none !important; }
        body[data-theme="read"] .katsa-result-badge { background: rgba(92,61,14,0.1) !important; color: #7a3a10 !important; border-color: rgba(92,61,14,0.25) !important; }
        body[data-theme="read"] .katsa-result-body { color: #2c2010 !important; }
        body[data-theme="read"] .katsa-results { background: transparent !important; }
        /* ── Read mode: katsa inline widget ── */
        body[data-theme="read"] .katsa-inline-widget { background: #f4ede0 !important; border-color: #d8c8ae !important; font-family: Georgia, 'Times New Roman', serif !important; }
        body[data-theme="read"] .katsa-inline-header { background: rgba(92,61,14,0.06) !important; border-bottom-color: #d8c8ae !important; }
        body[data-theme="read"] .katsa-inline-label { color: #6a5030 !important; }
        body[data-theme="read"] .katsa-inline-label strong { color: #5c2e08 !important; text-shadow: none !important; }
        body[data-theme="read"] .katsa-inline-icon { filter: sepia(0.6) saturate(0.5) !important; }
        body[data-theme="read"] .katsa-inline-run { background: rgba(92,61,14,0.08) !important; border-color: rgba(92,61,14,0.3) !important; color: #5c2e08 !important; box-shadow: none !important; filter: none !important; }
        body[data-theme="read"] .katsa-inline-run:hover { background: rgba(92,61,14,0.15) !important; box-shadow: none !important; }
        body[data-theme="read"] .katsa-inline-toggle { color: #9a8060 !important; }
        body[data-theme="read"] .katsa-inline-results .katsa-il-status { color: #7a6040 !important; }
        body[data-theme="read"] .katsa-inline-results .katsa-il-site { background: rgba(92,61,14,0.06) !important; border-color: rgba(92,61,14,0.18) !important; color: #7a3a10 !important; }
        body[data-theme="read"] .katsa-inline-results .katsa-il-site:hover { background: rgba(92,61,14,0.14) !important; border-color: rgba(92,61,14,0.35) !important; color: #5c2008 !important; }
        body[data-theme="read"] .katsa-inline-results .katsa-il-summary { color: #7a6040 !important; }
        body[data-theme="read"] .katsa-inline-results .katsa-il-summary strong { color: #5c2e08 !important; }
        body[data-theme="read"] .katsa-inline-results a { color: #7a3a10 !important; }
        /* Override all inline-style colors and backgrounds inside katsa results for read mode */
        body[data-theme="read"] .katsa-inline-results * { color: #5c3010 !important; }
        body[data-theme="read"] .katsa-inline-results > div[style] { background: rgba(92,61,14,0.04) !important; border-color: rgba(92,61,14,0.15) !important; }
        body[data-theme="read"] .katsa-inline-results div[style*="background"] { background: rgba(92,61,14,0.04) !important; border-color: rgba(92,61,14,0.15) !important; }
        body[data-theme="read"] .katsa-inline-results strong { color: #3a1e08 !important; }
        body[data-theme="read"] .katsa-inline-results details { background: rgba(92,61,14,0.04) !important; border-color: rgba(92,61,14,0.18) !important; }
        body[data-theme="read"] .katsa-inline-results summary { color: #7a4820 !important; }
        body[data-theme="read"] .katsa-inline-results .katsa-il-summary { color: #7a6040 !important; }
        body[data-theme="read"] .katsa-inline-results .katsa-il-summary strong { color: #3a1e08 !important; }
        body[data-theme="read"] .katsa-inline-results .katsa-il-site { background: rgba(92,61,14,0.06) !important; border-color: rgba(92,61,14,0.18) !important; color: #7a3a10 !important; }
        body[data-theme="read"] .katsa-inline-results .katsa-il-site:hover { background: rgba(92,61,14,0.14) !important; border-color: rgba(92,61,14,0.35) !important; color: #5c2008 !important; }
        /* ── Read mode: boost/tip badges ── */
        body[data-theme="read"] .boost-badge { opacity: 0.8 !important; }
        /* ── Read mode: boost $GOYIM modal ── */
        body[data-theme="read"] .gbump-overlay { background: rgba(80,50,10,0.72) !important; }
        body[data-theme="read"] .gbump-modal { background: #fff8ee !important; border-color: #c07020 !important; box-shadow: 0 4px 24px rgba(80,50,10,0.18) !important; }
        body[data-theme="read"] .gbump-modal h3 { color: #7a3a10 !important; }
        body[data-theme="read"] .gbump-modal .gbump-sub { color: #7a6040 !important; }
        body[data-theme="read"] .gbump-info-box { background: rgba(92,61,14,0.06) !important; border-color: rgba(92,61,14,0.2) !important; color: #7a6040 !important; }
        body[data-theme="read"] .gbump-amt { background: rgba(92,61,14,0.06) !important; border-color: rgba(92,61,14,0.22) !important; color: #7a3a10 !important; }
        body[data-theme="read"] .gbump-amt:hover, body[data-theme="read"] .gbump-amt.selected { background: rgba(92,61,14,0.18) !important; border-color: #a05818 !important; color: #5c2008 !important; }
        body[data-theme="read"] .gbump-custom { background: #faf3e8 !important; border-color: #cfc4ae !important; color: #2c2010 !important; }
        body[data-theme="read"] .gbump-custom::placeholder { color: #a09070 !important; }
        body[data-theme="read"] .gbump-custom:focus { border-color: #a07030 !important; }
        body[data-theme="read"] .gbump-send-btn { background: #c07020 !important; color: #fff8ee !important; }
        body[data-theme="read"] .gbump-send-btn:hover { background: #a05818 !important; }
        body[data-theme="read"] .gbump-send-btn:disabled { background: #c0b090 !important; }
        body[data-theme="read"] .gbump-close { color: #7a6040 !important; }
        body[data-theme="read"] .gbump-close:hover { color: #5c2008 !important; }
        body[data-theme="read"] .gbump-status { color: #7a4018 !important; }
        /* ── Read mode: tip $GOYIM modal ── */
        body[data-theme="read"] .tip-modal-overlay { background: rgba(80,50,10,0.72) !important; }
        body[data-theme="read"] .tip-modal { background: #fff8ee !important; border-color: #c07020 !important; box-shadow: 0 4px 24px rgba(80,50,10,0.18) !important; }
        body[data-theme="read"] .tip-modal h3 { color: #7a3a10 !important; }
        body[data-theme="read"] .tip-modal .tip-amounts .tip-amount { background: rgba(92,61,14,0.06) !important; border-color: rgba(92,61,14,0.22) !important; color: #7a3a10 !important; }
        body[data-theme="read"] .tip-modal .tip-amounts .tip-amount:hover,
        body[data-theme="read"] .tip-modal .tip-amounts .tip-amount.selected { background: rgba(92,61,14,0.18) !important; border-color: #a05818 !important; color: #5c2008 !important; }
        body[data-theme="read"] .tip-modal .tip-custom { background: #faf3e8 !important; border-color: #cfc4ae !important; color: #2c2010 !important; }
        body[data-theme="read"] .tip-modal .tip-send-btn { background: #c07020 !important; color: #fff8ee !important; }
        body[data-theme="read"] .tip-modal .tip-send-btn:hover { background: #a05818 !important; }
        body[data-theme="read"] .tip-modal .tip-close { color: #7a6040 !important; }
        body[data-theme="read"] .tip-modal .tip-close:hover { color: #5c2008 !important; }
        /* ── Read mode: post actions container ── */
        body[data-theme="read"] .post-actions { border-top-color: rgba(92,61,14,0.12) !important; }
        /* ── Read mode: suppress green animations/glows ── */
        body[data-theme="read"] .board-header h2 { animation: none !important; text-shadow: none !important; color: #4a3018 !important; }
        body[data-theme="read"] a.post-subject:hover { text-shadow: none !important; color: #7a3a10 !important; }
        body[data-theme="read"] .post-subject:hover { animation: none !important; }
        body[data-theme="read"] .board-header { background: transparent !important; }
        body[data-theme="read"] body::before, body[data-theme="read"] body::after { opacity: 0 !important; }
        /* ── Read mode: swamp chat widget ── */
        body[data-theme="read"] .chat-header { background: #e8e0cf !important; border-color: #d8c8ae !important; }
        body[data-theme="read"] .chat-header:hover { background: #e0d8c4 !important; }
        body[data-theme="read"] .chat-header h4 { color: #4a3018 !important; }
        body[data-theme="read"] .chat-header .chat-online { color: #7a6040 !important; }
        body[data-theme="read"] .chat-header .chat-toggle { color: #4a3018 !important; }
        body[data-theme="read"] .chat-body { background: #f2ece0 !important; border-color: #d8c8ae !important; }
        body[data-theme="read"] .chat-messages { background: #f2ece0 !important; }
        body[data-theme="read"] .chat-messages::-webkit-scrollbar-thumb { background: rgba(92,61,14,0.2) !important; }
        body[data-theme="read"] .chat-msg { color: #2c2010 !important; }
        body[data-theme="read"] .chat-msg .chat-name { color: #7a3a10 !important; }
        body[data-theme="read"] .chat-msg .chat-name:hover { text-decoration: underline; text-shadow: none !important; }
        body[data-theme="read"] .chat-msg .chat-time { color: #9a8060 !important; }
        body[data-theme="read"] .chat-msg .chat-text { color: #2c2010 !important; }
        body[data-theme="read"] .chat-msg .chat-text .greentext { color: #5a7020 !important; }
        body[data-theme="read"] .chat-msg .chat-text .chat-mention { color: #5c2e08 !important; }
        body[data-theme="read"] .chat-msg .chat-text .chat-mention.mention-you { color: #b05010 !important; background: rgba(160,80,30,0.1) !important; }
        body[data-theme="read"] .chat-msg.mention-highlight { background: rgba(160,80,30,0.06) !important; border-left-color: rgba(160,80,30,0.35) !important; }
        body[data-theme="read"] .chat-input-row { border-top-color: #d8c8ae !important; }
        body[data-theme="read"] .chat-input-row input { background: #fff8ee !important; color: #2c2010 !important; }
        body[data-theme="read"] .chat-input-row input:focus { background: #fffaf2 !important; }
        body[data-theme="read"] .chat-input-row input::placeholder { color: #9a8060 !important; }
        body[data-theme="read"] .chat-input-row button { background: #c07020 !important; color: #fff8ee !important; }
        body[data-theme="read"] .chat-input-row button:hover { background: #a05818 !important; }
        body[data-theme="read"] .chat-input-row .chat-mic-btn { background: #e8dcc8 !important; border-left: 1px solid #d8c8ae !important; color: #7a4018 !important; box-shadow: none !important; }
        body[data-theme="read"] .chat-input-row .chat-mic-btn:hover { background: #ddd0ba !important; }
        body[data-theme="read"] .chat-voice-preview { background: rgba(92,61,14,0.04) !important; border-top-color: #d8c8ae !important; }
        body[data-theme="read"] .chat-mic-send { background: #c07020 !important; color: #fff8ee !important; }
        body[data-theme="read"] .chat-mic-cancel { color: #8a2010 !important; border-color: rgba(138,32,16,0.3) !important; }
        body[data-theme="read"] .vmb-mobile-toggle { background: #ede4d2 !important; border-color: #d8c8ae !important; color: #7a6040 !important; }
        body[data-theme="read"] .vmb-mobile-toggle:hover { color: #4a3018 !important; }
        body[data-theme="read"] .media-pending-small { color: #9a8060 !important; background: rgba(92,61,14,0.04) !important; border-color: rgba(92,61,14,0.18) !important; }
        body[data-theme="read"] .mrb-pending-notice { color: #7a6040 !important; background: rgba(92,61,14,0.04) !important; border-color: rgba(92,61,14,0.25) !important; }
        body[data-theme="read"] .chat-recording-indicator { color: #8a2010 !important; }
        body[data-theme="read"] .chat-error { color: #8a2010 !important; background: rgba(140,30,10,0.06) !important; }
        /* ── Read mode: post/reply submit button ── */
        body[data-theme="read"] .post-btn { background: #c07020 !important; color: #fff8ee !important; box-shadow: none !important; text-shadow: none !important; }
        body[data-theme="read"] .post-btn:hover { background: #a05818 !important; box-shadow: 0 0 10px rgba(192,112,32,0.3) !important; transform: translateY(-1px); }
        /* ── Read mode: form inputs & textareas ── */
        body[data-theme="read"] .form-row input[type="text"],
        body[data-theme="read"] .form-row textarea { background: #faf3e8 !important; border-color: #cfc4ae !important; color: #2c2010 !important; }
        body[data-theme="read"] .form-row input[type="text"]:focus,
        body[data-theme="read"] .form-row textarea:focus { border-color: #a07030 !important; box-shadow: 0 0 5px rgba(160,112,48,0.2) !important; }
        body[data-theme="read"] .form-row input::placeholder,
        body[data-theme="read"] .form-row textarea::placeholder { color: #a09070 !important; opacity: 1; }
        body[data-theme="read"] .form-error { color: #c04030 !important; background: rgba(180,60,40,0.07) !important; border-left-color: rgba(180,60,40,0.5) !important; }
        /* ── Read mode: form expand/collapse header ── */
        body[data-theme="read"] .form-toggle-header { color: #4a3018 !important; }
        body[data-theme="read"] .reply-form-wrap { border-color: #d0c4ad !important; }
        body[data-theme="read"] .reply-form-wrap .form-toggle-header { background: rgba(92,61,14,0.04) !important; }
        body[data-theme="read"] .reply-form-wrap .form-toggle-header:hover { background: rgba(92,61,14,0.09) !important; }
        body[data-theme="read"] .reply-form-wrap #replyFormBody { border-top-color: #d0c4ad !important; }
        /* ── Read mode: mobile nav overlay ── */
        body[data-theme="read"] .nav-links { background: #e8e0cf !important; border-bottom-color: #cfc4ae !important; }
        /* ── Read mode: file name / selection count ── */
        body[data-theme="read"] .file-name { color: #7a6040 !important; }
        /* ── Read mode: view count ── */
        body[data-theme="read"] .view-count { color: #9a8060 !important; }
        /* ── Read mode: carousel buttons & dots ── */
        body[data-theme="read"] .car-prev, body[data-theme="read"] .car-next { background: rgba(92,61,14,0.75) !important; border-color: rgba(92,61,14,0.5) !important; color: #e8d8b8 !important; }
        body[data-theme="read"] .car-prev:hover, body[data-theme="read"] .car-next:hover { background: rgba(92,61,14,0.9) !important; }
        body[data-theme="read"] .car-dot { background: rgba(92,61,14,0.15) !important; border-color: rgba(92,61,14,0.35) !important; }
        body[data-theme="read"] .car-dot.active { background: #a07030 !important; border-color: #a07030 !important; }
        /* ── Read mode: YouTube embed elements ── */
        body[data-theme="read"] .post-comment .yt-embed .yt-thumb { border-color: rgba(92,61,14,0.2) !important; }
        body[data-theme="read"] .post-comment .yt-embed .yt-show-label { color: #9a8060 !important; }
        body[data-theme="read"] .post-comment .yt-embed .yt-frame-wrap iframe { border-color: rgba(92,61,14,0.18) !important; }
        /* ── Read mode: scrollbars ── */
        html[data-theme="read"] { scrollbar-color: #c4b090 #ede4d2; scrollbar-width: thin; }
        html[data-theme="read"]::-webkit-scrollbar { width: 8px; height: 8px; }
        html[data-theme="read"]::-webkit-scrollbar-track { background: #ede4d2; }
        html[data-theme="read"]::-webkit-scrollbar-thumb { background: #c4b090; border-radius: 4px; border: 2px solid #ede4d2; }
        html[data-theme="read"]::-webkit-scrollbar-thumb:hover { background: #a07030; }
        body[data-theme="read"] ::-webkit-scrollbar { width: 8px; height: 8px; }
        body[data-theme="read"] ::-webkit-scrollbar-track { background: #ede4d2; }
        body[data-theme="read"] ::-webkit-scrollbar-thumb { background: #c4b090; border-radius: 4px; border: 2px solid #ede4d2; }
        body[data-theme="read"] ::-webkit-scrollbar-thumb:hover { background: #a07030; }
        body[data-theme="read"] { scrollbar-color: #c4b090 #ede4d2; scrollbar-width: thin; }
        /* Wallet nav button — exactly match .top-nav .nav-link sizing */
        .wallet-widget-btn { padding: 5px 10px !important; font-size: 0.8em !important; line-height: inherit !important; box-sizing: border-box !important; margin: 0 !important; }
        .wallet-widget-btn.connected { padding: 5px 10px !important; font-size: 0.8em !important; line-height: inherit !important; box-sizing: border-box !important; margin: 0 !important; }
        /* Thread subjects are clickable links */
        a.post-subject { text-decoration: none; color: inherit; }
        a.post-subject:hover { text-shadow: 0 0 8px rgba(0,255,65,0.5); }
        @keyframes sortFlash { 0% { outline: 2px solid rgba(0,255,65,0); } 40% { outline: 2px solid rgba(0,255,65,0.45); } 100% { outline: 2px solid rgba(0,255,65,0); } }
        .thread.sort-flash, .catalog-card.sort-flash { animation: sortFlash 0.55s ease-out; }

        /* ═══ CATALOG VIEW ═══ */
        .catalog-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(175px, 1fr)); gap: 10px; padding: 5px 0; }
        .catalog-card { background: rgba(0,0,0,0.45); border: 1px solid rgba(0,255,65,0.1); border-radius: 6px; overflow: hidden; cursor: pointer; transition: all 0.25s ease; position: relative; display: flex; flex-direction: column; }
        .catalog-card:hover { border-color: rgba(0,255,65,0.35); box-shadow: 0 0 18px rgba(0,255,65,0.06), inset 0 0 12px rgba(0,255,65,0.02); transform: translateY(-2px); }
        .catalog-card a { text-decoration: none; color: inherit; display: flex; flex-direction: column; height: 100%; }
        .catalog-thumb { width: 100%; height: 160px; overflow: hidden; background: rgba(0,10,0,0.6); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .catalog-thumb img { width: 100%; height: 100%; object-fit: cover; transition: transform 0.3s, opacity 0.2s; }
        .catalog-card:hover .catalog-thumb img { transform: scale(1.05); opacity: 0.85; }
        .catalog-thumb-none { color: #2a5a2a; font-size: 3em; }
        .catalog-info { padding: 8px 10px; flex: 1; display: flex; flex-direction: column; }
        .catalog-subject { color: #00ff41; font-weight: bold; font-size: 12px; margin-bottom: 4px; line-height: 1.3; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word; }
        .catalog-comment { color: #6baf6b; font-size: 11px; line-height: 1.4; flex: 1; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word; }
        .catalog-stats { display: flex; gap: 8px; padding: 6px 10px; border-top: 1px solid rgba(0,255,65,0.06); font-size: 10px; color: #4a8f4a; background: rgba(0,0,0,0.2); margin-top: auto; }
        .catalog-stats span { display: inline-flex; align-items: center; gap: 2px; white-space: nowrap; }
        .catalog-stats .cs-val { color: #00ff41; font-weight: bold; }
        .catalog-card.sticky { border-color: rgba(255,140,0,0.3); }
        .catalog-card.sticky::before { content: '📌'; position: absolute; top: 4px; left: 6px; font-size: 12px; z-index: 2; filter: drop-shadow(0 0 3px rgba(0,0,0,0.8)); }
        .catalog-card.locked { opacity: 0.7; }
        /* Hot glow on catalog cards */
        .catalog-card.hot-10 { border-color: rgba(0,255,65,0.35) !important; box-shadow: 0 0 12px rgba(0,255,65,0.08) !important; }
        .catalog-card.hot-10::after { content: '🔥'; position: absolute; top: 4px; right: 6px; font-size: 12px; z-index: 2; pointer-events: none; }
        .catalog-card.hot-100 { border-color: rgba(246,133,27,0.5) !important; box-shadow: 0 0 18px rgba(246,133,27,0.1) !important; }
        .catalog-card.hot-100::after { content: '🔥🔥'; position: absolute; top: 4px; right: 6px; font-size: 11px; z-index: 2; pointer-events: none; }
        .catalog-card.hot-1000 { border-color: rgba(255,68,68,0.5) !important; box-shadow: 0 0 22px rgba(255,68,68,0.12) !important; animation: hotPulse 2s ease-in-out infinite; }
        .catalog-card.hot-1000::after { content: '🔥🔥🔥'; position: absolute; top: 4px; right: 6px; font-size: 10px; z-index: 2; pointer-events: none; }
        .catalog-card .image-pending-mini { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: #ff8c00; font-size: 11px; flex-direction: column; gap: 4px; }

        @media (max-width: 768px) {
            .catalog-grid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; }
            .catalog-thumb { height: 130px; }
            .catalog-subject { font-size: 11px; }
            .catalog-comment { font-size: 10px; -webkit-line-clamp: 2; }
            .catalog-stats { font-size: 9px; gap: 5px; padding: 5px 8px; }
        }
        @media (max-width: 480px) {
            .catalog-grid { grid-template-columns: repeat(2, 1fr); gap: 6px; }
            .catalog-thumb { height: 110px; }
        }

        /* Live refresh controls */
        .live-bar { display: flex; align-items: center; gap: 10px; padding: 8px 15px; margin-bottom: 10px; background: rgba(0,10,0,0.4); border: 1px solid rgba(0,255,65,0.1); border-radius: 6px; font-family: 'Courier New', monospace; font-size: 12px; flex-wrap: wrap; }
        .live-bar .refresh-btn { display: inline-flex; align-items: center; gap: 4px; background: rgba(0,255,65,0.06); border: 1px solid rgba(0,255,65,0.2); border-radius: 4px; padding: 4px 12px; color: #4a8f4a; cursor: pointer; font-family: 'Courier New', monospace; font-size: 12px; transition: all 0.2s; }
        .live-bar .refresh-btn:hover { border-color: #00ff41; color: #00ff41; background: rgba(0,255,65,0.12); }
        .live-bar .refresh-btn.spinning .refresh-icon { animation: spin 0.6s linear; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .live-bar .auto-label { display: inline-flex; align-items: center; gap: 5px; color: #4a8f4a; cursor: pointer; user-select: none; }
        .live-bar .auto-label input[type="checkbox"] { appearance: none; -webkit-appearance: none; width: 14px; height: 14px; border: 1px solid rgba(0,255,65,0.3); border-radius: 3px; background: rgba(0,10,0,0.5); cursor: pointer; position: relative; vertical-align: middle; }
        .live-bar .auto-label input[type="checkbox"]:checked { background: rgba(0,255,65,0.15); border-color: #00ff41; }
        .live-bar .auto-label input[type="checkbox"]:checked::after { content: '✓'; position: absolute; top: -1px; left: 2px; color: #00ff41; font-size: 11px; }
        .live-bar .live-status { color: #3a6f3a; font-size: 11px; margin-left: auto; }
        .live-bar .live-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #3a6f3a; margin-right: 4px; vertical-align: middle; }
        .live-bar .live-dot.active { background: #00ff41; box-shadow: 0 0 6px rgba(0,255,65,0.5); animation: livePulse 2s ease-in-out infinite; }
        @keyframes livePulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        
        /* Thread fade animations */
        @keyframes threadFadeIn { from { opacity: 0; transform: translateY(-15px); max-height: 0; } to { opacity: 1; transform: translateY(0); max-height: 2000px; } }
        @keyframes threadFadeOut { from { opacity: 1; transform: translateY(0); max-height: 2000px; } to { opacity: 0; transform: translateY(15px); max-height: 0; } }
        .thread-entering { animation: threadFadeIn 0.5s ease-out forwards; overflow: hidden; }
        .thread-leaving { animation: threadFadeOut 0.4s ease-in forwards; overflow: hidden; }
        @keyframes replySlideIn { from { opacity: 0; transform: translateX(-10px); } to { opacity: 1; transform: translateX(0); } }
        .reply-new { animation: replySlideIn 0.4s ease-out; border-left: 2px solid rgba(0,255,65,0.4) !important; }
        .empty-board .empty-frog { font-size: 4em; margin-bottom: 15px; }
        
        /* ── LIVE CHAT ── */
        .chat-widget { position: fixed; bottom: 0; right: 20px; width: 340px; z-index: 5000; font-family: 'Courier New', monospace; }
        .chat-header { background: rgba(0,20,0,0.95); border: 1px solid rgba(0,255,65,0.3); border-bottom: none; border-radius: 8px 8px 0 0; padding: 8px 14px; display: flex; align-items: center; justify-content: space-between; cursor: pointer; user-select: none; transition: background 0.2s; }
        .chat-header:hover { background: rgba(0,30,0,0.95); }
        .chat-header h4 { color: #00ff41; font-size: 12px; margin: 0; display: flex; align-items: center; gap: 6px; }
        .chat-header .chat-online { color: #4a8f4a; font-size: 11px; }
        .chat-header .chat-toggle { color: #00ff41; font-size: 16px; background: none; border: none; cursor: pointer; font-family: 'Courier New', monospace; transition: transform 0.3s; }
        .chat-body.open ~ .chat-header .chat-toggle, .chat-header .chat-toggle.open { transform: rotate(180deg); }
        .chat-unread { display: none; background: #ff4444; color: #fff; font-size: 9px; font-weight: bold; min-width: 16px; height: 16px; border-radius: 8px; text-align: center; line-height: 16px; padding: 0 4px; animation: unreadPop 0.3s ease; }
        .chat-unread.visible { display: inline-block; }
        .chat-unread.mention { background: #f6851b; }
        @keyframes unreadPop { from { transform: scale(0); } to { transform: scale(1); } }
        
        .chat-body { display: none; background: rgba(5,10,5,0.97); border: 1px solid rgba(0,255,65,0.2); border-top: none; max-height: 0; overflow: hidden; transition: max-height 0.3s ease; }
        .chat-body.open { display: block; max-height: 400px; }
        
        .chat-messages { height: 280px; overflow-y: auto; padding: 10px; scroll-behavior: smooth; }
        .chat-messages::-webkit-scrollbar { width: 4px; }
        .chat-messages::-webkit-scrollbar-track { background: transparent; }
        .chat-messages::-webkit-scrollbar-thumb { background: rgba(0,255,65,0.2); border-radius: 2px; }
        
        .chat-msg { margin-bottom: 6px; font-size: 12px; line-height: 1.4; word-wrap: break-word; animation: chatMsgIn 0.2s ease-out; }
        @keyframes chatMsgIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
        .chat-msg .chat-name { color: #33ff33; font-weight: bold; cursor: pointer; }
        .chat-msg .chat-name:hover { text-decoration: underline; text-shadow: 0 0 6px rgba(0,255,65,0.4); }
        .chat-msg .chat-time { color: #2a5a2a; font-size: 10px; }
        .chat-msg .chat-text { color: #b0ffb0; }
        .chat-msg .chat-text .greentext { color: #789922; }
        .chat-msg .chat-text .chat-mention { color: #5fffaf; font-weight: bold; cursor: default; }
        .chat-msg .chat-text .chat-mention.mention-you { color: #f6851b; background: rgba(246,133,27,0.12); padding: 0 3px; border-radius: 2px; }
        .chat-msg.mention-highlight { background: rgba(246,133,27,0.06); border-left: 2px solid rgba(246,133,27,0.4); padding-left: 8px; }
        
        .chat-input-row { display: flex; border-top: 1px solid rgba(0,255,65,0.15); }
        .chat-input-row input { flex: 1; background: rgba(0,255,65,0.03); border: none; color: #b0ffb0; font-family: 'Courier New', monospace; font-size: 12px; padding: 8px 10px; outline: none; transition: background 0.2s; }
        .chat-input-row input:focus { background: rgba(0,255,65,0.06); }
        .chat-input-row input::placeholder { color: #2a5a2a; }
        .chat-input-row button { background: #00ff41; color: #0a0e0a; border: none; padding: 8px 14px; font-family: 'Courier New', monospace; font-weight: bold; font-size: 11px; cursor: pointer; transition: background 0.2s; }
        .chat-input-row button:hover { background: #33ff33; }
        @media (max-width: 768px) {
            .chat-input-row button { padding: 11px 18px; font-size: 13px; min-width: 60px; }
            .chat-input-row .chat-mic-btn { padding: 0 14px !important; font-size: 17px !important; }
        }
        .chat-mic-btn { background: rgba(0,255,65,0.05) !important; color: #5fffaf !important; border-left: 1px solid rgba(0,255,65,0.1) !important; font-size: 14px !important; padding: 0 11px !important; flex-shrink: 0; transition: background 0.15s; }
        .chat-mic-btn:hover { background: rgba(0,255,65,0.14) !important; }
        .chat-mic-btn.recording { color: #ff4444 !important; animation: mrbPulse 1s infinite; }
        .chat-voice-preview { display: none; align-items: center; gap: 6px; padding: 6px 10px; border-top: 1px solid rgba(0,255,65,0.1); background: rgba(0,0,0,0.25); }
        .chat-voice-preview.active { display: flex; }
        .chat-mic-send { background: #00ff41; color: #0a0e0a; border: none; padding: 5px 10px; font-size: 11px; font-weight: bold; font-family: 'Courier New', monospace; cursor: pointer; border-radius: 3px; flex-shrink: 0; }
        .chat-mic-cancel { background: transparent; color: #ff6b6b; border: 1px solid rgba(255,107,107,0.3); padding: 5px 8px; font-size: 11px; cursor: pointer; border-radius: 3px; flex-shrink: 0; }
        
        .chat-recording-indicator { display: none; flex: 1; align-items: center; padding: 0 10px; color: #ff4444; font-family: 'Courier New', monospace; font-size: 11px; letter-spacing: 0.5px; }
        .chat-input-row.voice-mode .chat-recording-indicator { display: flex; animation: mrbPulse 1s infinite; }
        .chat-input-row.voice-mode.done .chat-recording-indicator { display: none; }
        .chat-input-row.voice-mode input,
        .chat-input-row.voice-mode #chatSendBtn { display: none !important; }
        .mrb-pending-notice { flex: 1; min-width: 0; padding: 6px 10px; font-size: 11px; color: #7a6040; font-family: 'Courier New', monospace; background: rgba(92,61,14,0.04); border: 1px dashed rgba(92,61,14,0.25); border-radius: 4px; line-height: 1.4; }

        /* ── FROGTALK MINI WIDGET (replaces Swamp Chat) ── */
        .frog-mini-headline {
            color:#00ff41;
            font-size:12px;
            margin:0;
            display:inline-flex;
            align-items:center;
            gap:6px;
            line-height:1;
            white-space:nowrap;
        }
        .frog-mini-headline .frog-mini-emoji {
            display:inline-flex;
            align-items:center;
            justify-content:center;
            line-height:1;
            transform:translateY(1px);
        }
        .frog-mini-headline .frog-mini-label {
            display:inline-block;
            line-height:1;
        }
        .frog-mini-note {
            color:#4a8f4a;
            font-size:11px;
            margin-left:8px;
            display:inline-flex;
            align-items:center;
            line-height:1;
            transform:translateY(1px);
            white-space:nowrap;
        }
        .frog-mini-open-full {
            width:24px;
            height:24px;
            border:1px solid rgba(0,255,65,0.28);
            border-radius:6px;
            background:rgba(0,255,65,0.06);
            color:#9fffa3;
            font-size:13px;
            line-height:1;
            display:inline-flex;
            align-items:center;
            justify-content:center;
            cursor:pointer;
            margin-left:auto;
            margin-right:10px;
            transition:background .15s ease, border-color .15s ease, color .15s ease;
        }
        .frog-mini-open-full:hover {
            background:rgba(0,255,65,0.12);
            border-color:rgba(0,255,65,0.45);
            color:#d5ffd7;
        }
        .chat-header .chat-toggle {
            margin-left:2px;
        }
        .frog-mini-wrap { display:none; height: 480px; border-top:1px solid rgba(0,255,65,0.15); }
        .frog-mini-wrap.open { display:block; }
        .frog-mini-frame { width:100%; height:100%; border:none; background:#0b120b; }
        .frog-mini-guest { display:flex; flex-direction:column; gap:10px; align-items:stretch; padding:12px; border-top:1px solid rgba(0,255,65,0.15); }
        .frog-mini-guest-title { color:#8cff8c; font-size:13px; font-weight:700; }
        .frog-mini-guest-copy { color:#7eb07e; font-size:12px; line-height:1.4; }
        .frog-mini-actions { display:flex; gap:8px; }
        .frog-mini-btn { flex:1; border:none; border-radius:8px; padding:8px 10px; font-family:'Courier New', monospace; font-size:12px; font-weight:700; cursor:pointer; }
        .frog-mini-btn.login { background:#2a4a2a; color:#d9ffd9; }
        .frog-mini-btn.register { background:#4caf50; color:#041304; }
        .frog-mini-btn:hover { filter:brightness(1.05); }
        
        /* ── OCCULT VISUAL EFFECTS ── */
        
        /* Floating occult symbols */
        .occult-symbols { position: fixed; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 0; overflow: hidden; }
        .occult-sym { position: absolute; font-size: 24px; opacity: 0; animation: floatSymbol linear infinite; filter: blur(0.5px); color: rgba(0,255,65,0.08); }
        @keyframes floatSymbol {
            0% { transform: translateY(110vh) rotate(0deg); opacity: 0; }
            5% { opacity: 1; }
            90% { opacity: 1; }
            100% { transform: translateY(-10vh) rotate(360deg); opacity: 0; }
        }
        
        /* Scanline overlay */
        .scanlines { position: fixed; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 1; background: repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.03) 2px, rgba(0,0,0,0.03) 4px); }
        
        /* Vignette edges */
        .vignette { position: fixed; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 1; background: radial-gradient(ellipse at center, transparent 60%, rgba(0,0,0,0.4) 100%); }
        
        /* Occult sigil watermark */
        .sigil-watermark { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); pointer-events: none; z-index: 0; font-size: 30vw; opacity: 0.012; color: #00ff41; animation: sigilPulse 12s ease-in-out infinite; user-select: none; }
        @keyframes sigilPulse { 0%, 100% { opacity: 0.012; transform: translate(-50%, -50%) scale(1); } 50% { opacity: 0.025; transform: translate(-50%, -50%) scale(1.02); } }
        
        /* Glitch effect on thread subjects */
        .post-subject { position: relative; }
        .post-subject:hover { animation: glitchText 0.3s ease-in-out; }
        @keyframes glitchText {
            0% { text-shadow: 0 0 0 transparent; }
            20% { text-shadow: -2px 0 #ff0000, 2px 0 #00ffff; }
            40% { text-shadow: 2px 0 #ff0000, -2px 0 #00ffff; }
            60% { text-shadow: -1px 0 #ff0000, 1px 0 #00ffff; }
            80% { text-shadow: 1px 0 #ff0000, -1px 0 #00ffff; }
            100% { text-shadow: 0 0 0 transparent; }
        }
        
        /* Mysterious header glow pulse */
        .board-header h2 { animation: headerGlow 4s ease-in-out infinite; }
        @keyframes headerGlow {
            0%, 100% { text-shadow: 0 0 20px rgba(0,255,65,0.4); }
            50% { text-shadow: 0 0 30px rgba(0,255,65,0.6), 0 0 60px rgba(0,255,65,0.15), 0 0 100px rgba(0,255,65,0.05); }
        }
        
        /* Thread hover - subtle occult border glow */
        .thread { transition: border-color 0.3s ease, box-shadow 0.3s ease; }

        /* ════ GOYIM Boost — Ember Glow System ════
         * Three tiers: slow organic breathing, layered depth, terminal badge.
         * No strobing — each tier breathes at a pace that matches board atmosphere.
         * Colors: dark amber → deep orange → molten red-orange, all with dark base. */

        /* ── Boost decay CSS variable — JS-driven, smooth transition between 30s ticks ── */
        @property --bd {
            syntax: '<number>';
            inherits: false;
            initial-value: 1;
        }
        .thread.boost-1, .thread.boost-2, .thread.boost-3,
        .catalog-card.boost-1, .catalog-card.boost-2, .catalog-card.boost-3 {
            --bd: 1;
            transition: --bd 28s linear;
        }

        @keyframes boostEmber1 {
            /* Tier 1: smouldering coal — scales with --bd decay */
            0%,100% {
                box-shadow: 0 0 calc(10px * var(--bd)) rgba(160,65,0,calc(0.12 * var(--bd))),
                            0 0 calc(28px * var(--bd)) rgba(145,55,0,calc(0.06 * var(--bd))),
                            inset 0 0 calc(20px * var(--bd)) rgba(140,50,0,calc(0.025 * var(--bd)));
                border-color: rgba(175,78,0,calc(0.28 * var(--bd)));
            }
            50% {
                box-shadow: 0 0 calc(18px * var(--bd)) rgba(205,90,0,calc(0.20 * var(--bd))),
                            0 0 calc(44px * var(--bd)) rgba(185,72,0,calc(0.10 * var(--bd))),
                            inset 0 0 calc(28px * var(--bd)) rgba(170,65,0,calc(0.045 * var(--bd)));
                border-color: rgba(225,105,0,calc(0.44 * var(--bd)));
            }
        }
        @keyframes boostEmber2 {
            /* Tier 2: active burn */
            0%,100% {
                box-shadow: 0 0 calc(16px * var(--bd)) rgba(215,88,0,calc(0.22 * var(--bd))),
                            0 0 calc(38px * var(--bd)) rgba(195,68,0,calc(0.12 * var(--bd))),
                            0 0 calc(65px * var(--bd)) rgba(170,50,0,calc(0.05 * var(--bd))),
                            inset 0 0 calc(26px * var(--bd)) rgba(195,72,0,calc(0.055 * var(--bd)));
                border-color: rgba(230,103,0,calc(0.48 * var(--bd)));
            }
            45% {
                box-shadow: 0 0 calc(24px * var(--bd)) rgba(248,122,0,calc(0.33 * var(--bd))),
                            0 0 calc(54px * var(--bd)) rgba(228,95,0,calc(0.19 * var(--bd))),
                            0 0 calc(88px * var(--bd)) rgba(205,65,0,calc(0.09 * var(--bd))),
                            inset 0 0 calc(38px * var(--bd)) rgba(228,105,0,calc(0.085 * var(--bd)));
                border-color: rgba(255,150,0,calc(0.65 * var(--bd)));
            }
        }
        @keyframes boostEmber3 {
            /* Tier 3: inferno — three-phase organic drift */
            0% {
                box-shadow: 0 0 calc(22px * var(--bd)) rgba(248,78,0,calc(0.30 * var(--bd))),
                            0 0 calc(52px * var(--bd)) rgba(224,52,0,calc(0.17 * var(--bd))),
                            0 0 calc(92px * var(--bd)) rgba(200,28,0,calc(0.09 * var(--bd))),
                            inset 0 0 calc(36px * var(--bd)) rgba(225,62,0,calc(0.07 * var(--bd)));
                border-color: rgba(255,85,0,calc(0.58 * var(--bd)));
            }
            38% {
                box-shadow: 0 0 calc(34px * var(--bd)) rgba(255,132,0,calc(0.42 * var(--bd))),
                            0 0 calc(68px * var(--bd)) rgba(248,92,0,calc(0.26 * var(--bd))),
                            0 0 calc(112px * var(--bd)) rgba(225,52,0,calc(0.14 * var(--bd))),
                            inset 0 0 calc(50px * var(--bd)) rgba(245,108,0,calc(0.10 * var(--bd)));
                border-color: rgba(255,162,0,calc(0.78 * var(--bd)));
            }
            72% {
                box-shadow: 0 0 calc(26px * var(--bd)) rgba(240,58,0,calc(0.34 * var(--bd))),
                            0 0 calc(58px * var(--bd)) rgba(218,40,0,calc(0.20 * var(--bd))),
                            0 0 calc(98px * var(--bd)) rgba(190,20,0,calc(0.10 * var(--bd))),
                            inset 0 0 calc(42px * var(--bd)) rgba(222,56,0,calc(0.075 * var(--bd)));
                border-color: rgba(255,95,0,calc(0.64 * var(--bd)));
            }
            100% {
                box-shadow: 0 0 calc(22px * var(--bd)) rgba(248,78,0,calc(0.30 * var(--bd))),
                            0 0 calc(52px * var(--bd)) rgba(224,52,0,calc(0.17 * var(--bd))),
                            0 0 calc(92px * var(--bd)) rgba(200,28,0,calc(0.09 * var(--bd))),
                            inset 0 0 calc(36px * var(--bd)) rgba(225,62,0,calc(0.07 * var(--bd)));
                border-color: rgba(255,85,0,calc(0.58 * var(--bd)));
            }
        }

        /* ── Thread boost classes ── */
        .thread.boost-1, .thread.boost-2, .thread.boost-3 { overflow: visible; }
        .thread.boost-1 { animation: boostEmber1 4.8s ease-in-out infinite; }
        .thread.boost-2 { animation: boostEmber2 2.9s ease-in-out infinite; }
        .thread.boost-3 { animation: boostEmber3 1.9s ease-in-out infinite; }

        /* Subtle heat tint on the OP body — darkroom ember feel */
        .thread.boost-1 .thread-op { background: rgba(170,58,0,0.018); }
        .thread.boost-2 .thread-op { background: rgba(205,75,0,0.028); }
        .thread.boost-3 .thread-op { background: rgba(235,65,0,0.038); }

        /* ── Live boost badge (real DOM element — replaces static ::before pseudo) ── */
        .boost-badge {
            position: absolute; bottom: -1px; left: -1px;
            display: inline-flex; align-items: center; gap: 5px;
            font-family: 'Courier New', monospace; font-size: 9px;
            letter-spacing: 1.2px; font-weight: bold; text-transform: uppercase;
            padding: 3px 10px 3px 10px; border-radius: 0 5px 0 8px;
            pointer-events: none; z-index: 6; line-height: 1.3; white-space: nowrap;
        }
        .boost-badge-1 {
            background: rgba(155,62,0,0.28); border: 1px solid rgba(180,78,0,0.28);
            border-top-color: transparent; border-left-color: transparent;
            color: rgba(225,128,0,0.80);
        }
        .boost-badge-2 {
            background: rgba(200,82,0,0.25); border: 1px solid rgba(235,108,0,0.48);
            border-top-color: transparent; border-left-color: transparent;
            color: rgba(255,158,28,0.92); text-shadow: 0 0 6px rgba(245,110,0,0.30);
        }
        .boost-badge-3 {
            background: rgba(228,58,0,0.28); border: 1px solid rgba(255,92,0,0.62);
            border-top-color: transparent; border-left-color: transparent;
            color: #ff9848; text-shadow: 0 0 10px rgba(255,95,0,0.55);
        }
        /* Timer sub-text inside badge */
        .boost-badge .boost-timer {
            font-size: 8px; letter-spacing: 0.5px; opacity: 0.72;
            font-weight: normal; margin-left: 1px;
        }
        .boost-badge-1 .boost-timer { color: rgba(205,115,0,0.70); }
        .boost-badge-2 .boost-timer { color: rgba(255,145,20,0.75); }
        .boost-badge-3 .boost-timer { color: rgba(255,175,60,0.80); text-shadow: 0 0 5px rgba(255,100,0,0.35); }
        /* Dimmed badge when boost is near-expired */
        .boost-badge.boost-expired { opacity: 0.35; filter: grayscale(0.5); }

        /* ── Catalog card boost classes ── */
        .catalog-card.boost-1, .catalog-card.boost-2, .catalog-card.boost-3 { overflow: visible; }
        .catalog-card.boost-1 { border-color: rgba(175,78,0,0.30) !important; animation: boostEmber1 4.8s ease-in-out infinite; }
        .catalog-card.boost-2 { animation: boostEmber2 2.9s ease-in-out infinite; }
        .catalog-card.boost-3 { animation: boostEmber3 1.9s ease-in-out infinite; }
        /* Catalog badge — smaller variant */
        .catalog-card .boost-badge {
            font-size: 8px; padding: 2px 7px 2px 7px; border-radius: 0 4px 0 4px;
            letter-spacing: 0.8px; gap: 3px;
        }
        .catalog-card .boost-badge .boost-timer { font-size: 7px; }
        .thread:hover { border-color: rgba(0,255,65,0.2); box-shadow: 0 0 15px rgba(0,255,65,0.04), inset 0 0 15px rgba(0,255,65,0.02); }

        /* ── Read mode: ember glow — warm sepia palette, visible on paper background ── */
        @keyframes readEmber1 {
            /* Tier 1: smouldering page — amber border breathe, soft inset warmth */
            0%,100% {
                box-shadow: 0 0 10px rgba(155,96,14,0.22), 0 0 26px rgba(135,76,8,0.10), inset 0 0 18px rgba(125,68,6,0.055);
                border-color: rgba(168,112,28,0.42);
                border-left-color: rgba(188,122,28,0.58);
            }
            50% {
                box-shadow: 0 0 16px rgba(182,118,20,0.32), 0 0 40px rgba(162,98,14,0.16), inset 0 0 26px rgba(152,88,12,0.085);
                border-color: rgba(205,148,38,0.58);
                border-left-color: rgba(222,162,42,0.72);
            }
        }
        @keyframes readEmber2 {
            /* Tier 2: active burn — deeper amber, visible left accent */
            0%,100% {
                box-shadow: 0 0 15px rgba(172,112,18,0.30), 0 0 34px rgba(152,88,11,0.17), 0 0 56px rgba(128,66,8,0.082), inset 0 0 24px rgba(162,96,14,0.095);
                border-color: rgba(192,130,28,0.50);
                border-left-color: rgba(210,142,32,0.66);
            }
            45% {
                box-shadow: 0 0 24px rgba(200,140,24,0.44), 0 0 52px rgba(180,115,16,0.26), 0 0 84px rgba(158,90,10,0.12), inset 0 0 36px rgba(188,122,18,0.130);
                border-color: rgba(222,160,40,0.66);
                border-left-color: rgba(238,172,45,0.82);
            }
        }
        @keyframes readEmber3 {
            /* Tier 3: inferno — rich sepia-gold, unmissable on warm paper */
            0% {
                box-shadow: 0 0 18px rgba(182,118,18,0.38), 0 0 44px rgba(162,95,12,0.22), 0 0 72px rgba(142,72,8,0.11), inset 0 0 32px rgba(172,102,14,0.105);
                border-color: rgba(202,140,32,0.58);
                border-left-color: rgba(220,155,38,0.74);
            }
            38% {
                box-shadow: 0 0 30px rgba(215,152,26,0.55), 0 0 62px rgba(198,126,18,0.33), 0 0 100px rgba(175,98,12,0.17), inset 0 0 46px rgba(208,135,22,0.148);
                border-color: rgba(235,168,44,0.76);
                border-left-color: rgba(248,182,50,0.90);
            }
            72% {
                box-shadow: 0 0 22px rgba(190,125,20,0.44), 0 0 52px rgba(170,102,14,0.26), 0 0 82px rgba(150,78,10,0.13), inset 0 0 38px rgba(180,110,16,0.118);
                border-color: rgba(210,148,35,0.64);
                border-left-color: rgba(228,160,40,0.78);
            }
            100% {
                box-shadow: 0 0 18px rgba(182,118,18,0.38), 0 0 44px rgba(162,95,12,0.22), 0 0 72px rgba(142,72,8,0.11), inset 0 0 32px rgba(172,102,14,0.105);
                border-color: rgba(202,140,32,0.58);
                border-left-color: rgba(220,155,38,0.74);
            }
        }
        body[data-theme="read"] .thread.boost-1 { animation: readEmber1 4.8s ease-in-out infinite; }
        body[data-theme="read"] .thread.boost-2 { animation: readEmber2 2.9s ease-in-out infinite; }
        body[data-theme="read"] .thread.boost-3 { animation: readEmber3 1.9s ease-in-out infinite; }
        body[data-theme="read"] .catalog-card.boost-1 { animation: readEmber1 4.8s ease-in-out infinite; }
        body[data-theme="read"] .catalog-card.boost-2 { animation: readEmber2 2.9s ease-in-out infinite; }
        body[data-theme="read"] .catalog-card.boost-3 { animation: readEmber3 1.9s ease-in-out infinite; }
        body[data-theme="read"] .thread.boost-1 .thread-op { background: rgba(175,115,14,0.030) !important; }
        body[data-theme="read"] .thread.boost-2 .thread-op { background: rgba(192,128,16,0.046) !important; }
        body[data-theme="read"] .thread.boost-3 .thread-op { background: rgba(210,140,20,0.062) !important; }
        body[data-theme="read"] .boost-badge-1 { background: rgba(140,90,8,0.18); border-color: rgba(165,108,15,0.22); color: rgba(185,125,25,0.82); text-shadow: none; }
        body[data-theme="read"] .boost-badge-2 { background: rgba(165,108,12,0.16); border-color: rgba(195,135,22,0.34); color: rgba(200,145,35,0.88); text-shadow: 0 0 4px rgba(180,120,15,0.20); }
        body[data-theme="read"] .boost-badge-3 { background: rgba(178,118,15,0.18); border-color: rgba(210,150,30,0.44); color: #c49030; text-shadow: 0 0 5px rgba(190,130,20,0.25); }
        body[data-theme="read"] .thread:hover { border-color: rgba(140,88,10,0.18); box-shadow: 0 0 10px rgba(140,88,10,0.03), inset 0 0 10px rgba(140,88,10,0.015); }
        
        /* Rune-like decorative borders on post form */
        .post-form-container { position: relative; overflow: hidden; }
        .post-form-container::before { content: 'ᚠ ᚢ ᚦ ᚨ ᚱ ᚲ ᚷ ᚹ ᚺ'; position: absolute; top: 0; left: 0; right: 0; text-align: center; font-size: 10px; color: rgba(0,255,65,0.06); letter-spacing: 8px; pointer-events: none; }
        .post-form-container::after { content: 'ᚾ ᛁ ᛃ ᛇ ᛈ ᛉ ᛊ ᛏ ᛟ'; position: absolute; bottom: 0; left: 0; right: 0; text-align: center; font-size: 10px; color: rgba(0,255,65,0.06); letter-spacing: 8px; pointer-events: none; }
        
        /* Frog like button - mysterious glow when liked */
        .like-btn.liked { box-shadow: 0 0 10px rgba(0,255,65,0.15); }
        
        /* ═══ HOT POST GLOW TIERS ═══ */
        .hot-10 { border-color: rgba(0,255,65,0.35) !important; box-shadow: 0 0 12px rgba(0,255,65,0.08), inset 0 0 12px rgba(0,255,65,0.03) !important; }
        .hot-10::after { content: '🔥'; position: absolute; top: 6px; right: 10px; font-size: 14px; opacity: 0.7; pointer-events: none; }
        .hot-100 { border-color: rgba(246,133,27,0.5) !important; box-shadow: 0 0 20px rgba(246,133,27,0.12), 0 0 40px rgba(246,133,27,0.05), inset 0 0 15px rgba(246,133,27,0.04) !important; }
        .hot-100::after { content: '🔥🔥'; position: absolute; top: 6px; right: 10px; font-size: 14px; opacity: 0.8; pointer-events: none; }
        .hot-1000 { border-color: rgba(255,68,68,0.5) !important; box-shadow: 0 0 25px rgba(255,68,68,0.15), 0 0 50px rgba(255,68,68,0.06), 0 0 80px rgba(246,133,27,0.04), inset 0 0 20px rgba(255,68,68,0.04) !important; animation: hotPulse 2s ease-in-out infinite; }
        .hot-1000::after { content: '🔥🔥🔥'; position: absolute; top: 6px; right: 10px; font-size: 14px; opacity: 0.9; pointer-events: none; }
        @keyframes hotPulse {
            0%, 100% { box-shadow: 0 0 25px rgba(255,68,68,0.15), 0 0 50px rgba(255,68,68,0.06), inset 0 0 20px rgba(255,68,68,0.04); }
            50% { box-shadow: 0 0 35px rgba(255,68,68,0.22), 0 0 60px rgba(255,68,68,0.1), inset 0 0 25px rgba(255,68,68,0.06); }
        }
        .thread, .reply { position: relative; }
        .reply.hot-10, .reply.hot-100, .reply.hot-1000 { border-left: 2px solid; padding-left: 28px; overflow: hidden; }
        .reply.hot-10 { border-left-color: rgba(0,255,65,0.4); }
        .reply.hot-100 { border-left-color: rgba(246,133,27,0.5); }
        .reply.hot-1000 { border-left-color: rgba(255,68,68,0.5); }

        /* ═══ CYBER FROG WATERMARK — background of liked posts ═══
         * ::after on .thread-op (OP content) and ::before on .reply
         * Both are free — fire emoji uses ::after on the .thread/.reply container  */
        @keyframes frogBreath {
            0%,100% { opacity: 0.048; transform: rotate(-8deg) scale(1) translateY(0); }
            50%      { opacity: 0.072; transform: rotate(-7deg) scale(1.05) translateY(-4px); }
        }
        @keyframes frogCyber {
            0%,100% { opacity: 0.065; filter: blur(0.4px) brightness(1); transform: translate(50%,50%) rotate(-5deg) scale(1); }
            35%      { opacity: 0.10;  filter: blur(0px)   brightness(1.18); transform: translate(50%,50%) rotate(-4.5deg) scale(1.07); }
            70%      { opacity: 0.058; filter: blur(0.6px) brightness(0.92); transform: translate(50%,50%) rotate(-5.5deg) scale(0.97); }
        }
        /* Shared base — keep behind text */
        .thread.hot-10 .thread-op::after,   .thread.hot-100 .thread-op::after,  .thread.hot-1000 .thread-op::after,
        .reply.hot-10::before,               .reply.hot-100::before,              .reply.hot-1000::before {
            content: '🐸'; position: absolute; pointer-events: none; line-height: 1;
        }
        /* Tier 1 — subtle corner ghost, static */
        .thread.hot-10 .thread-op::after, .reply.hot-10::before {
            bottom: -8px; right: 2px; font-size: 78px;
            opacity: 0.032; transform: rotate(-10deg);
            filter: blur(1.2px) grayscale(0.55) brightness(0.75);
        }
        /* Tier 2 — corner frog, breathing, faint green tint on post bg */
        .thread.hot-100 .thread-op { background: rgba(0,255,65,0.016) !important; }
        .reply.hot-100 { background: rgba(0,255,65,0.014) !important; }
        .thread.hot-100 .thread-op::after, .reply.hot-100::before {
            bottom: -12px; right: 0px; font-size: 118px;
            opacity: 0.048; transform: rotate(-8deg);
            filter: blur(0.7px) grayscale(0.3);
            animation: frogBreath 5.5s ease-in-out infinite;
        }
        /* Tier 3 — large centred phantom frog, cyber pulse, deeper green tint */
        .thread.hot-1000 .thread-op { background: rgba(0,255,65,0.024) !important; }
        .reply.hot-1000 { background: rgba(0,255,65,0.020) !important; }
        .thread.hot-1000 .thread-op::after, .reply.hot-1000::before {
            bottom: 50%; right: 50%; font-size: 170px;
            opacity: 0.07; transform: translate(50%,50%) rotate(-5deg) scale(1);
            filter: blur(0.3px) grayscale(0.1);
            animation: frogCyber 3.9s ease-in-out infinite;
        }
        
        /* Occasional flicker on the board */
        @keyframes screenFlicker {
            0%, 97%, 100% { opacity: 1; }
            97.5% { opacity: 0.95; }
            98% { opacity: 1; }
            98.5% { opacity: 0.97; }
        }
        .board-container { animation: screenFlicker 8s infinite; }
        
        /* Nordic rune on board footer */
        .board-footer::before { content: 'ᛟ'; display: block; font-size: 2em; color: rgba(0,255,65,0.06); margin-bottom: 10px; letter-spacing: 0; text-shadow: 0 0 20px rgba(0,255,65,0.04); }
        
        /* Nav layout spacing */
        .top-nav { padding: 10px 0; }
        .top-nav .container { display: flex; align-items: center; justify-content: space-between; flex-wrap: nowrap; gap: 12px; padding: 0 20px; }
        .nav-branding { flex-shrink: 0; }
        .nav-branding .logo { font-size: 1.4em; margin: 0; color: #00ff41; font-family: 'Courier New', monospace; font-weight: bold; }
        .nav-branding .tagline { font-size: 10px; color: #4a8f4a; margin: 2px 0 0; letter-spacing: 1.5px; white-space: nowrap; }
        .nav-links { margin-left: auto; flex: 1 1 0; min-width: 0; overflow: visible; scrollbar-width: none; -ms-overflow-style: none; gap: 8px; flex-wrap: nowrap; }
        .nav-links::-webkit-scrollbar { display: none; }
        .top-nav .nav-link { padding: 5px 8px; font-size: 0.72em; display: flex !important; flex-wrap: nowrap !important; align-items: center !important; align-self: center !important; gap: 3px; line-height: 1; white-space: nowrap !important; flex-shrink: 0 !important; width: max-content !important; overflow: visible !important; min-width: max-content !important; }
        .top-nav .nav-link svg { flex-shrink: 0; display: block; }

        /* Mysterious nav glow */
        .top-nav .nav-link:hover { text-shadow: 0 0 8px rgba(0,255,65,0.4); }

        /* Hide tagline until viewport is wide enough */
        @media (max-width: 1400px) {
            .nav-branding .tagline { display: none !important; }
        }

        /* Compress nav at medium desktop widths */
        @media (max-width: 1200px) {
            .top-nav .container { gap: 6px !important; }
            .top-nav .nav-link { padding: 4px 7px !important; font-size: 0.72em !important; }
            .nav-links { gap: 5px !important; }
            .wallet-widget-btn { font-size: 0.72em !important; padding: 4px 7px !important; }
            .wallet-widget-btn.connected { font-size: 0.72em !important; padding: 4px 7px !important; }
            .nav-branding .tagline { display: none !important; }
        }

        /* Mid-range ~1100px */
        @media (max-width: 1100px) {
            .top-nav .container { gap: 4px !important; }
            .top-nav .nav-link { padding: 3px 6px !important; font-size: 0.67em !important; }
            .nav-links { gap: 3px !important; }
            .wallet-widget-btn { font-size: 0.67em !important; padding: 3px 6px !important; }
            .wallet-widget-btn.connected { font-size: 0.67em !important; padding: 3px 6px !important; }
            .nav-branding .tagline { display: none !important; }
        }

        /* Tighter ~980px */
        @media (max-width: 980px) {
            .top-nav .container { gap: 2px !important; }
            .top-nav .nav-link { padding: 2px 5px !important; font-size: 0.62em !important; }
            .nav-links { gap: 2px !important; }
            .wallet-widget-btn { font-size: 0.62em !important; padding: 2px 5px !important; }
            .wallet-widget-btn.connected { font-size: 0.62em !important; padding: 2px 5px !important; }
        }

        /* ≤920px: single-row bar; nav-links drops as absolute overlay — bar height never changes */
        @media (max-width: 920px) {
            /* nowrap keeps branding+button on one stable row; nav-links is an absolute dropdown */
            .top-nav .container { flex-wrap: nowrap !important; justify-content: space-between !important; align-items: center !important; padding: 8px 12px !important; gap: 6px !important; }
            .nav-branding { flex: 0 0 auto !important; text-align: left !important; }
            .nav-branding .logo { font-size: 1.2em !important; }
            .nav-branding .tagline { display: none !important; }
            .nav-links { position: absolute !important; top: 100% !important; left: 0 !important; right: 0 !important; flex-wrap: wrap !important; justify-content: center !important; gap: 5px !important; padding: 8px 12px !important; background: rgba(10,14,10,0.97) !important; border-bottom: 1px solid rgba(0,255,65,0.5) !important; z-index: 1001 !important; margin-left: 0 !important; flex: none !important; overflow: visible !important; }
            .top-nav .nav-link { padding: 4px 8px !important; font-size: 0.75em !important; }
            .wallet-widget-btn { font-size: 0.75em !important; padding: 4px 8px !important; }
            .wallet-widget-btn.connected { font-size: 0.75em !important; padding: 4px 8px !important; }
            .nav-minimize-btn { order: 2 !important; flex-shrink: 0 !important; font-size: 10px !important; padding: 3px 6px !important; margin-left: auto !important; }
        }
        /* Read mode overrides for mobile nav dropdown */
        @media (max-width: 920px) {
            body[data-theme="read"] .nav-links { background: #e8e0cf !important; border-bottom-color: #cfc4ae !important; }        }
        
        /* Subtle smoke/mist at bottom */
        .board-footer::after { content: ''; display: block; width: 100%; height: 2px; margin-top: 15px; background: linear-gradient(90deg, transparent, rgba(0,255,65,0.15), transparent); }

        @media (max-width: 768px) {
            .board-header h2 { font-size: 1.3em; }
            .board-stats { gap: 4px; padding: 6px 10px; font-size: 11px; }
            /* Post header mobile: subject always gets its own full row so name/id/time
               never awkwardly orphan next to it on narrow screens */
            .post-header { gap: 5px 8px; row-gap: 4px; }
            .post-subject { width: 100%; display: block; font-size: 13px; line-height: 1.3; }
            .post-badge { align-self: flex-start; }
            .post-anon { font-size: 12px; }
            .post-anon-id, .post-time, .post-no { font-size: 10px; white-space: nowrap; }
            .post-timeago { display: none; }
            .post-wallet { font-size: 10px; }
            .post-image-container, .image-pending { float: none; margin: 0 0 10px 0; }
            .post-image-container img { max-width: 100%; }
            .image-pending { width: 100%; }
            .post-carousel { float: none; margin: 0 0 10px 0; width: 100%; }
            .post-carousel img { max-width: 100%; }
            .car-prev { left: 0; font-size: 18px; padding: 4px 8px; }
            .car-next { right: 0; font-size: 18px; padding: 4px 8px; }
            .form-bottom { flex-direction: column; align-items: stretch; }
            .form-hint { margin-left: 0; margin-top: 5px; }
            .chat-widget { width: 100%; right: 0; left: 0; }
            .post-actions { flex-wrap: wrap; gap: 8px; }
            .tip-modal { padding: 18px; }
            .tip-chain-selector { gap: 4px; }
            .tip-chain-btn { padding: 4px 8px; font-size: 10px; }
            .tip-modal .tip-amounts { gap: 6px; }
            .tip-modal .tip-amount { padding: 6px 10px; font-size: 12px; }
            .wallet-connect-row { flex-direction: column; align-items: flex-start; }
            .thread-footer { gap: 5px; padding: 7px 10px; }
            .tf-stats { width: 100%; }
            /* media recorder — full width on mobile */
            .mrb-body { flex-direction: column; align-items: stretch; gap: 5px; padding: 2px 8px 10px; }
            .mrb-btn { width: 100%; justify-content: center; }
            .mrb-cancel { width: 100%; justify-content: center; }
            .mrb-preview { flex-direction: column; gap: 6px; }
            .mrb-preview audio, .mrb-preview video { flex: none; width: 100%; }
            .mrb-status { text-align: center; min-width: 0; }
            .post-voice-note, .post-video-clip { max-width: 100%; }
            .occult-sym { font-size: 18px; }
            .sigil-watermark { font-size: 50vw; }
            .view-mode-bar { margin-bottom: 8px; padding: 5px 6px; gap: 3px; }
            .view-mode-btn, .sort-mode-btn { flex: 1 1 0; justify-content: center; font-size: 11px; padding: 6px 6px; min-width: 0; }
            .sort-mode-label { display: none; }
            .sort-mode-sep2 { display: none; }
            .theme-label { display: none; }
            .theme-sep { display: none; }
            .theme-select { flex: 1 1 0; min-width: 0; font-size: 11px; padding: 6px 20px 6px 6px; }
            .live-bar { gap: 6px; padding: 6px 10px; }
            .wallet-bar { padding: 7px 10px; gap: 7px; }
            .wallet-bar .wb-bal { font-size: 10px; }
            .board-header { padding: 15px 10px 12px; }
            .board-header h2 { font-size: 1.2em; }
            .chat-widget { width: 100%; right: 0; left: 0; border-radius: 0; }
            .chat-header { border-radius: 8px 8px 0 0; }
        }

        /* ── Narrow mobile: 2-row controls bar ── */
        @media (max-width: 460px) {
            .view-mode-bar { gap: 3px; padding: 5px 6px 6px; }
            /* Row 1: Index + Catalog take full width */
            .view-mode-btn { flex: 1 1 45%; min-width: 0; font-size: 11px; padding: 5px 4px; }
            /* sep2 becomes an invisible full-width flex line-break after the view btns */
            .sort-mode-sep2 { display: block !important; flex-basis: 100%; height: 0; margin: 0; padding: 0; background: none; }
            /* Row 2: Sort buttons + theme select */
            .sort-mode-btn { flex: 1 1 0; min-width: 0; font-size: 10px; padding: 5px 2px; }
            .theme-select { flex: 2 1 0; min-width: 0; font-size: 10px; padding: 5px 14px 5px 4px; }
        }

        @media (max-width: 860px) {
            /* nothing nav-specific here */
        }

        /* ═══ Nav Minimize Toggle — appearance only; position/z-index from style.css ═══ */
        .nav-minimize-btn { flex-shrink: 0 !important; }
        .nav-minimize-btn .chevron { transition: transform 0.2s; display: inline-block; line-height: 1; }

        /* Minimized state */
        .nav-minimized .nav-links { display: none !important; }
        .nav-minimized .tagline { display: none !important; }
        .nav-minimized .top-nav { padding: 10px 0 !important; }
        .nav-minimized .logo { font-size: 1.2em !important; margin: 0 !important; }
        .nav-minimized .nav-minimize-btn { }
        .nav-minimized .nav-minimize-btn .chevron { transform: rotate(180deg); }

        /* Collapsible details chevron */
        details summary::-webkit-details-marker { display: none; }
        details[open] summary .tool-chevron { transform: rotate(90deg); }
        
        /* Katsa inline widget in posts */
        .katsa-inline-widget {
            margin: 10px 0;
            border: 1px solid rgba(0,255,65,0.2);
            border-radius: 6px;
            background: rgba(0,20,0,0.5);
            overflow: hidden;
            font-family: 'Courier New', monospace;
        }
        .katsa-inline-header {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 12px;
            background: rgba(0,255,65,0.06);
            border-bottom: 1px solid rgba(0,255,65,0.1);
            flex-wrap: wrap;
        }
        .katsa-inline-icon { font-size: 16px; }
        .katsa-inline-label {
            color: #4a8f4a;
            font-size: 12px;
            letter-spacing: 0.5px;
            flex: 1;
        }
        .katsa-inline-label strong { color: #00ff41; }
        .katsa-inline-run {
            padding: 4px 12px;
            background: rgba(0,255,65,0.1);
            border: 1px solid rgba(0,255,65,0.3);
            color: #00ff41;
            font-family: 'Courier New', monospace;
            font-size: 11px;
            cursor: pointer;
            border-radius: 3px;
            transition: all 0.2s;
        }
        .katsa-inline-run:hover {
            background: rgba(0,255,65,0.2);
            box-shadow: 0 0 8px rgba(0,255,65,0.2);
        }
        .katsa-inline-run:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .katsa-inline-results {
            padding: 0;
        }
        .katsa-inline-results.has-results {
            padding: 10px 12px;
        }
        .katsa-inline-results .katsa-il-status {
            color: #4a8f4a;
            font-size: 11px;
            padding: 8px 12px;
        }
        .katsa-inline-results .katsa-il-sites {
            display: flex;
            flex-wrap: wrap;
            gap: 4px;
        }
        .katsa-inline-results .katsa-il-site {
            display: inline-block;
            padding: 3px 8px;
            background: rgba(0,255,65,0.06);
            border: 1px solid rgba(0,255,65,0.1);
            border-radius: 3px;
            color: #5fffaf;
            font-size: 10px;
            text-decoration: none;
            transition: all 0.15s;
        }
        .katsa-inline-results .katsa-il-site:hover {
            background: rgba(0,255,65,0.15);
            border-color: rgba(0,255,65,0.3);
            color: #00ff41;
        }
        .katsa-inline-results .katsa-il-summary {
            margin-top: 6px;
            font-size: 11px;
            color: #4a8f4a;
        }
        .katsa-inline-results .katsa-il-summary strong {
            color: #00ff41;
        }
        .katsa-inline-results a {
            text-decoration: none;
        }
        .katsa-inline-toggle {
            color: #4a8f4a;
            font-size: 10px;
            margin-left: 4px;
            transition: transform 0.2s ease;
            user-select: none;
        }
        .katsa-inline-widget.collapsed .katsa-inline-results {
            display: none;
        }
        .katsa-inline-widget.collapsed .katsa-inline-toggle {
            transform: rotate(-90deg);
        }
        .katsa-inline-widget.collapsed .katsa-inline-header {
            border-bottom: none;
        }
        /* Mobile fixes for katsa widget */
        @media (max-width: 768px) {
            .katsa-inline-widget { margin: 6px 0; }
            .katsa-inline-header { padding: 6px 8px; gap: 4px; }
            .katsa-inline-label { font-size: 10px; min-width: 0; word-break: break-word; }
            .katsa-inline-run { padding: 3px 8px; font-size: 10px; white-space: nowrap; }
            .katsa-inline-results.has-results { padding: 6px 8px; }
            .katsa-inline-results .katsa-il-site { font-size: 9px; padding: 2px 5px; max-width: calc(50vw - 30px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .katsa-inline-results .katsa-il-sites { gap: 3px; }
            .katsa-inline-results details summary { font-size: 8px !important; }
        }
        /* Prevent horizontal scrolling globally */
        html, body { max-width: 100vw; overflow-x: hidden; }
        .post, .thread, .reply { max-width: 100%; overflow-wrap: break-word; word-wrap: break-word; word-break: break-word; }
        .post-comment { max-width: 100%; overflow-wrap: break-word; word-wrap: break-word; }
        .post-comment a { word-break: break-all; }
    </style>
</head>
<body>
<script>(function(){var t=localStorage.getItem('ph_theme');if(t){document.body.setAttribute('data-theme',t);document.documentElement.setAttribute('data-theme',t);}})()</script>
    <div class="matrix-bg"></div>
    <div class="header-bg-overlay"></div>
    
    <!-- Occult atmosphere -->
    <div class="occult-symbols" id="occultSymbols"></div>
    <div class="scanlines"></div>
    <div class="vignette"></div>
    <div class="sigil-watermark">ᛟ</div>

    <nav class="top-nav">
        <div class="container">
            <div class="nav-branding">
            </div>
            <div class="nav-links">
</div>
                    </div>
                </div>
            </div>
        </div>
    </nav>
    <div id="walletBackdrop" class="wallet-backdrop hidden" onclick="closeWalletPanel()"></div>

    <main>
        <div class="board-container">
            <div class="board-header">
                <h2>🐸 Frog General</h2>
                <p class="board-subtitle">Anonymous discussion board. No accounts. No tracking. Speak freely.</p>
                <div class="board-stats">
                    <span class="stat-item">📋 Threads: <span class="stat-val"><?= $threadCount ?></span></span>
                    <span class="stat-sep">·</span>
                    <span class="stat-item">💬 Posts: <span class="stat-val"><?= $totalPosts ?></span></span>
                    <span class="stat-sep">·</span>
                    <span class="stat-item">👁 Total Views: <span class="stat-val"><?= number_format($totalViews) ?></span></span>
                    <span class="stat-sep">·</span>
                    <span class="stat-item"><span class="online-dot"></span> <span class="stat-val"><?= $onlineCount ?></span> browsing now</span>
                    <span class="stat-sep">·</span>
                    <span class="stat-item"><?= $settings['board_locked'] ? '🔒 LOCKED' : '<span class="stat-val">ONLINE</span>' ?></span>
                    <?php
                        $_modParts = [];
                        if ($settings['require_image_approval'] ?? false) $_modParts[] = 'Images';
                        if ($settings['require_audio_approval'] ?? false) $_modParts[] = 'Audio';
                        if ($settings['require_video_approval'] ?? false) $_modParts[] = 'Videos';
                        if ($_modParts):
                    ?>
                        <span class="stat-sep">·</span>
                        <span class="stat-item stat-moderated"><?= implode('/', $_modParts) ?>: MODERATED</span>
                    <?php endif; ?>
                </div>
            </div>

            <!-- Wallet Status Bar -->
            <div class="wallet-bar" id="walletBar">
                <span class="wb-icon">🦊</span>
                <span class="wb-addr" id="wbAddr" onclick="toggleWalletBarMenu(event)" title="Click to switch account or network">...</span>
                <span class="wb-bal" id="wbBal">loading...</span>
                <span class="wb-network" id="wbNetwork"></span>
                <button class="wallet-disconnect" onclick="disconnectWallet()">✕ Disconnect</button>
                <div class="wb-menu" id="wbMenu" style="display:none;">
                    <span class="wb-menu-item" onclick="switchWalletBarAccount()">👤 Switch Account</span>
                    <div class="wb-menu-sep"></div>
                    <span class="wb-menu-label">Switch Network</span>
                    <div id="wbChainList"></div>
                </div>
            </div>

            <?php if ($settings['announcement']): ?>
                <div class="board-announcement">
                    <strong>📢 ANNOUNCEMENT:</strong> <?= htmlspecialchars($settings['announcement']) ?>
                </div>
            <?php endif; ?>


            <?php if ($isBanned): ?>
                <div class="ban-notice">
                    <div class="ban-notice-icon">🔨</div>
                    <h3>ACCESS RESTRICTED</h3>
                    <div class="ban-notice-row"><span class="label">Reason</span><span class="value"><?= htmlspecialchars($ban['reason'] ?? 'Violation of board rules') ?></span></div>
                    <div class="ban-notice-row"><span class="label">Expires</span><span class="value"><?= $ban['expires'] === 0 ? '⛔ PERMANENT' : '⏱ ' . date('Y-m-d H:i', $ban['expires']) . ' UTC' ?></span></div>
                    <div class="ban-notice-footer">Posting, replying, and chat are disabled for your session. If you believe this is an error, contact the site admin.</div>
                </div>
            <?php endif; ?>

            <?php if ($error && !$singleThread): ?>
                <div class="board-msg error">⚠️ <?= htmlspecialchars($error) ?></div>
            <?php endif; ?>

            <?php if (!$singleThread): ?>
                <!-- ═══ VIEW MODE TOGGLE ═══ -->
                <button type="button" class="vmb-mobile-toggle" id="vmbMobBtn" onclick="toggleViewModeBar()">🎛 Board Controls <span id="vmbToggleArrow">▼</span></button>
                <div class="view-mode-bar" id="viewModeBar">
                    <a href="/board<?= $currentPage > 1 ? '?page='.$currentPage : '' ?>" class="view-mode-btn <?= !$isCatalog ? 'active' : '' ?>">📋 Index</a>
                    <a href="/board?mode=catalog" class="view-mode-btn <?= $isCatalog ? 'active' : '' ?>">📸 Catalog</a>
                    <span class="sort-mode-sep2"></span>
                    <span class="sort-mode-label">Sort:</span>
                    <button data-mode="futaba" class="sort-mode-btn" onclick="setSortMode('futaba')" title="Traditional bump order — newest reply wins">📜 Futaba</button>
                    <button data-mode="frog" class="sort-mode-btn" onclick="setSortMode('frog')" title="Engagement score — GOYIM + likes + views + replies">🐸 FrogAlgo</button>
                    <span class="theme-sep"></span>
                    <span class="theme-label">Theme</span>
                    <select class="theme-select" id="theme-select" onchange="setTheme(this.value)">
                        <option value="">🐸 Frog</option>
                        <option value="read">📖 Read Mode</option>
                    </select>
                </div>
            <?php endif; ?>

            <?php if ($singleThread): ?>
                <!-- ═══ SINGLE THREAD VIEW ═══ -->
                <button type="button" class="vmb-mobile-toggle" id="vmbMobBtn" onclick="toggleViewModeBar()">🎛 Board Controls <span id="vmbToggleArrow">▼</span></button>
                <div class="view-mode-bar" id="viewModeBar">
                    <a href="/board" id="backToBoard" class="view-mode-btn">← Index</a>
                    <a href="/board?mode=catalog" class="view-mode-btn">📸 Catalog</a>
                    <span class="sort-mode-sep2"></span>
                    <span class="sort-mode-label">Sort:</span>
                    <button data-mode="futaba" class="sort-mode-btn" onclick="setSortMode('futaba')" title="Traditional bump order">📜 Futaba</button>
                    <button data-mode="frog" class="sort-mode-btn" onclick="setSortMode('frog')" title="Engagement score">🐸 FrogAlgo</button>
                    <span class="theme-sep"></span>
                    <span class="theme-label">Theme</span>
                    <select class="theme-select" id="theme-select" onchange="setTheme(this.value)">
                        <option value="">🐸 Frog</option>
                        <option value="read">📖 Read Mode</option>
                    </select>
                </div>
                <script>
                (function(){
                    var r = document.referrer;
                    var fromCatalog = (r && r.indexOf('mode=catalog') !== -1);
                    // persist so bottom nav can also use it
                    try { if (fromCatalog) sessionStorage.setItem('ph_back','catalog'); else if (r && r.indexOf('/board') !== -1) sessionStorage.setItem('ph_back','index'); } catch(e){}
                    var saved = '';
                    try { saved = sessionStorage.getItem('ph_back') || ''; } catch(e){}
                    var isCatalog = fromCatalog || saved === 'catalog';
                    var href = isCatalog ? '/board?mode=catalog' : '/board';
                    var label = isCatalog ? '← Back to Catalog' : '← Back to Index';
                    document.querySelectorAll('.thread-nav-back').forEach(function(a){
                        a.href = href; a.textContent = label;
                    });
                })();
                </script>
                <div class="live-bar" id="liveBarThread">
                    <button class="refresh-btn" onclick="liveRefreshThread()" title="Refresh thread"><span class="refresh-icon" style="display:inline-block;">🔄</span> Refresh</button>
                    <label class="auto-label"><input type="checkbox" id="autoRefreshThread" onchange="toggleAutoRefresh('thread')"> Auto <span id="countdownThread"></span></label>
                    <span class="live-status"><span class="live-dot" id="liveDotThread"></span><span id="liveStatusThread">Manual</span></span>
                </div>

                <div class="thread-nav-bar">
                    [<a href="/board" class="thread-nav-back thread-nav-link">← Back to Index</a>]
                </div>

                <div class="thread <?= ($singleThread['sticky'] ?? false) ? 'sticky' : '' ?> <?= ($singleThread['locked'] ?? false) ? 'locked' : '' ?> <?= hotClass($singleThread['id']) ?> <?= boostClass($singleThread['goyim_tips'] ?? 0) ?>" id="p<?= $singleThread['id'] ?>" data-boost-until="<?= (int)($singleThread['bump'] ?? $singleThread['time'] ?? 0) ?>" data-goyim="<?= round($singleThread['goyim_tips'] ?? 0) ?>">
                    <?= boostBadgeHtml($singleThread['goyim_tips'] ?? 0, (int)($singleThread['bump'] ?? $singleThread['time'] ?? 0)) ?>
                    <div class="thread-op clearfix <?= !empty($singleThread['is_holder']) ? 'holder-post' : '' ?>" id="p<?= $singleThread['id'] ?>">
                        <div class="post-header">
                            <?php if ($singleThread['subject']): ?>
                                <span class="post-subject"><?= $singleThread['subject'] ?></span>
                            <?php endif; ?>
                            <?php if ($singleThread['sticky'] ?? false): ?><span class="post-badge badge-sticky">📌 STICKY</span><?php endif; ?>
                            <?php if ($singleThread['locked'] ?? false): ?><span class="post-badge badge-locked">🔒 LOCKED</span><?php endif; ?>
                            <?php if (($singleThread['capcode'] ?? null) === 'admin'): ?>
                                <span class="post-name-admin">Frog</span><span class="capcode-admin">## Admin</span>
                            <?php else: ?>
                                <span class="post-anon">Anonymous</span>
                            <?php endif; ?>
                            <span class="post-anon-id">ID: <?= $singleThread['anonId'] ?></span>
                            <?php $opWallets = getPostWallets($singleThread['id']); if ($opWallets): ?>
                                <?php foreach ($opWallets as $chain => $addr): ?>
                                    <span class="post-wallet" onclick="copyWallet('<?= $addr ?>')" title="<?= strtoupper($chain) ?>: <?= $addr ?>"><?= walletIcon($addr) ?> <?= substr($addr, 0, 6) ?>...<?= substr($addr, -4) ?></span>
                                <?php endforeach; ?>
                            <?php endif; ?>
                            <?php if (!empty($singleThread['is_holder'])): ?><span class="goyim-holder-badge">&#x1F525; HOLDER<?php if (($singleThread['goyim_balance'] ?? 0) >= 1): ?><span class="gbadge-bal"> <?= number_format((float)$singleThread['goyim_balance'], 0) ?>G</span><?php endif; ?></span><?php endif; ?>
                            <span class="post-time"><?= date('m/d/y(D)H:i:s', $singleThread['time']) ?></span>
                            <span class="post-no" onclick="insertQuote('<?= $singleThread['id'] ?>')">No.<?= $singleThread['id'] ?></span>
                            <?php if (!empty($backlinks[$singleThread['id']])): ?>
                                <span class="post-backlinks"><?php foreach ($backlinks[$singleThread['id']] as $bl): ?><a href="#p<?= $bl ?>">&gt;&gt;<?= $bl ?></a><?php endforeach; ?></span>
                            <?php endif; ?>
                            <?php if ($isAdmin): ?>
                                <span class="admin-controls">
                                    <form method="POST" action="/board/admin" style="display:inline"><input type="hidden" name="action" value="delete_post"><input type="hidden" name="post_id" value="<?= $singleThread['id'] ?>"><input type="hidden" name="is_thread" value="1"><input type="hidden" name="return_url" value="<?= htmlspecialchars($_SERVER['REQUEST_URI']) ?>"><button onclick="return confirm('Delete thread?')" title="Delete">🗑</button></form>
                                    <form method="POST" action="/board/admin" style="display:inline"><input type="hidden" name="action" value="ban_user"><input type="hidden" name="ip_hash" value="<?= $singleThread['ip_hash'] ?>"><input type="hidden" name="reason" value="Banned by admin"><input type="hidden" name="duration" value="0"><input type="hidden" name="return_url" value="<?= htmlspecialchars($_SERVER['REQUEST_URI']) ?>"><button onclick="return confirm('Ban this user?')" title="Ban">🔨</button></form>
                                </span>
                            <?php endif; ?>
                        </div>
                        <?= renderPostImages($singleThread, $isAdmin) ?>
                        <?php if (!empty($singleThread['media'])): $m=$singleThread['media']; ?>
                        <?php if (isMediaVisible($m)): ?>
                        <div class="post-media">
                            <?php if ($m['type']==='audio'): ?>
                            <div class="post-voice-note"><div class="pvn-row"><span class="pvn-icon">🎤</span><div class="pvn-audio"><audio controls src="/board_uploads/<?= htmlspecialchars($m['file'],ENT_QUOTES,'UTF-8') ?>"></audio></div></div><div class="pvn-label"><?= htmlspecialchars($m['origName']??'voice note',ENT_QUOTES,'UTF-8') ?></div></div>
                            <?php else: ?>
                            <div class="post-video-clip"><video controls src="/board_uploads/<?= htmlspecialchars($m['file'],ENT_QUOTES,'UTF-8') ?>" preload="metadata"></video><div class="pvc-label"><?= htmlspecialchars($m['origName']??'video clip',ENT_QUOTES,'UTF-8') ?> (<?= formatFileSize($m['size']??0) ?>)</div></div>
                            <?php endif; ?>
                        </div>
                        <?php elseif (!($m['approved'] ?? true)): ?>
                        <?php if ($isAdmin): ?>
                        <div class="media-pending-small media-pending-admin" style="flex-direction:column;align-items:flex-start;gap:6px;">
                            <?php if ($m['type']==='video'): ?>
                            <video controls src="/board_uploads/<?= htmlspecialchars($m['file'],ENT_QUOTES,'UTF-8') ?>" style="max-width:100%;max-height:280px;border:1px solid rgba(255,140,0,0.5);border-radius:4px;" preload="metadata"></video>
                            <?php else: ?>
                            <audio controls src="/board_uploads/<?= htmlspecialchars($m['file'],ENT_QUOTES,'UTF-8') ?>" style="width:100%;max-width:400px;"></audio>
                            <?php endif; ?>
                            <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">
                            <?= $m['type']==='audio' ? '🎤 Voice note' : '🎥 Video' ?> pending approval
                            <form method="POST" action="/board/admin" style="display:inline;margin-left:4px;"><input type="hidden" name="action" value="approve_media"><input type="hidden" name="post_id" value="<?= $singleThread['id'] ?>"><input type="hidden" name="is_reply" value="0"><input type="hidden" name="return_url" value="<?= htmlspecialchars($_SERVER['REQUEST_URI']) ?>"><button class="approve-overlay-btn">✅ Approve</button></form>
                            <form method="POST" action="/board/admin" style="display:inline;"><input type="hidden" name="action" value="reject_media"><input type="hidden" name="post_id" value="<?= $singleThread['id'] ?>"><input type="hidden" name="is_reply" value="0"><input type="hidden" name="return_url" value="<?= htmlspecialchars($_SERVER['REQUEST_URI']) ?>"><button class="reject-overlay-btn">❌ Reject</button></form>
                            </div>
                        </div>
                        <?php else: ?>
                        <div class="media-pending-small" style="font-size:13px;padding:10px 12px;justify-content:center;flex-direction:column;text-align:center;gap:4px;"><span style="font-size:1.8em;line-height:1;"><?= $m['type']==='audio' ? '🎤' : '🎥' ?></span><span><?= $m['type']==='audio' ? 'Voice note' : 'Video' ?> pending admin approval</span></div>
                        <?php endif; ?>
                        <?php endif; ?>
                        <?php endif; ?>
                        <div class="post-comment"><?= formatPostText($singleThread['comment'], $singleThread['id']) ?></div>
                        <div class="post-actions">
                            <button class="like-btn <?= hasLiked($singleThread['id']) ? 'liked' : '' ?>" onclick="toggleLike('<?= $singleThread['id'] ?>', this)" data-post="<?= $singleThread['id'] ?>">
                                🐸 <span class="like-count"><?= getLikeCount($singleThread['id']) ?></span>
                            </button>
                            <button class="tip-btn" onclick="tipPost('<?= $singleThread['id'] ?>')" data-post="<?= $singleThread['id'] ?>">&#x1F4B0; Tip OP</button>
                            <button class="goyim-bump-btn" onclick="openGoyimBump('<?= $singleThread['id'] ?>')" title="Tip $GOYIM to boost this thread's visibility">&#x1F525; Boost $GOYIM<span class="gbump-count" id="gbump-count-<?= $singleThread['id'] ?>"><?php $gt = round($singleThread['goyim_tips'] ?? 0); if ($gt > 0) echo ' ' . number_format($gt) . 'G'; ?></span></button>
                            <span class="view-count">👁 <?= $threadViewCount ?> views</span>
                            <div class="share-wrap">
                                <button class="share-btn" onclick="toggleShare(this)">📤 Share</button>
                                <div class="share-dropdown">
                                    <button onclick="copyThreadLink('<?= $singleThread['id'] ?>', this)"><span class="share-icon">🔗</span> Copy Link</button>
                                    <div class="share-sep"></div>
                                    <a href="https://x.com/intent/tweet?text=<?= urlencode(($singleThread['subject'] ?: 'Check this thread') . ' — Frog Channel') ?>&url=<?= urlencode($baseUrl . '/board?thread=' . $singleThread['id']) ?>" target="_blank"><span class="share-icon">𝕏</span> Share on X</a>
                                    <a href="https://t.me/share/url?url=<?= urlencode($baseUrl . '/board?thread=' . $singleThread['id']) ?>&text=<?= urlencode('🐸 ' . ($singleThread['subject'] ?: 'Thread') . ' — Frog Channel') ?>" target="_blank"><span class="share-icon">✈️</span> Telegram</a>
                                    <a href="https://reddit.com/submit?url=<?= urlencode($baseUrl . '/board?thread=' . $singleThread['id']) ?>&title=<?= urlencode(($singleThread['subject'] ?: 'Thread') . ' — Frog Channel') ?>" target="_blank"><span class="share-icon">🔺</span> Reddit</a>
                                    <a href="https://www.facebook.com/sharer/sharer.php?u=<?= urlencode($baseUrl . '/board?thread=' . $singleThread['id']) ?>" target="_blank"><span class="share-icon">📘</span> Facebook</a>
                                </div>
                            </div>
                            <button class="reply-scroll-btn" onclick="(function(){var b=document.getElementById('replyFormBody');if(b&&b.classList.contains('collapsed'))togglePostForm('reply');var t=document.getElementById('replyToggleBtn');if(t)t.scrollIntoView({behavior:'smooth',block:'start'});})()">✏️ Reply</button>
                        </div>
                    </div>
                    
                    <?php foreach ($singleThread['replies'] as $reply): ?>
                        <?php if (!postHasVisibleContent($reply, $isAdmin)): continue; endif; ?>
                        <div class="reply clearfix <?= hotClass($reply['id']) ?> <?= !empty($reply['is_holder']) ? 'holder-post' : '' ?>" id="p<?= $reply['id'] ?>">
                            <div class="post-header">
                                <?php if (($reply['capcode'] ?? null) === 'admin'): ?>
                                    <span class="post-name-admin">Frog</span><span class="capcode-admin">## Admin</span>
                                <?php else: ?>
                                    <span class="post-anon">Anonymous</span>
                                <?php endif; ?>
                                <span class="post-anon-id">ID: <?= $reply['anonId'] ?></span>
                                <?php $replyWallets = getPostWallets($reply['id']); if ($replyWallets): ?>
                                    <?php foreach ($replyWallets as $chain => $addr): ?>
                                        <span class="post-wallet" onclick="copyWallet('<?= $addr ?>')" title="<?= strtoupper($chain) ?>: <?= $addr ?>"><?= walletIcon($addr) ?> <?= substr($addr, 0, 6) ?>...<?= substr($addr, -4) ?></span>
                                    <?php endforeach; ?>
                                <?php endif; ?>
                                <?php if (!empty($reply['is_holder'])): ?><span class="goyim-holder-badge">&#x1F525; HOLDER<?php if (($reply['goyim_balance'] ?? 0) >= 1): ?><span class="gbadge-bal"> <?= number_format((float)$reply['goyim_balance'], 0) ?>G</span><?php endif; ?></span><?php endif; ?>
                                <span class="post-time"><?= date('m/d/y(D)H:i:s', $reply['time']) ?></span>
                                <span class="post-no" onclick="insertQuote('<?= $reply['id'] ?>')">No.<?= $reply['id'] ?></span>
                                <?php if (!empty($backlinks[$reply['id']])): ?>
                                    <span class="post-backlinks"><?php foreach ($backlinks[$reply['id']] as $bl): ?><a href="#p<?= $bl ?>">&gt;&gt;<?= $bl ?></a><?php endforeach; ?></span>
                                <?php endif; ?>
                                <?php if ($isAdmin): ?>
                                    <span class="admin-controls">
                                        <form method="POST" action="/board/admin" style="display:inline"><input type="hidden" name="action" value="delete_post"><input type="hidden" name="post_id" value="<?= $reply['id'] ?>"><input type="hidden" name="thread_id" value="<?= $singleThread['id'] ?>"><input type="hidden" name="is_thread" value="0"><input type="hidden" name="return_url" value="<?= htmlspecialchars($_SERVER['REQUEST_URI']) ?>"><button onclick="return confirm('Delete reply?')" title="Delete">🗑</button></form>
                                        <form method="POST" action="/board/admin" style="display:inline"><input type="hidden" name="action" value="ban_user"><input type="hidden" name="ip_hash" value="<?= $reply['ip_hash'] ?>"><input type="hidden" name="reason" value="Banned by admin"><input type="hidden" name="duration" value="0"><input type="hidden" name="return_url" value="<?= htmlspecialchars($_SERVER['REQUEST_URI']) ?>"><button onclick="return confirm('Ban?')" title="Ban">🔨</button></form>
                                    </span>
                                <?php endif; ?>
                            </div>
                            <?= renderPostImages($reply, $isAdmin, $singleThread['id'], true) ?>
                            <?php if (!empty($reply['media'])): $m=$reply['media']; ?>
                            <?php if (isMediaVisible($m)): ?>
                            <div class="post-media">
                                <?php if ($m['type']==='audio'): ?>
                                <div class="post-voice-note"><div class="pvn-row"><span class="pvn-icon">🎤</span><div class="pvn-audio"><audio controls src="/board_uploads/<?= htmlspecialchars($m['file'],ENT_QUOTES,'UTF-8') ?>"></audio></div></div><div class="pvn-label"><?= htmlspecialchars($m['origName']??'voice note',ENT_QUOTES,'UTF-8') ?></div></div>
                                <?php else: ?>
                                <div class="post-video-clip"><video controls src="/board_uploads/<?= htmlspecialchars($m['file'],ENT_QUOTES,'UTF-8') ?>" preload="metadata"></video><div class="pvc-label"><?= htmlspecialchars($m['origName']??'video clip',ENT_QUOTES,'UTF-8') ?> (<?= formatFileSize($m['size']??0) ?>)</div></div>
                                <?php endif; ?>
                            </div>
                            <?php elseif (!($m['approved'] ?? true)): ?>
                            <?php if ($isAdmin): ?>
                            <div class="media-pending-small media-pending-admin" style="flex-direction:column;align-items:flex-start;gap:6px;">
                                <?php if ($m['type']==='video'): ?>
                                <video controls src="/board_uploads/<?= htmlspecialchars($m['file'],ENT_QUOTES,'UTF-8') ?>" style="max-width:100%;max-height:280px;border:1px solid rgba(255,140,0,0.5);border-radius:4px;" preload="metadata"></video>
                                <?php else: ?>
                                <audio controls src="/board_uploads/<?= htmlspecialchars($m['file'],ENT_QUOTES,'UTF-8') ?>" style="width:100%;max-width:400px;"></audio>
                                <?php endif; ?>
                                <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">
                                <?= $m['type']==='audio' ? '🎤 Voice note' : '🎥 Video' ?> pending approval
                                <form method="POST" action="/board/admin" style="display:inline;margin-left:4px;"><input type="hidden" name="action" value="approve_media"><input type="hidden" name="post_id" value="<?= $reply['id'] ?>"><input type="hidden" name="thread_id" value="<?= $singleThread['id'] ?>"><input type="hidden" name="is_reply" value="1"><input type="hidden" name="return_url" value="<?= htmlspecialchars($_SERVER['REQUEST_URI']) ?>"><button class="approve-overlay-btn">✅ Approve</button></form>
                                <form method="POST" action="/board/admin" style="display:inline;"><input type="hidden" name="action" value="reject_media"><input type="hidden" name="post_id" value="<?= $reply['id'] ?>"><input type="hidden" name="thread_id" value="<?= $singleThread['id'] ?>"><input type="hidden" name="is_reply" value="1"><input type="hidden" name="return_url" value="<?= htmlspecialchars($_SERVER['REQUEST_URI']) ?>"><button class="reject-overlay-btn">❌ Reject</button></form>
                                </div>
                            </div>
                            <?php else: ?>
                            <div class="media-pending-small" style="font-size:13px;padding:10px 12px;justify-content:center;flex-direction:column;text-align:center;gap:4px;"><span style="font-size:1.8em;line-height:1;"><?= $m['type']==='audio' ? '🎤' : '🎥' ?></span><span><?= $m['type']==='audio' ? 'Voice note' : 'Video' ?> pending admin approval</span></div>
                            <?php endif; ?>
                            <?php endif; ?>
                            <?php endif; ?>
                            <div class="post-comment"><?= formatPostText($reply['comment'], $reply['id']) ?></div>
                            <div class="post-actions">
                                <button class="like-btn <?= hasLiked($reply['id']) ? 'liked' : '' ?>" onclick="toggleLike('<?= $reply['id'] ?>', this)" data-post="<?= $reply['id'] ?>">
                                    🐸 <span class="like-count"><?= getLikeCount($reply['id']) ?></span>
                                </button>
                                <button class="tip-btn" onclick="tipPost('<?= $reply['id'] ?>')" data-post="<?= $reply['id'] ?>" style="padding:2px 8px;font-size:11px;">💰 Tip</button>
                            </div>
                        </div>
                    <?php endforeach; ?>
                    
                    <?php if (!$isBanned && !($singleThread['locked'] ?? false) && !$settings['board_locked']): ?>
                    <div class="reply-form-wrap">
                        <button class="form-toggle-header" id="replyToggleBtn" onclick="togglePostForm('reply')">
                            <span>/// POST REPLY ///</span>
                            <span class="form-toggle-caret">&#x25BC;</span>
                        </button>
                    <div id="replyFormBody" class="form-collapsible" style="padding:0;">
                    <div class="quick-reply active">
                        <form method="POST" enctype="multipart/form-data">
                            <?= csrfField() ?>
                            <input type="hidden" name="action" value="reply">
                            <input type="hidden" name="thread_id" value="<?= $singleThread['id'] ?>">
                            <?php if ($error): ?>
                            <div class="form-error visible">⚠ <?= htmlspecialchars($error) ?></div>
                            <?php endif; ?>
                            <div class="form-row">
                                <textarea name="comment" id="replyComment" placeholder="Reply to thread... (>greentext, >>postId to quote, paste YouTube links)" maxlength="5000"></textarea>
                            </div>
                            <div class="form-bottom">
                                <?php if ($_anyMedia): ?><div class="media-rec-bar" id="mrb-rply">
                                    <div class="mrb-body" id="mrb-body-rply">
                                        <?php if ($_allowImages): ?><label class="file-label mrb-btn">&#x1F5BC;&#xFE0F; Add Photos<input type="file" name="images[]" accept="image/jpeg,image/png,image/gif,image/webp" multiple onchange="showFileName(this,'replyFileName')"></label>
                                        <span class="file-name" id="replyFileName"></span><?php endif; ?>
                                        <?php if ($_mAccept): ?><label class="mrb-btn">&#x1F3A5; Add Video<input type="file" name="media" id="mrb-pick-rply" class="mrb-file-hidden" accept="<?= htmlspecialchars($_mAccept) ?>" onchange="mrbPickFile(this,'rply')"></label><?php endif; ?>
                                        <?php if ($_allowAudio): ?><button type="button" class="mrb-btn" id="mrb-mic-rply" onclick="mrbStartRec('rply','audio')">&#x1F3A4; Voice Note</button><?php endif; ?>
                                        <span class="mrb-status" id="mrb-status-rply"></span>
                                        <div class="mrb-preview" id="mrb-preview-rply"><span id="mrb-preview-el-rply"></span><button type="button" class="mrb-cancel" onclick="mrbCancel('rply')">✕ Clear</button></div>
                                    </div>
                                </div><?php endif; ?>
                                <button type="submit" class="post-btn">POST REPLY</button>
                                <?php if ($settings['require_image_approval'] || ($settings['require_audio_approval'] ?? false) || ($settings['require_video_approval'] ?? true)): ?>
                                    <span class="form-hint">⚠️ <?= $settings['require_image_approval'] ? 'Images' : '' ?><?= ($settings['require_image_approval'] && (($settings['require_audio_approval'] ?? false) || ($settings['require_video_approval'] ?? true))) ? ' &amp; ' : '' ?><?php if ($settings['require_audio_approval'] ?? false): ?>Audio<?php endif; ?><?= (($settings['require_audio_approval'] ?? false) && ($settings['require_video_approval'] ?? true)) ? '/' : '' ?><?php if ($settings['require_video_approval'] ?? true): ?>Video<?php endif; ?> requires admin approval</span>
                                <?php endif; ?>
                            </div>
                            <div class="wallet-connect-row" id="replyWalletRow">
                                <button type="button" class="wallet-toggle-btn" onclick="var c=this.closest('.wallet-connect-row').querySelector('.wallet-connect-collapsible');var open=c.style.display==='block';c.style.display=open?'none':'block';this.classList.toggle('open',!open);">🦊 Wallet for tips <span class="wtb-arrow">▼</span></button>
                                <div class="wallet-connect-collapsible">
                                <label style="display:flex;align-items:center;gap:6px;cursor:pointer;color:#4a8f4a;font-size:12px;font-family:'Courier New',monospace;margin-top:6px;">
                                    <input type="checkbox" id="replyWalletToggle" onchange="toggleWalletField('reply')" style="accent-color:#f6851b;"> Include in post
                                </label>
                                <div id="replyWalletField" style="display:none; margin-top:6px; width:100%;">
                                    <!-- MetaMask panel (desktop with wallet provider) -->
                                    <div class="wallet-mm-panel" id="replyMmPanel" style="display:none;">
                                        <div class="wmp-row">
                                            <span class="wmp-label">Account</span>
                                            <span class="wmp-value" id="replyMmAddr">...</span>
                                            <button type="button" class="wmp-btn" onclick="switchWalletAccount('reply')">Switch</button>
                                        </div>
                                        <div class="wmp-row">
                                            <span class="wmp-label">Chain</span>
                                            <span class="wmp-chain-tag" id="replyMmChain">Ethereum</span>
                                            <button type="button" class="wmp-btn" onclick="openWalletChainPicker('reply')">Change</button>
                                        </div>
                                        <div class="wmp-row" id="replyChainPicker" style="display:none; width:100%;">
                                            <div class="tip-chain-selector" id="replyChainSelector" style="width:100%;"></div>
                                        </div>
                                        <div class="wallet-reveal-row"><button type="button" class="wallet-reveal-btn" onclick="toggleWalletReveal(this,'reply')">&#x1F441; Reveal</button></div>
                                        <div class="wallet-chain-inputs" style="display:none">
                                            <div class="wci-row"><span class="wci-label">🦊 ETH</span><input type="text" name="wallet_eth" id="replyWalletEth" placeholder="Auto-filled from MetaMask" maxlength="128" class="wci-input" readonly></div>
                                            <div class="wci-row"><span class="wci-label">₿ BTC</span><input type="text" name="wallet_btc" id="replyWalletBtc" placeholder="Paste BTC address (optional)" maxlength="128" class="wci-input"></div>
                                            <div class="wci-row"><span class="wci-label">💰 SOL</span><input type="text" name="wallet_sol" id="replyWalletSol" placeholder="Paste SOL address (optional)" maxlength="128" class="wci-input"></div>
                                            <div class="wci-row"><span class="wci-label">◎ TRX</span><input type="text" name="wallet_tron" id="replyWalletTron" placeholder="Paste TRX address (optional)" maxlength="128" class="wci-input"></div>
                                        </div>
                                    </div>
                                    <!-- Manual paste (mobile / no MetaMask) -->
                                    <div class="wallet-mm-manual" id="replyManualPanel">
                                        <p style="color:#4a8f4a;font-size:11px;margin:0 0 6px;">💱 Enter addresses for each chain you want tips on:</p>
                                        <div class="wallet-reveal-row"><button type="button" class="wallet-reveal-btn" onclick="toggleWalletReveal(this,'reply')">&#x1F441; Reveal</button></div>
                                        <div class="wallet-chain-inputs" style="display:none">
                                            <div class="wci-row"><span class="wci-label">🦊 ETH</span><input type="text" name="wallet_eth" placeholder="0x... (ETH/BSC/Polygon)" maxlength="128" class="wci-input"></div>
                                            <div class="wci-row"><span class="wci-label">₿ BTC</span><input type="text" name="wallet_btc" placeholder="1.../3.../bc1... Bitcoin" maxlength="128" class="wci-input"></div>
                                            <div class="wci-row"><span class="wci-label">💰 SOL</span><input type="text" name="wallet_sol" placeholder="Solana address" maxlength="128" class="wci-input"></div>
                                            <div class="wci-row"><span class="wci-label">◎ TRX</span><input type="text" name="wallet_tron" placeholder="T... TRON address" maxlength="128" class="wci-input"></div>
                                        </div>
                                        <button type="button" class="metamask-btn" id="replyMetamask" onclick="connectMetaMask('replyWalletEth', 'replyMetamask')" style="margin-top:4px;font-size:11px;">🦊 Connect MetaMask (fills ETH)</button>
                                    </div>
                                </div>
                                </div><!-- /wallet-connect-collapsible -->
                            </div>
                        </form>
                    </div>
                    </div><!-- /replyFormBody -->
                    </div><!-- /reply-form-wrap -->
                    <?php elseif ($singleThread['locked'] ?? false): ?>
                        <div style="padding: 12px 15px; text-align: center; color: #ff8c00; font-size: 12px; background: rgba(0,0,0,0.2);">🔒 This thread is locked. No new replies.</div>
                    <?php endif; ?>
                </div>

                <div class="thread-nav-bar" style="margin-top:10px;">
                    [<a href="/board" class="thread-nav-back thread-nav-link">← Back to Index</a>]
                </div>

            <?php elseif ($viewThread): ?>
                <!-- ═══ 404 THREAD NOT FOUND ═══ -->
                <div style="text-align:center; padding: 60px 20px;">
                    <div style="font-size: 64px; margin-bottom: 16px;">🐸</div>
                    <div style="font-size: 22px; color: #ff4444; font-family: 'Courier New', monospace; margin-bottom: 10px;">404 — Thread Not Found</div>
                    <div style="font-size: 13px; color: #7a9a7a; margin-bottom: 24px;">This thread no longer exists. It may have been deleted or pruned.</div>
                    <a href="/board" style="display:inline-block; padding: 8px 20px; background: #1a3a1a; border: 1px solid #2a5a2a; color: #5fffaf; text-decoration: none; font-family: 'Courier New', monospace; font-size: 13px;">← Return to Frog Channel</a>
                    <a href="/board?mode=catalog" style="display:inline-block; padding: 8px 20px; margin-left: 10px; background: #1a3a1a; border: 1px solid #2a5a2a; color: #4a8f4a; text-decoration: none; font-family: 'Courier New', monospace; font-size: 13px;">📸 Catalog</a>
                </div>

            <?php else: ?>
                <!-- ═══ BOARD INDEX ═══ -->
                <?php if (!$isBanned && !$settings['board_locked']): ?>
                <div class="post-form-container">
                    <h3 class="form-toggle-header" id="newThreadToggleBtn" onclick="togglePostForm('newThread')">
                        <span>/// START NEW THREAD ///</span>
                        <span class="form-toggle-caret">▼</span>
                    </h3>
                    <div id="newThreadFormBody" class="form-collapsible">
                    <form method="POST" enctype="multipart/form-data">
                        <?= csrfField() ?>
                        <input type="hidden" name="action" value="new_thread">
                        <div class="form-row">
                            <input type="text" name="subject" placeholder="Subject (optional)" maxlength="100">
                        </div>
                        <div class="form-row">
                            <textarea name="comment" placeholder="Comment... (>greentext, paste YouTube links to embed)" maxlength="5000"></textarea>
                        </div>
                        <div class="form-bottom">
                            <?php if ($_anyMedia): ?><div class="media-rec-bar" id="mrb-thr">
                                <div class="mrb-body" id="mrb-body-thr">
                                    <?php if ($_allowImages): ?><label class="file-label mrb-btn">&#x1F5BC;&#xFE0F; Add Photos<input type="file" name="images[]" accept="image/jpeg,image/png,image/gif,image/webp" multiple onchange="showFileName(this,'newThreadFileName')"></label>
                                    <span class="file-name" id="newThreadFileName"></span><?php endif; ?>
                                    <?php if ($_mAccept): ?><label class="mrb-btn">&#x1F3A5; Add Video<input type="file" name="media" id="mrb-pick-thr" class="mrb-file-hidden" accept="<?= htmlspecialchars($_mAccept) ?>" onchange="mrbPickFile(this,'thr')"></label><?php endif; ?>
                                    <?php if ($_allowAudio): ?><button type="button" class="mrb-btn" id="mrb-mic-thr" onclick="mrbStartRec('thr','audio')">&#x1F3A4; Voice Note</button><?php endif; ?>
                                    <span class="mrb-status" id="mrb-status-thr"></span>
                                    <div class="mrb-preview" id="mrb-preview-thr"><span id="mrb-preview-el-thr"></span><button type="button" class="mrb-cancel" onclick="mrbCancel('thr')">✕ Clear</button></div>
                                </div>
                            </div><?php endif; ?>
                            <button type="submit" class="post-btn">CREATE THREAD</button>
                            <span class="form-hint">Images up to 5MB · audio/video up to <?= (int)($settings['max_media_size_mb'] ?? 100) ?>MB<?php if ($settings['require_image_approval'] || ($settings['require_audio_approval'] ?? false) || ($settings['require_video_approval'] ?? true)): ?> · ⚠️ Media moderated<?php endif; ?></span>
                        </div>
                        <div class="wallet-connect-row" id="threadWalletRow">
                            <button type="button" class="wallet-toggle-btn" onclick="var c=this.closest('.wallet-connect-row').querySelector('.wallet-connect-collapsible');var open=c.style.display==='block';c.style.display=open?'none':'block';this.classList.toggle('open',!open);">🦊 Wallet for tips <span class="wtb-arrow">▼</span></button>
                            <div class="wallet-connect-collapsible">
                            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;color:#4a8f4a;font-size:12px;font-family:'Courier New',monospace;margin-top:6px;">
                                <input type="checkbox" id="threadWalletToggle" onchange="toggleWalletField('thread')" style="accent-color:#f6851b;"> Include in post
                            </label>
                            <div id="threadWalletField" style="display:none; margin-top:6px; width:100%;">
                                <!-- MetaMask panel (desktop with wallet provider) -->
                                <div class="wallet-mm-panel" id="threadMmPanel" style="display:none;">
                                    <div class="wmp-row">
                                        <span class="wmp-label">Account</span>
                                        <span class="wmp-value" id="threadMmAddr">...</span>
                                        <button type="button" class="wmp-btn" onclick="switchWalletAccount('thread')">Switch</button>
                                    </div>
                                    <div class="wmp-row">
                                        <span class="wmp-label">Chain</span>
                                        <span class="wmp-chain-tag" id="threadMmChain">Ethereum</span>
                                        <button type="button" class="wmp-btn" onclick="openWalletChainPicker('thread')">Change</button>
                                    </div>
                                    <div class="wmp-row" id="threadChainPicker" style="display:none; width:100%;">
                                        <div class="tip-chain-selector" id="threadChainSelector" style="width:100%;"></div>
                                    </div>
                                    <div class="wallet-reveal-row"><button type="button" class="wallet-reveal-btn" onclick="toggleWalletReveal(this,'thread')">&#x1F441; Reveal</button></div>
                                    <div class="wallet-chain-inputs" style="display:none">
                                        <div class="wci-row"><span class="wci-label">🦊 ETH</span><input type="text" name="wallet_eth" id="threadWalletEth" placeholder="Auto-filled from MetaMask" maxlength="128" class="wci-input" readonly></div>
                                        <div class="wci-row"><span class="wci-label">₿ BTC</span><input type="text" name="wallet_btc" id="threadWalletBtc" placeholder="Paste BTC address (optional)" maxlength="128" class="wci-input"></div>
                                        <div class="wci-row"><span class="wci-label">💰 SOL</span><input type="text" name="wallet_sol" id="threadWalletSol" placeholder="Paste SOL address (optional)" maxlength="128" class="wci-input"></div>
                                        <div class="wci-row"><span class="wci-label">◎ TRX</span><input type="text" name="wallet_tron" id="threadWalletTron" placeholder="Paste TRX address (optional)" maxlength="128" class="wci-input"></div>
                                    </div>
                                </div>
                                <!-- Manual paste (mobile / no MetaMask) -->
                                <div class="wallet-mm-manual" id="threadManualPanel">
                                    <p style="color:#4a8f4a;font-size:11px;margin:0 0 6px;">💱 Enter addresses for each chain you want tips on:</p>
                                    <div class="wallet-reveal-row"><button type="button" class="wallet-reveal-btn" onclick="toggleWalletReveal(this,'thread')">&#x1F441; Reveal</button></div>
                                    <div class="wallet-chain-inputs" style="display:none">
                                        <div class="wci-row"><span class="wci-label">🦊 ETH</span><input type="text" name="wallet_eth" placeholder="0x... (ETH/BSC/Polygon)" maxlength="128" class="wci-input"></div>
                                        <div class="wci-row"><span class="wci-label">₿ BTC</span><input type="text" name="wallet_btc" placeholder="1.../3.../bc1... Bitcoin" maxlength="128" class="wci-input"></div>
                                        <div class="wci-row"><span class="wci-label">💰 SOL</span><input type="text" name="wallet_sol" placeholder="Solana address" maxlength="128" class="wci-input"></div>
                                        <div class="wci-row"><span class="wci-label">◎ TRX</span><input type="text" name="wallet_tron" placeholder="T... TRON address" maxlength="128" class="wci-input"></div>
                                    </div>
                                    <button type="button" class="metamask-btn" id="threadMetamask" onclick="connectMetaMask('threadWalletEth', 'threadMetamask')" style="margin-top:4px;font-size:11px;">🦊 Connect MetaMask (fills ETH)</button>
                                </div>
                            </div>
                            </div><!-- /wallet-connect-collapsible -->
                        </div>
                    </form>
                    </div><!-- /newThreadFormBody -->
                </div><!-- /post-form-container -->
                <?php elseif ($settings['board_locked']): ?>
                    <div class="board-msg error" style="text-align: center;">🔒 Board is currently locked. No new posts.</div>
                <?php endif; ?>

                <?php if (empty($threads)): ?>
                    <div class="empty-board">
                        <div class="empty-frog">🐸</div>
                        <p>Frog Channel is empty. Be the first to post!</p>
                        <p style="color: #4a8f4a;">Be the first to start a thread.</p>
                    </div>
                <?php else: ?>
                    <?php if ($isCatalog): ?>
                    <!-- ═══ CATALOG VIEW ═══ -->
                    <div class="catalog-grid">
                    <?php foreach ($threads as $thread):
                        if (!postHasVisibleContent($thread, $isAdmin)) continue;
                        $catReplyCount = count($thread['replies'] ?? []);
                        $catLikeCount = getLikeCount($thread['id']);
                        $catViewCount = getViewCount($thread['id']);
                        $catHot = hotClass($thread['id']);
                        $catClasses = 'catalog-card';
                        if ($thread['sticky'] ?? false) $catClasses .= ' sticky';
                        if ($thread['locked'] ?? false) $catClasses .= ' locked';
                        if ($catHot) $catClasses .= ' ' . $catHot;
                        $catBoost = boostClass($thread['goyim_tips'] ?? 0);
                        if ($catBoost) $catClasses .= ' ' . $catBoost;
                        // Strip HTML for clean snippet
                        $rawComment = strip_tags($thread['comment']);
                        $snippet = mb_substr($rawComment, 0, 120);
                        if (mb_strlen($rawComment) > 120) $snippet .= '…';
                    ?>
                        <div class="<?= $catClasses ?>" data-bump="<?= $thread['bump'] ?? $thread['time'] ?? 0 ?>" data-boost-until="<?= (int)($thread['bump'] ?? $thread['time'] ?? 0) ?>" data-goyim="<?= round($thread['goyim_tips'] ?? 0) ?>" data-likes="<?= $catLikeCount ?>" data-views="<?= $catViewCount ?>" data-replies="<?= $catReplyCount ?>">
                            <?= boostBadgeHtml($thread['goyim_tips'] ?? 0, (int)($thread['bump'] ?? $thread['time'] ?? 0)) ?>
                            <a href="/board?thread=<?= $thread['id'] ?>">
                                <div class="catalog-thumb" style="position:relative;">
                                    <?php if ($thread['image']): ?>
                                        <?php if (isImageVisible($thread['image'])): ?>
                                            <img src="/board_uploads/<?= $thread['image']['thumb'] ?>" alt="" loading="lazy">
                                        <?php elseif ($isAdmin && !empty($thread['image']['thumb'])): ?>
                                            <img src="/board_uploads/<?= $thread['image']['thumb'] ?>" alt="" loading="lazy" style="opacity:0.5;border:1px solid rgba(255,140,0,0.5);">
                                            <div style="position:absolute;top:2px;right:2px;background:rgba(255,140,0,0.8);color:#000;font-size:8px;padding:1px 4px;border-radius:2px;font-weight:bold;">⏳</div>
                                        <?php else: ?>
                                            <div class="image-pending-mini"><span>🕐</span><span>Pending</span></div>
                                        <?php endif; ?>
                                    <?php elseif (!empty($thread['media'])): $catM = $thread['media']; ?>
                                        <?php if (isMediaVisible($catM)): ?>
                                            <?php if ($catM['type'] === 'video'): ?>
                                                <video src="/board_uploads/<?= htmlspecialchars($catM['file'],ENT_QUOTES,'UTF-8') ?>" muted preload="metadata" style="width:100%;height:100%;object-fit:cover;pointer-events:none;"></video>
                                                <div style="position:absolute;bottom:4px;left:0;right:0;text-align:center;background:rgba(0,0,0,0.55);color:#00ff41;font-size:10px;padding:2px 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"><?= htmlspecialchars(mb_substr($catM['origName']??'',0,24),ENT_QUOTES,'UTF-8') ?></div>
                                                <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:2em;pointer-events:none;opacity:0.65;text-shadow:0 0 8px rgba(0,0,0,0.9);">▶</div>
                                            <?php else: ?>
                                                <div style="width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:4px;">
                                                    <span style="font-size:2.5em;line-height:1;">🎤</span>
                                                    <span style="font-size:10px;color:#00ff41;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:90%;"><?= htmlspecialchars(mb_substr($catM['origName']??'voice note',0,24),ENT_QUOTES,'UTF-8') ?></span>
                                                </div>
                                            <?php endif; ?>
                                        <?php else: ?>
                                            <div class="image-pending-mini">
                                                <span><?= $catM['type']==='audio' ? '🎤' : '🎥' ?></span>
                                                <span><?= $catM['type']==='audio' ? 'Voice' : 'Video' ?> pending</span>
                                            </div>
                                        <?php endif; ?>
                                    <?php else: ?>
                                        <span class="catalog-thumb-none">🐸</span>
                                    <?php endif; ?>
                                </div>
                                <div class="catalog-info">
                                    <?php if ($thread['subject']): ?>
                                        <div class="catalog-subject"><?= htmlspecialchars($thread['subject']) ?></div>
                                    <?php endif; ?>
                                    <div class="catalog-comment"><?= htmlspecialchars($snippet) ?></div>
                                </div>
                                <div class="catalog-stats">
                                    <span>💬 <span class="cs-val"><?= $catReplyCount ?></span></span>
                                    <span>🐸 <span class="cs-val"><?= $catLikeCount ?></span></span>
                                    <span>👁 <span class="cs-val"><?= $catViewCount ?></span></span>
                                </div>
                            </a>
                            <?php if (!empty($thread['media']) && !isMediaVisible($thread['media']) && $isAdmin): $catMpa = $thread['media']; ?>
                            <div class="media-pending-small media-pending-admin" style="font-size:10px;padding:4px 8px;gap:4px;flex-wrap:wrap;border-radius:0 0 6px 6px;">
                                <?= $catMpa['type']==='audio' ? '🎤 Voice' : '🎥 Video' ?> pending
                                <form method="POST" action="/board/admin" style="display:inline;"><input type="hidden" name="action" value="approve_media"><input type="hidden" name="post_id" value="<?= $thread['id'] ?>"><input type="hidden" name="is_reply" value="0"><input type="hidden" name="return_url" value="<?= htmlspecialchars($_SERVER['REQUEST_URI']) ?>"><button class="approve-overlay-btn">✅</button></form>
                                <form method="POST" action="/board/admin" style="display:inline;"><input type="hidden" name="action" value="reject_media"><input type="hidden" name="post_id" value="<?= $thread['id'] ?>"><input type="hidden" name="is_reply" value="0"><input type="hidden" name="return_url" value="<?= htmlspecialchars($_SERVER['REQUEST_URI']) ?>"><button class="reject-overlay-btn">❌</button></form>
                            </div>
                            <?php endif; ?>
                        </div>
                    <?php endforeach; ?>
                    </div>
                    <div style="text-align:center; padding:10px; color:#3a6f3a; font-size:11px; font-family:monospace;">
                        Showing all <?= $threadCount ?> thread<?= $threadCount !== 1 ? 's' : '' ?> · Sorted by bump order
                    </div>
                    <?php else: ?>
                    <!-- ═══ INDEX VIEW ═══ -->
                    <div class="live-bar" id="liveBarIndex">
                        <button class="refresh-btn" onclick="liveRefreshIndex()" title="Refresh board"><span class="refresh-icon" style="display:inline-block;">🔄</span> Refresh</button>
                        <label class="auto-label"><input type="checkbox" id="autoRefreshIndex" onchange="toggleAutoRefresh('index')"> Auto <span id="countdownIndex"></span></label>
                        <span class="live-status"><span class="live-dot" id="liveDotIndex"></span><span id="liveStatusIndex">Manual</span></span>
                    </div>
                    <div id="threadsContainer">
                    <?php foreach ($pageThreads as $thread): ?>
                        <?php if (!postHasVisibleContent($thread, $isAdmin)): continue; endif; ?>
                        <div class="thread <?= ($thread['sticky'] ?? false) ? 'sticky' : '' ?> <?= ($thread['locked'] ?? false) ? 'locked' : '' ?> <?= hotClass($thread['id']) ?> <?= boostClass($thread['goyim_tips'] ?? 0) ?>" id="p<?= $thread['id'] ?>" data-bump="<?= $thread['bump'] ?? $thread['time'] ?? 0 ?>" data-boost-until="<?= (int)($thread['bump'] ?? $thread['time'] ?? 0) ?>" data-goyim="<?= round($thread['goyim_tips'] ?? 0) ?>">
                            <?= boostBadgeHtml($thread['goyim_tips'] ?? 0, (int)($thread['bump'] ?? $thread['time'] ?? 0)) ?>
                            <div class="thread-op clearfix <?= !empty($thread['is_holder']) ? 'holder-post' : '' ?>">
                                <div class="post-header">
                                    <?php if ($thread['subject']): ?>
                                        <a href="/board?thread=<?= $thread['id'] ?>" class="post-subject"><?= $thread['subject'] ?></a>
                                    <?php endif; ?>
                                    <?php if ($thread['sticky'] ?? false): ?><span class="post-badge badge-sticky">📌</span><?php endif; ?>
                                    <?php if ($thread['locked'] ?? false): ?><span class="post-badge badge-locked">🔒</span><?php endif; ?>
                                    <?php if (($thread['capcode'] ?? null) === 'admin'): ?>
                                        <span class="post-name-admin">Frog</span><span class="capcode-admin">## Admin</span>
                                    <?php else: ?>
                                        <span class="post-anon">Anonymous</span>
                                    <?php endif; ?>
                                    <span class="post-anon-id">ID: <?= $thread['anonId'] ?></span>
                                    <?php if (!empty($thread['is_holder'])): ?><span class="goyim-holder-badge">&#x1F525; HOLDER<?php if (($thread['goyim_balance'] ?? 0) >= 1): ?><span class="gbadge-bal"> <?= number_format((float)$thread['goyim_balance'], 0) ?>G</span><?php endif; ?></span><?php endif; ?>
                                    <span class="post-time"><?= date('m/d/y(D)H:i:s', $thread['time']) ?><span class="post-timeago"> (<?= timeAgo($thread['time']) ?>)</span></span>
                                    <a href="/board?thread=<?= $thread['id'] ?>#p<?= $thread['id'] ?>" class="post-no" style="text-decoration:none;color:inherit;">No.<?= $thread['id'] ?></a>
                                    <?php if ($isAdmin): ?>
                                        <span class="admin-controls">
                                            <form method="POST" action="/board/admin" style="display:inline"><input type="hidden" name="action" value="sticky_thread"><input type="hidden" name="post_id" value="<?= $thread['id'] ?>"><input type="hidden" name="return_url" value="<?= htmlspecialchars($_SERVER['REQUEST_URI']) ?>"><button title="Pin/Unpin">📌</button></form>
                                            <form method="POST" action="/board/admin" style="display:inline"><input type="hidden" name="action" value="lock_thread"><input type="hidden" name="post_id" value="<?= $thread['id'] ?>"><input type="hidden" name="return_url" value="<?= htmlspecialchars($_SERVER['REQUEST_URI']) ?>"><button title="Lock/Unlock">🔒</button></form>
                                            <form method="POST" action="/board/admin" style="display:inline"><input type="hidden" name="action" value="delete_post"><input type="hidden" name="post_id" value="<?= $thread['id'] ?>"><input type="hidden" name="is_thread" value="1"><input type="hidden" name="return_url" value="<?= htmlspecialchars($_SERVER['REQUEST_URI']) ?>"><button onclick="return confirm('Delete thread?')" title="Delete">🗑</button></form>
                                            <form method="POST" action="/board/admin" style="display:inline"><input type="hidden" name="action" value="ban_user"><input type="hidden" name="ip_hash" value="<?= $thread['ip_hash'] ?>"><input type="hidden" name="reason" value="Banned by admin"><input type="hidden" name="duration" value="0"><input type="hidden" name="return_url" value="<?= htmlspecialchars($_SERVER['REQUEST_URI']) ?>"><button onclick="return confirm('Ban this user?')" title="Ban IP">🚫</button></form>
                                        </span>
                                    <?php endif; ?>
                                </div>
                                <?= renderPostImages($thread, $isAdmin) ?>
                                <?php if (!empty($thread['media'])): $m=$thread['media']; ?>
                                <?php if (isMediaVisible($m)): ?>
                                <div class="post-media">
                                    <?php if ($m['type']==='audio'): ?>
                                    <div class="post-voice-note"><div class="pvn-row"><span class="pvn-icon">🎤</span><div class="pvn-audio"><audio controls src="/board_uploads/<?= htmlspecialchars($m['file'],ENT_QUOTES,'UTF-8') ?>"></audio></div></div><div class="pvn-label"><?= htmlspecialchars($m['origName']??'voice note',ENT_QUOTES,'UTF-8') ?></div></div>
                                    <?php else: ?>
                                    <div class="post-video-clip"><video controls src="/board_uploads/<?= htmlspecialchars($m['file'],ENT_QUOTES,'UTF-8') ?>" preload="metadata"></video><div class="pvc-label"><?= htmlspecialchars($m['origName']??'video clip',ENT_QUOTES,'UTF-8') ?> (<?= formatFileSize($m['size']??0) ?>)</div></div>
                                    <?php endif; ?>
                                </div>
                                <?php elseif (!($m['approved'] ?? true)): ?>
                                <?php if ($isAdmin): ?>
                                <div class="media-pending-small media-pending-admin" style="flex-direction:column;align-items:flex-start;gap:6px;">
                                    <?php if ($m['type']==='video'): ?>
                                    <video controls src="/board_uploads/<?= htmlspecialchars($m['file'],ENT_QUOTES,'UTF-8') ?>" style="max-width:100%;max-height:280px;border:1px solid rgba(255,140,0,0.5);border-radius:4px;" preload="metadata"></video>
                                    <?php else: ?>
                                    <audio controls src="/board_uploads/<?= htmlspecialchars($m['file'],ENT_QUOTES,'UTF-8') ?>" style="width:100%;max-width:400px;"></audio>
                                    <?php endif; ?>
                                    <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">
                                    <?= $m['type']==='audio' ? '🎤 Voice note' : '🎥 Video' ?> pending approval
                                    <form method="POST" action="/board/admin" style="display:inline;margin-left:4px;"><input type="hidden" name="action" value="approve_media"><input type="hidden" name="post_id" value="<?= $thread['id'] ?>"><input type="hidden" name="is_reply" value="0"><input type="hidden" name="return_url" value="<?= htmlspecialchars($_SERVER['REQUEST_URI']) ?>"><button class="approve-overlay-btn">✅ Approve</button></form>
                                    <form method="POST" action="/board/admin" style="display:inline;"><input type="hidden" name="action" value="reject_media"><input type="hidden" name="post_id" value="<?= $thread['id'] ?>"><input type="hidden" name="is_reply" value="0"><input type="hidden" name="return_url" value="<?= htmlspecialchars($_SERVER['REQUEST_URI']) ?>"><button class="reject-overlay-btn">❌ Reject</button></form>
                                    </div>
                                </div>
                                <?php else: ?>
                                <div class="media-pending-small" style="font-size:13px;padding:10px 12px;justify-content:center;flex-direction:column;text-align:center;gap:4px;"><span style="font-size:1.8em;line-height:1;"><?= $m['type']==='audio' ? '🎤' : '🎥' ?></span><span><?= $m['type']==='audio' ? 'Voice note' : 'Video' ?> pending admin approval</span></div>
                                <?php endif; ?>
                                <?php endif; ?>
                                <?php endif; ?>
                                <div class="post-comment"><?= formatPostText($thread['comment'], $thread['id']) ?></div>
                            </div>
                            
                            <?php
                            $replyCount = count($thread['replies']);
                            $showReplies = array_slice($thread['replies'], -$repliesPreview);
                            $hiddenCount = $replyCount - count($showReplies);
                            ?>
                            
                            <?php if ($hiddenCount > 0): ?>
                                <div class="replies-hidden-note">
                                    <?= $hiddenCount ?> earlier repl<?= $hiddenCount === 1 ? 'y' : 'ies' ?> hidden.
                                    <a href="/board?thread=<?= $thread['id'] ?>" class="thread-link" style="text-decoration: none;">View full thread →</a>
                                </div>
                            <?php endif; ?>
                            
                            <?php foreach ($showReplies as $reply): ?>
                                <?php if (!postHasVisibleContent($reply, $isAdmin)): continue; endif; ?>
                                <div class="reply clearfix <?= hotClass($reply['id']) ?>" id="p<?= $reply['id'] ?>">
                                    <div class="post-header">
                                        <?php if (($reply['capcode'] ?? null) === 'admin'): ?>
                                            <span class="post-name-admin">Frog</span><span class="capcode-admin">## Admin</span>
                                        <?php else: ?>
                                            <span class="post-anon">Anonymous</span>
                                        <?php endif; ?>
                                        <span class="post-anon-id">ID: <?= $reply['anonId'] ?></span>
                                        <span class="post-time"><?= date('m/d/y(D)H:i:s', $reply['time']) ?></span>
                                        <a href="/board?thread=<?= $thread['id'] ?>#p<?= $reply['id'] ?>" class="post-no" style="text-decoration:none;color:inherit;">No.<?= $reply['id'] ?></a>
                                        <?php if ($isAdmin): ?>
                                            <span class="admin-controls">
                                                <form method="POST" action="/board/admin" style="display:inline"><input type="hidden" name="action" value="delete_post"><input type="hidden" name="post_id" value="<?= $reply['id'] ?>"><input type="hidden" name="thread_id" value="<?= $thread['id'] ?>"><input type="hidden" name="is_thread" value="0"><input type="hidden" name="return_url" value="<?= htmlspecialchars($_SERVER['REQUEST_URI']) ?>"><button onclick="return confirm('Delete reply?')" title="Delete">🗑</button></form>
                                                <form method="POST" action="/board/admin" style="display:inline"><input type="hidden" name="action" value="ban_user"><input type="hidden" name="ip_hash" value="<?= $reply['ip_hash'] ?>"><input type="hidden" name="reason" value="Banned by admin"><input type="hidden" name="duration" value="0"><input type="hidden" name="return_url" value="<?= htmlspecialchars($_SERVER['REQUEST_URI']) ?>"><button onclick="return confirm('Ban this user?')" title="Ban IP">🚫</button></form>
                                            </span>
                                        <?php endif; ?>
                                    </div>
                                    <?= renderPostImages($reply, $isAdmin, $thread['id'], true) ?>
                                    <?php if (!empty($reply['media'])): $m=$reply['media']; ?>
                                    <?php if (isMediaVisible($m)): ?>
                                    <div class="post-media">
                                        <?php if ($m['type']==='audio'): ?>
                                        <div class="post-voice-note"><div class="pvn-row"><span class="pvn-icon">🎤</span><div class="pvn-audio"><audio controls src="/board_uploads/<?= htmlspecialchars($m['file'],ENT_QUOTES,'UTF-8') ?>"></audio></div></div><div class="pvn-label"><?= htmlspecialchars($m['origName']??'voice note',ENT_QUOTES,'UTF-8') ?></div></div>
                                        <?php else: ?>
                                        <div class="post-video-clip"><video controls src="/board_uploads/<?= htmlspecialchars($m['file'],ENT_QUOTES,'UTF-8') ?>" preload="metadata"></video><div class="pvc-label"><?= htmlspecialchars($m['origName']??'video clip',ENT_QUOTES,'UTF-8') ?> (<?= formatFileSize($m['size']??0) ?>)</div></div>
                                        <?php endif; ?>
                                    </div>
                                    <?php elseif (!($m['approved'] ?? true)): ?>
                                    <?php if ($isAdmin): ?>
                                    <div class="media-pending-small media-pending-admin" style="flex-direction:column;align-items:flex-start;gap:6px;">
                                        <?php if ($m['type']==='video'): ?>
                                        <video controls src="/board_uploads/<?= htmlspecialchars($m['file'],ENT_QUOTES,'UTF-8') ?>" style="max-width:100%;max-height:280px;border:1px solid rgba(255,140,0,0.5);border-radius:4px;" preload="metadata"></video>
                                        <?php else: ?>
                                        <audio controls src="/board_uploads/<?= htmlspecialchars($m['file'],ENT_QUOTES,'UTF-8') ?>" style="width:100%;max-width:400px;"></audio>
                                        <?php endif; ?>
                                        <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">
                                        <?= $m['type']==='audio' ? '🎤 Voice note' : '🎥 Video' ?> pending approval
                                        <form method="POST" action="/board/admin" style="display:inline;margin-left:4px;"><input type="hidden" name="action" value="approve_media"><input type="hidden" name="post_id" value="<?= $reply['id'] ?>"><input type="hidden" name="thread_id" value="<?= $thread['id'] ?>"><input type="hidden" name="is_reply" value="1"><input type="hidden" name="return_url" value="<?= htmlspecialchars($_SERVER['REQUEST_URI']) ?>"><button class="approve-overlay-btn">✅ Approve</button></form>
                                        <form method="POST" action="/board/admin" style="display:inline;"><input type="hidden" name="action" value="reject_media"><input type="hidden" name="post_id" value="<?= $reply['id'] ?>"><input type="hidden" name="thread_id" value="<?= $thread['id'] ?>"><input type="hidden" name="is_reply" value="1"><input type="hidden" name="return_url" value="<?= htmlspecialchars($_SERVER['REQUEST_URI']) ?>"><button class="reject-overlay-btn">❌ Reject</button></form>
                                        </div>
                                    </div>
                                    <?php else: ?>
                                    <div class="media-pending-small" style="font-size:13px;padding:10px 12px;justify-content:center;flex-direction:column;text-align:center;gap:4px;"><span style="font-size:1.8em;line-height:1;"><?= $m['type']==='audio' ? '🎤' : '🎥' ?></span><span><?= $m['type']==='audio' ? 'Voice note' : 'Video' ?> pending admin approval</span></div>
                                    <?php endif; ?>
                                    <?php endif; ?>
                                    <?php endif; ?>
                                    <div class="post-comment"><?= formatPostText($reply['comment'], $reply['id']) ?></div>
                                </div>
                            <?php endforeach; ?>
                            
                            <div class="thread-footer">
                                <span class="tf-stats">
                                    <span class="ts-num"><?= $replyCount ?></span> repl<?= $replyCount === 1 ? 'y' : 'ies' ?>
                                    <span class="tf-sep">&middot;</span>
                                    <span class="view-count">&#x1F441; <?= getViewCount($thread['id']) ?></span>
                                    <span class="tf-sep">&middot;</span>
                                    <button class="like-btn <?= hasLiked($thread['id']) ? 'liked' : '' ?>" onclick="toggleLike('<?= $thread['id'] ?>', this)" data-post="<?= $thread['id'] ?>">&#x1F438; <span class="like-count"><?= getLikeCount($thread['id']) ?></span></button>
                                </span>
                                <button class="tip-btn" onclick="tipPost('<?= $thread['id'] ?>')">&#x1F4B0; Tip</button>
                                <button class="goyim-bump-btn" onclick="openGoyimBump('<?= $thread['id'] ?>')">&#x1F525; Boost<?php $gt = round($thread['goyim_tips'] ?? 0); if ($gt > 0) echo ' <span class="gbump-count">' . number_format($gt) . 'G</span>'; ?></button>
                                <?php if (!$isBanned && !($thread['locked'] ?? false) && !$settings['board_locked']): ?>
                                    <button class="reply-toggle" onclick="toggleReply('<?= $thread['id'] ?>')">&#x21A9; Reply</button>
                                <?php endif; ?>
                                <div class="share-wrap">
                                    <button class="share-btn" onclick="toggleShare(this)">&#x1F4E4;</button>
                                    <div class="share-dropdown">
                                        <button onclick="copyThreadLink('<?= $thread['id'] ?>', this)"><span class="share-icon">&#x1F517;</span> Copy Link</button>
                                        <div class="share-sep"></div>
                                        <a href="https://x.com/intent/tweet?text=<?= urlencode(($thread['subject'] ?: 'Thread') . ' — FrogTalk') ?>&url=<?= urlencode($baseUrl . '/board?thread=' . $thread['id']) ?>" target="_blank"><span class="share-icon">𝕏</span> X / Twitter</a>
                                        <a href="https://t.me/share/url?url=<?= urlencode($baseUrl . '/board?thread=' . $thread['id']) ?>&text=<?= urlencode('🐸 ' . ($thread['subject'] ?: 'Thread')) ?>" target="_blank"><span class="share-icon">✈️</span> Telegram</a>
                                        <a href="https://reddit.com/submit?url=<?= urlencode($baseUrl . '/board?thread=' . $thread['id']) ?>&title=<?= urlencode(($thread['subject'] ?: 'Thread') . ' — FrogTalk') ?>" target="_blank"><span class="share-icon">&#x1F53A;</span> Reddit</a>
                                    </div>
                                </div>
                                <a href="/board?thread=<?= $thread['id'] ?>" class="thread-link">View Thread &#x2192;</a>
                            </div>
                            
                            <?php if (!$isBanned && !($thread['locked'] ?? false) && !$settings['board_locked']): ?>
                            <div class="quick-reply" id="qr-<?= $thread['id'] ?>">
                                <form method="POST" enctype="multipart/form-data">
                                    <?= csrfField() ?>
                                    <input type="hidden" name="action" value="reply">
                                    <input type="hidden" name="thread_id" value="<?= $thread['id'] ?>">
                                    <div class="form-error" style="margin:4px 0;"></div>
                                    <div class="form-row">
                                        <textarea name="comment" placeholder="Quick reply..." maxlength="5000"></textarea>
                                    </div>
                                    <div class="form-bottom">
                                        <?php if ($_anyMedia): ?><div class="media-rec-bar" id="mrb-qr<?= $thread['id'] ?>">
                                            <div class="mrb-body" id="mrb-body-qr<?= $thread['id'] ?>">
                                                <?php if ($_allowImages): ?><label class="file-label mrb-btn">&#x1F5BC;&#xFE0F; Add Photos<input type="file" name="images[]" accept="image/jpeg,image/png,image/gif,image/webp" multiple></label><?php endif; ?>
                                                <?php if ($_mAccept): ?><label class="mrb-btn">&#x1F3A5; Add Video<input type="file" name="media" id="mrb-pick-qr<?= $thread['id'] ?>" class="mrb-file-hidden" accept="<?= htmlspecialchars($_mAccept) ?>" onchange="mrbPickFile(this,'qr<?= $thread['id'] ?>')"></label><?php endif; ?>
                                                <?php if ($_allowAudio): ?><button type="button" class="mrb-btn" id="mrb-mic-qr<?= $thread['id'] ?>" onclick="mrbStartRec('qr<?= $thread['id'] ?>','audio')">&#x1F3A4; Voice Note</button><?php endif; ?>
                                                <span class="mrb-status" id="mrb-status-qr<?= $thread['id'] ?>"></span>
                                                <div class="mrb-preview" id="mrb-preview-qr<?= $thread['id'] ?>"><span id="mrb-preview-el-qr<?= $thread['id'] ?>"></span><button type="button" class="mrb-cancel" onclick="mrbCancel('qr<?= $thread['id'] ?>')">✕ Clear</button></div>
                                            </div>
                                        </div><?php endif; ?>
                                        <button type="submit" class="post-btn">POST</button>
                                    </div>
                                    <div class="wallet-connect-row">
                                        <button type="button" class="wallet-toggle-btn" onclick="var c=this.closest('.wallet-connect-row').querySelector('.wallet-connect-collapsible');var open=c.style.display==='block';c.style.display=open?'none':'block';this.classList.toggle('open',!open);">🦊 Wallet for tips <span class="wtb-arrow">▼</span></button>
                                        <div class="wallet-connect-collapsible">
                                        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;color:#4a8f4a;font-size:11px;font-family:'Courier New',monospace;margin-top:6px;">
                                            <input type="checkbox" onchange="this.closest('.wallet-connect-row').querySelector('.qr-wallet-fields').style.display=this.checked?'block':'none';try{localStorage.setItem('walletToggle',this.checked?'1':'0');if(this.checked&&typeof restoreWalletAddresses==='function')restoreWalletAddresses();}catch(e){}" style="accent-color:#f6851b;"> Include in post
                                        </label>
                                        <div class="qr-wallet-fields" style="display:none;margin-top:6px;">
                                            <div class="wallet-chain-inputs">
                                                <div class="wci-row"><span class="wci-label">🦊 ETH</span><input type="text" name="wallet_eth" placeholder="0x... (ETH/BSC/Polygon)" maxlength="128" class="wci-input"></div>
                                                <div class="wci-row"><span class="wci-label">₿ BTC</span><input type="text" name="wallet_btc" placeholder="BTC address" maxlength="128" class="wci-input"></div>
                                                <div class="wci-row"><span class="wci-label">💰 SOL</span><input type="text" name="wallet_sol" placeholder="Solana address" maxlength="128" class="wci-input"></div>
                                                <div class="wci-row"><span class="wci-label">◎ TRX</span><input type="text" name="wallet_tron" placeholder="TRON address" maxlength="128" class="wci-input"></div>
                                            </div>
                                        </div>
                                        </div>
                                    </div>
                                </form>
                            </div>
                            <?php endif; ?>
                        </div>
                    <?php endforeach; ?>
                    </div><!-- /threadsContainer -->
                    
                    <?php if ($totalPages > 1): ?>
                    <div class="board-pagination">
                        <?php if ($currentPage > 1): ?>
                            <a href="/board?page=<?= $currentPage - 1 ?>" class="page-btn">« Prev</a>
                        <?php else: ?>
                            <span class="page-btn disabled">« Prev</span>
                        <?php endif; ?>
                        
                        <?php
                        // Show page numbers with ellipsis for large page counts
                        $range = 2;
                        for ($p = 1; $p <= $totalPages; $p++):
                            if ($p === 1 || $p === $totalPages || abs($p - $currentPage) <= $range):
                        ?>
                            <?php if ($p === $currentPage): ?>
                                <span class="page-btn current">[<?= $p ?>]</span>
                            <?php else: ?>
                                <a href="/board?page=<?= $p ?>" class="page-btn">[<?= $p ?>]</a>
                            <?php endif; ?>
                        <?php
                            elseif ($p === $currentPage - $range - 1 || $p === $currentPage + $range + 1):
                                echo '<span class="page-ellipsis">…</span>';
                            endif;
                        endfor;
                        ?>
                        
                        <?php if ($currentPage < $totalPages): ?>
                            <a href="/board?page=<?= $currentPage + 1 ?>" class="page-btn">Next »</a>
                        <?php else: ?>
                            <span class="page-btn disabled">Next »</span>
                        <?php endif; ?>
                        
                        <span class="page-info">Page <?= $currentPage ?>/<?= $totalPages ?> · <?= $threadCount ?> threads</span>
                    </div>
                    <?php endif; ?>
                    <?php endif; ?><!-- /index vs catalog -->
                <?php endif; ?><!-- /empty threads check -->
            <?php endif; ?><!-- /singleThread check -->

            <div class="board-footer">
                <a href="/" style="font-weight:700;">🐸 FrogTalk</a>
                <?php if ($isAdmin): ?> · <a href="/board/admin" style="color: #ff8c00;">🔧 Admin</a><?php endif; ?>
                <br>
                <span style="font-size:11px;color:#6baf6b;letter-spacing:.2px;">powered by FrogTalk</span>
                <br>
                <span class="footer-online"><span class="footer-views">👁 <?= number_format($totalViews) ?> views</span> · <span class="online-dot footer-dot"></span> <span class="footer-online-count"><?= $onlineCount ?> online</span></span>
                <br><br>
                <span>🐸 The swamp remembers everything.</span>
            </div>
        </div>
    </main>

    <!-- Image expand overlay -->
    <div class="img-overlay" id="imgOverlay" onclick="closeExpanded()"></div>
    
    <!-- Tip Modal -->
    <div class="tip-modal-overlay" id="tipOverlay" onclick="if(event.target===this)closeTipModal()">
        <div class="tip-modal">
            <h3>💰 Tip This Poster</h3>
            <div id="tipNoWallet" style="display:none; padding: 15px; background: rgba(255,68,68,0.06); border: 1px solid rgba(255,68,68,0.2); border-radius: 6px; margin-bottom: 12px;">
                <p style="color: #ff8888; font-size: 12px; margin: 0;">⚠️ This poster hasn't connected a wallet yet.</p>
                <p style="color: #4a8f4a; font-size: 11px; margin: 6px 0 0;">They need to connect MetaMask when posting to receive tips.</p>
            </div>
            <div id="tipHasWallet">
                <p style="color: #4a8f4a; font-size: 11px; margin: 0 0 6px;">Sending to: <span id="tipRecipientDisplay" style="color: #f6851b;"></span></p>
                <!-- Desktop: MetaMask flow -->
                <div id="tipDesktopFlow">
                    <div class="tip-chain-selector" id="tipChainSelector"></div>
                    <p class="tip-chain-current">Network: <span id="tipChainName">Ethereum</span> · <span id="tipChainSymbol">ETH</span></p>
                    <div class="tip-amounts" id="tipAmountsContainer"></div>
                    <input type="text" class="tip-custom" id="tipCustomAmount" placeholder="Or enter custom amount" oninput="clearTipSelection()">
                    <input type="hidden" id="tipRecipient" value="">
                    <button class="tip-send-btn" id="tipSendBtn" onclick="sendTip()">🦊 Send Tip via MetaMask</button>
                </div>
                <!-- Mobile: Simple info popup -->
                <div id="tipMobileFlow" style="display:none;">
                    <p style="color:#6baf6b; font-size:13px; margin:8px 0 10px;">📱 Send a tip from your wallet app</p>
                    <div class="tip-chain-selector" id="tipMobileChainSelector"></div>
                    <div style="background:rgba(246,133,27,0.05); border:1px solid rgba(246,133,27,0.2); border-radius:8px; padding:14px; margin:10px 0; text-align:left;">
                        <div style="margin-bottom:10px;">
                            <span style="color:#4a8f4a; font-size:11px;">CHAIN</span><br>
                            <span id="tipMobileChainName" style="color:#f6851b; font-size:14px; font-weight:bold; font-family:'Courier New',monospace;">Ethereum</span>
                            <span style="color:#888;"> · </span>
                            <span id="tipMobileChainSymbol" style="color:#f6851b; font-family:'Courier New',monospace;">ETH</span>
                        </div>
                        <div style="margin-bottom:10px;">
                            <span style="color:#4a8f4a; font-size:11px;">SEND TO ADDRESS</span><br>
                            <span id="tipMobileAddr" style="color:#f6851b; font-size:12px; font-family:'Courier New',monospace; word-break:break-all; user-select:all;"></span>
                        </div>
                        <div>
                            <span style="color:#4a8f4a; font-size:11px;">SUGGESTED AMOUNTS</span><br>
                            <span id="tipMobileSuggested" style="color:#ffd700; font-size:13px; font-family:'Courier New',monospace;">0.001, 0.005, 0.01, 0.05 ETH</span>
                        </div>
                    </div>
                    <button class="tip-send-btn" onclick="copyTipAddress()" style="background:#f6851b; width:100%; font-size:15px; padding:12px;">📋 Copy Address</button>
                    <div id="tipCopyConfirm" style="display:none; color:#00ff41; font-size:12px; margin-top:6px;">✅ Copied! Now paste in your wallet app.</div>
                    <input type="hidden" id="tipRecipientMobile" value="">
                </div>
            </div>
            <div class="tip-close" onclick="closeTipModal()">Cancel</div>
            <div id="tipStatus" style="margin-top: 10px; font-size: 12px; color: #6baf6b;"></div>
        </div>
    </div>

    <!-- ═══ GOYIM BOOST MODAL ═══ -->
    <div class="gbump-overlay" id="gbumpOverlay" onclick="if(event.target===this)closeGoyimBump()">
        <div class="gbump-modal">
            <h3>&#x1F525; BOOST THREAD WITH $GOYIM</h3>
            <p class="gbump-sub">Tip $GOYIM tokens to push this thread up the board algorithmically.<br>1,000 GOYIM = +1 hour bump time. Tips stack permanently.</p>
            <div class="gbump-info-box" id="gbumpInfoBox">
                &#x1F4E1; <strong style="color:#cc8800;">Token Status:</strong> <span id="gbumpTokenStatus">Checking...</span><br>
                &#x1F3AF; <strong style="color:#cc8800;">Treasury:</strong> <span id="gbumpTreasury" style="word-break:break-all;">Loading...</span>
            </div>
            <div id="gbumpFormArea">
                <div class="gbump-amounts" id="gbumpAmountBtns">
                    <button class="gbump-amt" onclick="selectGbumpAmt(100,this)">100</button>
                    <button class="gbump-amt" onclick="selectGbumpAmt(500,this)">500</button>
                    <button class="gbump-amt" onclick="selectGbumpAmt(1000,this)">1,000</button>
                    <button class="gbump-amt" onclick="selectGbumpAmt(5000,this)">5,000</button>
                </div>
                <input type="number" class="gbump-custom" id="gbumpCustom" placeholder="Or enter custom GOYIM amount" oninput="clearGbumpSelection()" min="1">
                <div id="gbumpPhantomArea" style="margin-bottom:8px;">
                    <button class="gbump-send-btn" id="gbumpConnectBtn" onclick="connectPhantomForBump()" style="background:#512da8;font-size:12px;padding:7px;">&#x1F47B; Connect Phantom Wallet</button>
                    <div id="gbumpPhantomStatus" style="font-family:'Courier New',monospace;font-size:11px;color:#888;text-align:center;margin-top:5px;"></div>
                </div>
                <button class="gbump-send-btn" id="gbumpSendBtn" onclick="submitGoyimBump()" style="display:none;">&#x1F525; Send GOYIM &amp; Boost Thread</button>
            </div>
            <div class="gbump-status" id="gbumpStatus"></div>
            <div class="gbump-close" onclick="closeGoyimBump()">Cancel</div>
        </div>
    </div>

    <?php if ($settings['chat_enabled'] && !$isBanned): ?>
    <!-- ═══ FROGTALK MINI WIDGET ═══ -->
    <div class="chat-widget" id="chatWidget">
        <div class="chat-header" onclick="toggleFrogMini()">
            <h4 class="frog-mini-headline"><span class="frog-mini-emoji" aria-hidden="true">🐸</span><span class="frog-mini-label">FrogTalk</span></h4>
            <span class="frog-mini-note" id="frogMiniState">Checking login…</span>
            <button class="frog-mini-open-full" id="frogMiniOpenFull" type="button" title="Open full FrogTalk" aria-label="Open full FrogTalk in new tab" onclick="event.stopPropagation();frogMiniOpenFullApp()">↗</button>
            <button class="chat-toggle" id="chatToggleBtn">▲</button>
        </div>
        <div class="chat-body" id="chatBody" style="display:block;max-height:none;">
            <div id="frogMiniGuest" class="frog-mini-guest">
                <div class="frog-mini-guest-title">Sign in to use FrogTalk while browsing</div>
                <div class="frog-mini-guest-copy">Open your channels and DMs in this side panel without leaving Frog Channel.</div>
                <div class="frog-mini-actions">
                    <button class="frog-mini-btn login" type="button" onclick="frogMiniAuth('login')">Sign In</button>
                    <button class="frog-mini-btn register" type="button" onclick="frogMiniAuth('register')">Register</button>
                </div>
            </div>
            <div id="frogMiniWrap" class="frog-mini-wrap">
                <iframe id="frogMiniFrame" class="frog-mini-frame" src="about:blank" title="FrogTalk mini channels and DMs"></iframe>
            </div>
        </div>
    </div>
    <?php endif; ?>

    <script>
    // ══ $GOYIM Boost config (from .env via PHP) ══
    var BOARD_GOYIM_CA           = '<?php echo htmlspecialchars(BOARD_GOYIM_CA); ?>';
    var BOARD_GOYIM_TREASURY     = '<?php echo htmlspecialchars(BOARD_GOYIM_TREASURY); ?>';
    var BOARD_GOYIM_ADMIN_WALLET = '<?php echo htmlspecialchars(BOARD_GOYIM_ADMIN_WALLET); ?>';
    var BOARD_IS_ADMIN           = <?php echo $isAdmin ? 'true' : 'false'; ?>;
    var REQUIRE_AUDIO_APPROVAL = <?= ($settings['require_audio_approval'] ?? false) ? 'true' : 'false' ?>;
    var REQUIRE_VIDEO_APPROVAL = <?= ($settings['require_video_approval'] ?? true) ? 'true' : 'false' ?>;
    // ── Auto-inject CSRF tokens into admin forms ──
    (function() {
        var csrfToken = document.querySelector('meta[name="csrf-token"]');
        if (csrfToken) {
            document.querySelectorAll('form[action="/board/admin"]').forEach(function(form) {
                if (!form.querySelector('input[name="csrf_token"]')) {
                    var input = document.createElement('input');
                    input.type = 'hidden';
                    input.name = 'csrf_token';
                    input.value = csrfToken.getAttribute('content');
                    form.appendChild(input);
                }
            });
        }
    })();
    // Nav minimize was removed from the UI; force expanded nav and clear old state.
    (function() {
        document.body.classList.remove('nav-minimized');
        try { localStorage.removeItem('navMinimized'); } catch (e) {}
    })();
    function toggleNavMinimize() {}

    // ── View Mode Bar mobile toggle ──
    (function() {
        if (!window.matchMedia('(max-width: 768px)').matches) return;
        var bar = document.getElementById('viewModeBar');
        if (!bar) return;
        var c = localStorage.getItem('vmbCollapsed');
        if (c !== '0') bar.classList.add('vmb-collapsed');
        var arrow = document.getElementById('vmbToggleArrow');
        if (arrow) arrow.textContent = bar.classList.contains('vmb-collapsed') ? '▼' : '▲';
    })();
    function toggleViewModeBar() {
        var bar = document.getElementById('viewModeBar');
        var arrow = document.getElementById('vmbToggleArrow');
        if (!bar) return;
        var collapsed = bar.classList.toggle('vmb-collapsed');
        if (arrow) arrow.textContent = collapsed ? '▼' : '▲';
        try { localStorage.setItem('vmbCollapsed', collapsed ? '1' : '0'); } catch(e) {}
    }

    // ── YouTube embed toggle ──
    function toggleYT(uid) {
        var el = document.getElementById(uid);
        if (!el) return;
        var toggle = el.querySelector('.yt-toggle');
        var frame  = el.querySelector('.yt-frame-wrap');
        if (!frame) return;
        var isOpen = frame.style.display !== 'none';
        if (isOpen) {
            // Close: remove iframe from DOM entirely so sort moves won't reload it
            var existing = frame.querySelector('iframe');
            if (existing) existing.remove();
            frame.style.display = 'none';
            if (toggle) toggle.style.display = '';
        } else {
            // Open: inject iframe now (lazy) using data attrs on parent .yt-embed
            var ytId   = el.dataset.ytId   || '';
            var ytTime = el.dataset.ytTime  || '0';
            if (!ytId) return;
            if (!frame.querySelector('iframe')) {
                var src = 'https://www.youtube-nocookie.com/embed/' + ytId
                        + '?autoplay=1' + (ytTime !== '0' ? '&start=' + ytTime : '')
                        + '&rel=0';
                var iframe = document.createElement('iframe');
                iframe.width = '560'; iframe.height = '315';
                iframe.src = src;
                iframe.setAttribute('frameborder', '0');
                iframe.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share');
                iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
                iframe.setAttribute('allowfullscreen', '');
                frame.appendChild(iframe);
            }
            frame.style.display = '';
            if (toggle) toggle.style.display = 'none';
        }
    }

    // ── Nav Dropdown (touch support for board.php) ──
    (function(){
        var isTouch = window.matchMedia('(hover: none)').matches;
        var isMobile = window.matchMedia('(max-width: 768px)').matches;
        document.querySelectorAll('.nav-item[data-dropdown]').forEach(function(item) {
            var link = item.querySelector(':scope > .nav-link');
            if (!link) return;
            link.addEventListener('click', function(e) {
                if (!isTouch || isMobile) return; // mobile CSS flattens submenus, desktop uses hover
                if (!item.classList.contains('nd-open')) {
                    e.preventDefault();
                    document.querySelectorAll('.nav-item[data-dropdown]').forEach(function(o){ o.classList.remove('nd-open'); });
                    item.classList.add('nd-open');
                }
            });
        });
        document.addEventListener('click', function(e) {
            if (!e.target.closest('.nav-item[data-dropdown]')) {
                document.querySelectorAll('.nav-item[data-dropdown]').forEach(function(i){ i.classList.remove('nd-open'); });
            }
        });
    })();

    // ── Board Functions ──
    function toggleReply(threadId) {
        const qr = document.getElementById('qr-' + threadId);
        if (qr) {
            qr.classList.toggle('active');
            const isOpen = qr.classList.contains('active');
            if (isOpen) qr.querySelector('textarea').focus();
            try { localStorage.setItem('openReplyBox', isOpen ? String(threadId) : ''); } catch(e){}
        }
    }
    
    function insertQuote(postId) {
        const ta = document.getElementById('replyComment') || document.querySelector('.quick-reply.active textarea');
        if (ta) { ta.value += '>>' + postId + '\n'; ta.focus(); }
    }
    
    function showFileName(input, spanId) {
        const n = input.files.length;
        const text = n === 0 ? '' : n === 1 ? input.files[0].name : n + ' images selected';
        const span = spanId ? document.getElementById(spanId) : input.closest('.form-bottom')?.querySelector('.file-name');
        if (span) span.textContent = text;
    }
    function carNav(postId, dir) {
        var car = document.getElementById('car-' + postId);
        if (!car) return;
        var slides = car.querySelectorAll('.car-slide');
        var dots   = car.querySelectorAll('.car-dot');
        var cur = Array.prototype.findIndex.call(slides, function(s){ return s.classList.contains('active'); });
        slides[cur].classList.remove('active');
        if (dots[cur]) dots[cur].classList.remove('active');
        cur = (cur + dir + slides.length) % slides.length;
        slides[cur].classList.add('active');
        if (dots[cur]) dots[cur].classList.add('active');
    }
    function carGoto(postId, idx) {
        var car = document.getElementById('car-' + postId);
        if (!car) return;
        car.querySelectorAll('.car-slide').forEach(function(s,i){ s.classList.toggle('active', i === idx); });
        car.querySelectorAll('.car-dot').forEach(function(d,i){ d.classList.toggle('active', i === idx); });
    }
    // Touch swipe for carousels
    (function initCarouselTouch() {
        document.querySelectorAll('.post-carousel').forEach(function(car) {
            var sx = null;
            car.addEventListener('touchstart', function(e){ sx = e.touches[0].clientX; }, { passive: true });
            car.addEventListener('touchend', function(e) {
                if (sx === null) return;
                var dx = e.changedTouches[0].clientX - sx;
                if (Math.abs(dx) > 40) {
                    var pid = car.id.replace('car-', '');
                    carNav(pid, dx > 0 ? -1 : 1);
                }
                sx = null;
            }, { passive: true });
        });
    })();
    
    function expandImage(thumb) {
        const fullSrc = thumb.getAttribute('data-full');
        if (!fullSrc) return;
        const overlay = document.getElementById('imgOverlay');
        overlay.style.display = 'block';
        const img = document.createElement('img');
        img.src = fullSrc;
        img.className = 'expanded-img';
        img.onclick = closeExpanded;
        document.body.appendChild(img);
        document.body.style.overflow = 'hidden';
    }
    
    function closeExpanded() {
        document.getElementById('imgOverlay').style.display = 'none';
        const expanded = document.querySelector('.expanded-img');
        if (expanded) expanded.remove();
        document.body.style.overflow = 'auto';
    }
    
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeExpanded(); });

    // ── Share ──
    function toggleShare(btn) {
        const dropdown = btn.nextElementSibling;
        // Close all other dropdowns first
        document.querySelectorAll('.share-dropdown.active').forEach(d => {
            if (d !== dropdown) d.classList.remove('active');
        });
        dropdown.classList.toggle('active');
    }
    
    function copyThreadLink(threadId, btn) {
        const url = window.location.origin + '/board?thread=' + threadId;
        navigator.clipboard.writeText(url).then(() => {
            const orig = btn.innerHTML;
            btn.innerHTML = '<span class="share-icon">✅</span> Copied!';
            btn.classList.add('share-copied');
            setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('share-copied'); }, 1500);
        }).catch(() => {
            // Fallback
            const ta = document.createElement('textarea');
            ta.value = url;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            const orig = btn.innerHTML;
            btn.innerHTML = '<span class="share-icon">✅</span> Copied!';
            setTimeout(() => btn.innerHTML = orig, 1500);
        });
        // Close dropdown after copy
        btn.closest('.share-dropdown').classList.remove('active');
    }
    
    // Close share dropdowns when clicking outside
    document.addEventListener('click', function(e) {
        if (!e.target.closest('.share-wrap')) {
            document.querySelectorAll('.share-dropdown.active').forEach(d => d.classList.remove('active'));
        }
    });

    // ── Likes ──
    function updateHotClass(el, count) {
        if (!el) return;
        el.classList.remove('hot-10', 'hot-100', 'hot-1000');
        if (count >= 1000) el.classList.add('hot-1000');
        else if (count >= 100) el.classList.add('hot-100');
        else if (count >= 10) el.classList.add('hot-10');
    }
    
    async function toggleLike(postId, btn) {
        try {
            const formData = new FormData();
            formData.append('action', 'like');
            formData.append('post_id', postId);
            const res = await fetch('/board', { method: 'POST', body: formData });
            const data = await res.json();
            if (data.error) return;
            
            const countEl = btn.querySelector('.like-count');
            countEl.textContent = data.count;
            btn.classList.toggle('liked', data.liked);
            btn.classList.add('like-pop');
            setTimeout(() => btn.classList.remove('like-pop'), 300);
            
            // Update hot glow on parent thread or reply
            var postEl = document.getElementById('p' + postId);
            if (postEl) updateHotClass(postEl, data.count);
            // If this is a thread div (has .thread class parent), update the thread wrapper too
            var threadEl = postEl ? postEl.closest('.thread') : null;
            if (threadEl && postEl.classList.contains('thread-op')) {
                updateHotClass(threadEl, data.count);
            }
        } catch (e) { /* silent */ }
    }

    // ── MetaMask Wallet Connect ──
    let connectedWallet = null;
    let walletBalance = null;

    // ── EIP-6963 multi-wallet provider detection (bypasses evmAsk.js Brave/MetaMask proxy conflict) ──
    var _boardEIP6963 = {};
    window.addEventListener('eip6963:announceProvider', function(e) {
        if (e.detail && e.detail.info && e.detail.provider) {
            _boardEIP6963[e.detail.info.rdns] = e.detail.provider;
        }
    });
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    async function getBoardProvider() {
        if (_boardEIP6963['io.metamask']) return _boardEIP6963['io.metamask'];
        // Wait briefly for late EIP-6963 announcements
        await new Promise(function(r){ setTimeout(r, 80); });
        if (_boardEIP6963['io.metamask']) return _boardEIP6963['io.metamask'];
        // Multi-provider fallback (Brave + MetaMask coexist)
        if (window.ethereum && window.ethereum.providers && window.ethereum.providers.length) {
            var mm = window.ethereum.providers.find(function(p){ return p.isMetaMask && !p.isBraveWallet; });
            if (mm) return mm;
        }
        if (window.ethereum && !window.ethereum.isBraveWallet) return window.ethereum;
        return window.ethereum;
    }
    
    const VIEW_THREAD_ID = <?= json_encode($viewThread) ?>;

    function _pfKey(key) {
        // Per-thread key for reply form; shared key for new-thread form
        if (key === 'reply' && VIEW_THREAD_ID) return 'postForm_reply_' + VIEW_THREAD_ID;
        return 'postForm_' + key;
    }
    function togglePostForm(key) {
        var body = document.getElementById(key + 'FormBody');
        var btn  = document.getElementById(key + 'ToggleBtn');
        if (!body) return;
        var isOpen = !body.classList.contains('collapsed');
        body.classList.toggle('collapsed', isOpen);
        if (btn) btn.classList.toggle('collapsed', isOpen);
        try { sessionStorage.setItem(_pfKey(key), isOpen ? '0' : '1'); } catch(e){}
    }

    function toggleWalletReveal(btn, prefix) {
        var row = btn.closest('.wallet-reveal-row');
        if (!row) return;
        var chain = row.nextElementSibling;
        if (!chain || !chain.classList.contains('wallet-chain-inputs')) return;
        var hidden = chain.style.display === 'none';
        chain.style.display = hidden ? '' : 'none';
        btn.innerHTML = hidden ? '&#x1F648; Hide' : '&#x1F441; Reveal';
    }

    // Restore post form open/closed state from sessionStorage (per-thread for reply form)
    const HAS_POST_ERROR = <?= json_encode(!empty($error)) ?>;
    (function restorePostForms() {
        var justPosted = /[?&]post=/.test(location.search);
        [['newThread', true], ['reply', true]].forEach(function(pair) {
            var key = pair[0], defaultOpen = pair[1];
            var body = document.getElementById(key + 'FormBody');
            var btn  = document.getElementById(key + 'ToggleBtn');
            if (!body) return;
            // If we just landed from a successful post, force reply form closed
            if (justPosted && key === 'reply') {
                body.classList.add('collapsed');
                if (btn) btn.classList.add('collapsed');
                try { sessionStorage.setItem(_pfKey('reply'), '0'); } catch(e){}
                return;
            }
            // If there was a server error (e.g. rate limit), force reply form open so user sees error
            if (HAS_POST_ERROR && key === 'reply') {
                body.classList.remove('collapsed');
                if (btn) btn.classList.remove('collapsed');
                try { sessionStorage.setItem(_pfKey('reply'), '1'); } catch(e){}
                return;
            }
            var saved = null;
            try { saved = sessionStorage.getItem(_pfKey(key)); } catch(e){}
            var open  = saved === null ? defaultOpen : (saved === '1');
            body.classList.toggle('collapsed', !open);
            if (btn) btn.classList.toggle('collapsed', !open);
        });
    })();

    function toggleWalletField(type) {
        var fieldDiv = document.getElementById(type === 'reply' ? 'replyWalletField' : 'threadWalletField');
        var toggle = document.getElementById(type === 'reply' ? 'replyWalletToggle' : 'threadWalletToggle');
        if (toggle && fieldDiv) {
            var show = toggle.checked;
            fieldDiv.style.display = show ? 'block' : 'none';
            if (show) {
                initWalletPanel(type);
                restoreWalletAddresses();
            }
            // Persist state
            try { localStorage.setItem('walletToggle', show ? '1' : '0'); } catch(e){}
        }
    }

    // Save wallet addresses to localStorage whenever they change
    // Merges with existing saved addresses — never wipes a chain that still has a saved value
    function saveWalletAddresses() {
        try {
            var existing = {};
            try { existing = JSON.parse(localStorage.getItem('walletAddresses')) || {}; } catch(e){}
            var chains = ['wallet_eth', 'wallet_btc', 'wallet_sol', 'wallet_tron'];
            chains.forEach(function(name) {
                var inputs = document.querySelectorAll('input[name="' + name + '"]');
                inputs.forEach(function(inp) {
                    var v = (inp.value || '').trim();
                    // Only update storage if the input actually has a value
                    if (v) existing[name] = v;
                });
            });
            if (Object.keys(existing).length > 0) {
                localStorage.setItem('walletAddresses', JSON.stringify(existing));
            }
        } catch(e){}
    }

    // Restore saved wallet addresses into all matching inputs on the page
    function restoreWalletAddresses() {
        try {
            var raw = localStorage.getItem('walletAddresses');
            if (!raw) return;
            var addrs = JSON.parse(raw);
            if (!addrs || typeof addrs !== 'object') return;
            Object.keys(addrs).forEach(function(name) {
                var val = addrs[name];
                if (!val) return;
                document.querySelectorAll('input[name="' + name + '"]').forEach(function(inp) {
                    if (!inp.value || !inp.value.trim()) {
                        inp.value = val;
                    }
                });
            });
        } catch(e){}
    }

    // Auto-save wallet addresses whenever user types in any wallet input
    document.addEventListener('input', function(e) {
        if (e.target && e.target.matches && e.target.matches('input[name^="wallet_"]')) {
            saveWalletAddresses();
        }
    });

    // Restore wallet checkbox state AND addresses on page load
    document.addEventListener('DOMContentLoaded', function() {
        try {
            var saved = localStorage.getItem('walletToggle');
            if (saved === '1') {
                // Thread form
                var tt = document.getElementById('threadWalletToggle');
                if (tt) { tt.checked = true; toggleWalletField('thread'); }
                // Reply form
                var rt = document.getElementById('replyWalletToggle');
                if (rt) { rt.checked = true; toggleWalletField('reply'); }
                // Quick-reply forms (index page)
                document.querySelectorAll('.wallet-connect-row input[type="checkbox"]:not([id])').forEach(function(cb) {
                    cb.checked = true;
                    var fields = cb.closest('.wallet-connect-row').querySelector('.qr-wallet-fields');
                    if (fields) fields.style.display = 'block';
                });
            }
            // Restore saved addresses into all wallet inputs
            restoreWalletAddresses();
        } catch(e){}
    });
    
    function initWalletPanel(type) {
        var mmPanel = document.getElementById(type + 'MmPanel');
        var manualPanel = document.getElementById(type + 'ManualPanel');
        if (typeof window.ethereum !== 'undefined' || Object.keys(_boardEIP6963).length > 0) {
            // Desktop with MetaMask — show MetaMask panel
            if (mmPanel) mmPanel.style.display = 'block';
            if (manualPanel) {
                manualPanel.style.display = 'none';
                // Disable manual panel inputs so they don't override MetaMask values on form submit
                manualPanel.querySelectorAll('input[name]').forEach(function(inp) { inp.disabled = true; });
            }
            // Auto-connect if not already
            if (!connectedWallet) {
                connectAndShowPanel(type);
            } else {
                updateWalletPanel(type);
            }
        } else {
            // Mobile / no wallet — show manual paste, disable MetaMask panel inputs
            if (mmPanel) {
                mmPanel.style.display = 'none';
                mmPanel.querySelectorAll('input[name]').forEach(function(inp) { inp.disabled = true; });
            }
            if (manualPanel) {
                manualPanel.style.display = 'block';
                manualPanel.querySelectorAll('input[name]').forEach(function(inp) { inp.disabled = false; });
            }
        }
    }
    
    async function connectAndShowPanel(type) {
        try {
            const _prov = await getBoardProvider();
            if (!_prov) throw new Error('no-provider');
            const accounts = await _prov.request({ method: 'eth_requestAccounts' });
            if (accounts && accounts[0]) {
                connectedWallet = accounts[0];
                localStorage.removeItem('boardWalletDismissed');
                document.querySelectorAll('[id$="WalletEth"]').forEach(el => { el.value = connectedWallet; el.readOnly = true; });
                await updateWalletBar();
                updateWalletPanel(type);
            }
        } catch(e) {
            // User rejected — fall back to manual, swap disabled states
            var mmPanel = document.getElementById(type + 'MmPanel');
            var manualPanel = document.getElementById(type + 'ManualPanel');
            if (mmPanel) {
                mmPanel.style.display = 'none';
                mmPanel.querySelectorAll('input[name]').forEach(function(inp) { inp.disabled = true; });
            }
            if (manualPanel) {
                manualPanel.style.display = 'block';
                manualPanel.querySelectorAll('input[name]').forEach(function(inp) { inp.disabled = false; });
            }
        }
    }
    
    async function updateWalletPanel(type) {
        if (!connectedWallet) return;
        var addrEl = document.getElementById(type + 'MmAddr');
        var chainEl = document.getElementById(type + 'MmChain');
        var ethInput = document.getElementById(type + 'WalletEth');
        
        if (addrEl) addrEl.textContent = connectedWallet.slice(0,6) + '...' + connectedWallet.slice(-4);
        if (ethInput) { ethInput.value = connectedWallet; ethInput.readOnly = true; }
        
        try {
            const _p = await getBoardProvider();
            var chainId = await _p.request({ method: 'eth_chainId' });
            var chain = CHAINS[chainId] || { name: 'Chain ' + parseInt(chainId, 16), symbol: '?', color: '#999' };
            if (chainEl) chainEl.innerHTML = '<span class="chain-dot" style="background:' + chain.color + ';width:6px;height:6px;border-radius:50%;display:inline-block;"></span> ' + chain.name + ' (' + chain.symbol + ')';
        } catch(e) {
            if (chainEl) chainEl.textContent = 'Unknown';
        }
    }
    
    async function switchWalletAccount(type) {
        try {
            const _p = await getBoardProvider();
            if (!_p) return;
            // Request wallet to show account picker
            await _p.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] });
            const accounts = await _p.request({ method: 'eth_accounts' });
            if (accounts && accounts[0]) {
                connectedWallet = accounts[0];
                document.querySelectorAll('[id$="WalletEth"]').forEach(el => { el.value = connectedWallet; el.readOnly = true; });
                updateWalletPanel('thread');
                updateWalletPanel('reply');
                await updateWalletBar();
                showToast('🦊 Switched to ' + connectedWallet.slice(0,6) + '...' + connectedWallet.slice(-4));
            }
        } catch(e) {
            if (e.code !== 4001) console.error('Switch account error:', e);
        }
    }
    
    function openWalletChainPicker(type) {
        var picker = document.getElementById(type + 'ChainPicker');
        if (!picker) return;
        var isVisible = picker.style.display !== 'none';
        picker.style.display = isVisible ? 'none' : 'block';
        if (!isVisible) buildWalletChainSelector(type);
    }
    
    function buildWalletChainSelector(type) {
        var container = document.getElementById(type + 'ChainSelector');
        if (!container) return;
        container.innerHTML = '';
        var evmChains = ['0x1', '0x38', '0x89', '0xa86a', '0xa', '0xa4b1'];
        evmChains.forEach(function(cid) {
            var c = CHAINS[cid];
            if (!c) return;
            var btn = document.createElement('div');
            btn.className = 'tip-chain-btn';
            btn.innerHTML = '<span class="chain-dot" style="background:' + c.color + '"></span>' + c.name;
            btn.onclick = function() { switchWalletChain(type, cid); };
            container.appendChild(btn);
        });
    }
    
    async function switchWalletChain(type, chainId) {
        try {
            const _p = await getBoardProvider();
            if (!_p) return;
            await _p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainId }] });
            updateWalletPanel(type);
            var picker = document.getElementById(type + 'ChainPicker');
            if (picker) picker.style.display = 'none';
            showToast('🔗 Switched to ' + (CHAINS[chainId]?.name || 'chain'));
        } catch(e) {
            if (e.code === 4902) showToast('⚠️ Chain not added to MetaMask');
            else if (e.code !== 4001) console.error('Chain switch error:', e);
        }
    }
    
    // ── Client-side wallet address validation ──
    const WALLET_PATTERNS = {
        eth:  /^0x[0-9a-fA-F]{40}$/,
        btc:  /^([13][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[a-zA-HJ-NP-Z0-9]{25,62})$/,
        sol:  /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
        tron: /^T[a-zA-HJ-NP-Z0-9]{33}$/
    };
    function validateWalletInput(input) {
        const val = input.value.trim();
        if (!val) { input.style.borderColor = ''; return true; }
        const chain = (input.name || '').replace('wallet_', '');
        const pat = WALLET_PATTERNS[chain];
        if (pat && !pat.test(val)) {
            input.style.borderColor = '#ff4444';
            input.style.boxShadow = '0 0 4px rgba(255,68,68,0.3)';
            return false;
        }
        input.style.borderColor = 'rgba(0,255,65,0.4)';
        input.style.boxShadow = '0 0 4px rgba(0,255,65,0.15)';
        return true;
    }
    // ══════════════════════════════════════════════════════════════════
    // Unified post-form submit: validation + XHR upload with progress bar
    // ══════════════════════════════════════════════════════════════════
    document.querySelectorAll('.quick-reply form, .reply-form-wrap form, .post-form-container form').forEach(function(form) {
        // Inject progress bar DOM once per form
        if (!form.querySelector('.upload-progress-wrap')) {
            var pwrap = document.createElement('div');
            pwrap.className = 'upload-progress-wrap';
            pwrap.innerHTML = '<div class="upload-progress-bar-track"><div class="upload-progress-bar-fill"></div></div><div class="upload-progress-label"></div>';
            var bottom = form.querySelector('.form-bottom');
            if (bottom) bottom.parentNode.insertBefore(pwrap, bottom);
            else form.appendChild(pwrap);
        }
        // Ensure there is a .form-error container for inline server error display
        if (!form.querySelector('.form-error')) {
            var fe = document.createElement('div'); fe.className = 'form-error';
            form.insertBefore(fe, form.firstChild);
        }

        form.addEventListener('submit', function(e) {
            e.preventDefault();

            // ── Clear previous errors ──
            form.querySelectorAll('.form-error').forEach(function(el) { el.classList.remove('visible'); });

            // ── Blank-content validation ──
            var commentField = form.querySelector('textarea[name="comment"]');
            if (commentField && !commentField.value.trim()) {
                var _mi = form.querySelector('input[name="media"]');
                var _ii = form.querySelector('input[name="images[]"]');
                var hasM = _mi && ((_mi.files && _mi.files.length > 0) || _mi._recBlob);
                var hasI = _ii && _ii.files && _ii.files.length > 0;
                if (!hasM && !hasI) {
                    var errEl = form.querySelector('.form-error') || (function(){
                        var d = document.createElement('div'); d.className='form-error';
                        commentField.parentNode.insertBefore(d, commentField); return d;
                    })();
                    errEl.textContent = '⚠ Add a comment, image, or voice/video note.';
                    errEl.classList.add('visible');
                    commentField.focus();
                    return;
                }
            }

            // ── Wallet validation ──
            var walletsOk = true;
            form.querySelectorAll('.wci-input').forEach(function(inp) {
                if (!validateWalletInput(inp)) walletsOk = false;
            });
            if (!walletsOk) {
                showToast('⚠️ Invalid wallet address — check highlighted fields');
                return;
            }

            // ── Build FormData (mobile Safari voice-blob fallback) ──
            var fd = new FormData(form);
            var mediaInp = form.querySelector('input[name="media"]');
            if (mediaInp && mediaInp._recBlob && (!mediaInp.files || mediaInp.files.length === 0)) {
                fd.delete('media');
                fd.append('media', new File([mediaInp._recBlob], mediaInp._recFname, { type: mediaInp._recBlob.type }));
            }

            // ── Calculate total upload bytes ──
            var totalBytes = 0;
            try { for (var _p of fd.entries()) { if (_p[1] instanceof File) totalBytes += _p[1].size; } } catch(ex){}
            var hasFile = totalBytes > 0;

            // ── UI references ──
            var errArea      = form.querySelector('.form-error');
            var progressWrap = form.querySelector('.upload-progress-wrap');
            var progressFill = progressWrap && progressWrap.querySelector('.upload-progress-bar-fill');
            var progressLbl  = progressWrap && progressWrap.querySelector('.upload-progress-label');
            var submitBtn    = form.querySelector('[type="submit"]');
            var origBtnTxt   = submitBtn ? submitBtn.textContent : 'POST';

            // ── Lock submit (keep form open until upload completes) ──
            if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Posting…'; }

            // ── Show progress bar OR simple status text ──
            if (hasFile && progressWrap) {
                if (errArea) errArea.classList.remove('visible');
                progressFill.style.width = '0%';
                progressLbl.textContent  = 'Preparing upload…';
                progressWrap.style.display = 'block';
            } else if (errArea) {
                errArea.style.color = '#5fffaf';
                errArea.style.background = 'rgba(0,255,65,0.04)';
                errArea.style.borderLeftColor = 'rgba(0,255,65,0.3)';
                errArea.textContent = '⏳ Posting...';
                errArea.classList.add('visible');
            }

            // ── XHR with upload progress ──
            // Use location directly — form.action can be shadowed by <input name="action">
            var xhrUrl = location.pathname + location.search;
            var xhr = new XMLHttpRequest();
            xhr.open('POST', xhrUrl);

            if (hasFile && progressFill && progressLbl) {
                xhr.upload.addEventListener('progress', function(ev) {
                    if (!ev.lengthComputable) return;
                    var pct = Math.round(ev.loaded / ev.total * 100);
                    progressFill.style.width = pct + '%';
                    var mb = function(b){ return (b/1048576).toFixed(1)+' MB'; };
                    progressLbl.textContent = 'Uploading… ' + pct + '%  (' + mb(ev.loaded) + ' / ' + mb(ev.total) + ')';
                });
                xhr.upload.addEventListener('load', function() {
                    progressFill.style.width = '100%';
                    progressLbl.textContent  = '⚙️ Processing…';
                });
            }

            xhr.onload = function() {
                var dest = typeof xhr.responseURL === 'string' ? xhr.responseURL : '';
                var postM = dest && dest.match(/[?&]post=([^&#]+)/);
                var isSuccess = !!postM; // server only redirects (adding post=) on success

                // ── Error: server rendered page with $error (no redirect) ──
                if (!isSuccess) {
                    if (progressWrap) progressWrap.style.display = 'none';
                    // Extract error text from response HTML
                    var errMsg = '⚠ Post failed — please try again.';
                    try {
                        var errMatch = xhr.responseText.match(/<div[^>]+class="form-error visible"[^>]*>([\s\S]*?)<\/div>/);
                        if (errMatch) errMsg = errMatch[1].replace(/<[^>]+>/g, '').trim();
                    } catch(ex){}
                    if (errArea) {
                        errArea.style.color = '';
                        errArea.style.background = '';
                        errArea.style.borderLeftColor = '';
                        errArea.textContent = errMsg;
                        errArea.classList.add('visible');
                    } else { showToast(errMsg); }
                    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = origBtnTxt; }
                    return;
                }

                // ── Success ──
                var isIndexQuickReply = !!form.closest('.quick-reply');
                if (isIndexQuickReply) {
                    // Close the box, reset the form, show feedback, then reload
                    var threadId = (form.querySelector('input[name="thread_id"]') || {}).value || '';
                    // Reset form UI
                    if (progressWrap) progressWrap.style.display = 'none';
                    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = origBtnTxt; }
                    if (errArea) { errArea.textContent = '✓ Reply posted!'; errArea.style.color = '#00ff41'; errArea.style.background = 'rgba(0,255,65,0.04)'; errArea.style.borderLeftColor = 'rgba(0,255,65,0.3)'; errArea.classList.add('visible'); }
                    var ta = form.querySelector('textarea'); if (ta) ta.value = '';
                    try { if (typeof mrbCancel === 'function') { var fid = 'qr' + threadId; mrbCancel(fid); } } catch(ex){}
                    // Collapse quick-reply box
                    var qrBox = form.closest('.quick-reply');
                    if (qrBox) qrBox.classList.remove('active');
                    try { localStorage.setItem('openReplyBox', ''); } catch(ex){}
                    // Go to thread view anchored to the new reply (guaranteed to exist there)
                    var newPostId = postM[1];
                    var threadUrl = '/board?thread=' + threadId + '#p' + newPostId;
                    setTimeout(function() { location.href = threadUrl; }, 600);
                    return;
                }
                // Thread view — collapse form and jump to new post
                try { localStorage.removeItem('openReplyBox'); } catch(ex){}
                var replyBody = document.getElementById('replyFormBody');
                if (replyBody) {
                    replyBody.classList.add('collapsed');
                    try { sessionStorage.setItem(_pfKey('reply'), '0'); } catch(ex){}
                }
                var postId = postM[1];
                dest = dest.split('#')[0] + '#p' + postId;
                location.replace(dest);
            };
            xhr.onerror = function() {
                if (progressWrap) progressWrap.style.display = 'none';
                if (errArea) {
                    errArea.style.color = '';
                    errArea.style.background = '';
                    errArea.style.borderLeftColor = '';
                    errArea.textContent = '⚠ Upload failed — please try again.';
                    errArea.classList.add('visible');
                }
                if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = origBtnTxt; }
            };

            xhr.send(fd);
        });
    });

    // Clear inline errors on textarea input
    document.addEventListener('input', function(e) {
        if (e.target && e.target.tagName === 'TEXTAREA' && e.target.name === 'comment') {
            var errEl = e.target.previousElementSibling;
            if (errEl && errEl.classList.contains('form-error')) errEl.classList.remove('visible');
        }
    }, true);

    // Attach blur validation to all wallet chain inputs
    document.querySelectorAll('.wci-input').forEach(function(inp) {
        inp.addEventListener('blur', function() { validateWalletInput(this); });
        inp.addEventListener('input', function() {
            if (this.style.borderColor === 'rgb(255, 68, 68)') validateWalletInput(this);
        });
    });
    // Wallet validation for non-post forms (post forms handled above)
    document.querySelectorAll('form').forEach(function(form) {
        if (form.closest('.quick-reply, .reply-form-wrap, .post-form-container')) return;
        form.addEventListener('submit', function(e) {
            var walletInputs = form.querySelectorAll('.wci-input');
            var allValid = true;
            walletInputs.forEach(function(inp) {
                if (!validateWalletInput(inp)) allValid = false;
            });
            if (!allValid) {
                e.preventDefault();
                showToast('⚠️ Invalid wallet address detected — check highlighted fields');
            }
        });
    });

    // On mobile without wallet provider, hide MetaMask buttons inside wallet fields
    if (typeof window.ethereum === 'undefined') {
        document.querySelectorAll('.metamask-btn').forEach(function(btn) {
            if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) {
                btn.style.display = 'none';
            }
        });
    }
    
    // MetaMask multichain account cache
    let mmMultichainAccounts = { btc: null, sol: null, tron: null };

    async function fetchMultichainAccounts() {
        // MetaMask's standard provider only supports EVM (eth_*) methods.
        // Non-EVM chains (BTC/SOL/TRX) must be pasted manually.
        // This function is a no-op placeholder — if MetaMask adds multichain
        // support via a stable API in the future, it can be wired up here.
        // We intentionally do NOT call wallet_invokeSnap or wallet_createSession
        // as they are not available in standard MetaMask and cause RPC errors.
        return;
    }

    function fillMultichainInputs() {
        // Fill BTC/SOL/TRON inputs from MetaMask multichain if available
        if (mmMultichainAccounts.btc) {
            document.querySelectorAll('[id$="WalletBtc"]').forEach(el => {
                if (!el.value) { el.value = mmMultichainAccounts.btc; el.readOnly = true; el.placeholder = 'Auto-filled from MetaMask'; }
            });
        }
        if (mmMultichainAccounts.sol) {
            document.querySelectorAll('[id$="WalletSol"]').forEach(el => {
                if (!el.value) { el.value = mmMultichainAccounts.sol; el.readOnly = true; el.placeholder = 'Auto-filled from MetaMask'; }
            });
        }
        if (mmMultichainAccounts.tron) {
            document.querySelectorAll('[id$="WalletTron"]').forEach(el => {
                if (!el.value) { el.value = mmMultichainAccounts.tron; el.readOnly = true; el.placeholder = 'Auto-filled from MetaMask'; }
            });
        }
    }

    async function connectMetaMask(ethInputId, btnId) {
        if (typeof window.ethereum === 'undefined' && Object.keys(_boardEIP6963).length === 0) {
            alert('MetaMask not detected. Install MetaMask to connect your wallet.');
            window.open('https://metamask.io/download/', '_blank');
            return;
        }
        try {
            const _prov = await getBoardProvider();
            if (!_prov) throw new Error('no-provider');
            const accounts = await _prov.request({ method: 'eth_requestAccounts' });
            if (accounts && accounts[0]) {
                connectedWallet = accounts[0];
                const input = document.getElementById(ethInputId);
                const btn = document.getElementById(btnId);
                
                if (input) { input.value = connectedWallet; input.readOnly = true; }
                if (btn) { btn.textContent = '🦊 ' + connectedWallet.slice(0,6) + '...' + connectedWallet.slice(-4); btn.classList.add('connected'); }
                
                // Fill all ETH wallet inputs
                document.querySelectorAll('[id$="WalletEth"]').forEach(el => { el.value = connectedWallet; el.readOnly = true; });
                
                // Switch to MetaMask panels if they exist
                ['thread', 'reply'].forEach(function(t) {
                    var mmPanel = document.getElementById(t + 'MmPanel');
                    var manualPanel = document.getElementById(t + 'ManualPanel');
                    var fieldDiv = document.getElementById(t + 'WalletField');
                    if (mmPanel && fieldDiv && fieldDiv.style.display !== 'none') {
                        mmPanel.style.display = 'block';
                        if (manualPanel) manualPanel.style.display = 'none';
                        updateWalletPanel(t);
                    }
                });
                
                // Update wallet bar
                await updateWalletBar();
                
                showToast('🦊 Connected: ETH auto-filled. Paste BTC/SOL/TRX manually.');
            }
        } catch (err) {
            if (err.code === 4001) { /* user rejected */ }
            else console.error('MetaMask connect error:', err);
        }
    }
    
    function boardDisconnectWallet() {
        connectedWallet = null;
        walletBalance = null;
        localStorage.setItem('boardWalletDismissed', '1');
        mmMultichainAccounts = { btc: null, sol: null, tron: null };
        // Clear all wallet inputs
        document.querySelectorAll('[id$="WalletEth"]').forEach(el => { el.value = ''; el.readOnly = false; });
        document.querySelectorAll('[id$="WalletBtc"], [id$="WalletSol"], [id$="WalletTron"]').forEach(el => { el.value = ''; el.readOnly = false; el.placeholder = el.placeholder.replace('Auto-filled from MetaMask', ''); });
        // Reset all connect buttons
        document.querySelectorAll('.metamask-btn').forEach(btn => {
            btn.classList.remove('connected');
            btn.textContent = '🦊 Connect MetaMask (fills ETH)';
        });
        // Hide wallet bar
        const bar = document.getElementById('walletBar');
        if (bar) bar.classList.remove('active');
        // Switch wallet panels back to manual mode
        ['thread', 'reply'].forEach(function(t) {
            var mmPanel = document.getElementById(t + 'MmPanel');
            var manualPanel = document.getElementById(t + 'ManualPanel');
            if (mmPanel) mmPanel.style.display = 'none';
            if (manualPanel) manualPanel.style.display = 'block';
        });
        showToast('🦊 Wallet disconnected');
    }
    
    async function updateWalletBar() {
        if (!connectedWallet) return;
        const _p = await getBoardProvider();
        if (!_p) return;
        const bar = document.getElementById('walletBar');
        if (!bar) return;
        
        bar.classList.add('active');
        document.getElementById('wbAddr').textContent = connectedWallet.slice(0,6) + '...' + connectedWallet.slice(-4);
        
        try {
            const balHex = await _p.request({ method: 'eth_getBalance', params: [connectedWallet, 'latest'] });
            const balWei = parseInt(balHex, 16);
            walletBalance = (balWei / 1e18).toFixed(4);
            
            const chainId = await _p.request({ method: 'eth_chainId' });
            const chain = CHAINS[chainId] || { name: 'Chain ' + parseInt(chainId, 16), symbol: 'ETH', color: '#999' };
            document.getElementById('wbBal').textContent = walletBalance + ' ' + chain.symbol;
            document.getElementById('wbNetwork').textContent = chain.name;
        } catch (e) {
            document.getElementById('wbBal').textContent = '? ETH';
        }
    }
    
    function copyWallet(addr) {
        navigator.clipboard.writeText(addr).then(() => showToast('🦊 Wallet copied!'));
    }

    function toggleWalletBarMenu(e) {
        e.stopPropagation();
        var menu = document.getElementById('wbMenu');
        if (!menu) return;
        var open = menu.style.display !== 'none';
        if (open) { menu.style.display = 'none'; return; }
        // Populate chain list
        var list = document.getElementById('wbChainList');
        if (list && !list.hasChildNodes()) {
            Object.entries(CHAINS).forEach(function([cid, c]) {
                var row = document.createElement('div');
                row.className = 'wb-chain-item';
                row.innerHTML = '<span class="wb-chain-dot" style="background:' + c.color + '"></span>' + c.name;
                row.onclick = function() { switchWalletBarChain(cid); };
                list.appendChild(row);
            });
        }
        menu.style.display = 'block';
        // Close on outside click
        setTimeout(function() {
            document.addEventListener('click', function _close() {
                menu.style.display = 'none';
                document.removeEventListener('click', _close);
            });
        }, 0);
    }

    async function switchWalletBarAccount() {
        document.getElementById('wbMenu').style.display = 'none';
        await switchWalletAccount('bar');
    }

    async function switchWalletBarChain(chainId) {
        document.getElementById('wbMenu').style.display = 'none';
        try {
            const _p = await getBoardProvider();
            if (!_p) return;
            await _p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainId }] });
            await updateWalletBar();
            showToast('🔗 Switched to ' + (CHAINS[chainId]?.name || 'chain'));
        } catch(e) {
            if (e.code === 4902) showToast('⚠️ Chain not added to wallet');
            else if (e.code !== 4001) showToast('⚠️ Could not switch network');
        }
    }
    
    function showToast(msg) {
        const toast = document.createElement('div');
        toast.textContent = msg;
        const isRead = document.body.dataset.theme === 'read';
        toast.style.cssText = isRead
            ? 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#ede4d2;border:1px solid #a07030;color:#7a3a10;padding:8px 16px;border-radius:6px;font-size:12px;z-index:20000;font-family:Courier New,monospace;box-shadow:0 2px 8px rgba(0,0,0,0.15);'
            : 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#0a0e0a;border:1px solid #f6851b;color:#f6851b;padding:8px 16px;border-radius:6px;font-size:12px;z-index:20000;font-family:Courier New,monospace;';
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 2000);
    }
    
    // ── Multi-Currency Tipping ──
    const CHAINS = {
        '0x1':    { name: 'Ethereum',  symbol: 'ETH',   color: '#627eea', explorer: 'https://etherscan.io/tx/',           amounts: ['0.001', '0.005', '0.01', '0.05'] },
        '0x38':   { name: 'BSC',       symbol: 'BNB',   color: '#f0b90b', explorer: 'https://bscscan.com/tx/',             amounts: ['0.005', '0.01', '0.05', '0.1'] },
        '0x89':   { name: 'Polygon',   symbol: 'MATIC', color: '#8247e5', explorer: 'https://polygonscan.com/tx/',         amounts: ['1', '5', '10', '50'] },
        '0xa86a': { name: 'Avalanche', symbol: 'AVAX',  color: '#e84142', explorer: 'https://snowtrace.io/tx/',            amounts: ['0.05', '0.1', '0.5', '1'] },
        '0xa':    { name: 'Optimism',  symbol: 'ETH',   color: '#ff0420', explorer: 'https://optimistic.etherscan.io/tx/', amounts: ['0.001', '0.005', '0.01', '0.05'] },
        '0xa4b1': { name: 'Arbitrum',  symbol: 'ETH',   color: '#28a0f0', explorer: 'https://arbiscan.io/tx/',             amounts: ['0.001', '0.005', '0.01', '0.05'] },
        '0xaa36a7':{ name: 'Sepolia',  symbol: 'ETH',   color: '#999',    explorer: 'https://sepolia.etherscan.io/tx/',   amounts: ['0.01', '0.05', '0.1', '0.5'] },
    };
    const CHAIN_ORDER = ['0x1', '0x38', '0x89', '0xa86a', '0xa', '0xa4b1', 'btc', 'sol', 'tron'];

    // Non-EVM chains — MetaMask multichain may support these on desktop
    const NON_EVM_CHAINS = {
        'btc':  { name: 'Bitcoin',  symbol: 'BTC',  color: '#f7931a', amounts: ['0.0001', '0.0005', '0.001', '0.005'] },
        'sol':  { name: 'Solana',   symbol: 'SOL',  color: '#9945ff', amounts: ['0.05', '0.1', '0.5', '1'] },
        'tron': { name: 'TRON',     symbol: 'TRX',  color: '#ff0013', amounts: ['10', '50', '100', '500'] },
    };
    // Backwards compat alias
    const MOBILE_CHAINS = NON_EVM_CHAINS;
    const MOBILE_CHAIN_ORDER = ['0x1', '0x38', '0x89', 'btc', 'sol', 'tron'];
    let tipAmount = null;
    let tipChainId = '0x1';
    
    function getChain(id) { return CHAINS[id] || MOBILE_CHAINS[id] || CHAINS['0x1']; }
    function getCurrentChain() { return getChain(tipChainId); }
    
    function getChainWalletKey(cid) {
        if (MOBILE_CHAINS[cid]) return cid; // btc, sol, tron
        return 'eth'; // All EVM chains use the ETH address
    }
    
    function buildChainSelector() {
        const container = document.getElementById('tipChainSelector');
        if (!container) return;
        container.innerHTML = '';
        CHAIN_ORDER.forEach(cid => {
            const c = CHAINS[cid] || MOBILE_CHAINS[cid];
            if (!c) return;
            const walletKey = getChainWalletKey(cid);
            const hasAddr = tipPostWallets && tipPostWallets[walletKey];
            const btn = document.createElement('div');
            btn.className = 'tip-chain-btn' + (cid === tipChainId ? ' active' : '') + (!hasAddr ? ' disabled' : '');
            const isNonEvm = !!NON_EVM_CHAINS[cid];
            btn.innerHTML = '<span class="chain-dot" style="background:' + (hasAddr ? c.color : '#555') + '"></span>' + c.name + (!hasAddr ? ' <span style="font-size:9px;opacity:0.5;">✗</span>' : '');
            if (hasAddr) {
                btn.onclick = () => selectChain(cid);
            } else {
                btn.style.opacity = '0.35';
                btn.style.cursor = 'not-allowed';
                btn.title = 'Poster did not provide a ' + c.name + ' address';
            }
            container.appendChild(btn);
        });
    }
    
    function buildTipAmounts() {
        const container = document.getElementById('tipAmountsContainer');
        if (!container) return;
        const chain = getCurrentChain();
        const isNonEvm = !!MOBILE_CHAINS[tipChainId];
        container.innerHTML = '';
        chain.amounts.forEach((amt, i) => {
            const div = document.createElement('div');
            div.className = 'tip-amount' + (i === 1 ? ' selected' : '');
            div.textContent = amt + ' ' + chain.symbol;
            div.onclick = function() { selectTipAmount(amt, this); };
            container.appendChild(div);
        });
        tipAmount = chain.amounts[1];
        document.getElementById('tipChainName').textContent = chain.name;
        document.getElementById('tipChainSymbol').textContent = chain.symbol;
        document.getElementById('tipCustomAmount').placeholder = 'Or enter custom ' + chain.symbol + ' amount';
        
        const sendBtn = document.getElementById('tipSendBtn');
        if (isNonEvm) {
            // Non-EVM chain: try MetaMask multichain if available, else copy address
            sendBtn.textContent = '📋 Copy ' + chain.name + ' Address & Send';
            sendBtn.onclick = function() { sendNonEvmTip(); };
        } else {
            sendBtn.textContent = '🦊 Send ' + chain.symbol + ' via MetaMask';
            sendBtn.onclick = function() { sendTip(); };
        }
    }
    
    async function selectChain(chainId) {
        tipChainId = chainId;
        // Update recipient address based on chain
        if (tipPostWallets) {
            var walletKey = getChainWalletKey(chainId);
            var addr = tipPostWallets[walletKey] || '';
            document.getElementById('tipRecipient').value = addr;
            document.getElementById('tipRecipientDisplay').textContent = addr ? addr.slice(0,6) + '...' + addr.slice(-4) : 'N/A';
        }
        buildChainSelector();
        buildTipAmounts();
        document.getElementById('tipCustomAmount').value = '';
        document.getElementById('tipStatus').textContent = '';
    }
    
    async function autoDetectChain() {
        try {
            const _p = await getBoardProvider();
            if (!_p) return;
            const cid = await _p.request({ method: 'eth_chainId' });
            if (CHAINS[cid]) tipChainId = cid;
        } catch(e) {}
    }
    
    function tipOP(threadId, wallet) {
        // Legacy compat — redirect to tipPost
        tipPost(threadId);
    }
    
    let tipPostWallets = null; // {eth: "0x...", btc: "1...", ...}
    
    async function tipPost(postId) {
        try {
            const resp = await fetch('/board?action=get_wallet&post_id=' + postId);
            const data = await resp.json();
            tipPostWallets = data.wallets || null;
            
            if (!tipPostWallets || Object.keys(tipPostWallets).length === 0) {
                document.getElementById('tipNoWallet').style.display = 'block';
                document.getElementById('tipHasWallet').style.display = 'none';
                document.getElementById('tipStatus').textContent = '';
                document.getElementById('tipOverlay').classList.add('active');
                return;
            }
            
            openTipModal(tipPostWallets);
        } catch(e) {
            console.error('Failed to fetch wallet:', e);
            showToast('❌ Failed to load wallet info');
        }
    }
    
    function openTipModal(wallets) {
        try {
            // Show primary address
            var primaryAddr = wallets.eth || wallets.btc || wallets.sol || wallets.tron || '';
            document.getElementById('tipRecipientDisplay').textContent = primaryAddr.slice(0,6) + '...' + primaryAddr.slice(-4);
            document.getElementById('tipNoWallet').style.display = 'none';
            document.getElementById('tipHasWallet').style.display = 'block';
            document.getElementById('tipStatus').textContent = '';
            
            // Pick default chain based on what addresses are available
            if (wallets.eth) tipChainId = '0x1';
            else if (wallets.btc) tipChainId = 'btc';
            else if (wallets.sol) tipChainId = 'sol';
            else if (wallets.tron) tipChainId = 'tron';
            
            if (typeof window.ethereum !== 'undefined' || Object.keys(_boardEIP6963).length > 0) {
                // Desktop MetaMask flow
                document.getElementById('tipDesktopFlow').style.display = 'block';
                document.getElementById('tipMobileFlow').style.display = 'none';
                document.getElementById('tipRecipient').value = primaryAddr;
                document.getElementById('tipCustomAmount').value = '';
                try { autoDetectChain().then(function(){
                    // Only auto-select if poster has an ETH address
                    if (!wallets.eth && tipChainId.startsWith('0x')) {
                        tipChainId = wallets.btc ? 'btc' : wallets.sol ? 'sol' : wallets.tron ? 'tron' : '0x1';
                    }
                    buildChainSelector();
                    buildTipAmounts();
                }); } catch(e){ buildChainSelector(); buildTipAmounts(); }
            } else {
                // Mobile / no wallet
                document.getElementById('tipDesktopFlow').style.display = 'none';
                document.getElementById('tipMobileFlow').style.display = 'block';
                document.getElementById('tipMobileAddr').textContent = primaryAddr;
                document.getElementById('tipRecipientMobile').value = primaryAddr;
                document.getElementById('tipCopyConfirm').style.display = 'none';
                buildMobileChainSelector();
                updateMobileChainInfo();
            }
            
            document.getElementById('tipOverlay').classList.add('active');
        } catch(err) {
            console.error('Tip modal error:', err);
            alert('Send tip to: ' + (wallets.eth || wallets.btc || wallets.sol || wallets.tron || '?'));
        }
    }
    
    function copyTipAddress() {
        var addr = document.getElementById('tipRecipientMobile').value || document.getElementById('tipMobileAddr').textContent;
        var confirm = document.getElementById('tipCopyConfirm');
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(addr).then(function() {
                if (confirm) confirm.style.display = 'block';
            });
        } else {
            var ta = document.createElement('textarea');
            ta.value = addr;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            try { document.execCommand('copy'); } catch(e){}
            document.body.removeChild(ta);
            if (confirm) confirm.style.display = 'block';
        }
    }
    
    function buildMobileChainSelector() {
        var container = document.getElementById('tipMobileChainSelector');
        if (!container) return;
        container.innerHTML = '';
        MOBILE_CHAIN_ORDER.forEach(function(cid) {
            var c = CHAINS[cid] || MOBILE_CHAINS[cid];
            if (!c) return;
            var walletKey = getChainWalletKey(cid);
            var hasAddr = tipPostWallets && tipPostWallets[walletKey];
            var btn = document.createElement('div');
            btn.className = 'tip-chain-btn' + (cid === tipChainId ? ' active' : '');
            btn.innerHTML = '<span class="chain-dot" style="background:' + (hasAddr ? c.color : '#555') + '"></span>' + c.name + (!hasAddr ? ' <span style="font-size:9px;opacity:0.5;">✗</span>' : '');
            if (hasAddr) {
                btn.setAttribute('data-chain', cid);
                btn.onclick = function() { selectMobileChain(cid); };
            } else {
                btn.style.opacity = '0.35';
                btn.style.cursor = 'not-allowed';
                btn.title = 'No ' + c.name + ' address provided';
            }
            container.appendChild(btn);
        });
    }
    
    function selectMobileChain(chainId) {
        tipChainId = chainId;
        // Update displayed address for this chain
        if (tipPostWallets) {
            var walletKey = getChainWalletKey(chainId);
            var addr = tipPostWallets[walletKey] || '';
            document.getElementById('tipMobileAddr').textContent = addr;
            document.getElementById('tipRecipientMobile').value = addr;
            document.getElementById('tipRecipientDisplay').textContent = addr ? addr.slice(0,6) + '...' + addr.slice(-4) : 'N/A';
        }
        buildMobileChainSelector();
        updateMobileChainInfo();
        document.getElementById('tipCopyConfirm').style.display = 'none';
    }
    
    function updateMobileChainInfo() {
        var chain = getCurrentChain();
        var nameEl = document.getElementById('tipMobileChainName');
        var symEl = document.getElementById('tipMobileChainSymbol');
        var sugEl = document.getElementById('tipMobileSuggested');
        if (nameEl) nameEl.textContent = chain.name;
        if (symEl) symEl.textContent = chain.symbol;
        if (sugEl) sugEl.textContent = chain.amounts.join(', ') + ' ' + chain.symbol;
    }
    
    function closeTipModal() {
        document.getElementById('tipOverlay').classList.remove('active');
    }

    // ═══ $GOYIM BOOST SYSTEM ═══
     var gbumpThreadId          = null;
     var gbumpAmount            = null;
     var _gbumpPhantomPubkey    = null;
     var _gbumpHolderVerified   = false;
     var _gbumpHolderBalance    = 0;
    function openGoyimBump(threadId) {
        gbumpThreadId       = threadId;
        gbumpAmount         = null;
        _gbumpPhantomPubkey = null;
        _gbumpHolderVerified = false;
        _gbumpHolderBalance  = 0;
        // Reset status + amounts
        var status = document.getElementById('gbumpStatus');
        if (status) status.textContent = '';
        document.querySelectorAll('.gbump-amt').forEach(function(e){ e.classList.remove('selected'); });
        var custom = document.getElementById('gbumpCustom');
        if (custom) custom.value = '';
        // Reset Phantom connect area
        var connectBtn = document.getElementById('gbumpConnectBtn');
        var phantomStatus = document.getElementById('gbumpPhantomStatus');
        var phantomArea = document.getElementById('gbumpPhantomArea');
        var sendBtn = document.getElementById('gbumpSendBtn');
        if (BOARD_IS_ADMIN) {
            // Admin bypass — no Phantom needed
            _gbumpPhantomPubkey  = 'admin';
            _gbumpHolderVerified = true;
            if (phantomArea) phantomArea.style.display = 'none';
            if (phantomStatus) { phantomStatus.innerHTML = '\u2705 <span style="color:#ffa500;">Admin — boost bypass enabled</span>'; phantomStatus.style.color = '#ffa500'; }
            if (sendBtn) { sendBtn.disabled = false; sendBtn.style.display = ''; sendBtn.textContent = '\uD83D\uDD25 Boost Thread (Admin)'; }
        } else {
            if (connectBtn) { connectBtn.disabled = false; connectBtn.textContent = '\uD83D\uDC7B Connect Phantom Wallet'; connectBtn.style.display = ''; }
            if (phantomStatus) phantomStatus.textContent = '';
            if (phantomArea) phantomArea.style.display = '';
            if (sendBtn) { sendBtn.disabled = false; sendBtn.style.display = 'none'; sendBtn.textContent = '\uD83D\uDD25 Send GOYIM & Boost Thread'; }
        }
        // Token status
        var tokenStatusEl = document.getElementById('gbumpTokenStatus');
        var treasuryEl    = document.getElementById('gbumpTreasury');
        if (tokenStatusEl) {
            tokenStatusEl.innerHTML = BOARD_GOYIM_CA
                ? '<span style="color:#00ff41;">LIVE</span> &mdash; <code style="font-size:9px;color:#888;">' + BOARD_GOYIM_CA.slice(0,8) + '...' + BOARD_GOYIM_CA.slice(-6) + '</code>'
                : '<span style="color:#888;">Pre-launch</span>';
        }
        if (treasuryEl) treasuryEl.textContent = BOARD_GOYIM_TREASURY ? BOARD_GOYIM_TREASURY.slice(0,8)+'...'+BOARD_GOYIM_TREASURY.slice(-4) : 'TBA';
        document.getElementById('gbumpOverlay').classList.add('active');
    }

    function closeGoyimBump() {
        document.getElementById('gbumpOverlay').classList.remove('active');
        gbumpThreadId       = null;
        gbumpAmount         = null;
        _gbumpPhantomPubkey = null;
        _gbumpHolderVerified = false;
        _gbumpHolderBalance  = 0;
    }

    async function connectPhantomForBump() {
        var connectBtn    = document.getElementById('gbumpConnectBtn');
        var phantomStatus = document.getElementById('gbumpPhantomStatus');
        var sendBtn       = document.getElementById('gbumpSendBtn');
        if (!window.solana || !window.solana.isPhantom) {
            phantomStatus.innerHTML = '\u26A0\uFE0F Phantom not found &mdash; <a href="https://phantom.app" target="_blank" style="color:#9945ff;">install Phantom</a>';
            phantomStatus.style.color = '#ff6b6b';
            return;
        }
        try {
            connectBtn.disabled = true;
            connectBtn.textContent = '\u23F3 Connecting...';
            phantomStatus.style.color = '#ffa500';
            phantomStatus.textContent = 'Requesting wallet access...';
            var resp = await window.solana.connect();
            _gbumpPhantomPubkey = resp.publicKey.toString();
            // Admin wallet bypass — no payment required
            if (BOARD_GOYIM_ADMIN_WALLET && _gbumpPhantomPubkey === BOARD_GOYIM_ADMIN_WALLET) {
                _gbumpHolderVerified = true;
                _gbumpHolderBalance  = 0;
                var shortAddr = _gbumpPhantomPubkey.slice(0,6) + '...' + _gbumpPhantomPubkey.slice(-4);
                if (phantomStatus) { phantomStatus.innerHTML = '\u2705 <span style="color:#ffa500;">Admin wallet — boost bypass enabled</span> \u2014 ' + shortAddr; phantomStatus.style.color = '#ffa500'; }
                if (connectBtn) connectBtn.style.display = 'none';
                if (sendBtn) { sendBtn.style.display = ''; sendBtn.disabled = false; sendBtn.textContent = '\uD83D\uDD25 Boost Thread (Admin)'; }
                return;
            }
            // Verify $GOYIM balance via server
            phantomStatus.textContent = 'Verifying $GOYIM balance...';
            var fd = new FormData();
            fd.append('action', 'check_goyim_holder');
            fd.append('wallet', _gbumpPhantomPubkey);
            var r = await fetch('/board', { method: 'POST', body: fd });
            var result = await r.json();
            _gbumpHolderVerified = result.holder || false;
            _gbumpHolderBalance  = result.balance || 0;
            var shortAddr = _gbumpPhantomPubkey.slice(0,6) + '...' + _gbumpPhantomPubkey.slice(-4);
            if (_gbumpHolderVerified) {
                phantomStatus.innerHTML = '\u2705 <span style="color:#00ff41;">HOLDER VERIFIED</span> &#x2014; ' + shortAddr + ' <span style="color:#ffa500;">' + Math.round(_gbumpHolderBalance).toLocaleString() + 'G &#x1F525;</span>';
                phantomStatus.style.color = '#00ff41';
            } else {
                phantomStatus.innerHTML = '<span style="color:#ff9900;">&#x26A0;&#xFE0F; No $GOYIM detected</span> &#x2014; ' + shortAddr + '. <a href="https://pump.fun/coin/' + BOARD_GOYIM_CA + '" target="_blank" style="color:#ffa500;">Buy on pump.fun</a>';
                phantomStatus.style.color = '#ff9900';
            }
            connectBtn.style.display = 'none';
            if (_gbumpHolderVerified) {
                sendBtn.style.display = '';
                sendBtn.disabled = false;
                sendBtn.textContent = BOARD_GOYIM_TREASURY
                    ? '\uD83D\uDD25 Send GOYIM & Boost Thread'
                    : '\uD83D\uDD25 Boost Thread (verify-only)';
            } else {
                // Not a holder — keep send hidden, show buy link prominently
                sendBtn.style.display = 'none';
                phantomStatus.innerHTML = '\u274C <strong style="color:#ff6b6b;">You must hold $GOYIM to boost.</strong><br>'
                    + '&#x1F4B8; <a href="https://pump.fun/coin/' + BOARD_GOYIM_CA + '" target="_blank" style="color:#ffa500;">Buy $GOYIM on pump.fun</a> then reconnect.';
                phantomStatus.style.color = '#ff6b6b';
                // Let them retry with a different wallet
                connectBtn.style.display = '';
                connectBtn.disabled = false;
                connectBtn.textContent = '\uD83D\uDC7B Try Another Wallet';
            }
        } catch(e) {
            connectBtn.disabled = false;
            connectBtn.textContent = '\uD83D\uDC7B Connect Phantom Wallet';
            phantomStatus.textContent = (e.code === 4001) ? '\u274C Rejected' : '\u274C ' + (e.message || 'Connection failed');
            phantomStatus.style.color = '#ff6b6b';
        }
    }

    function selectGbumpAmt(amt, el) {
        gbumpAmount = amt;
        document.getElementById('gbumpCustom').value = '';
        document.querySelectorAll('.gbump-amt').forEach(function(e){ e.classList.remove('selected'); });
        el.classList.add('selected');
    }

    function clearGbumpSelection() {
        document.querySelectorAll('.gbump-amt').forEach(function(e){ e.classList.remove('selected'); });
        gbumpAmount = null;
    }

    function applyBoostClass(threadId, totalG, newBumpUntil) {
        var el = document.getElementById('p' + threadId);
        if (!el) return;
        el.classList.remove('boost-1', 'boost-2', 'boost-3');
        var tier = 0;
        if (totalG >= 500)      { el.classList.add('boost-3'); tier = 3; }
        else if (totalG >= 100) { el.classList.add('boost-2'); tier = 2; }
        else if (totalG >= 1)   { el.classList.add('boost-1'); tier = 1; }
        // Update or create the badge element
        var existing = el.querySelector('.boost-badge');
        if (tier > 0) {
            var until = newBumpUntil || (Date.now()/1000|0) + Math.round((totalG/1000)*3600);
            if (!existing) {
                var labels = ['','BOOSTED','ON FIRE','INFERNO'];
                existing = document.createElement('span');
                existing.className = 'boost-badge boost-badge-' + tier;
                existing.innerHTML = '\uD83D\uDD25 ' + labels[tier] + '<span class="boost-timer"></span>';
                el.insertBefore(existing, el.firstChild);
            } else {
                existing.className = 'boost-badge boost-badge-' + tier;
            }
            existing.setAttribute('data-boost-until', String(until));
            existing.setAttribute('data-goyim-total', String(totalG));
            el.setAttribute('data-boost-until', String(until));
            el.setAttribute('data-goyim', String(totalG));
            el.style.setProperty('--bd', '1');
            // Immediately update timer text
            _boostUpdateBadge(existing);
        } else if (existing) {
            existing.remove();
        }
    }

    async function submitGoyimBump() {
        var customVal = document.getElementById('gbumpCustom').value.trim();
        var amount    = customVal ? parseFloat(customVal) : gbumpAmount;
        var status    = document.getElementById('gbumpStatus');
        var sendBtn   = document.getElementById('gbumpSendBtn');
        if (!amount || isNaN(amount) || amount <= 0) {
            if (status) { status.textContent = '\u26A0\uFE0F Select or enter an amount'; status.style.color = '#ff6b6b'; }
            return;
        }
        if (!gbumpThreadId) return;
        var _isAdminWallet = BOARD_GOYIM_ADMIN_WALLET && _gbumpPhantomPubkey === BOARD_GOYIM_ADMIN_WALLET;
        if (!BOARD_IS_ADMIN && !_isAdminWallet) {
            if (!_gbumpPhantomPubkey) {
                if (status) { status.textContent = '\uD83D\uDC7B Connect Phantom first'; status.style.color = '#ffa500'; }
                return;
            }
            if (!_gbumpHolderVerified) {
                if (status) { status.innerHTML = '\u274C You must hold $GOYIM to boost. <a href="https://pump.fun/coin/' + BOARD_GOYIM_CA + '" target="_blank" style="color:#ffa500;">Buy on pump.fun</a>'; status.style.color = '#ff6b6b'; }
                return;
            }
            // Client-side balance check — catch insufficient funds before hitting chain
            if (_gbumpHolderBalance > 0 && amount > _gbumpHolderBalance) {
                if (status) { status.textContent = '\u274C Not enough $GOYIM \u2014 you have ' + Math.round(_gbumpHolderBalance).toLocaleString() + 'G, tried to send ' + Math.round(amount).toLocaleString() + 'G'; status.style.color = '#ff6b6b'; }
                return;
            }
        }
        if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = '\u23F3 Processing...'; }
        if (status) { status.textContent = ''; }
        try {
            var txHash = 'phantom-' + Date.now();
            if (!BOARD_IS_ADMIN && !_isAdminWallet && BOARD_GOYIM_CA && BOARD_GOYIM_TREASURY && window.solana && window.solana.isPhantom) {
                // Load @solana/web3.js from CDN if needed
                if (!window.solanaWeb3) {
                    await new Promise(function(res, rej) {
                        var s = document.createElement('script');
                        s.src = 'https://unpkg.com/@solana/web3.js@1.98.0/lib/index.iife.min.js';
                        s.onload = res; s.onerror = rej;
                        document.head.appendChild(s);
                    });
                }
                var web3 = window.solanaWeb3;
                var connection  = new web3.Connection('https://api.mainnet-beta.solana.com', 'confirmed');
                var fromPubkey  = new web3.PublicKey(_gbumpPhantomPubkey);
                var mintPubkey  = new web3.PublicKey(BOARD_GOYIM_CA);
                var toPubkey    = new web3.PublicKey(BOARD_GOYIM_TREASURY);
                var TOKEN_PID   = new web3.PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
                var ASSOC_PID   = new web3.PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bDs');
                function findATA(wallet, mint) {
                    return web3.PublicKey.findProgramAddressSync(
                        [wallet.toBuffer(), TOKEN_PID.toBuffer(), mint.toBuffer()], ASSOC_PID
                    )[0];
                }
                var fromATA = findATA(fromPubkey, mintPubkey);
                var toATA   = findATA(toPubkey,   mintPubkey);
                var DECIMALS = 6; // pump.fun SPL default
                var rawAmt = BigInt(Math.round(amount)) * BigInt(Math.pow(10, DECIMALS));
                var SYS_PID = new web3.PublicKey('11111111111111111111111111111111');
                // Create treasury ATA idempotently (no-op if it already exists, creates it if not)
                var createATAIx = new web3.TransactionInstruction({
                    keys: [
                        { pubkey: fromPubkey, isSigner: true,  isWritable: true  }, // payer
                        { pubkey: toATA,      isSigner: false, isWritable: true  }, // ata to create
                        { pubkey: toPubkey,   isSigner: false, isWritable: false }, // owner
                        { pubkey: mintPubkey, isSigner: false, isWritable: false }, // mint
                        { pubkey: SYS_PID,    isSigner: false, isWritable: false }, // system program
                        { pubkey: TOKEN_PID,  isSigner: false, isWritable: false }, // token program
                    ],
                    programId: ASSOC_PID,
                    data: new Uint8Array([1]), // 1 = CreateIdempotent
                });
                // Build SPL token transfer instruction (instruction index 3)
                var data = new Uint8Array(9);
                data[0] = 3;
                var view = new DataView(data.buffer);
                view.setBigUint64(1, rawAmt, true);
                var ix = new web3.TransactionInstruction({
                    keys: [
                        { pubkey: fromATA,    isSigner: false, isWritable: true  },
                        { pubkey: toATA,      isSigner: false, isWritable: true  },
                        { pubkey: fromPubkey, isSigner: true,  isWritable: false },
                    ],
                    programId: TOKEN_PID,
                    data: data,
                });
                if (status) { status.textContent = '\uD83D\uDC7B Confirm in Phantom...'; status.style.color = '#9945ff'; }
                var tx = new web3.Transaction().add(createATAIx).add(ix);
                var latestBlock = await connection.getLatestBlockhash();
                tx.recentBlockhash = latestBlock.blockhash;
                tx.feePayer = fromPubkey;
                var signed = await window.solana.signTransaction(tx);
                if (status) { status.textContent = '\u23F3 Sending to Solana...'; status.style.color = '#9945ff'; }
                txHash = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
                if (status) { status.textContent = '\u23F3 Confirming on-chain...'; status.style.color = '#9945ff'; }
                var confirmation = await connection.confirmTransaction({ signature: txHash, blockhash: latestBlock.blockhash, lastValidBlockHeight: latestBlock.lastValidBlockHeight }, 'confirmed');
                if (confirmation.value.err) throw new Error('Transaction failed: ' + JSON.stringify(confirmation.value.err));
            } else if (BOARD_IS_ADMIN || _isAdminWallet) {
                if (status) { status.textContent = '\uD83D\uDD25 Admin boost — recording...'; status.style.color = '#ffa500'; }
            } else if (!BOARD_GOYIM_TREASURY) {
                if (status) { status.textContent = '\u26A1 Verify-only mode — recording boost...'; status.style.color = '#ffa500'; }
            }
            var fd = new FormData();
            fd.append('action',    'goyim_bump');
            fd.append('thread_id', gbumpThreadId);
            fd.append('amount',    amount);
            fd.append('tx_hash',   txHash);
            fd.append('wallet',    _gbumpPhantomPubkey || '');
            var resp = await fetch('/board', { method: 'POST', body: fd });
            var result = await resp.json();
            if (result.ok) {
                var totalG = Math.round(result.goyim_tips);
                var txLink = txHash && !txHash.startsWith('phantom-') ? ' <a href="https://solscan.io/tx/' + txHash + '" target="_blank" style="color:#9945ff;font-size:10px;">view tx \u2197</a>' : '';
                if (status) { status.innerHTML = '\uD83D\uDE80 Thread boosted! (' + totalG + 'G total)' + txLink; status.style.color = '#00ff41'; }
                var countEl = document.getElementById('gbump-count-' + gbumpThreadId);
                if (countEl) countEl.textContent = ' ' + totalG + 'G';
                if (sendBtn) sendBtn.textContent = '\u2705 Boosted!';
                applyBoostClass(gbumpThreadId, totalG);
                setTimeout(closeGoyimBump, 2000);
            } else {
                throw new Error(result.error || 'Unknown error');
            }
        } catch(e) {
            console.error('Boost error:', e);
            if (status) {
                if (e.code === 4001) {
                    status.textContent = '\u274C Transaction cancelled';
                } else {
                    var errMsg = e.message || '';
                    // Extract Solana simulation logs if present
                    if (e.logs && e.logs.length) errMsg += ' | ' + e.logs.slice(-2).join(' | ');
                    status.textContent = '\u274C ' + (errMsg || 'Error sending GOYIM');
                }
                status.style.color = '#ff6b6b';
            }
            if (sendBtn) {
                sendBtn.disabled = false;
                sendBtn.textContent = BOARD_GOYIM_CA ? '\uD83D\uDD25 Send GOYIM & Boost Thread' : '\uD83D\uDD25 Demo Boost (Pre-Launch)';
            }
        }
    }
    
    function selectTipAmount(amount, el) {
        tipAmount = amount;
        document.getElementById('tipCustomAmount').value = '';
        document.querySelectorAll('.tip-amount').forEach(e => e.classList.remove('selected'));
        el.classList.add('selected');
    }
    
    function clearTipSelection() {
        document.querySelectorAll('.tip-amount').forEach(e => e.classList.remove('selected'));
        tipAmount = null;
    }
    
    async function sendTip() {
        const recipient = document.getElementById('tipRecipient').value;
        const custom = document.getElementById('tipCustomAmount').value.trim();
        const amount = custom || tipAmount;
        const status = document.getElementById('tipStatus');
        const chain = getCurrentChain();
        
        if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
            status.textContent = '⚠️ Enter a valid amount';
            status.style.color = '#ff6b6b';
            return;
        }
        
        if (typeof window.ethereum === 'undefined' && Object.keys(_boardEIP6963).length === 0) {
            status.textContent = '🦊 MetaMask required. Install it first.';
            status.style.color = '#ff6b6b';
            window.open('https://metamask.io/download/', '_blank');
            return;
        }
        
        try {
            // Get provider via EIP-6963 to avoid evmAsk.js Unexpected error
            const _ev = await getBoardProvider();
            if (!_ev) throw new Error('no-wallet');
            // Switch chain if needed
            const currentChainId = await _ev.request({ method: 'eth_chainId' });
            if (currentChainId !== tipChainId) {
                status.textContent = '🔄 Switching to ' + chain.name + '...';
                status.style.color = '#f6851b';
                try {
                    await _ev.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: tipChainId }] });
                } catch (switchErr) {
                    if (switchErr.code === 4902) {
                        status.textContent = '⚠️ ' + chain.name + ' not added to MetaMask. Add it first.';
                    } else if (switchErr.code === 4001) {
                        status.textContent = '❌ Chain switch cancelled';
                    } else {
                        status.textContent = '❌ Could not switch to ' + chain.name;
                    }
                    status.style.color = '#ff6b6b';
                    return;
                }
            }
            
            status.textContent = '⏳ Opening MetaMask...';
            status.style.color = '#f6851b';
            
            const accounts = await _ev.request({ method: 'eth_requestAccounts' });
            const from = accounts[0];
            
            const weiValue = '0x' + (BigInt(Math.floor(parseFloat(amount) * 1e18))).toString(16);
            
            const txHash = await _ev.request({
                method: 'eth_sendTransaction',
                params: [{ from, to: recipient, value: weiValue }]
            });
            
            status.innerHTML = '✅ ' + amount + ' ' + chain.symbol + ' sent! <a href="' + chain.explorer + txHash + '" target="_blank" style="color:#5fffaf;">View TX ↗</a>';
            status.style.color = '#00ff41';
            setTimeout(updateWalletBar, 3000);
        } catch (err) {
            if (err.code === 4001) {
                status.textContent = '❌ Transaction cancelled';
            } else {
                status.textContent = '❌ ' + (err.message || 'Transaction failed');
            }
            status.style.color = '#ff6b6b';
        }
    }
    
    // Auto-restore wallet on load + show balance
    (async function() {
        try {
            const _p = await getBoardProvider();
            if (!_p) return;
            if (localStorage.getItem('boardWalletDismissed') === '1') return;
            const accounts = await _p.request({ method: 'eth_accounts' });
            if (accounts && accounts[0]) {
                connectedWallet = accounts[0];
                // Fill all ETH wallet inputs
                document.querySelectorAll('[id$="WalletEth"]').forEach(el => { if (!el.value) { el.value = connectedWallet; el.readOnly = true; } });
                document.querySelectorAll('.metamask-btn').forEach(btn => {
                    btn.textContent = '🦊 ' + connectedWallet.slice(0,6) + '...' + connectedWallet.slice(-4);
                    btn.classList.add('connected');
                });
                await updateWalletBar();
                // Update any open wallet panels
                ['thread', 'reply'].forEach(function(t) {
                    var mmPanel = document.getElementById(t + 'MmPanel');
                    if (mmPanel && mmPanel.style.display !== 'none') updateWalletPanel(t);
                });
            }
            // Listen for account/chain changes
            if (_p.on) {
                _p.on('accountsChanged', (accounts) => {
                    if (accounts.length === 0) { disconnectWallet(); }
                    else {
                        connectedWallet = accounts[0];
                        updateWalletBar();
                        document.querySelectorAll('[id$="WalletEth"]').forEach(el => { el.value = connectedWallet; el.readOnly = true; });
                        document.querySelectorAll('.metamask-btn').forEach(btn => { btn.textContent = '🦊 ' + connectedWallet.slice(0,6) + '...' + connectedWallet.slice(-4); btn.classList.add('connected'); });
                        // Update wallet panels
                        ['thread', 'reply'].forEach(function(t) { updateWalletPanel(t); });
                    }
                });
                _p.on('chainChanged', () => {
                    updateWalletBar();
                    // Update wallet panels with new chain
                    ['thread', 'reply'].forEach(function(t) { updateWalletPanel(t); });
                });
            }
        } catch(e) {}
    })();

    <?php if (false && $settings['chat_enabled'] && !$isBanned): ?>
    // ── Live Chat ──
    let chatOpen = false;
    let chatLastTime = parseInt(localStorage.getItem('chatLastTime') || '0'); // resume from last seen to stop stale @mention re-fires on refresh
    let chatSeeded = chatLastTime > 0; // skip @mention counting on very first seed fetch
    let chatInitialized = false;   // true after first fetch completes this page-session (fixes stuck "Loading chat...")
    let chatFetching = false;      // guard: prevent concurrent fetchChat calls causing duplicate messages
    let chatPollInterval = null;   // live 4s poll when chat is open
    let chatBgInterval = null;     // background 15s poll for @mention detection when closed
    let chatUnreadCount = 0;
    let chatMentionCount = 0;
    let myAnonId = ''; // Set after first fetch (cookie-based, works for all users)

    function updateChatUnread(count) {
        chatUnreadCount = count;
        if (count === 0) chatMentionCount = 0;
        const badge = document.getElementById('chatUnread');
        if (badge) {
            if (chatMentionCount > 0) {
                badge.textContent = '@' + (chatMentionCount > 9 ? '9+' : chatMentionCount);
                badge.classList.add('visible', 'mention');
            } else {
                badge.textContent = chatUnreadCount > 9 ? '9+' : chatUnreadCount;
                badge.classList.remove('mention');
                badge.classList.toggle('visible', chatUnreadCount > 0);
            }
        }
    }

    // Process @mentions in chat text — highlight @IDs, special color if it's you
    function processMentions(text) {
        return text.replace(/@([a-f0-9]{12})/gi, function(match, id) {
            const isYou = myAnonId && id.toLowerCase() === myAnonId.toLowerCase();
            const cls = isYou ? 'chat-mention mention-you' : 'chat-mention';
            const label = isYou ? '@' + id + ' (You)' : '@' + id;
            return '<span class="' + cls + '">' + label + '</span>';
        });
    }

    // Check if a message mentions your ID
    function mentionsMe(text) {
        if (!myAnonId) return false;
        const re = new RegExp('@' + myAnonId, 'i');
        return re.test(text);
    }

    // Click a chat name to insert @theirId into input
    function chatMention(anonId) {
        const input = document.getElementById('chatInput');
        if (!input) return;
        input.value = input.value.trimEnd() + (input.value ? ' ' : '') + '@' + anonId + ' ';
        input.focus();
    }

    function toggleChat() {
        chatOpen = !chatOpen;
        document.getElementById('chatBody').classList.toggle('open', chatOpen);
        document.getElementById('chatToggleBtn').textContent = chatOpen ? '▼' : '▲';
        if (chatOpen) {
            // Clear @mention badge — user is now reading the chat
            chatMentionCount = 0;
            updateChatUnread(0);
            // Stop slow background poll, start fast live poll
            if (chatBgInterval) { clearInterval(chatBgInterval); chatBgInterval = null; }
            if (!chatPollInterval) chatPollInterval = setInterval(fetchChat, 4000);
            fetchChat().then(function() {
                const c = document.getElementById('chatMessages');
                if (c) c.scrollTop = c.scrollHeight;
            });
            document.getElementById('chatInput').focus();
        } else {
            // Stop live poll, restart slow background @mention poll
            if (chatPollInterval) { clearInterval(chatPollInterval); chatPollInterval = null; }
            if (!chatBgInterval) chatBgInterval = setInterval(fetchChat, 15000);
        }
    }
    
    async function fetchChat() {
        if (chatFetching) return; // prevent concurrent fetches causing duplicate messages
        chatFetching = true;
        try {
            // Always seed with since=0 on the first fetch of this page-session.
            // This ensures the "Loading chat..." placeholder is always replaced,
            // even when localStorage chatLastTime is set from a prior session.
            const since = chatInitialized ? chatLastTime : 0;
            const res = await fetch('/board_chat.php?action=fetch&since=' + since);
            const data = await res.json();
            if (data.error) return;
            
            document.getElementById('chatOnline').textContent = (data.online || 0) + ' online';
            
            // Capture own anonId from server response
            if (data.my_anon_id) myAnonId = data.my_anon_id;

            if (data.messages && data.messages.length > 0) {
                const container = document.getElementById('chatMessages');
                // Clear placeholder on initial page-session seed
                if (!chatInitialized) container.innerHTML = '';
                
                let mentionCount = 0;
                data.messages.forEach(msg => {
                    const div = document.createElement('div');
                    const isVoiceMsg = msg.type === 'voice' && msg.file;
                    const isMention = !isVoiceMsg && mentionsMe(msg.message);
                    div.className = 'chat-msg' + (isMention ? ' mention-highlight' : '');
                    const time = new Date(msg.time * 1000);
                    const timeStr = time.getHours().toString().padStart(2,'0') + ':' + time.getMinutes().toString().padStart(2,'0');
                    const nameHtml = '<span class="chat-time">' + timeStr + '</span> <span class="chat-name" onclick="chatMention(\'' + msg.anonId + '\')" title="Click to @mention">' + msg.anonId + '</span>: ';
                    if (isVoiceMsg) {
                        const safeFile = msg.file.replace(/[^a-zA-Z0-9._-]/g, '');
                        div.innerHTML = nameHtml + '<span class="chat-voice-msg">🎤 <audio controls preload="metadata" src="/board_uploads/' + safeFile + '" style="height:28px;max-width:200px;vertical-align:middle;"></audio></span>';
                    } else {
                        let text = msg.message;
                        if (text.startsWith('&gt;')) text = '<span class="greentext">' + text + '</span>';
                        text = processMentions(text);
                        div.innerHTML = nameHtml + '<span class="chat-text">' + text + '</span>';
                    }
                    container.appendChild(div);
                    if (isMention) mentionCount++;
                });
                container.scrollTop = container.scrollHeight;
                // Update chatLastTime — only advance, never regress
                if (data.server_time && data.server_time > chatLastTime) {
                    chatLastTime = data.server_time;
                    try { localStorage.setItem('chatLastTime', chatLastTime); } catch(e){}
                }
                // Only fire @mention badge for NEW messages (not the initial page-session seed)
                if (!chatOpen && mentionCount > 0 && chatInitialized) {
                    chatMentionCount += mentionCount;
                    updateChatUnread(chatUnreadCount + mentionCount);
                }
            } else if (!chatInitialized) {
                // First load, no messages — update time and show empty state
                chatLastTime = data.server_time || Math.floor(Date.now() / 1000);
                try { localStorage.setItem('chatLastTime', chatLastTime); } catch(e){}
                const container = document.getElementById('chatMessages');
                container.innerHTML = '<div style="text-align:center;color:#3a6f3a;padding:20px;">No messages yet. Be the first! 🐸</div>';
            }
            chatInitialized = true; // page-session seed complete
            chatSeeded = true;      // used by background @mention suppression logic
        } catch (e) { /* silent */ } finally {
            chatFetching = false;   // always release the guard
        }
    }
    
    let chatSending = false; // guard against double-send (pressing Send twice quickly)

    // ── Chat voice note recording ──
    let _chatVoiceRec  = null;
    let _chatVoiceBlob = null;
    let _chatVoiceMime = '';
    let _chatVoiceUrl  = null;

    function toggleChatVoice() {
        var btn = document.getElementById('chatMicBtn');
        var row = document.getElementById('chatInputRow');
        if (_chatVoiceRec && _chatVoiceRec.state === 'recording') {
            _chatVoiceRec.stop();
            return;
        }
        if (_chatVoiceUrl) { URL.revokeObjectURL(_chatVoiceUrl); _chatVoiceUrl = null; }
        _chatVoiceBlob = null;
        var preview = document.getElementById('chatVoicePreview');
        if (preview) { preview.classList.remove('active'); preview.innerHTML = ''; }
        if (row) { row.classList.remove('voice-mode', 'done'); }
        navigator.mediaDevices.getUserMedia({ audio: true }).then(function(stream) {
            var types = ['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg;codecs=opus','audio/ogg'];
            var mimeType = types.find(function(t){ return MediaRecorder.isTypeSupported(t); }) || '';
            var rec = new MediaRecorder(stream, mimeType ? { mimeType: mimeType } : {});
            var chunks = [];
            rec.ondataavailable = function(e){ if (e.data.size > 0) chunks.push(e.data); };
            rec.onstop = function() {
                stream.getTracks().forEach(function(t){ t.stop(); });
                _chatVoiceMime = rec.mimeType || mimeType || 'audio/webm';
                _chatVoiceBlob = new Blob(chunks, { type: _chatVoiceMime });
                _chatVoiceUrl  = URL.createObjectURL(_chatVoiceBlob);
                _showChatVoicePreview(_chatVoiceUrl, _chatVoiceMime, _chatVoiceBlob);
                if (btn) { btn.textContent = '🎤'; btn.classList.remove('recording'); }
            };
            rec.start(100);
            _chatVoiceRec = rec;
            if (btn) { btn.textContent = '⏹'; btn.classList.add('recording'); }
            if (row) { row.classList.add('voice-mode'); row.classList.remove('done'); }
        }).catch(function() {
            var errEl = document.getElementById('chatError');
            if (errEl) { errEl.textContent = 'Microphone permission denied'; errEl.style.display='block'; setTimeout(function(){ errEl.style.display='none'; }, 3000); }
        });
    }

    function _showChatVoicePreview(url, mimeHint, blob) {
        var row     = document.getElementById('chatInputRow');
        var preview = document.getElementById('chatVoicePreview');
        if (!preview) return;
        if (row) { row.classList.add('voice-mode', 'done'); }
        preview.innerHTML = '';

        var audio = document.createElement('audio');
        audio.controls = true;
        audio.preload  = 'auto';
        audio.src      = url;   // blob URL — immediate playback; swapped to server URL after temp_upload
        audio.style.cssText = 'flex:1;min-width:0;height:32px;max-width:220px;';

        // Upload to temp dir in background so preview plays from server (consistent across browsers)
        if (blob) {
            var _ext = (mimeHint||'').includes('ogg') ? '.ogg' : (mimeHint||'').includes('mp4') ? '.m4a' : '.webm';
            var _fd = new FormData();
            _fd.append('file', new File([blob], 'chat_prev' + _ext, { type: blob.type }));
            fetch('?action=temp_upload', { method: 'POST', body: _fd })
                .then(function(r){ return r.json(); })
                .then(function(d){ if (d && d.url) { audio.src = d.url; } })
                .catch(function(){});
        }

        var sendBtn = document.createElement('button');
        sendBtn.type = 'button';
        sendBtn.className = 'chat-mic-send';
        sendBtn.innerHTML = '📤 Send';
        sendBtn.onclick = function(){ sendChatVoice(); };

        var cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'chat-mic-cancel';
        cancelBtn.textContent = '✕';
        cancelBtn.onclick = function() {
            if (_chatVoiceUrl) { URL.revokeObjectURL(_chatVoiceUrl); _chatVoiceUrl = null; }
            _chatVoiceBlob = null;
            preview.classList.remove('active');
            preview.innerHTML = '';
            if (row) { row.classList.remove('voice-mode', 'done'); }
        };

        preview.appendChild(audio);
        preview.appendChild(sendBtn);
        preview.appendChild(cancelBtn);
        preview.classList.add('active');
    }

    async function sendChatVoice() {
        if (!_chatVoiceBlob) return;
        var errEl = document.getElementById('chatError');
        var preview = document.getElementById('chatVoicePreview');
        var baseType = _chatVoiceMime.split(';')[0] || 'audio/webm';
        var ext = baseType.includes('ogg') ? '.ogg' : baseType.includes('mp4') ? '.m4a' : '.webm';
        var fname = 'voice_' + Date.now() + ext;
        var fd = new FormData();
        fd.append('action', 'voice');
        fd.append('audio', new File([_chatVoiceBlob], fname, { type: _chatVoiceBlob.type }));
        try {
            var res = await fetch('/board_chat.php', { method: 'POST', body: fd });
            var data = await res.json();
            if (data.error) {
                if (errEl) { errEl.textContent = data.error; errEl.style.display='block'; setTimeout(function(){ errEl.style.display='none'; }, 3000); }
                return;
            }
            if (_chatVoiceUrl) { URL.revokeObjectURL(_chatVoiceUrl); _chatVoiceUrl = null; }
            _chatVoiceBlob = null;
            if (preview) { preview.classList.remove('active'); preview.innerHTML = ''; }
            var row = document.getElementById('chatInputRow');
            if (row) { row.classList.remove('voice-mode', 'done'); }
            if (chatPollInterval) { clearInterval(chatPollInterval); chatPollInterval = setInterval(fetchChat, 4000); }
            fetchChat();
        } catch(e) {
            if (errEl) { errEl.textContent = 'Failed to send voice note'; errEl.style.display='block'; }
        }
    }

    async function sendChatMessage() {
        if (chatSending) return;
        const input = document.getElementById('chatInput');
        const msg = input.value.trim();
        if (!msg) return;
        
        const btn = document.getElementById('chatSendBtn');
        const errEl = document.getElementById('chatError');
        errEl.style.display = 'none';

        // Lock immediately — prevent any re-entry until server responds
        chatSending = true;
        input.disabled = true;
        if (btn) { btn.disabled = true; btn.textContent = '...'; }

        try {
            const formData = new FormData();
            formData.append('action', 'send');
            formData.append('message', msg);
            
            const res = await fetch('/board_chat.php', { method: 'POST', body: formData });
            const data = await res.json();
            
            if (data.error) {
                errEl.textContent = data.error;
                errEl.style.display = 'block';
                setTimeout(() => errEl.style.display = 'none', 3000);
                return;
            }
            
            input.value = '';
            // Reset the poll interval so it doesn't race with this fetch
            if (chatPollInterval) {
                clearInterval(chatPollInterval);
                chatPollInterval = setInterval(fetchChat, 4000);
            }
            fetchChat();
        } catch (e) {
            errEl.textContent = 'Failed to send';
            errEl.style.display = 'block';
        } finally {
            chatSending = false;
            input.disabled = false;
            if (btn) { btn.disabled = false; btn.textContent = 'SEND'; }
            input.focus();
        }
    }
    
    document.getElementById('chatInput')?.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
    });
    
    // Auto-open chat on load (minimized) - start polling only if opened
    <?php endif; ?>

    // ── FrogTalk Mini Widget ──
    let frogMiniOpen = false;
    let frogMiniLogged = false;
    let frogMiniSyncTimer = null;
    let frogMiniAuthPending = false;
    let frogMiniAuthPendingTimer = null;

    function _frogMiniUpdateOpenFullBtn() {
        const openFullBtn = document.getElementById('frogMiniOpenFull');
        if (!openFullBtn) return;
        // Only show for board visitors who are not already logged in.
        openFullBtn.style.display = frogMiniLogged ? 'none' : 'inline-flex';
    }

    function _frogMiniToken() {
        try {
            // FrogTalk app stores auth as fc_token/fc_user.
            // Keep legacy 'token' fallback for older sessions.
            return localStorage.getItem('fc_token')
                || localStorage.getItem('token')
                || '';
        } catch (e) {
            return '';
        }
    }

    function _frogMiniHasUser() {
        try {
            return !!(localStorage.getItem('fc_user') || localStorage.getItem('user'));
        } catch (e) {
            return false;
        }
    }

    function _frogMiniApplyState() {
        const stateEl = document.getElementById('frogMiniState');
        const guest = document.getElementById('frogMiniGuest');
        const wrap = document.getElementById('frogMiniWrap');
        const frame = document.getElementById('frogMiniFrame');
        if (!stateEl || !guest || !wrap || !frame) return;

        frogMiniLogged = !!_frogMiniToken() && _frogMiniHasUser();
        _frogMiniUpdateOpenFullBtn();
        if (frogMiniLogged) {
            // Auth succeeded — clear pending flag
            frogMiniAuthPending = false;
            if (frogMiniAuthPendingTimer) { clearTimeout(frogMiniAuthPendingTimer); frogMiniAuthPendingTimer = null; }
            let _miniNick = '';
            try { const _u = JSON.parse(localStorage.getItem('fc_user') || '{}'); _miniNick = _u.nickname || ''; } catch (e) {}
            stateEl.textContent = _miniNick ? ('Logged in as ' + _miniNick) : 'Logged in';
            guest.style.display = 'none';
            wrap.classList.add('open');
            if (!frame.src || frame.src === 'about:blank') frame.src = '/app?mini=1&src=board';
        } else if (!frogMiniAuthPending) {
            // Only reset to guest state if auth is not in progress
            stateEl.textContent = 'Not logged in';
            guest.style.display = 'flex';
            wrap.classList.remove('open');
            frame.src = 'about:blank';
        }
    }

    function toggleFrogMini() {
        frogMiniOpen = !frogMiniOpen;
        const body = document.getElementById('chatBody');
        const toggle = document.getElementById('chatToggleBtn');
        if (body) body.style.display = frogMiniOpen ? 'block' : 'none';
        if (toggle) toggle.textContent = frogMiniOpen ? '▼' : '▲';
        if (frogMiniOpen) {
            _frogMiniApplyState();
            if (!frogMiniSyncTimer) {
                frogMiniSyncTimer = setInterval(_frogMiniApplyState, 1200);
            }
        } else if (frogMiniSyncTimer) {
            clearInterval(frogMiniSyncTimer);
            frogMiniSyncTimer = null;
        }
    }

    function frogMiniAuth(mode) {
        const frame = document.getElementById('frogMiniFrame');
        const wrap = document.getElementById('frogMiniWrap');
        const guest = document.getElementById('frogMiniGuest');
        if (!frame || !wrap || !guest) return;
        // Set pending flag so _frogMiniApplyState doesn't collapse UI before user logs in
        frogMiniAuthPending = true;
        if (frogMiniAuthPendingTimer) clearTimeout(frogMiniAuthPendingTimer);
        // Safety: clear pending after 10 minutes
        frogMiniAuthPendingTimer = setTimeout(function() {
            frogMiniAuthPending = false;
            frogMiniAuthPendingTimer = null;
            _frogMiniApplyState();
        }, 10 * 60 * 1000);
        frame.src = mode === 'register' ? '/app?register=1&mini=1&src=board' : '/app?mini=1&src=board';
        guest.style.display = 'none';
        wrap.classList.add('open');
    }

    function frogMiniOpenFullApp() {
        window.open('/app', '_blank', 'noopener,noreferrer');
    }

    (function initFrogMini() {
        const body = document.getElementById('chatBody');
        if (body) body.style.display = 'none';
        _frogMiniApplyState();

        // React when auth changes in another same-origin context (e.g. /app iframe).
        window.addEventListener('storage', function(ev) {
            const k = String(ev && ev.key || '');
            if (!k || k === 'fc_token' || k === 'fc_user' || k === 'token' || k === 'user') {
                _frogMiniApplyState();
            }
        });

        // Also refresh when tab becomes visible after logging in inside iframe.
        document.addEventListener('visibilitychange', function() {
            if (!document.hidden) _frogMiniApplyState();
        });
    })();
    
    // ── Live Refresh System ──
    let boardSortMode = localStorage.getItem('boardSortMode') || 'frog';

    function clientSortScore(el) {
        var bump  = parseFloat(el.dataset.bump || 0);
        var goyim = parseFloat(el.dataset.goyim || 0);
        // Support both index view (DOM-scraped) and catalog view (data attrs)
        var likes = parseInt(el.dataset.likes || 0) || (function(){ var e = el.querySelector('.like-count'); return e ? (parseInt(e.textContent)||0) : 0; })();
        var views = parseInt(el.dataset.views || 0) || (function(){ var e = el.querySelector('.view-count'); return e ? (parseInt((e.textContent||'').replace(/\D/g,''))||0) : 0; })();
        var reps  = parseInt(el.dataset.replies || 0) || (function(){ var e = el.querySelector('.reply-count span'); return e ? (parseInt(e.textContent)||0) : 0; })();
        if (boardSortMode === 'futaba') return bump;
        return bump
             + Math.log2(goyim + 1) * 5400
             + Math.log2(likes + 1) * 7200
             + Math.log2(reps  + 1) * 1200
             + Math.log2(views + 1) * 120;
    }

    function clientSortThreads(container, flash) {
        if (flash === undefined) flash = true;
        // Support both index view (.thread) and catalog view (.catalog-card)
        var isCatalog = container.classList.contains('catalog-grid');
        var selector = isCatalog ? ':scope > .catalog-card' : ':scope > .thread';
        var els = Array.from(container.querySelectorAll(selector));
        var stickies = els.filter(function(e){ return e.classList.contains('sticky'); });
        var rest     = els.filter(function(e){ return !e.classList.contains('sticky'); });
        rest.sort(function(a, b){ return clientSortScore(b) - clientSortScore(a); });
        // Don't move any element that has an open (visible) YouTube player or a playing native media element
        function hasActiveYT(el) {
            var fw = el.querySelector('.yt-frame-wrap');
            return fw && fw.style.display !== 'none';
        }
        function hasPlayingMedia(el) {
            return Array.from(el.querySelectorAll('video,audio')).some(function(m){ return !m.paused; });
        }
        // Scroll-anchor: remember the first partly-visible thread so we can restore the viewport after re-ordering
        var sorted = stickies.concat(rest);
        var anchor = null, anchorOffset = 0;
        sorted.forEach(function(el) {
            if (!anchor) {
                var r = el.getBoundingClientRect();
                if (r.bottom > 0 && r.top < window.innerHeight) { anchor = el; anchorOffset = r.top; }
            }
        });
        sorted.forEach(function(el){
            if (!hasActiveYT(el) && !hasPlayingMedia(el) && !el.contains(document.activeElement)) container.appendChild(el);
        });
        // Restore viewport — undo any scroll jump caused by DOM reordering
        if (anchor) {
            var newTop = anchor.getBoundingClientRect().top;
            if (Math.abs(newTop - anchorOffset) > 1) window.scrollBy(0, newTop - anchorOffset);
        }
        if (flash) sorted.forEach(function(el, i){
            if (!hasActiveYT(el) && !hasPlayingMedia(el)) setTimeout(function(){ el.classList.add('sort-flash'); setTimeout(function(){ el.classList.remove('sort-flash'); }, 560); }, i * 20);
        });
    }

    let autoRefreshTimers = { index: null, thread: null };
    let countdownTimers = { index: null, thread: null };
    let countdownSecs = { index: 0, thread: 0 };
    let knownThreadIds = [];
    let knownReplyIds = [];
    const REFRESH_SECONDS = 5;

    // Typing detection — prevent refresh disrupting keyboard/focus
    let _lastTyped = 0;
    let _pendingReplies = null; // queued new replies to inject after typing stops
    document.addEventListener('input', function(e) {
        const tag = e.target && e.target.tagName;
        if (tag === 'TEXTAREA' || tag === 'INPUT') _lastTyped = Date.now();
    }, true);
    function userIsTyping() {
        const tag = document.activeElement && document.activeElement.tagName;
        const focused = (tag === 'TEXTAREA' || tag === 'INPUT');
        const recentKeypress = (Date.now() - _lastTyped) < 3000;
        return focused || recentKeypress;
    }
    const REFRESH_INTERVAL = REFRESH_SECONDS * 1000;
    const CURRENT_PAGE = <?= json_encode($currentPage ?? 1) ?>;
    
    // Collect initial thread IDs on board index
    document.querySelectorAll('#threadsContainer > .thread').forEach(el => {
        const id = el.id.replace('p', '');
        if (id) knownThreadIds.push(id);
    });
    // Collect initial reply IDs on thread view
    document.querySelectorAll('.reply').forEach(el => {
        const id = el.id.replace('p', '');
        if (id) knownReplyIds.push(id);
    });
    
    function updateCountdown(mode) {
        const el = document.getElementById(mode === 'thread' ? 'countdownThread' : 'countdownIndex');
        if (!el) return;
        if (countdownSecs[mode] > 0) {
            el.textContent = '(' + countdownSecs[mode] + 's)';
            countdownSecs[mode]--;
        } else {
            el.textContent = '(0s)';
        }
    }
    
    function startCountdown(mode) {
        stopCountdown(mode);
        countdownSecs[mode] = REFRESH_SECONDS;
        updateCountdown(mode);
        countdownTimers[mode] = setInterval(function() { updateCountdown(mode); }, 1000);
    }
    
    function stopCountdown(mode) {
        if (countdownTimers[mode]) { clearInterval(countdownTimers[mode]); countdownTimers[mode] = null; }
        const el = document.getElementById(mode === 'thread' ? 'countdownThread' : 'countdownIndex');
        if (el) el.textContent = '';
    }
    
    // skipInitial=true: restore on page load — PHP data is already fresh, don't immediately replace it
    function toggleAutoRefresh(mode, skipInitial) {
        const cb = document.getElementById(mode === 'thread' ? 'autoRefreshThread' : 'autoRefreshIndex');
        const dot = document.getElementById(mode === 'thread' ? 'liveDotThread' : 'liveDotIndex');
        const statusEl = document.getElementById(mode === 'thread' ? 'liveStatusThread' : 'liveStatusIndex');
        
        if (cb && cb.checked) {
            localStorage.setItem('autoRefresh', '1');
            dot.classList.add('active');
            statusEl.textContent = 'LIVE';
            const fn = function() {
                var refreshFn = mode === 'thread' ? liveRefreshThread : liveRefreshIndex;
                refreshFn().then(function() { startCountdown(mode); });
            };
            if (!skipInitial) fn(); // don't fire immediately on restore — prevents flash on page load
            autoRefreshTimers[mode] = setInterval(fn, REFRESH_INTERVAL);
            if (skipInitial) startCountdown(mode); // still show countdown
        } else {
            localStorage.setItem('autoRefresh', '0');
            dot.classList.remove('active');
            statusEl.textContent = 'Manual';
            if (autoRefreshTimers[mode]) { clearInterval(autoRefreshTimers[mode]); autoRefreshTimers[mode] = null; }
            stopCountdown(mode);
        }
    }
    
    // Restore open reply box state on page load (fixes mobile refresh closing reply)
    // Don't restore if we just submitted a reply (?post= in URL = fresh redirect)
    (function restoreReplyState() {
        var justPosted = /[?&]post=/.test(location.search);
        if (justPosted) {
            try { localStorage.removeItem('openReplyBox'); } catch(e){}
            return;
        }
        var saved = '';
        try { saved = localStorage.getItem('openReplyBox') || ''; } catch(e){}
        if (saved) {
            var qr = document.getElementById('qr-' + saved);
            if (qr) qr.classList.add('active'); // restore open state; don't focus to avoid mobile keyboard popup
        }
    })();

    // Restore auto-refresh state from localStorage (single shared setting)
    (function restoreAutoRefresh() {
        const saved = localStorage.getItem('autoRefresh') === '1';
        ['index', 'thread'].forEach(mode => {
            const cb = document.getElementById(mode === 'thread' ? 'autoRefreshThread' : 'autoRefreshIndex');
            if (cb && saved) {
                cb.checked = true;
                toggleAutoRefresh(mode, true); // skipInitial=true: page just loaded, PHP data is fresh
            }
        });
    })();

    function setTheme(name) {
        document.body.setAttribute('data-theme', name || '');
        document.documentElement.setAttribute('data-theme', name || '');
        localStorage.setItem('ph_theme', name || '');
        var metaTheme = document.querySelector('meta[name="theme-color"]');
        if (metaTheme) metaTheme.setAttribute('content', name === 'read' ? '#c4a96e' : '#00ff41');
        var sel = document.getElementById('theme-select');
        if (sel) sel.value = name || '';
    }

    function setSortMode(mode) {
        boardSortMode = (mode === 'futaba') ? 'futaba' : 'frog';
        localStorage.setItem('boardSortMode', boardSortMode);
        document.querySelectorAll('.sort-mode-btn').forEach(function(btn) {
            btn.classList.toggle('active', btn.dataset.mode === boardSortMode);
        });
        // Instant client-side re-sort — works for both index and catalog views
        var sContainer = document.getElementById('threadsContainer') || document.querySelector('.catalog-grid');
        if (sContainer) clientSortThreads(sContainer);
        // Fetch fresh server data (catalog view skips live refresh since it has no live bar)
        if (document.getElementById('threadsContainer')) liveRefreshIndex();
    }

    // Restore sort mode + theme on load
    (function restoreSortMode() {
        var savedTheme = localStorage.getItem('ph_theme') || '';
        if (savedTheme) {
            document.body.setAttribute('data-theme', savedTheme);
            document.documentElement.setAttribute('data-theme', savedTheme);
            var metaTheme = document.querySelector('meta[name="theme-color"]');
            if (metaTheme) metaTheme.setAttribute('content', savedTheme === 'read' ? '#c4a96e' : '#00ff41');
        }
        var themeSel = document.getElementById('theme-select');
        if (themeSel) themeSel.value = savedTheme;
        document.querySelectorAll('.sort-mode-btn').forEach(function(btn) {
            btn.classList.toggle('active', btn.dataset.mode === boardSortMode);
        });
        // If futaba mode saved, immediately re-sort the PHP-rendered list by pure bump order
        if (boardSortMode === 'futaba' || boardSortMode === 'frog') {
            var sc = document.getElementById('threadsContainer') || document.querySelector('.catalog-grid');
            if (sc) clientSortThreads(sc, false);
        }
    })();
    
    async function liveRefreshIndex() {
        const btn = document.querySelector('#liveBarIndex .refresh-btn');
        if (btn) btn.classList.add('spinning');
        const statusEl = document.getElementById('liveStatusIndex');
        
        // Helper: is any YouTube video currently open/playing?
        function anyYTOpen() {
            return !!document.querySelector('.yt-frame-wrap iframe');
        }
        // Helper: is any native <video> or <audio> currently playing?
        function anyNativeMediaPlaying() {
            return Array.from(document.querySelectorAll('video,audio')).some(function(m){ return !m.paused; });
        }
        
        try {
            const resp = await fetch('/board?action=live_index&page=' + CURRENT_PAGE + '&sort=' + boardSortMode);
            const data = await resp.json();
            if (!data.threads) return;
            
            const container = document.getElementById('threadsContainer');
            if (!container) return;
            
            const newIds = data.threads.map(t => t.id);
            
            // Find threads that need to leave (not in new data)
            const leaving = knownThreadIds.filter(id => !newIds.includes(id));
            leaving.forEach(id => {
                const el = document.getElementById('p' + id);
                if (el) {
                    const threadEl = el.closest('.thread') || el;
                    // Don't remove a thread that has a YT video playing
                    if (anyYTOpen() && threadEl.querySelector('.yt-frame-wrap iframe')) return;
                    // Don't remove a thread with a playing native video or audio
                    if (Array.from(threadEl.querySelectorAll('video,audio')).some(function(m){ return !m.paused; })) return;
                    // Don't remove a thread the user is actively typing in
                    const ta = threadEl.querySelector('textarea');
                    if (ta && (ta === document.activeElement || ta.value.trim())) return;
                    threadEl.classList.add('thread-leaving');
                    setTimeout(() => threadEl.remove(), 400);
                }
            });
            
            // Find new threads (not in current DOM)
            const entering = data.threads.filter(t => !knownThreadIds.includes(t.id));
            
            // Update existing thread stats (reply count, views, likes, images)
            data.threads.forEach(t => {
                if (knownThreadIds.includes(t.id)) {
                    const threadEl = document.getElementById('p' + t.id);
                    if (!threadEl) return;
                    const wrapEl = threadEl.closest('.thread') || threadEl;
                    const footer = wrapEl.querySelector('.thread-footer');
                    if (!footer) return;
                    const replySpan = footer.querySelector('.reply-count span');
                    if (replySpan) replySpan.textContent = t.replyCount;
                    const viewEl = footer.querySelector('.view-count');
                    if (viewEl) viewEl.textContent = '👁 ' + t.views;
                    const likeEl = footer.querySelector('.like-count');
                    if (likeEl) likeEl.textContent = t.likes;
                    // Update hot glow
                    updateHotClass(wrapEl, t.likes);
                    // Update sort data attributes
                    if (t.bump) wrapEl.dataset.bump = t.bump;
                    wrapEl.dataset.goyim = t.goyimTips || 0;
                    // Update pending image to approved thumbnail
                    const opEl = wrapEl.querySelector('.thread-op');
                    if (opEl && t.thumb) {
                        const pending = opEl.querySelector('.image-pending');
                        if (pending) {
                            const imgDiv = document.createElement('div');
                            imgDiv.className = 'post-image-container';
                            imgDiv.innerHTML = '<img src="' + t.thumb + '" alt="post image" style="max-width:250px;" onclick="expandImage(this)" loading="lazy">';
                            pending.replaceWith(imgDiv);
                        }
                    }
                }
            });
            
            // Insert new threads at the top with fade-in
            entering.forEach(t => {
                const div = document.createElement('div');
                var hotCls = t.likes >= 1000 ? ' hot-1000' : t.likes >= 100 ? ' hot-100' : t.likes >= 10 ? ' hot-10' : '';
                div.className = 'thread thread-entering' + hotCls;
                div.id = 'wrap-p' + t.id;
                div.dataset.bump = t.bump || t.time || 0;
                div.dataset.goyim = t.goyimTips || 0;
                const imgHtml = t.thumb ? '<div class="post-image-container"><img src="' + t.thumb + '" alt="thumb" style="max-width:150px;max-height:150px;border-radius:3px;" loading="lazy"></div>' : '';
                const subjectHtml = t.subject ? '<a href="/board?thread=' + t.id + '" class="post-subject">' + escapeHtml(t.subject) + '</a>' : '';
                const stickyBadge = t.sticky ? '<span class="post-badge badge-sticky">📌</span>' : '';
                const lockedBadge = t.locked ? '<span class="post-badge badge-locked">🔒</span>' : '';
                div.innerHTML = '<div class="thread-op clearfix" id="p' + t.id + '">'
                    + '<div class="post-header">' + subjectHtml + stickyBadge + lockedBadge
                    + '<span class="post-anon">Anonymous</span>'
                    + '<span class="post-time">' + t.timeAgo + '</span>'
                    + '<span class="post-no">No.' + t.id + '</span></div>'
                    + imgHtml
                    + '<div class="post-comment">' + escapeHtml(t.comment) + (t.comment.length >= 300 ? '...' : '') + '</div></div>'
                    + '<div class="thread-footer">'
                    + '<span class="reply-count"><span>' + t.replyCount + '</span> repl' + (t.replyCount === 1 ? 'y' : 'ies') + '</span>'
                    + '<span class="view-count">👁 ' + t.views + '</span>'
                    + '<button class="like-btn" onclick="toggleLike(\'' + t.id + '\', this)" data-post="' + t.id + '">&#x1F438; <span class="like-count">' + t.likes + '</span></button>'
                    + '<button class="goyim-bump-btn" onclick="openGoyimBump(\'' + t.id + '\')" style="padding:2px 8px;font-size:11px;">&#x1F525; Boost' + (t.goyimTips > 0 ? ' <span class="gbump-count">' + Math.round(t.goyimTips) + 'G</span>' : '') + '</button>'
                    + '<a href="/board?thread=' + t.id + '" class="thread-link">View Thread →</a>'
                    + '</div>';
                container.insertBefore(div, container.firstChild);
                setTimeout(() => div.classList.remove('thread-entering'), 500);
            });
            
            knownThreadIds = newIds;

            // Re-sort DOM — skip if a YT or native video is playing, or user is typing in a quick reply
            if (!anyYTOpen() && !anyNativeMediaPlaying() && !userIsTyping()) clientSortThreads(container, false);

            const count = entering.length;
            if (statusEl) {
                const autoOn = document.getElementById('autoRefreshIndex')?.checked;
                const modeLabel = boardSortMode === 'futaba' ? 'Futaba' : 'FrogAlgo';
                if (count > 0) {
                    statusEl.textContent = (autoOn ? 'LIVE' : 'Updated') + ' · +' + count + ' new · ' + modeLabel;
                } else {
                    statusEl.textContent = (autoOn ? 'LIVE' : 'Up to date') + ' · ' + modeLabel;
                }
            }
            
            // Update online count in footer
            const onlineEl = document.querySelector('.board-footer .online-dot')?.parentElement;
            if (onlineEl && data.online !== undefined) {
                // Update is embedded in footer text, skip complex update
            }
            
        } catch(e) {
            if (statusEl) statusEl.textContent = 'Error';
            console.error('Live refresh failed:', e);
        } finally {
            if (btn) setTimeout(() => btn.classList.remove('spinning'), 300);
        }
    }
    
    async function liveRefreshThread() {
        if (!VIEW_THREAD_ID) return;
        const btn = document.querySelector('#liveBarThread .refresh-btn');
        if (btn) btn.classList.add('spinning');
        const statusEl = document.getElementById('liveStatusThread');
        
        try {
            const resp = await fetch('/board?action=live_thread&thread=' + VIEW_THREAD_ID);
            const data = await resp.json();
            if (data.error) return;
            
            // Update OP stats
            const viewEl = document.querySelector('.post-actions .view-count');
            if (viewEl) viewEl.textContent = '👁 ' + data.views + ' views';
            const likeEl = document.querySelector('.post-actions .like-count');
            if (likeEl) likeEl.textContent = data.likes;
            
            // Update OP image if it was pending and is now approved
            if (data.opImage && data.opImage.visible) {
                const opEl = document.getElementById('p' + data.id);
                if (opEl) {
                    const pending = opEl.querySelector('.image-pending');
                    if (pending) {
                        // Image was pending, now approved — replace with actual image
                        const imgDiv = document.createElement('div');
                        imgDiv.className = 'post-image-container';
                        imgDiv.innerHTML = '<div class="post-image-info">' + escapeHtml(data.opImage.name) + ' (' + escapeHtml(data.opImage.size) + ')</div>'
                            + '<img src="' + escapeHtml(data.opImage.thumb) + '" data-full="' + escapeHtml(data.opImage.full) + '" alt="post image" onclick="expandImage(this)" loading="lazy">';
                        pending.replaceWith(imgDiv);
                    }
                }
            }
            
            // Update existing reply images (e.g., pending → approved)
            data.replies.forEach(r => {
                if (!knownReplyIds.includes(r.id)) return; // skip new replies, handled below
                const replyEl = document.getElementById('p' + r.id);
                if (!replyEl) return;
                
                // Check if this reply has a pending image that is now visible
                const pendingImg = replyEl.querySelector('.image-pending');
                if (pendingImg && r.thumb) {
                    const imgDiv = document.createElement('div');
                    imgDiv.className = 'post-image-container';
                    imgDiv.innerHTML = '<div class="post-image-info">' + escapeHtml(r.imageName || 'image') + ' (' + escapeHtml(r.imageSize || '?') + ')</div>'
                        + '<img src="' + escapeHtml(r.thumb) + '" data-full="' + escapeHtml(r.fullImage || r.thumb) + '" alt="reply image" onclick="expandImage(this)" loading="lazy">';
                    pendingImg.replaceWith(imgDiv);
                }
            });
            
            // Find new replies
            const newReplies = data.replies.filter(r => !knownReplyIds.includes(r.id));
            
            if (newReplies.length > 0) {
                // Insert before .reply-form-wrap (direct child of .thread) — NOT .quick-reply which is nested inside it
                const threadContainer = document.querySelector('.thread');
                const replyFormWrap = document.querySelector('.reply-form-wrap');
                
                // Defer DOM insertion if user is actively typing to avoid keyboard dismissal on mobile
                const _injectReplies = (replies) => {
                    replies.forEach(r => {
                    const div = document.createElement('div');
                    div.className = 'reply clearfix reply-new';
                    div.id = 'p' + r.id;
                    let imgHtml = '';
                    if (r.thumb) {
                        imgHtml = '<div class="post-image-container">'
                            + '<div class="post-image-info">' + (r.imageName || 'image') + ' (' + (r.imageSize || '?') + ')</div>'
                            + '<img src="' + r.thumb + '" data-full="' + (r.fullImage || r.thumb) + '" alt="reply image" onclick="expandImage(this)" loading="lazy">'
                            + '</div>';
                    } else if (r.hasImage && !r.thumb) {
                        imgHtml = '<div class="image-pending"><div><span class="pending-icon">🕐</span><span>Image pending<br>admin approval</span></div></div>';
                    }
                    let walletHtml = '';
                    if (r.wallet) {
                        walletHtml = '<span class="post-wallet" onclick="copyWallet(\'' + r.wallet + '\')" title="Click to copy">🦊 ' + r.wallet.slice(0,6) + '...' + r.wallet.slice(-4) + '</span>';
                    }
                    let mediaHtml = '';
                    if (r.mediaUrl) {
                        if (r.mediaType === 'audio') {
                            mediaHtml = '<div class="post-media"><div class="post-voice-note"><div class="pvn-row"><span class="pvn-icon">🎤</span><div class="pvn-audio"><audio controls src="' + escapeHtml(r.mediaUrl) + '"></audio></div></div><div class="pvn-label">' + escapeHtml(r.mediaOrigName || 'voice note') + '</div></div></div>';
                        } else {
                            mediaHtml = '<div class="post-media"><div class="post-video-clip"><video controls src="' + escapeHtml(r.mediaUrl) + '" preload="metadata"></video><div class="pvc-label">' + escapeHtml(r.mediaOrigName || 'video clip') + '</div></div></div>';
                        }
                    } else if (r.mediaPending) {
                        if (BOARD_IS_ADMIN) {
                            mediaHtml = '<div class="media-pending-small media-pending-admin">'
                                + (r.mediaType === 'audio' ? '🎤 Voice note' : '🎥 Video') + ' pending approval '
                                + '<form method="POST" action="/board/admin" style="display:inline;margin-left:6px;">'
                                + '<input type="hidden" name="action" value="approve_media">'
                                + '<input type="hidden" name="post_id" value="' + r.id + '">'
                                + '<input type="hidden" name="thread_id" value="' + VIEW_THREAD_ID + '">'
                                + '<input type="hidden" name="is_reply" value="1">'
                                + '<input type="hidden" name="return_url" value="' + location.pathname + location.search + '">'
                                + '<button class="approve-overlay-btn">✅ Approve</button></form>'
                                + '<form method="POST" action="/board/admin" style="display:inline;">'
                                + '<input type="hidden" name="action" value="reject_media">'
                                + '<input type="hidden" name="post_id" value="' + r.id + '">'
                                + '<input type="hidden" name="thread_id" value="' + VIEW_THREAD_ID + '">'
                                + '<input type="hidden" name="is_reply" value="1">'
                                + '<input type="hidden" name="return_url" value="' + location.pathname + location.search + '">'
                                + '<button class="reject-overlay-btn">❌ Reject</button></form>'
                                + '</div>';
                        } else {
                            mediaHtml = '<div class="media-pending-small">' + (r.mediaType === 'audio' ? '🎤 Voice note' : '🎥 Video') + ' pending admin approval</div>';
                        }
                    }
                    div.innerHTML = '<div class="post-header">'
                        + '<span class="post-anon">Anonymous</span>'
                        + '<span class="post-anon-id">ID: ' + r.anonId + '</span>'
                        + walletHtml
                        + '<span class="post-time">' + r.timeFormatted + '</span>'
                        + '<span class="post-no" onclick="insertQuote(\'' + r.id + '\')">No.' + r.id + '</span>'
                        + '</div>'
                        + imgHtml
                        + mediaHtml
                        + '<div class="post-comment">' + r.comment + '</div>';
                    
                    if (replyFormWrap) {
                        threadContainer.insertBefore(div, replyFormWrap);
                    } else {
                        threadContainer.appendChild(div);
                    }
                    knownReplyIds.push(r.id);
                    }); // end forEach
                }; // end _injectReplies

                if (userIsTyping()) {
                    // Queue for after typing stops so mobile keyboard isn't disrupted
                    // Mark IDs as known immediately so they aren't re-queued on next refresh cycle
                    newReplies.forEach(r => { if (!knownReplyIds.includes(r.id)) knownReplyIds.push(r.id); });
                    _pendingReplies = (_pendingReplies || []).concat(newReplies);
                    const _waitAndInject = function() {
                        if (userIsTyping()) {
                            setTimeout(_waitAndInject, 1000);
                        } else if (_pendingReplies && _pendingReplies.length) {
                            const toInject = _pendingReplies;
                            _pendingReplies = null;
                            _injectReplies(toInject);
                            const firstNew = document.getElementById('p' + toInject[0].id);
                            if (firstNew) firstNew.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                        }
                    };
                    setTimeout(_waitAndInject, 1000);
                } else {
                    _injectReplies(newReplies);
                    // Scroll only if not typing
                    const firstNew = document.getElementById('p' + newReplies[0].id);
                    if (firstNew) firstNew.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
            }
            
            if (statusEl) {
                const autoOn = document.getElementById('autoRefreshThread')?.checked;
                if (newReplies.length > 0) {
                    statusEl.textContent = (autoOn ? 'LIVE' : 'Updated') + ' · +' + newReplies.length + ' new replies';
                } else {
                    statusEl.textContent = autoOn ? 'LIVE' : 'Up to date';
                }
            }
            
        } catch(e) {
            if (statusEl) statusEl.textContent = 'Error';
        } finally {
            if (btn) setTimeout(() => btn.classList.remove('spinning'), 300);
        }
    }
    
    function escapeHtml(text) {
        const d = document.createElement('div');
        d.textContent = text;
        return d.innerHTML;
    }
    
    // ── Background chat poll for @mention badges ──
    <?php if ($settings['chat_enabled'] && !$isBanned): ?>
    (function() {
        // Light background poll — only to detect @mentions when chat is closed
        setTimeout(function() {
            const isClosedOrMissing = (typeof chatOpen === 'undefined') || !chatOpen;
            const noBgPoll = (typeof chatBgInterval === 'undefined') || !chatBgInterval;
            const noLivePoll = (typeof chatPollInterval === 'undefined') || !chatPollInterval;
            if (isClosedOrMissing && noBgPoll && noLivePoll && typeof fetchChat === 'function') {
                fetchChat(); // initial fetch to get myAnonId + seed chatLastTime
                chatBgInterval = setInterval(fetchChat, 15000);
            }
        }, 3000);
    })();
    <?php endif; ?>

    // ── Fetch and fill multichain from MetaMask (button handler) ──
    async function fetchAndFillMultichain() {
        showToast('ℹ️ Paste your BTC/SOL/TRX addresses manually — MetaMask only auto-fills ETH.');
    }

    // ── Send non-EVM tip (copy address + open wallet) ──
    function sendNonEvmTip() {
        const addr = document.getElementById('tipRecipient').value;
        const status = document.getElementById('tipStatus');
        const chain = getCurrentChain();
        const custom = document.getElementById('tipCustomAmount').value.trim();
        const amount = custom || tipAmount;
        
        if (!addr) {
            status.textContent = '⚠️ No ' + chain.name + ' address provided';
            status.style.color = '#ff6b6b';
            return;
        }
        
        // Copy address to clipboard
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(addr).then(function() {
                status.innerHTML = '✅ ' + chain.name + ' address copied!<br><span style="font-size:11px;opacity:0.8;">Send <b>' + (amount || '') + ' ' + chain.symbol + '</b> to: <code style="color:#5fffaf;">' + addr.slice(0,10) + '...' + addr.slice(-6) + '</code></span>';
                status.style.color = '#00ff41';
            });
        } else {
            var ta = document.createElement('textarea');
            ta.value = addr;
            ta.style.cssText = 'position:fixed;opacity:0;';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); } catch(e) {}
            document.body.removeChild(ta);
            status.innerHTML = '✅ ' + chain.name + ' address copied!<br><span style="font-size:11px;opacity:0.8;">Send <b>' + (amount || '') + ' ' + chain.symbol + '</b> to: <code style="color:#5fffaf;">' + addr.slice(0,10) + '...' + addr.slice(-6) + '</code></span>';
            status.style.color = '#00ff41';
        }
        
        // Try to open deep link for the chain's native wallet
        var deepLink = null;
        if (tipChainId === 'btc') {
            deepLink = 'bitcoin:' + addr + (amount ? '?amount=' + amount : '');
        } else if (tipChainId === 'sol') {
            deepLink = 'solana:' + addr + (amount ? '?amount=' + amount : '');
        }
        if (deepLink) {
            // Use a hidden iframe to trigger protocol handler without xdg-open / new tab issues
            setTimeout(function() {
                var iframe = document.createElement('iframe');
                iframe.style.display = 'none';
                iframe.src = deepLink;
                document.body.appendChild(iframe);
                setTimeout(function() { document.body.removeChild(iframe); }, 3000);
            }, 500);
        }
    }

    // ── Copy address for non-EVM chains on desktop ──
    function copyDesktopTipAddress() {
        const addr = document.getElementById('tipRecipient').value;
        const status = document.getElementById('tipStatus');
        const chain = getCurrentChain();
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(addr).then(function() {
                status.innerHTML = '✅ Address copied! Send ' + chain.symbol + ' from your ' + chain.name + ' wallet.';
                status.style.color = '#00ff41';
            });
        } else {
            var ta = document.createElement('textarea');
            ta.value = addr;
            ta.style.cssText = 'position:fixed;opacity:0;';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); } catch(e) {}
            document.body.removeChild(ta);
            status.innerHTML = '✅ Address copied! Send ' + chain.symbol + ' from your ' + chain.name + ' wallet.';
            status.style.color = '#00ff41';
        }
    }

    // ── URL Hash: scroll + highlight on load, update hash on No. click ──
    (function() {
        // Override insertQuote to also update hash
        const origInsertQuote = window.insertQuote;
        window.insertQuote = function(postId) {
            history.replaceState(null, '', '#p' + postId);
            origInsertQuote(postId);
        };
        
        // Highlight post from URL hash on page load
        function highlightFromHash() {
            const hash = window.location.hash;
            if (hash && hash.startsWith('#p')) {
                const el = document.getElementById(hash.substring(1));
                if (el) {
                    // Small delay to ensure layout is done
                    setTimeout(function() {
                        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        el.classList.add('post-highlight');
                        setTimeout(function() { el.classList.remove('post-highlight'); }, 2500);
                    }, 300);
                }
            }
        }
        highlightFromHash();
        window.addEventListener('hashchange', highlightFromHash);
        
        // Clicking backlinks should update hash too
        document.addEventListener('click', function(e) {
            const link = e.target.closest('.post-backlinks a, .post-comment .post-ref');
            if (link) {
                const href = link.getAttribute('href');
                if (href && href.startsWith('#p')) {
                    e.preventDefault();
                    history.pushState(null, '', href);
                    const el = document.getElementById(href.substring(1));
                    if (el) {
                        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        el.classList.add('post-highlight');
                        setTimeout(function() { el.classList.remove('post-highlight'); }, 2500);
                    }
                }
            }
        });
    })();

    // ── Floating Post Preview on Hover (4chan-style) ──
    (function() {
        let previewEl = null;
        let hoverTimeout = null;
        
        function showPreview(target, postId) {
            hidePreview();
            const sourcePost = document.getElementById('p' + postId);
            if (!sourcePost) return;
            
            previewEl = document.createElement('div');
            previewEl.className = 'post-preview-float';
            
            // Clone header and comment
            const header = sourcePost.querySelector('.post-header');
            const comment = sourcePost.querySelector('.post-comment');
            const imgContainer = sourcePost.querySelector('.post-image-container');
            
            if (header) {
                const hClone = header.cloneNode(true);
                // Remove admin controls and backlinks from preview
                hClone.querySelectorAll('.admin-controls, .post-backlinks').forEach(function(el) { el.remove(); });
                previewEl.appendChild(hClone);
            }
            if (imgContainer) {
                const iClone = imgContainer.cloneNode(true);
                previewEl.appendChild(iClone);
            }
            if (comment) {
                const cClone = comment.cloneNode(true);
                previewEl.appendChild(cClone);
            }
            
            document.body.appendChild(previewEl);
            
            // Position near the link
            const rect = target.getBoundingClientRect();
            const previewRect = previewEl.getBoundingClientRect();
            let top = rect.bottom + window.scrollY + 5;
            let left = rect.left + window.scrollX;
            
            // Keep within viewport
            if (left + previewRect.width > window.innerWidth - 10) {
                left = window.innerWidth - previewRect.width - 10;
            }
            if (left < 10) left = 10;
            
            // If preview would go below viewport, show above
            if (rect.bottom + previewRect.height + 10 > window.innerHeight) {
                top = rect.top + window.scrollY - previewRect.height - 5;
            }
            
            previewEl.style.top = top + 'px';
            previewEl.style.left = left + 'px';
        }
        
        function hidePreview() {
            if (previewEl) {
                previewEl.remove();
                previewEl = null;
            }
            if (hoverTimeout) {
                clearTimeout(hoverTimeout);
                hoverTimeout = null;
            }
        }
        
        document.addEventListener('mouseover', function(e) {
            const link = e.target.closest('.post-comment .post-ref, .post-backlinks a');
            if (!link) return;
            
            const href = link.getAttribute('href');
            if (!href || !href.startsWith('#p')) return;
            const postId = href.substring(2);
            
            hoverTimeout = setTimeout(function() {
                showPreview(link, postId);
            }, 100);
        });
        
        document.addEventListener('mouseout', function(e) {
            const link = e.target.closest('.post-comment .post-ref, .post-backlinks a');
            if (link) hidePreview();
        });
    })();

    // ── Floating Occult Symbols ──
    (function() {
        const symbols = ['ᚠ', 'ᚢ', 'ᚦ', 'ᚨ', 'ᚱ', 'ᚲ', 'ᚷ', 'ᛟ', '☽', '☾', 'ᛉ', 'ᛊ', '🐸', 'ᛏ', 'ᚹ', '◉', '♄', '☿', '🜏', '🜃'];
        const container = document.getElementById('occultSymbols');
        if (!container) return;
        
        function spawnSymbol() {
            const sym = document.createElement('div');
            sym.className = 'occult-sym';
            sym.textContent = symbols[Math.floor(Math.random() * symbols.length)];
            sym.style.left = Math.random() * 100 + '%';
            sym.style.fontSize = (16 + Math.random() * 20) + 'px';
            sym.style.animationDuration = (25 + Math.random() * 35) + 's';
            sym.style.animationDelay = '0s';
            container.appendChild(sym);
            
            // Remove after animation completes
            setTimeout(() => sym.remove(), (25 + 35) * 1000);
        }
        
        // Spawn initial batch staggered
        for (let i = 0; i < 6; i++) {
            setTimeout(spawnSymbol, i * 4000);
        }
        // Continue spawning
        setInterval(spawnSymbol, 6000);
    })();
    
    // ── Inline Katsa OSINT Widget (Multi-Field) ──
    async function runInlineKatsa(widgetId) {
        var widget = document.getElementById(widgetId);
        var btn = document.querySelector('#' + widgetId + ' .katsa-inline-run');
        var resultsDiv = document.getElementById(widgetId + '_results');
        if (!btn || !resultsDiv || !widget) return;
        
        var username = widget.getAttribute('data-username') || '';
        var email = widget.getAttribute('data-email') || '';
        var phone = widget.getAttribute('data-phone') || '';
        var nsfw = widget.getAttribute('data-nsfw') === '1';
        
        if (!username && !email && !phone) {
            resultsDiv.innerHTML = '<div class="katsa-il-status" style="color:#ff4444;">❌ No search targets specified</div>';
            return;
        }
        
        btn.disabled = true;
        btn.textContent = '⏳ SCANNING...';
        
        // Build status message
        var targets = [];
        if (username) targets.push('👤 @' + username);
        if (email) targets.push('📧 ' + email);
        if (phone) targets.push('📱 ' + phone);
        resultsDiv.innerHTML = '<div class="katsa-il-status">🔍 Multi-scan: ' + targets.join(' · ') + '...</div>';
        resultsDiv.className = 'katsa-inline-results has-results';
        
        var totalSearches = (username ? 1 : 0) + (email ? 2 : 0) + (phone ? 1 : 0);
        var completedSearches = 0;
        var allHtml = '';
        var anyError = false;
        var reportUrl = '';
        var reportFileUrl = '';
        
        function updateProgress() {
            completedSearches++;
            if (completedSearches < totalSearches) {
                btn.textContent = '⏳ ' + completedSearches + '/' + totalSearches + '...';
            }
        }
        
        function renderFinal() {
            if (completedSearches < totalSearches) return;
            if (!allHtml) {
                allHtml = '<div class="katsa-il-status">No results found across all searches.</div>';
            }
            // Link to generated report file or share URL
            var linkTarget = reportFileUrl || reportUrl || '/katsa';
            // Append #results anchor for file pages so it scrolls past the header
            if (reportFileUrl && reportFileUrl.indexOf('#') === -1) linkTarget = reportFileUrl + '?from=board#intel-summary';
            var linkLabel = (reportFileUrl || reportUrl) ? '📂 view full report →' : '🔎 scan on katsa →';
            allHtml += '<div style="margin-top:6px;text-align:right;"><a href="' + linkTarget + '" target="_blank" style="color:#4a6a4a;font-size:8px;font-family:monospace;text-decoration:none;letter-spacing:0.5px;">' + linkLabel + '</a></div>';
            resultsDiv.innerHTML = allHtml;
            btn.textContent = '✅ DONE';
            btn.style.borderColor = 'rgba(0,255,65,0.3)';
            btn.style.color = '#00ff41';
            btn.disabled = true;
            // Persist scan results in localStorage
            try { localStorage.setItem('katsa_scan_' + widgetId, JSON.stringify({ html: allHtml, ts: Date.now() })); } catch(e) {}
            // Don't auto-collapse on first scan — user needs to see the results
            // Only auto-collapse when restored from cache (see restore logic below)
        }
        
        // ── Username scan (board_scan API — async with polling) ──
        if (username) {
            (async function() {
                try {
                    var formData = new FormData();
                    formData.append('api_action', 'board_scan');
                    formData.append('username', username);
                    if (nsfw) formData.append('nsfw', '1');
                    var resp = await fetch('/katsa', { method: 'POST', body: formData });
                    var data = await resp.json();
                    
                    // If server returned immediately with scanning status, poll for results
                    if (data.status === 'scanning') {
                        var phaseLabels = { 'starting': 'launching...', 'sherlock': 'sherlock scan...', 'verifying': 'verifying URLs...', 'secondary': 'deep scan...', 'merging': 'merging results...' };
                        btn.textContent = '🔍 ' + (phaseLabels[data.phase] || 'scanning...');
                        
                        // Poll board_scan_status every 3 seconds
                        var pollCount = 0;
                        var maxPolls = 80; // 80 * 3s = 4 min max
                        data = await new Promise(function(resolve, reject) {
                            var pollTimer = setInterval(async function() {
                                pollCount++;
                                if (pollCount > maxPolls) {
                                    clearInterval(pollTimer);
                                    resolve({ error: 'Scan timed out' });
                                    return;
                                }
                                try {
                                    var pf = new FormData();
                                    pf.append('api_action', 'board_scan_status');
                                    pf.append('username', username);
                                    var pr = await fetch('/katsa', { method: 'POST', body: pf });
                                    var pd = await pr.json();
                                    
                                    if (pd.status === 'scanning') {
                                        // Update progress indicator
                                        var label = phaseLabels[pd.phase] || 'scanning...';
                                        if (pd.sherlock_count) label = pd.sherlock_count + ' found, ' + label;
                                        btn.textContent = '🔍 ' + label;
                                    } else if (pd.status === 'error') {
                                        clearInterval(pollTimer);
                                        resolve({ error: pd.error || 'Scan failed' });
                                    } else if (pd.success || pd.verified_count !== undefined) {
                                        // Got full results
                                        clearInterval(pollTimer);
                                        resolve(pd);
                                    } else if (pd.status === 'not_found') {
                                        clearInterval(pollTimer);
                                        resolve({ error: 'Scan lost' });
                                    }
                                } catch(pe) {
                                    // Network glitch — keep polling
                                }
                            }, 3000);
                        });
                    }
                    
                    if (!data.error) {
                        if (data.share_url) reportUrl = data.share_url;
                        if (data.file_url) reportFileUrl = data.file_url;
                        var vCount = data.verified_count || 0;
                        var uCount = data.uncertain_count || 0;
                        var html = '';
                        // Header
                        html += '<div style="margin-top:6px;padding:6px 8px;background:rgba(0,255,65,0.04);border:1px solid rgba(0,255,65,0.15);border-radius:3px;">';
                        html += '<div style="color:#00ff41;font-size:9px;font-family:monospace;letter-spacing:1px;margin-bottom:4px;">👤 USERNAME: @' + username + '</div>';
                        if (data.cached) {
                            var ageText = data.cache_age < 60 ? 'just now' : data.cache_age < 3600 ? Math.floor(data.cache_age/60) + 'm ago' : Math.floor(data.cache_age/3600) + 'h ago';
                            html += '<div style="font-size:8px;color:#00c8ff;margin-bottom:3px;">⚡ cached ' + ageText + '</div>';
                        }
                        html += '<div class="katsa-il-summary"><strong>' + vCount + '</strong> confirmed';
                        if (uCount > 0) html += ', <span style="color:#ffd700;">' + uCount + ' not found</span>';
                        html += '</div>';
                        if (data.results && data.results.length > 0) {
                            var mainResults = data.results.filter(function(r) { return r.status === 'verified' && !r.nsfw; });
                            var nsfwResults = nsfw ? data.results.filter(function(r) { return r.status === 'verified' && r.nsfw; }) : [];
                            if (mainResults.length > 0) {
                                html += '<details style="margin:3px 0;"><summary style="cursor:pointer;color:#00ff41;font-size:9px;font-family:monospace;list-style:none;display:flex;align-items:center;gap:4px;user-select:none;padding:2px 0;"><span class="tool-chevron" style="display:inline-block;transition:transform 0.2s;font-size:8px;">▶</span> ✅ ' + mainResults.length + ' confirmed</summary>';
                                html += '<div class="katsa-il-sites" style="margin-top:3px;">';
                                mainResults.forEach(function(r) {
                                    var srcTag = r.source === 'linkook' ? ' <span style="color:#00c8ff;font-size:7px;">🔗</span>' : '';
                                    html += '<a href="' + r.url.replace(/"/g, '&quot;') + '" target="_blank" class="katsa-il-site">' + r.site + srcTag + ' ✅</a>';
                                });
                                html += '</div></details>';
                            }
                            if (nsfwResults.length > 0) {
                                html += '<details style="margin-top:4px;"><summary style="color:#ff6496;font-size:9px;cursor:pointer;">🔞 ' + nsfwResults.length + ' adult accounts</summary>';
                                html += '<div class="katsa-il-sites" style="margin-top:3px;">';
                                nsfwResults.forEach(function(r) {
                                    html += '<a href="' + r.url.replace(/"/g, '&quot;') + '" target="_blank" class="katsa-il-site" style="border-color:rgba(255,100,150,0.2);color:#ff6496;">' + r.site + ' 🔞</a>';
                                });
                                html += '</div></details>';
                            }
                        }
                        // Linkook intel
                        if (data.linkook) {
                            var lk = data.linkook;
                            if ((lk.related_usernames && lk.related_usernames.length > 0) || (lk.emails && lk.emails.length > 0)) {
                                var lkCnt = (lk.related_usernames ? lk.related_usernames.length : 0) + (lk.emails ? lk.emails.length : 0);
                                html += '<details style="margin-top:4px;border:1px solid rgba(0,200,255,0.15);border-radius:3px;background:rgba(0,200,255,0.04);"><summary style="padding:3px 6px;cursor:pointer;color:#00c8ff;font-size:8px;font-family:monospace;list-style:none;display:flex;align-items:center;gap:3px;user-select:none;"><span class="tool-chevron" style="display:inline-block;transition:transform 0.2s;font-size:7px;">▶</span> 🔗 LINKOOK — ' + lkCnt + ' items</summary><div style="padding:3px 6px;">';
                                if (lk.related_usernames && lk.related_usernames.length > 0) {
                                    html += '<div style="font-size:8px;color:#4a8a8a;">Aliases: <strong style="color:#00c8ff;">' + lk.related_usernames.join('</strong>, <strong style="color:#00c8ff;">') + '</strong></div>';
                                }
                                if (lk.emails && lk.emails.length > 0) {
                                    lk.emails.forEach(function(e) {
                                        html += '<div style="font-size:8px;color:#4a8a8a;">📧 ' + e.email + (e.breached ? ' <span style="color:#ff4444;font-size:7px;">⚠ BREACHED</span>' : '') + '</div>';
                                    });
                                }
                                html += '</div></details>';
                            }
                        }
                        // Maigret results (included in board_scan response)
                        if (data.maigret && data.maigret.found_count > 0) {
                            var mData = data.maigret;
                            html += '<details style="margin-top:4px;border:1px solid rgba(148,0,255,0.15);border-radius:3px;background:rgba(148,0,255,0.04);"><summary style="padding:4px 8px;cursor:pointer;color:#9400ff;font-size:9px;font-family:monospace;letter-spacing:1px;list-style:none;display:flex;align-items:center;gap:3px;user-select:none;"><span class="tool-chevron" style="display:inline-block;transition:transform 0.2s;font-size:7px;">▶</span> 🕵️ MAIGRET — ' + mData.found_count + ' accounts</summary><div style="padding:3px 6px;">';
                            if (mData.results && mData.results.length > 0) {
                                html += '<div class="katsa-il-sites" style="margin-top:4px;">';
                                mData.results.slice(0, 20).forEach(function(r) {
                                    var name = r.site_name || r.site || 'Unknown';
                                    html += '<a href="' + (r.url || '#').replace(/"/g, '&quot;') + '" target="_blank" class="katsa-il-site" style="border-color:rgba(148,0,255,0.2);color:#9400ff;">' + name + ' ✅</a>';
                                });
                                if (mData.results.length > 20) html += '<span style="color:#9400ff;font-size:8px;">+' + (mData.results.length - 20) + ' more</span>';
                                html += '</div>';
                            }
                            html += '</div></details>';
                        }
                        // WhatsMyName results (included in board_scan response)
                        if (data.whatsmyname && data.whatsmyname.found_count > 0) {
                            var wData = data.whatsmyname;
                            html += '<details style="margin-top:4px;border:1px solid rgba(0,200,100,0.15);border-radius:3px;background:rgba(0,200,100,0.04);"><summary style="padding:4px 8px;cursor:pointer;color:#00c864;font-size:9px;font-family:monospace;letter-spacing:1px;list-style:none;display:flex;align-items:center;gap:3px;user-select:none;"><span class="tool-chevron" style="display:inline-block;transition:transform 0.2s;font-size:7px;">▶</span> 🌐 WMN — ' + wData.found_count + ' accounts</summary><div style="padding:3px 6px;">';
                            if (wData.results && wData.results.length > 0) {
                                html += '<div class="katsa-il-sites" style="margin-top:4px;">';
                                wData.results.slice(0, 15).forEach(function(r) {
                                    var name = r.site || 'Unknown';
                                    html += '<a href="' + (r.url || '#').replace(/"/g, '&quot;') + '" target="_blank" class="katsa-il-site" style="border-color:rgba(0,200,100,0.2);color:#00c864;">' + name + ' ✅</a>';
                                });
                                if (wData.results.length > 15) html += '<span style="color:#00c864;font-size:8px;">+' + (wData.results.length - 15) + ' more</span>';
                                html += '</div>';
                            }
                            html += '</div></details>';
                        }
                        html += '</div>';
                        allHtml += html;
                    }
                } catch(err) { anyError = true; }
                updateProgress();
                renderFinal();
            })();
        }
        
                // ── Email scan (email_search API) ──
        if (email) {
            (async function() {
                try {
                    var formData = new FormData();
                    formData.append('api_action', 'email_search');
                    formData.append('email', email);
                    var resp = await fetch('/katsa', { method: 'POST', body: formData });
                    var data = await resp.json();
                    if (!data.error) {
                        var found = data.accounts_found || 0;
                        var results = data.results || [];
                        var html = '<details style="margin-top:4px;border:1px solid rgba(255,200,0,0.15);border-radius:3px;background:rgba(255,200,0,0.04);"><summary style="padding:4px 8px;cursor:pointer;color:#ffd700;font-size:9px;font-family:monospace;letter-spacing:1px;list-style:none;display:flex;align-items:center;gap:3px;user-select:none;"><span class="tool-chevron" style="display:inline-block;transition:transform 0.2s;font-size:7px;">▶</span> 📧 EMAIL — ' + found + ' sites</summary><div style="padding:3px 6px;">';
                        if (data.cached) html += '<div style="font-size:8px;color:#00c8ff;margin-bottom:3px;">⚡ cached</div>';
                        html += '<div class="katsa-il-summary">Registered on <strong>' + found + '</strong> sites</div>';
                        if (found > 0) {
                            html += '<div class="katsa-il-sites" style="margin-top:4px;">';
                            results.forEach(function(r) {
                                var site = r.site || r.name || 'Unknown';
                                html += '<span class="katsa-il-site" style="border-color:rgba(255,200,0,0.2);color:#ffd700;">' + site + ' ✅</span>';
                            });
                            html += '</div>';
                        }
                        html += '</div></details>';
                        allHtml += html;
                    }
                } catch(err) { anyError = true; }
                updateProgress();
                renderFinal();
            })();
        }
        
        // ── GHunt scan (email) ──
        if (email) {
            (async function() {
                try {
                    var formData = new FormData();
                    formData.append('api_action', 'ghunt_scan');
                    formData.append('email', email);
                    var resp = await fetch('/katsa', { method: 'POST', body: formData });
                    var data = await resp.json();
                    if (!data.error && data.found && !data.needs_setup) {
                        var gid = data.google_id || '';
                        var html = '<details style="margin-top:4px;border:1px solid rgba(66,133,244,0.15);border-radius:3px;background:rgba(66,133,244,0.04);"><summary style="padding:4px 8px;cursor:pointer;color:#4285f4;font-size:9px;font-family:monospace;letter-spacing:1px;list-style:none;display:flex;align-items:center;gap:3px;user-select:none;"><span class="tool-chevron" style="display:inline-block;transition:transform 0.2s;font-size:7px;">▶</span> 🔍 GHUNT — ' + (data.google_name || 'Google Intel') + '</summary><div style="padding:3px 6px;">';
                        if (data.cached) html += '<div style="font-size:8px;color:#00c8ff;margin-bottom:3px;">⚡ cached</div>';
                        if (data.profile_photos && data.profile_photos.length > 0) { html += '<div style="margin-bottom:3px;">'; data.profile_photos.forEach(function(url) { html += '<img src="' + url + '" style="width:36px;height:36px;border-radius:50%;border:1px solid rgba(66,133,244,0.3);object-fit:cover;" />'; }); html += '</div>'; }
                        if (data.google_name) html += '<div style="font-size:9px;color:#e8e8e8;">Name: <strong style="color:#4285f4;">' + data.google_name + '</strong></div>';
                        if (data.google_id) html += '<div style="font-size:8px;color:#6a8a8a;">Gaia ID: <span style="user-select:all;">' + data.google_id + '</span></div>';
                        if (data.last_edit) html += '<div style="font-size:8px;color:#6a8a8a;">Last edit: ' + data.last_edit + '</div>';
                        if (data.entity_type) html += '<div style="font-size:8px;color:#6a8a8a;">Entity: ' + data.entity_type + '</div>';
                        if (data.flathash) html += '<div style="font-size:8px;color:#6a8a8a;">Flathash: <code style="color:#4285f4;">' + data.flathash + '</code></div>';
                        if (data.activated_services && data.activated_services.length > 0) {
                            var svcLinks = { 'Maps': gid ? 'https://www.google.com/maps/contrib/' + gid : null, 'Photos': gid ? 'https://get.google.com/albumarchive/' + gid : null };
                            html += '<div style="font-size:8px;color:#6a8a8a;margin-top:2px;">Services: ';
                            data.activated_services.forEach(function(s) {
                                var sl = svcLinks[s] || null;
                                if (sl) html += '<a href="' + sl + '" target="_blank" style="color:#4285f4;font-size:8px;text-decoration:none;background:rgba(66,133,244,0.1);padding:0 4px;border-radius:2px;margin:0 1px;">' + s + ' ↗</a>';
                                else html += '<span style="color:#4285f4;font-size:8px;margin:0 1px;">' + s + '</span>';
                            });
                            html += '</div>';
                        }
                        if (data.youtube_channel) html += '<div style="font-size:8px;"><a href="' + data.youtube_channel + '" target="_blank" style="color:#ff0000;">▶ YouTube ↗</a></div>';
                        if (data.google_maps_url || data.google_maps) html += '<div style="font-size:8px;"><a href="' + (data.google_maps_url || data.google_maps) + '" target="_blank" style="color:#34a853;">🗺 Maps ↗</a></div>';
                        if (data.maps_reviews) html += '<div style="font-size:8px;color:#6a8a8a;">Reviews: ' + data.maps_reviews + '</div>';
                        html += '</div></details>';
                        allHtml += html;
                    }
                } catch(err) {}
                updateProgress();
                renderFinal();
            })();
        }
        
                // ── Phone scan (phone_search API) ──
        if (phone) {
            (async function() {
                try {
                    // Parse country code from phone
                    var cleanPhone = phone.replace(/^\+/, '');
                    var countryCode = '+1';
                    var phoneNum = cleanPhone;
                    if (cleanPhone.length >= 11) {
                        if (cleanPhone.startsWith('1') && cleanPhone.length === 11) { countryCode = '+1'; phoneNum = cleanPhone.substring(1); }
                        else if (cleanPhone.startsWith('44')) { countryCode = '+44'; phoneNum = cleanPhone.substring(2); }
                        else if (cleanPhone.startsWith('61')) { countryCode = '+61'; phoneNum = cleanPhone.substring(2); }
                        else if (cleanPhone.startsWith('64')) { countryCode = '+64'; phoneNum = cleanPhone.substring(2); }
                        else if (cleanPhone.startsWith('353')) { countryCode = '+353'; phoneNum = cleanPhone.substring(3); }
                        else { countryCode = '+' + cleanPhone.substring(0,1); phoneNum = cleanPhone.substring(1); }
                    }
                    var formData = new FormData();
                    formData.append('api_action', 'phone_search');
                    formData.append('phone', phoneNum);
                    formData.append('country_code', countryCode);
                    var resp = await fetch('/katsa', { method: 'POST', body: formData });
                    var data = await resp.json();
                    if (!data.error) {
                        var found = data.accounts_found || 0;
                        var results = data.results || [];
                        var html = '<details style="margin-top:4px;border:1px solid rgba(0,255,150,0.15);border-radius:3px;background:rgba(0,255,150,0.04);"><summary style="padding:4px 8px;cursor:pointer;color:#00ff96;font-size:9px;font-family:monospace;letter-spacing:1px;list-style:none;display:flex;align-items:center;gap:3px;user-select:none;"><span class="tool-chevron" style="display:inline-block;transition:transform 0.2s;font-size:7px;">▶</span> 📱 PHONE — ' + found + ' sites</summary><div style="padding:3px 6px;">';
                        if (data.cached) html += '<div style="font-size:8px;color:#00c8ff;margin-bottom:3px;">⚡ cached</div>';
                        html += '<div class="katsa-il-summary">Registered on <strong>' + found + '</strong> sites</div>';
                        if (found > 0) {
                            html += '<div class="katsa-il-sites" style="margin-top:4px;">';
                            results.forEach(function(r) {
                                var site = r.site || 'Unknown';
                                html += '<span class="katsa-il-site" style="border-color:rgba(0,255,150,0.2);color:#00ff96;">' + site + ' ✅</span>';
                            });
                            html += '</div>';
                        }
                        html += '</div></details>';
                        allHtml += html;
                    }
                } catch(err) { anyError = true; }
                updateProgress();
                renderFinal();
            })();
        }
    }

    // ── Toggle collapse/expand katsa widget ──
    function toggleKatsaWidget(widgetId, event) {
        // Don't toggle if clicking the RUN SCAN button
        if (event && event.target.closest('.katsa-inline-run')) return;
        var widget = document.getElementById(widgetId);
        if (!widget) return;
        widget.classList.toggle('collapsed');
        try {
            localStorage.setItem('katsa_collapse_' + widgetId, widget.classList.contains('collapsed') ? '1' : '0');
        } catch(e) {}
    }

    // ── Restore cached scan results + collapse state from localStorage ──
    document.addEventListener('DOMContentLoaded', function() {
        document.querySelectorAll('.katsa-inline-widget').forEach(function(widget) {
            var wid = widget.id;
            try {
                var saved = localStorage.getItem('katsa_scan_' + wid);
                if (saved) {
                    var data = JSON.parse(saved);
                    // Only restore if less than 24h old
                    if (data.html && data.ts && (Date.now() - data.ts) < 86400000) {
                        var resultsDiv = document.getElementById(wid + '_results');
                        if (resultsDiv) {
                            resultsDiv.innerHTML = data.html;
                            resultsDiv.className = 'katsa-inline-results has-results';
                        }
                        var btn = widget.querySelector('.katsa-inline-run');
                        if (btn) {
                            btn.textContent = '✅ DONE';
                            btn.style.borderColor = 'rgba(0,255,65,0.3)';
                            btn.style.color = '#00ff41';
                            btn.disabled = true;
                        }
                    } else {
                        // Expired — clean up
                        localStorage.removeItem('katsa_scan_' + wid);
                        localStorage.removeItem('katsa_collapse_' + wid);
                    }
                }
                // Restore collapse state independently — always respect user's last toggle
                var collapseState = localStorage.getItem('katsa_collapse_' + wid);
                if (collapseState === '1') {
                    widget.classList.add('collapsed');
                } else if (collapseState === '0') {
                    widget.classList.remove('collapsed');
                }
            } catch(e) {}
        });
    });

    // ── Katsa scan queue: only 1 widget scans at a time to prevent lag ──
    var katsaScanQueue = [];
    var katsaScanRunning = false;

    function queueInlineKatsa(widgetId) {
        var btn = document.querySelector('#' + widgetId + ' .katsa-inline-run');
        if (btn && btn.disabled) return; // already running or done
        if (btn) {
            btn.textContent = '⏳ QUEUED...';
            btn.disabled = true;
        }
        katsaScanQueue.push(widgetId);
        processKatsaQueue();
    }

    async function processKatsaQueue() {
        if (katsaScanRunning || katsaScanQueue.length === 0) return;
        katsaScanRunning = true;
        var widgetId = katsaScanQueue.shift();
        try {
            await runInlineKatsa(widgetId);
        } catch(e) {}
        katsaScanRunning = false;
        // Process next in queue after a short delay
        if (katsaScanQueue.length > 0) {
            setTimeout(processKatsaQueue, 300);
        }
    }

    // ════ BOOST BADGE LIVE COUNTDOWN & DECAY ════

    function _boostFmtTime(secs) {
        if (secs <= 0) return null;
        var h = Math.floor(secs / 3600);
        var m = Math.floor((secs % 3600) / 60);
        var s = Math.floor(secs % 60);
        if (h > 0) return h + 'h ' + (m > 0 ? m + 'm' : '');
        if (m > 0) return m + 'm' + (s > 0 ? ' ' + s + 's' : '');
        return s + 's';
    }

    function _boostDecayBar(frac) {
        // 4-block progress bar  ▓▓▓░ etc.
        var filled = Math.max(0, Math.round(frac * 4));
        return '\u2593'.repeat(filled) + '\u2591'.repeat(4 - filled);
    }

    function _boostUpdateBadge(badge) {
        var now    = Math.floor(Date.now() / 1000);
        var until  = parseInt(badge.getAttribute('data-boost-until') || '0', 10);
        var gTotal = parseInt(badge.getAttribute('data-goyim-total') || '0', 10);
        var timerEl = badge.querySelector('.boost-timer');
        var parent  = badge.parentElement;
        var remaining = until - now;

        // Max boost duration for this amount (same formula as PHP: secs = (G/1000)*3600)
        var maxSecs = Math.max(1, Math.round((gTotal / 1000) * 3600));
        var frac    = remaining > 0 ? Math.min(1, remaining / maxSecs) : 0;

        if (remaining > 0) {
            var timeStr = _boostFmtTime(remaining);
            var bar     = _boostDecayBar(frac);
            if (timerEl) timerEl.textContent = '\u00B7 ' + timeStr + ' ' + bar;
            badge.classList.remove('boost-expired');
            // Per-tier minimum so inferno never completely fades while active
            var tier3 = badge.classList.contains('boost-badge-3');
            var tier2 = badge.classList.contains('boost-badge-2');
            var bdFloor = tier3 ? 0.32 : tier2 ? 0.20 : 0.10;
            if (parent) parent.style.setProperty('--bd', Math.max(bdFloor, frac).toFixed(3));
        } else {
            // Boost time has elapsed — show faded expired indicator
            if (timerEl) timerEl.textContent = '\u00B7 expired';
            badge.classList.add('boost-expired');
            var expFloor = badge.classList.contains('boost-badge-3') ? 0.16 : badge.classList.contains('boost-badge-2') ? 0.10 : 0.05;
            if (parent) parent.style.setProperty('--bd', String(expFloor));
        }
    }

    function updateAllBoostBadges() {
        document.querySelectorAll('.boost-badge').forEach(_boostUpdateBadge);
    }

    // Run immediately on load, then tick every 30 seconds
    updateAllBoostBadges();
    setInterval(updateAllBoostBadges, 30000);

    // ───────────────────────────────────────────────────────────────────────────
    // Media Recorder
    // ───────────────────────────────────────────────────────────────────────────
    var _mrRec = {};

    async function mrbStartRec(formId, type) {
        if (_mrRec[formId] && _mrRec[formId].active) {
            clearInterval(_mrRec[formId].timer);
            _mrRec[formId].recorder.stop();
            return;
        }
        var micBtn = document.getElementById('mrb-mic-' + formId);
        var vidBtn = document.getElementById('mrb-vid-' + formId);
        var status = document.getElementById('mrb-status-' + formId);
        try {
            var constraints = type === 'audio'
                ? { audio: true }
                : { audio: true, video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } };
            var stream    = await navigator.mediaDevices.getUserMedia(constraints);
            /* Pick best supported mimeType; pass nothing if unsure so browser chooses */
            var _audioTypes = ['audio/webm;codecs=opus','audio/webm','audio/mp4;codecs=mp4a.40.2','audio/mp4','audio/ogg;codecs=opus','audio/ogg'];
            var _videoTypes = ['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm','video/mp4'];
            var _candidates = type === 'audio' ? _audioTypes : _videoTypes;
            var mimeType    = _candidates.find(function(t) { return MediaRecorder.isTypeSupported(t); }) || '';
            var recorder    = new MediaRecorder(stream, mimeType ? { mimeType: mimeType } : {});
            var chunks    = [];
            recorder.ondataavailable = function(e) { if (e.data.size > 0) chunks.push(e.data); };
            recorder.onstop = function() {
                stream.getTracks().forEach(function(t) { t.stop(); });
                /* Keep FULL mimeType including codecs in the blob — browsers need
                   the codec string (e.g. audio/webm;codecs=opus) to decode correctly */
                var actualMime = recorder.mimeType || mimeType || (type === 'audio' ? 'audio/webm' : 'video/webm');
                var baseType   = actualMime.split(';')[0]; // strip codecs param — for file extension detection
                var blob       = new Blob(chunks, { type: actualMime }); // keep full codec string so browser can decode
                var ext        = baseType.includes('mp4') ? (type === 'audio' ? '.m4a' : '.mp4') : baseType.includes('ogg') ? '.ogg' : '.webm';
                var fname      = type + '_' + Date.now() + ext;
                _mrbAttachBlob(formId, blob, fname, type);
                if (_mrRec[formId]) { clearInterval(_mrRec[formId].timer); _mrRec[formId].active = false; }
                var btn = type === 'audio' ? micBtn : vidBtn;
                if (btn) { btn.classList.remove('recording'); btn.innerHTML = type === 'audio' ? '🎤 Voice Note' : '🎬 Video Clip'; }
                if (status) status.classList.remove('rec-active');
            };
            recorder.start(100);
            _mrRec[formId] = { recorder: recorder, active: true };
            var activeBtn = type === 'audio' ? micBtn : vidBtn;
            if (activeBtn) { activeBtn.classList.add('recording'); activeBtn.innerHTML = (type === 'audio' ? '🎤' : '🎬') + ' ■ Stop'; }
            if (status) { status.textContent = '⏺ 00:00'; status.classList.add('rec-active'); }
            var start = Date.now();
            _mrRec[formId].timer = setInterval(function() {
                if (!_mrRec[formId] || !_mrRec[formId].active) return;
                var s = Math.floor((Date.now() - start) / 1000);
                if (status) status.textContent = '⏺ ' + String(Math.floor(s/60)).padStart(2,'0') + ':' + String(s%60).padStart(2,'0');
            }, 500);
        } catch(e) {
            if (status) { status.textContent = '⚠ ' + (e.name === 'NotAllowedError' ? 'Permission denied' : (e.message || 'Error')); }
        }
    }

    /* Shared helper: build the preview widget — uses native browser media element
       for maximum cross-platform / iOS compatibility.
       mimeHint = base mime type e.g. audio/webm or audio/mp4 */
    function _mrbMakePlayer(url, type, mimeHint) {
        var wrap = document.createElement('div');
        wrap.className = 'mrb-aplayer';
        wrap._blobUrl = url;

        var media = document.createElement(type === 'audio' ? 'audio' : 'video');
        media.controls = true;
        media.setAttribute('playsinline', '');
        media.preload = 'metadata';
        if (type === 'audio') {
            media.style.cssText = 'flex:1;min-width:0;width:100%;';
        } else {
            media.style.cssText = 'width:100%;max-height:110px;display:block;border-radius:4px;';
        }

        media.onerror = function() {
            var code = media.error ? media.error.code : 0;
            // Code 4 = browser can't decode this format locally — file still uploads fine
            media.style.display = 'none';
            var notice = document.createElement('div');
            notice.style.cssText = 'font-size:11px;padding:5px 4px;opacity:0.75;';
            notice.textContent = code === 4
                ? '✓ File attached — browser can\'t preview this format but it will upload fine'
                : '⚠ Preview error (code ' + code + ') — file may still upload';
            wrap.appendChild(notice);
        };

        wrap.appendChild(media);

        /* _init(): set src directly — setting src already triggers auto-load, no need to call load() */
        wrap._init = function() {
            media.src = url;
        };

        return wrap;
    }

    function _mrbExpandBody(formId) {
        var body = document.getElementById('mrb-body-' + formId);
        if (body && body.classList.contains('collapsed')) {
            body.classList.remove('collapsed');
            var bar = body.closest('.media-rec-bar');
            var lbl = bar ? bar.querySelector('.media-rec-bar-label') : null;
            if (lbl) lbl.classList.remove('collapsed');
        }
    }

    function _mrbAttachBlob(formId, blob, fname, type) {
        var inp = document.getElementById('mrb-pick-' + formId);
        if (inp) {
            try { var dt = new DataTransfer(); dt.items.add(new File([blob], fname, { type: blob.type })); inp.files = dt.files; } catch(e) {}
            // Always store blob directly on element — fallback for mobile Safari where inp.files= silently fails
            inp._recBlob  = blob;
            inp._recFname = fname;
        }
        _mrbExpandBody(formId);
        var prevWrap = document.getElementById('mrb-preview-' + formId);
        var status   = document.getElementById('mrb-status-' + formId);
        if (prevWrap) {
            var old = prevWrap.querySelector('.mrb-aplayer, video, .mrb-pending-notice');
            if (old) { if (old._blobUrl) URL.revokeObjectURL(old._blobUrl); else if (old.src) URL.revokeObjectURL(old.src); old.remove(); }
            var needsApproval = (type === 'audio' && REQUIRE_AUDIO_APPROVAL) || (type === 'video' && REQUIRE_VIDEO_APPROVAL);
            if (needsApproval) {
                var pending = document.createElement('div');
                pending.className = 'mrb-pending-notice';
                pending.textContent = type === 'audio' ? '⏳ Voice note queued — awaiting admin approval before visible' : '⏳ Video queued — awaiting admin approval before visible';
                prevWrap.classList.add('visible');
                prevWrap.insertBefore(pending, prevWrap.querySelector('.mrb-cancel'));
            } else {
                _mrbTempUploadThenPlay(null, blob, type, formId);
            }
        }
        if (status) { status.textContent = '\u2713 ' + (type === 'audio' ? 'Voice ready' : 'Video ready'); status.classList.remove('rec-active'); }
    }

    function _mrbTempUploadThenPlay(file, blobOrNull, type, formId) {
        var prevWrap = document.getElementById('mrb-preview-' + formId);
        if (!prevWrap) return;
        var cancel = prevWrap.querySelector('.mrb-cancel');
        var spinner = document.createElement('div');
        spinner.className = 'mrb-uploading';
        spinner.style.cssText = 'font-size:12px;padding:6px 4px;opacity:0.7;font-family:\'Courier New\',monospace;';
        spinner.textContent = '⏳ Loading preview…';
        prevWrap.insertBefore(spinner, cancel);
        prevWrap.classList.add('visible');
        var fd = new FormData();
        fd.append('file', blobOrNull ? new File([blobOrNull], 'preview.' + (type === 'audio' ? 'webm' : 'mp4'), { type: blobOrNull.type }) : file);
        fetch('?action=temp_upload', { method: 'POST', body: fd })
            .then(function(r) { return r.json(); })
            .then(function(data) {
                spinner.remove();
                if (data.url) {
                    var player = _mrbMakePlayer(data.url, type, '');
                    prevWrap.insertBefore(player, prevWrap.querySelector('.mrb-cancel'));
                    if (player._init) player._init();
                } else {
                    var errDiv = document.createElement('div');
                    errDiv.style.cssText = 'font-size:11px;padding:5px 4px;opacity:0.75;font-family:\'Courier New\',monospace;';
                    errDiv.textContent = '⚠ Preview unavailable — file will still upload';
                    prevWrap.insertBefore(errDiv, prevWrap.querySelector('.mrb-cancel'));
                }
            })
            .catch(function() {
                spinner.remove();
                var errDiv = document.createElement('div');
                errDiv.style.cssText = 'font-size:11px;padding:5px 4px;opacity:0.75;font-family:\'Courier New\',monospace;';
                errDiv.textContent = '⚠ Preview unavailable — file will still upload';
                prevWrap.insertBefore(errDiv, prevWrap.querySelector('.mrb-cancel'));
            });
    }

    function mrbPickFile(inp, formId) {
        if (!inp || !inp.files[0]) return;
        var f    = inp.files[0];
        var mime = f.type || '';
        var ext  = f.name.split('.').pop().toLowerCase();
        var isAudio = mime.startsWith('audio/') || ['mp3','ogg','wav','flac','aac','m4a'].includes(ext);
        var isVideo = mime.startsWith('video/') || ['mp4','mov','avi','mkv','webm'].includes(ext);
        if (!isAudio && !isVideo) {
            // Wrong file type — clear the input and show status error
            inp.value = '';
            var status = document.getElementById('mrb-status-' + formId);
            if (status) { status.textContent = '⚠ Use a video or audio file'; status.style.color = '#ff6b6b'; setTimeout(function(){ status.textContent = ''; status.style.color = ''; }, 4000); }
            var prevWrap = document.getElementById('mrb-preview-' + formId);
            if (prevWrap) {
                var errNotice = document.createElement('div');
                errNotice.className = 'mrb-pending-notice';
                errNotice.style.cssText = 'color:#ff6b6b;';
                errNotice.textContent = '⚠ Only video/audio files are accepted here. For images use "Add Photos".';
                var old = prevWrap.querySelector('.mrb-aplayer, video, .mrb-pending-notice, .mrb-uploading');
                if (old) old.remove();
                prevWrap.insertBefore(errNotice, prevWrap.querySelector('.mrb-cancel'));
                prevWrap.classList.add('visible');
                setTimeout(function(){ if (errNotice.parentNode) { errNotice.remove(); prevWrap.classList.remove('visible'); }}, 5000);
            }
            return;
        }
        var type = isAudio ? 'audio' : 'video';
        _mrbExpandBody(formId);
        var prevWrap = document.getElementById('mrb-preview-' + formId);
        var status   = document.getElementById('mrb-status-' + formId);
        if (prevWrap) {
            var old = prevWrap.querySelector('.mrb-aplayer, video, .mrb-pending-notice, .mrb-uploading');
            if (old) { if (old._blobUrl) URL.revokeObjectURL(old._blobUrl); old.remove(); }
            var needsApproval = (type === 'audio' && REQUIRE_AUDIO_APPROVAL) || (type === 'video' && REQUIRE_VIDEO_APPROVAL);
            if (needsApproval) {
                var pending = document.createElement('div');
                pending.className = 'mrb-pending-notice';
                pending.textContent = type === 'audio' ? '⏳ Voice note queued — awaiting admin approval before visible' : '⏳ Video queued — awaiting admin approval before visible';
                prevWrap.classList.add('visible');
                prevWrap.insertBefore(pending, prevWrap.querySelector('.mrb-cancel'));
            } else {
                _mrbTempUploadThenPlay(f, null, type, formId);
            }
        }
        if (status) status.textContent = '\u2713 ' + f.name.slice(0, 28);
    }

    function mrbCancel(formId) {
        var inp = document.getElementById('mrb-pick-' + formId);
        if (inp) { inp.value = ''; inp._recBlob = null; inp._recFname = null; }
        var prevWrap = document.getElementById('mrb-preview-' + formId);
        var status   = document.getElementById('mrb-status-' + formId);
        if (prevWrap) {
            var old = prevWrap.querySelector('.mrb-aplayer, video, .mrb-pending-notice');
            if (old) { if (old._blobUrl) URL.revokeObjectURL(old._blobUrl); else if (old.src) URL.revokeObjectURL(old.src); old.remove(); }
            prevWrap.classList.remove('visible');
        }
        if (status) { status.textContent = ''; status.classList.remove('rec-active'); }
        if (_mrRec[formId] && _mrRec[formId].active) { clearInterval(_mrRec[formId].timer); _mrRec[formId].recorder.stop(); }
        delete _mrRec[formId];
    }
    function mrbToggle(formId) {
        var body  = document.getElementById('mrb-body-' + formId);
        if (!body) return;
        var bar   = body.closest('.media-rec-bar');
        var lbl   = bar ? bar.querySelector('.media-rec-bar-label') : null;
        var closed = body.classList.toggle('collapsed');
        if (lbl) lbl.classList.toggle('collapsed', closed);
    }
    </script>
    <script src="https://cdn.jsdelivr.net/npm/ethers@5.7.2/dist/ethers.umd.min.js"></script>
    <script src="app.js?v=20260302a"></script>
</body>
</html>
