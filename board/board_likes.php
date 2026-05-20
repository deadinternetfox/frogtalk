<?php
/**
 * Board Likes API — AJAX endpoint for like/unlike posts
 * POST: action=toggle, post_id=xxx → returns {count, liked}
 * GET:  action=get, post_id=xxx → returns {count, liked}
 */
session_start();
require_once __DIR__ . '/board_config.php';

header('Content-Type: application/json');
header('X-Content-Type-Options: nosniff');

$ipHash = getIPHash();
$ban = isIPBanned($ipHash);
if ($ban !== false) {
    echo json_encode(['error' => 'Banned']);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $action = $_POST['action'] ?? '';
    $postId = $_POST['post_id'] ?? '';
    
    if ($action === 'toggle' && !empty($postId)) {
        if (!verifyCsrfToken($_POST['csrf_token'] ?? null)) {
            http_response_code(403);
            echo json_encode(['error' => 'Invalid session']);
            exit;
        }
        // Rate limit: 1 like action per second
        $key = 'last_like_time';
        if (isset($_SESSION[$key]) && (time() - $_SESSION[$key]) < 1) {
            echo json_encode(['error' => 'Slow down']);
            exit;
        }
        $_SESSION[$key] = time();
        
        $result = toggleLike($postId);
        echo json_encode($result);
    } else {
        echo json_encode(['error' => 'Invalid request']);
    }
} elseif ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $action = $_GET['action'] ?? '';
    $postId = $_GET['post_id'] ?? '';
    
    if ($action === 'get' && !empty($postId)) {
        echo json_encode([
            'count' => getLikeCount($postId),
            'liked' => hasLiked($postId)
        ]);
    } else {
        echo json_encode(['error' => 'Invalid request']);
    }
}
