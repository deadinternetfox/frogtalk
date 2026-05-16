<?php
/**
 * Board Live Chat API — AJAX polling-based chat
 * GET  ?action=fetch&since=TIMESTAMP — get new messages
 * POST action=send, message=TEXT — send a message
 */
session_start();
header('Content-Type: application/json');
header('X-Content-Type-Options: nosniff');

require_once __DIR__ . '/board_config.php';

$settings = loadSettings();
if (!$settings['chat_enabled']) {
    echo json_encode(['error' => 'Chat is disabled']);
    exit;
}

$ipHash = getIPHash();

// Check ban
$ban = isIPBanned($ipHash);
if ($ban) {
    echo json_encode(['error' => 'You are banned: ' . ($ban['reason'] ?? 'Violation')]);
    exit;
}

$action = $_GET['action'] ?? $_POST['action'] ?? '';

if ($action === 'fetch') {
    $since = (int)($_GET['since'] ?? 0);
    $messages = loadChat();
    
    // Filter messages newer than $since
    if ($since > 0) {
        $messages = array_values(array_filter($messages, fn($m) => $m['time'] > $since));
    } else {
        // On first load, show last 50
        $messages = array_slice($messages, -50);
    }
    
    // Track this user as online (they're actively polling chat)
    trackOnlineUser();
    
    echo json_encode([
        'messages' => $messages,
        'online' => getOnlineCount(),
        'server_time' => time(),
        'my_anon_id' => getChatAnonId()
    ]);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'POST' && $action === 'send') {
    // CSRF: chat send must come from a same-origin form/JS that knows
    // the per-session token; without this an attacker page could
    // ride a logged-in admin's session to spam the live chat.
    if (!verifyCsrfToken($_POST['csrf_token'] ?? null)) {
        http_response_code(403);
        echo json_encode(['error' => 'Invalid session']);
        exit;
    }
    $message = trim($_POST['message'] ?? '');
    
    if (empty($message)) {
        echo json_encode(['error' => 'Message cannot be empty']);
        exit;
    }
    
    if (strlen($message) > 500) {
        echo json_encode(['error' => 'Message too long (max 500 chars)']);
        exit;
    }
    
    // Rate limit: 3 seconds between chat messages
    $now = time();
    if (isset($_SESSION['last_chat_time']) && ($now - $_SESSION['last_chat_time']) < 3) {
        echo json_encode(['error' => 'Slow down (3s cooldown)']);
        exit;
    }
    $_SESSION['last_chat_time'] = $now;
    
    // Auto-ban word filter
    $banWords = array_filter(array_map('trim', explode(',', $settings['auto_ban_words'] ?? '')));
    foreach ($banWords as $word) {
        if (!empty($word) && stripos($message, $word) !== false) {
            echo json_encode(['error' => 'Message contains blocked content']);
            exit;
        }
    }
    
    $messages = loadChat();
    $messages[] = [
        'id' => uniqid('c', true),
        'message' => htmlspecialchars($message, ENT_QUOTES, 'UTF-8'),
        'anonId' => getChatAnonId(),
        'time' => $now,
        'ip_hash' => $ipHash
    ];
    
    saveChat($messages);
    
    echo json_encode(['success' => true, 'server_time' => $now]);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'POST' && $action === 'voice') {
    if (!verifyCsrfToken($_POST['csrf_token'] ?? null)) {
        http_response_code(403);
        echo json_encode(['error' => 'Invalid session']);
        exit;
    }
    $now = time();
    if (isset($_SESSION['last_chat_time']) && ($now - $_SESSION['last_chat_time']) < 3) {
        echo json_encode(['error' => 'Slow down (3s cooldown)']);
        exit;
    }
    $_SESSION['last_chat_time'] = $now;

    if (empty($_FILES['audio']['tmp_name']) || $_FILES['audio']['error'] !== UPLOAD_ERR_OK) {
        echo json_encode(['error' => 'No audio received']);
        exit;
    }
    if ($_FILES['audio']['size'] > 5 * 1024 * 1024) {
        echo json_encode(['error' => 'Voice note too large (max 5MB)']);
        exit;
    }
    $finfo = finfo_open(FILEINFO_MIME_TYPE);
    $fMime = finfo_file($finfo, $_FILES['audio']['tmp_name']);
    finfo_close($finfo);
    $origMime = strtolower(explode(';', trim($_FILES['audio']['type'] ?? ''))[0]);
    $allowed = ['audio/webm','audio/ogg','audio/mp4','audio/mpeg','audio/wav','audio/x-wav','video/webm'];
    if (!in_array($fMime, $allowed) && !in_array($origMime, $allowed)) {
        echo json_encode(['error' => 'Unsupported audio format']);
        exit;
    }
    $ext = str_contains($fMime,'ogg') || str_contains($origMime,'ogg') ? '.ogg'
         : (str_contains($fMime,'mp4') || str_contains($origMime,'mp4') ? '.m4a' : '.webm');
    $filename = 'chat_' . $now . '_' . bin2hex(random_bytes(6)) . $ext;
    if (!move_uploaded_file($_FILES['audio']['tmp_name'], UPLOAD_DIR . '/' . $filename)) {
        echo json_encode(['error' => 'Upload failed']);
        exit;
    }
    $messages = loadChat();
    $messages[] = [
        'id'      => uniqid('cv', true),
        'type'    => 'voice',
        'file'    => $filename,
        'message' => '\xF0\x9F\x8E\xA4 Voice note',
        'anonId'  => getChatAnonId(),
        'time'    => $now,
        'ip_hash' => $ipHash,
    ];
    saveChat($messages);
    echo json_encode(['success' => true, 'server_time' => $now]);
    exit;
}

echo json_encode(['error' => 'Invalid action']);
