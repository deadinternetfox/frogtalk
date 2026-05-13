<?php
/**
 * Federated imageboard JSON API.
 * Routes:
 *   GET /board/api/info   → { node, version, ... }
 *   GET /board/api/peers  → { node, peers: [...] }
 *
 * Public, read-only, CORS-open (GET only). Tor-only peers are filtered from
 * clearnet visitors by getFederatedPeers().
 */
require_once __DIR__ . '/board_config.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, max-age=0');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, OPTIONS');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit;
}
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
    http_response_code(405);
    echo json_encode(['error' => 'method_not_allowed']);
    exit;
}

$uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';

if ($uri === '/board/api/info' || $uri === '/board/api/info/') {
    echo json_encode(getBoardInfo(), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

if ($uri === '/board/api/peers' || $uri === '/board/api/peers/') {
    $visitorTor = isTorRequest();
    $resp = [
        'node'  => getBoardInfo(),
        'peers' => getFederatedPeers($visitorTor),
        'visitor_tor' => $visitorTor,
        'generated_at' => time(),
    ];
    echo json_encode($resp, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

http_response_code(404);
echo json_encode(['error' => 'not_found']);
