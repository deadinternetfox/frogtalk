<?php
$uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$path = __DIR__ . $uri;

if ($uri !== '/' && file_exists($path) && !is_dir($path)) {
    return false;
}

switch ($uri) {
    case '/':
        require __DIR__ . '/index.php';
        break;
    case '/board':
    case '/board/':
        require __DIR__ . '/board.php';
        break;
    case '/board/admin':
    case '/board/admin/':
        require __DIR__ . '/board_admin.php';
        break;
    case '/board/chat':
        require __DIR__ . '/board_chat.php';
        break;
    case '/board/likes':
        require __DIR__ . '/board_likes.php';
        break;
    case '/board/preview':
        require __DIR__ . '/board_preview.php';
        break;
    case '/board/api/info':
    case '/board/api/info/':
    case '/board/api/peers':
    case '/board/api/peers/':
        require __DIR__ . '/board_api.php';
        break;
    default:
        http_response_code(404);
        echo 'Not Found';
        break;
}
