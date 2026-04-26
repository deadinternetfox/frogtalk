<?php
/**
 * FrogTalk — /board/admin — Admin Panel
 * Moderation: approve images, ban users, delete posts, board settings
 */
session_start();
require_once __DIR__ . '/board_config.php';

$error = '';
$success = '';

// Handle login
if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['action'] ?? '') === 'login') {
    if (adminLogin($_POST['user'] ?? '', $_POST['pass'] ?? '')) {
        logModAction('login', 'Admin logged in');
        header('Location: /board/admin');
        exit;
    } else {
        $error = 'Invalid credentials';
    }
}

// Handle logout
if (($_GET['action'] ?? '') === 'logout') {
    unset($_SESSION['board_admin']);
    header('Location: /board/admin');
    exit;
}

// If not logged in, show login
if (!isAdminLoggedIn()) {
    showLoginPage($error);
    exit;
}

// ── Handle Admin Actions ──
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $action = $_POST['action'] ?? '';
    
    // CSRF protection for all admin actions (except login which has its own protection)
    if ($action !== 'login' && !verifyCsrfToken($_POST['csrf_token'] ?? null)) {
        $error = 'Session expired. Please refresh and try again.';
    } else {
    $settings = loadSettings();
    $threads = loadThreads();
    
    switch ($action) {
        case 'save_settings':
            $settings['require_image_approval'] = isset($_POST['require_image_approval']);
            $settings['board_locked'] = isset($_POST['board_locked']);
            $settings['chat_enabled'] = isset($_POST['chat_enabled']);
            $settings['allow_images'] = isset($_POST['allow_images']);
            $settings['allow_audio']  = isset($_POST['allow_audio']);
            $settings['allow_video']  = isset($_POST['allow_video']);
            $settings['require_audio_approval'] = isset($_POST['require_audio_approval']);
            $settings['require_video_approval'] = isset($_POST['require_video_approval']);
            $settings['rate_limit_seconds'] = max(5, min(300, (int)($_POST['rate_limit_seconds'] ?? 15)));
            $settings['threads_per_page'] = max(1, min(50, (int)($_POST['threads_per_page'] ?? 10)));
            $settings['replies_preview_count'] = max(0, min(10, (int)($_POST['replies_preview_count'] ?? 3)));
            $settings['max_media_size_mb'] = max(1, min(500, (int)($_POST['max_media_size_mb'] ?? 100)));
            $settings['op_requires'] = in_array($_POST['op_requires'] ?? '', ['any','comment','image','image_or_media','comment_and_image']) ? $_POST['op_requires'] : 'any';
            $settings['announcement'] = substr(trim($_POST['announcement'] ?? ''), 0, 500);
            $settings['auto_ban_words'] = substr(trim($_POST['auto_ban_words'] ?? ''), 0, 2000);
            saveSettings($settings);
            logModAction('settings', 'Board settings updated');
            $success = 'Settings saved.';
            break;

        case 'approve_media':
            $postId   = $_POST['post_id'] ?? '';
            $threadId = $_POST['thread_id'] ?? '';
            $isReply  = ($_POST['is_reply'] ?? '0') === '1';
            foreach ($threads as &$thread) {
                if (!$isReply && $thread['id'] === $postId) {
                    if ($thread['media'] ?? null) $thread['media']['approved'] = true;
                    $success = "Media approved for post {$postId}";
                    break;
                }
                if ($isReply || $thread['id'] === $threadId) {
                    foreach ($thread['replies'] as &$reply) {
                        if ($reply['id'] === $postId) {
                            if ($reply['media'] ?? null) $reply['media']['approved'] = true;
                            $success = "Media approved for reply {$postId}";
                            break 2;
                        }
                    } unset($reply);
                }
            } unset($thread);
            saveThreads($threads);
            logModAction('approve', "Approved media on post {$postId}");
            break;

        case 'reject_media':
            $postId   = $_POST['post_id'] ?? '';
            $threadId = $_POST['thread_id'] ?? '';
            $isReply  = ($_POST['is_reply'] ?? '0') === '1';
            foreach ($threads as &$thread) {
                if (!$isReply && $thread['id'] === $postId) {
                    if ($thread['media'] ?? null) { @unlink(UPLOAD_DIR . '/' . $thread['media']['file']); $thread['media'] = null; }
                    break;
                }
                if ($isReply || $thread['id'] === $threadId) {
                    foreach ($thread['replies'] as &$reply) {
                        if ($reply['id'] === $postId) {
                            if ($reply['media'] ?? null) { @unlink(UPLOAD_DIR . '/' . $reply['media']['file']); $reply['media'] = null; }
                            break 2;
                        }
                    } unset($reply);
                }
            } unset($thread);
            saveThreads($threads);
            logModAction('reject', "Rejected media on post {$postId}");
            $success = 'Media rejected and deleted.';
            break;
            
        case 'approve_image':
            $postId   = $_POST['post_id'] ?? '';
            $threadId = $_POST['thread_id'] ?? '';
            $isReply  = ($_POST['is_reply'] ?? '0') === '1';
            $imgIdx   = (int)($_POST['img_index'] ?? 0);
            $approvedThreadId = null;

            foreach ($threads as &$thread) {
                if (!$isReply && $thread['id'] === $postId) {
                    // Approve in images array
                    if (!empty($thread['images'][$imgIdx])) {
                        $thread['images'][$imgIdx]['approved'] = true;
                    }
                    // Sync legacy image key (always kept in sync with images[0])
                    if ($imgIdx === 0 && !empty($thread['image'])) {
                        $thread['image']['approved'] = true;
                    }
                    $approvedThreadId = $thread['id'];
                    $success = "Image {$imgIdx} approved for post {$postId}";
                    break;
                }
                if ($isReply || $thread['id'] === $threadId) {
                    foreach ($thread['replies'] as &$reply) {
                        if ($reply['id'] === $postId) {
                            if (!empty($reply['images'][$imgIdx])) {
                                $reply['images'][$imgIdx]['approved'] = true;
                            }
                            if ($imgIdx === 0 && !empty($reply['image'])) {
                                $reply['image']['approved'] = true;
                            }
                            $approvedThreadId = $thread['id'];
                            $success = "Image {$imgIdx} approved for reply {$postId}";
                            break 2;
                        }
                    } unset($reply);
                }
            } unset($thread);
            saveThreads($threads);
            if ($approvedThreadId) {
                @unlink(PREVIEW_DIR . '/og_' . $approvedThreadId . '.png');
            }
            logModAction('approve', "Approved image idx={$imgIdx} on post {$postId}");
            // Update Telegram placeholder message with the real image (only for OP image 0)
            if (!$isReply && $approvedThreadId && $imgIdx === 0) {
                try {
                    require_once __DIR__ . '/telegram_bot.php';
                    $tgBot = new PeasantHuntTelegramBot();
                    if ($tgBot->isConfigured()) {
                        foreach ($threads as $t) {
                            if ($t['id'] === $postId && !empty($t['image'])) {
                                $tgBot->updateApprovedThreadImage($postId, $t['image']);
                                break;
                            }
                        }
                    }
                } catch (Throwable $e) {
                    error_log('Telegram image update error: ' . $e->getMessage());
                }
            }
            break;
            
        case 'reject_image':
            $postId   = $_POST['post_id'] ?? '';
            $threadId = $_POST['thread_id'] ?? '';
            $isReply  = ($_POST['is_reply'] ?? '0') === '1';
            $imgIdx   = (int)($_POST['img_index'] ?? 0);

            foreach ($threads as &$thread) {
                if (!$isReply && $thread['id'] === $postId) {
                    // Remove from images array
                    if (!empty($thread['images'][$imgIdx])) {
                        $im = $thread['images'][$imgIdx];
                        @unlink(UPLOAD_DIR . '/' . ($im['file'] ?? ''));
                        @unlink(UPLOAD_DIR . '/' . ($im['thumb'] ?? ''));
                        array_splice($thread['images'], $imgIdx, 1);
                        // Re-sync legacy image key
                        $thread['image'] = $thread['images'][0] ?? null;
                    } elseif ($thread['image'] && $imgIdx === 0) {
                        @unlink(UPLOAD_DIR . '/' . $thread['image']['file']);
                        @unlink(UPLOAD_DIR . '/' . $thread['image']['thumb']);
                        $thread['image'] = null;
                    }
                    break;
                }
                if ($isReply || $thread['id'] === $threadId) {
                    foreach ($thread['replies'] as &$reply) {
                        if ($reply['id'] === $postId) {
                            if (!empty($reply['images'][$imgIdx])) {
                                $im = $reply['images'][$imgIdx];
                                @unlink(UPLOAD_DIR . '/' . ($im['file'] ?? ''));
                                @unlink(UPLOAD_DIR . '/' . ($im['thumb'] ?? ''));
                                array_splice($reply['images'], $imgIdx, 1);
                                $reply['image'] = $reply['images'][0] ?? null;
                            } elseif ($reply['image'] && $imgIdx === 0) {
                                @unlink(UPLOAD_DIR . '/' . $reply['image']['file']);
                                @unlink(UPLOAD_DIR . '/' . $reply['image']['thumb']);
                                $reply['image'] = null;
                            }
                            break 2;
                        }
                    } unset($reply);
                }
            } unset($thread);
            saveThreads($threads);
            logModAction('reject', "Rejected image idx={$imgIdx} on post {$postId}");
            $success = 'Image rejected and deleted.';
            break;
            
        case 'delete_post':
            $postId = $_POST['post_id'] ?? '';
            $threadId = $_POST['thread_id'] ?? '';
            $isThread = ($_POST['is_thread'] ?? '0') === '1';
            
            if ($isThread) {
                $threads = array_values(array_filter($threads, function($t) use ($postId) {
                    if ($t['id'] === $postId) {
                        // Delete all associated images
                        if ($t['image']) {
                            @unlink(UPLOAD_DIR . '/' . $t['image']['file']);
                            @unlink(UPLOAD_DIR . '/' . $t['image']['thumb']);
                        }
                        foreach ($t['replies'] ?? [] as $r) {
                            if ($r['image'] ?? null) {
                                @unlink(UPLOAD_DIR . '/' . $r['image']['file']);
                                @unlink(UPLOAD_DIR . '/' . $r['image']['thumb']);
                            }
                        }
                        return false;
                    }
                    return true;
                }));
                $success = "Thread {$postId} deleted.";
                // Delete Telegram new-thread notification if one was sent
                try {
                    require_once __DIR__ . '/telegram_bot.php';
                    $tgBot = new PeasantHuntTelegramBot();
                    if ($tgBot->isConfigured()) {
                        $tgBot->deleteThreadNotification($postId);
                    }
                } catch (Throwable $e) {
                    error_log('Telegram delete notification error: ' . $e->getMessage());
                }
            } else {
                foreach ($threads as &$thread) {
                    if ($thread['id'] === $threadId) {
                        $thread['replies'] = array_values(array_filter($thread['replies'], function($r) use ($postId) {
                            if ($r['id'] === $postId) {
                                if ($r['image'] ?? null) {
                                    @unlink(UPLOAD_DIR . '/' . $r['image']['file']);
                                    @unlink(UPLOAD_DIR . '/' . $r['image']['thumb']);
                                }
                                return false;
                            }
                            return true;
                        }));
                        break;
                    }
                }
                unset($thread);
                $success = "Reply {$postId} deleted.";
            }
            saveThreads($threads);
            logModAction('delete', "Deleted " . ($isThread ? "thread" : "reply") . " {$postId}");
            break;
            
        case 'ban_user':
            $ipInput = trim($_POST['ip_hash'] ?? '');
            // Accept plain IP addresses — hash them server-side exactly like getIPHash()
            $ipHash = filter_var($ipInput, FILTER_VALIDATE_IP) ? md5($ipInput) : $ipInput;
            $reason = trim($_POST['reason'] ?? 'Violation of board rules');
            $duration = (int)($_POST['duration'] ?? 0); // hours, 0 = permanent
            $expires = $duration > 0 ? time() + ($duration * 3600) : 0;
            
            $bans = loadBans();
            $bans[] = [
                'ip_hash' => $ipHash,
                'reason' => htmlspecialchars(substr($reason, 0, 500)),
                'time' => time(),
                'expires' => $expires,
                'duration_label' => $duration > 0 ? "{$duration}h" : 'permanent'
            ];
            saveBans($bans);
            logModAction('ban', "Banned IP hash {$ipHash}: {$reason}");
            $success = "User banned.";
            break;
            
        case 'unban':
            $ipHash = $_POST['ip_hash'] ?? '';
            $bans = loadBans();
            $bans = array_values(array_filter($bans, fn($b) => $b['ip_hash'] !== $ipHash));
            saveBans($bans);
            logModAction('unban', "Unbanned IP hash {$ipHash}");
            $success = "User unbanned.";
            break;
            
        case 'clear_chat':
            saveChat([]);
            logModAction('clear_chat', 'Chat history cleared');
            $success = 'Chat cleared.';
            break;
            
        case 'sticky_thread':
            $postId = $_POST['post_id'] ?? '';
            foreach ($threads as &$thread) {
                if ($thread['id'] === $postId) {
                    $thread['sticky'] = !($thread['sticky'] ?? false);
                    $success = $thread['sticky'] ? 'Thread pinned.' : 'Thread unpinned.';
                    break;
                }
            }
            unset($thread);
            saveThreads($threads);
            logModAction('sticky', "Toggled sticky on thread {$postId}");
            break;
            
        case 'lock_thread':
            $postId = $_POST['post_id'] ?? '';
            foreach ($threads as &$thread) {
                if ($thread['id'] === $postId) {
                    $thread['locked'] = !($thread['locked'] ?? false);
                    $success = $thread['locked'] ? 'Thread locked.' : 'Thread unlocked.';
                    break;
                }
            }
            unset($thread);
            saveThreads($threads);
            logModAction('lock', "Toggled lock on thread {$postId}");
            break;

        case 'fulfil_order':
        case 'update_order_status': {
            $orderId  = strtoupper(preg_replace('/[^A-Z0-9]/', '', $_POST['order_id'] ?? ''));
            $newSt    = in_array($_POST['new_status'] ?? '', ['pending','approved','processing','fulfilled','denied'])
                        ? $_POST['new_status'] : 'fulfilled';
            $cardCode = trim($_POST['card_code'] ?? '');
            $notes    = substr(trim($_POST['notes'] ?? ''), 0, 500);
            $ordFile  = __DIR__ . '/board_data/goyim_card_orders.json';
            $ords = file_exists($ordFile) ? json_decode(file_get_contents($ordFile), true) : [];
            foreach ($ords as &$o) {
                if (($o['order_id'] ?? '') === $orderId) {
                    $o['status'] = $newSt;
                    if ($cardCode) $o['card_code'] = $cardCode;
                    if ($notes)    $o['notes']     = $notes;
                    if ($newSt === 'fulfilled') $o['fulfilled_at'] = time();
                    $success = "Order {$orderId} → {$newSt}.";
                    break;
                }
            } unset($o);
            file_put_contents($ordFile, json_encode($ords, JSON_PRETTY_PRINT));
            logModAction('update_order_status', "Card order {$orderId} status → {$newSt}");
            break;
        }

        case 'fulfil_withdrawal':
        case 'update_withdrawal_status': {
            $wid     = strtoupper(preg_replace('/[^A-Z0-9]/', '', $_POST['withdrawal_id'] ?? ''));
            $newSt   = in_array($_POST['new_status'] ?? '', ['pending','approved','processing','processed','denied'])
                       ? $_POST['new_status'] : 'processed';
            $ref     = trim($_POST['transfer_ref'] ?? '');
            $notes   = substr(trim($_POST['notes'] ?? ''), 0, 500);
            $wFile   = __DIR__ . '/board_data/goyim_withdrawals.json';
            $ws = file_exists($wFile) ? json_decode(file_get_contents($wFile), true) : [];
            foreach ($ws as &$w) {
                if (($w['withdrawal_id'] ?? '') === $wid) {
                    $w['status'] = $newSt;
                    if ($ref)   $w['transfer_ref'] = $ref;
                    if ($notes) $w['notes']        = $notes;
                    if (in_array($newSt, ['processed','denied'])) $w['processed_at'] = time();
                    $success = "Withdrawal {$wid} → {$newSt}.";
                    break;
                }
            } unset($w);
            file_put_contents($wFile, json_encode($ws, JSON_PRETTY_PRINT));
            logModAction('update_withdrawal_status', "Withdrawal {$wid} status → {$newSt}");
            break;
        }
    }
    } // end CSRF check else
    
    // If a return URL was provided (inline approve/reject from board), redirect back there
    $returnUrl = $_POST['return_url'] ?? '';
    if (!empty($returnUrl) && str_starts_with($returnUrl, '/board')) {
        header('Location: ' . $returnUrl);
        exit;
    }
}

// ── Load Data ──
$settings = loadSettings();
$threads = loadThreads();
$bans = loadBans();
$modlog = file_exists(DATA_DIR . '/modlog.json') ? json_decode(file_get_contents(DATA_DIR . '/modlog.json'), true) : [];

// Count stats
$totalPosts = count($threads);
foreach ($threads as $t) $totalPosts += count($t['replies'] ?? []);
$pendingImages = 0;
$pendingMedia  = 0;
foreach ($threads as $t) {
    if (!empty($t['images']) && is_array($t['images'])) {
        foreach ($t['images'] as $im) { if (!($im['approved'] ?? true)) $pendingImages++; }
    } elseif (($t['image'] ?? null) && !($t['image']['approved'] ?? true)) {
        $pendingImages++;
    }
    if (($t['media'] ?? null) && !($t['media']['approved'] ?? true)) $pendingMedia++;
    foreach ($t['replies'] ?? [] as $r) {
        if (!empty($r['images']) && is_array($r['images'])) {
            foreach ($r['images'] as $im) { if (!($im['approved'] ?? true)) $pendingImages++; }
        } elseif (($r['image'] ?? null) && !($r['image']['approved'] ?? true)) {
            $pendingImages++;
        }
        if (($r['media'] ?? null) && !($r['media']['approved'] ?? true)) $pendingMedia++;
    }
}
$pendingTotal = $pendingImages + $pendingMedia;
$activeBans = 0;
foreach ($bans as $b) {
    if ($b['expires'] === 0 || $b['expires'] > time()) $activeBans++;
}

$tab = $_GET['tab'] ?? 'overview';

// Load orders/withdrawals for orders tab
$cardOrdersFile  = DATA_DIR . '/goyim_card_orders.json';
$withdrawalsFile = DATA_DIR . '/goyim_withdrawals.json';
$cardOrders  = file_exists($cardOrdersFile)  ? (json_decode(file_get_contents($cardOrdersFile),  true) ?: []) : [];
$withdrawals = file_exists($withdrawalsFile) ? (json_decode(file_get_contents($withdrawalsFile), true) ?: []) : [];
$pendingOrders      = count(array_filter($cardOrders,  fn($o) => in_array($o['status'] ?? '', ['pending','approved','processing'])));
$pendingWithdrawals = count(array_filter($withdrawals, fn($w) => in_array($w['status'] ?? '', ['pending','approved','processing'])));

?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin Panel — /board/</title>
    <meta name="robots" content="noindex, nofollow">
    <link rel="icon" type="image/x-icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🔧</text></svg>">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: #0a0e0a; color: #b0ffb0; font-family: 'Courier New', monospace; font-size: 13px; min-height: 100vh; }
        a { color: #00aaff; text-decoration: none; }
        a:hover { text-decoration: underline; }
        
        .admin-layout { display: flex; min-height: 100vh; }
        
        /* Sidebar */
        .sidebar {
            width: 220px;
            background: rgba(0,0,0,0.6);
            border-right: 1px solid rgba(0,255,65,0.15);
            padding: 20px 0;
            flex-shrink: 0;
        }
        .sidebar-brand {
            padding: 0 20px 20px;
            border-bottom: 1px solid rgba(0,255,65,0.1);
            margin-bottom: 15px;
        }
        .sidebar-brand h2 { color: #00ff41; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; }
        .sidebar-brand p { color: #3a6f3a; font-size: 11px; margin-top: 4px; }
        
        .sidebar-nav a {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px 20px;
            color: #6baf6b;
            text-decoration: none;
            font-size: 12px;
            transition: all 0.2s;
            border-left: 3px solid transparent;
        }
        .sidebar-nav a:hover { background: rgba(0,255,65,0.05); color: #00ff41; text-decoration: none; }
        .sidebar-nav a.active { border-left-color: #00ff41; background: rgba(0,255,65,0.08); color: #00ff41; }
        .sidebar-nav .badge {
            background: #ff4444;
            color: white;
            font-size: 10px;
            padding: 1px 6px;
            border-radius: 10px;
            margin-left: auto;
        }
        .sidebar-nav .badge.green { background: #00ff41; color: #0a0e0a; }
        
        /* Main content */
        .admin-main { flex: 1; padding: 25px; overflow-x: auto; }
        
        .page-header { margin-bottom: 25px; }
        .page-header h1 { color: #00ff41; font-size: 18px; margin-bottom: 5px; }
        .page-header p { color: #4a8f4a; font-size: 12px; }
        
        /* Cards */
        .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 15px; margin-bottom: 25px; }
        .stat-card {
            background: rgba(0,0,0,0.4);
            border: 1px solid rgba(0,255,65,0.15);
            border-radius: 8px;
            padding: 18px;
        }
        .stat-card .label { color: #4a8f4a; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; }
        .stat-card .value { color: #00ff41; font-size: 24px; margin-top: 5px; }
        .stat-card .sub { color: #3a6f3a; font-size: 11px; margin-top: 3px; }
        
        /* Forms */
        .admin-form { max-width: 600px; }
        .form-group { margin-bottom: 15px; }
        .form-group label { display: block; color: #6baf6b; font-size: 12px; margin-bottom: 5px; text-transform: uppercase; letter-spacing: 0.5px; }
        .form-group input[type="text"],
        .form-group input[type="password"],
        .form-group input[type="number"],
        .form-group textarea,
        .form-group select {
            width: 100%;
            background: rgba(0,255,65,0.04);
            border: 1px solid rgba(0,255,65,0.2);
            border-radius: 4px;
            color: #b0ffb0;
            font-family: 'Courier New', monospace;
            font-size: 13px;
            padding: 8px 12px;
        }
        .form-group input:focus, .form-group textarea:focus, .form-group select:focus {
            outline: none; border-color: #00ff41; box-shadow: 0 0 5px rgba(0,255,65,0.2);
        }
        .form-group textarea { min-height: 80px; resize: vertical; }
        .form-group .hint { color: #3a6f3a; font-size: 11px; margin-top: 3px; }
        
        .checkbox-row {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 0;
        }
        .checkbox-row input[type="checkbox"] { accent-color: #00ff41; width: 16px; height: 16px; }
        .checkbox-row label { color: #b0ffb0; font-size: 13px; margin: 0; text-transform: none; letter-spacing: 0; }
        
        .btn {
            display: inline-block;
            padding: 8px 18px;
            border: none;
            border-radius: 4px;
            font-family: 'Courier New', monospace;
            font-weight: bold;
            font-size: 12px;
            cursor: pointer;
            transition: all 0.2s;
        }
        .btn-green { background: #00ff41; color: #0a0e0a; }
        .btn-green:hover { box-shadow: 0 0 15px rgba(0,255,65,0.4); }
        .btn-red { background: #ff4444; color: white; }
        .btn-red:hover { box-shadow: 0 0 15px rgba(255,68,68,0.4); }
        .btn-orange { background: #ff8c00; color: white; }
        .btn-orange:hover { box-shadow: 0 0 15px rgba(255,140,0,0.4); }
        .btn-sm { padding: 4px 10px; font-size: 11px; }
        
        /* Tables */
        .admin-table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
        .admin-table th {
            text-align: left;
            padding: 8px 12px;
            border-bottom: 2px solid rgba(0,255,65,0.2);
            color: #00ff41;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .admin-table td {
            padding: 8px 12px;
            border-bottom: 1px solid rgba(0,255,65,0.06);
            font-size: 12px;
        }
        .admin-table tr:hover td { background: rgba(0,255,65,0.03); }
        
        /* Alerts */
        .alert { padding: 10px 15px; border-radius: 6px; margin-bottom: 15px; font-size: 12px; }
        .alert-success { background: rgba(0,255,65,0.08); border: 1px solid rgba(0,255,65,0.2); color: #33ff33; }
        .alert-error { background: rgba(255,0,0,0.08); border: 1px solid rgba(255,0,0,0.2); color: #ff6b6b; }
        
        /* Image queue */
        .image-queue-item {
            display: flex;
            gap: 15px;
            padding: 12px;
            background: rgba(0,0,0,0.3);
            border: 1px solid rgba(0,255,65,0.1);
            border-radius: 6px;
            margin-bottom: 10px;
            align-items: flex-start;
        }
        .image-queue-item img {
            max-width: 150px;
            max-height: 150px;
            border: 1px solid rgba(0,255,65,0.2);
            border-radius: 3px;
        }
        .image-queue-meta { flex: 1; }
        .image-queue-actions { display: flex; gap: 8px; margin-top: 8px; }
        
        /* Scrollable log */
        .log-container {
            max-height: 400px;
            overflow-y: auto;
            background: rgba(0,0,0,0.3);
            border: 1px solid rgba(0,255,65,0.1);
            border-radius: 6px;
            padding: 10px;
        }
        .log-entry { padding: 4px 0; border-bottom: 1px solid rgba(0,255,65,0.04); font-size: 11px; }
        .log-entry .log-time { color: #3a6f3a; }
        .log-entry .log-action { color: #00ff41; font-weight: bold; }
        
        /* Thread management rows */
        .thread-row {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 8px 12px;
            background: rgba(0,0,0,0.2);
            border: 1px solid rgba(0,255,65,0.06);
            border-radius: 4px;
            margin-bottom: 6px;
        }
        .thread-row .thread-info { flex: 1; }
        .thread-row .thread-badges span {
            display: inline-block;
            font-size: 10px;
            padding: 1px 6px;
            border-radius: 3px;
            margin-left: 5px;
        }
        .badge-sticky { background: #ff8c00; color: white; }
        .badge-locked { background: #ff4444; color: white; }
        
        @media (max-width: 768px) {
            .admin-layout { flex-direction: column; }

            /* ── Sidebar becomes top nav bar ── */
            .sidebar { width: 100%; border-right: none; border-bottom: 1px solid rgba(0,255,65,0.15); padding: 10px 0; }
            .sidebar-brand { padding: 0 12px 10px; margin-bottom: 8px; }
            .sidebar-brand h2 { font-size: 12px; }
            .sidebar-brand p { display: none; }
            .sidebar-nav { display: flex; flex-wrap: wrap; gap: 0; padding: 0 8px; overflow-x: auto; -webkit-overflow-scrolling: touch; }
            .sidebar-nav a { padding: 8px 11px; border-left: none; border-bottom: 2px solid transparent; font-size: 11px; white-space: nowrap; gap: 5px; }
            .sidebar-nav a.active { border-bottom-color: #00ff41; border-left: none; background: rgba(0,255,65,0.08); }
            .sidebar-nav a[style*="margin-top"] { margin-top: 0 !important; }

            /* ── Main content ── */
            .admin-main { padding: 14px 12px; }
            .page-header { margin-bottom: 16px; }
            .page-header h1 { font-size: 15px; }

            /* ── Stat grid ── */
            .stat-grid { grid-template-columns: repeat(2, 1fr); gap: 10px; margin-bottom: 16px; }
            .stat-card { padding: 12px; }
            .stat-card .value { font-size: 18px; }

            /* ── Tables: horizontal scroll on mobile ── */
            .admin-table { display: block; overflow-x: auto; -webkit-overflow-scrolling: touch; white-space: nowrap; }
            .admin-table th, .admin-table td { padding: 7px 10px; font-size: 11px; white-space: nowrap; }

            /* ── Action buttons in tables ── */
            .admin-table .btn { padding: 5px 8px; font-size: 10px; }

            /* ── Image queue items ── */
            .image-queue-item { flex-direction: column; gap: 10px; }
            .image-queue-item img { max-width: 100%; max-height: 200px; width: 100%; object-fit: contain; }
            .image-queue-actions { flex-wrap: wrap; gap: 8px; }
            .image-queue-actions .btn { flex: 1; min-width: 0; text-align: center; padding: 10px 8px; font-size: 12px; }

            /* ── Thread rows ── */
            .thread-row { flex-wrap: wrap; gap: 8px; align-items: flex-start; }
            .thread-row .thread-info { width: 100%; }
            .thread-row .thread-badges { display: flex; flex-wrap: wrap; gap: 4px; }
            .thread-row form { flex-shrink: 0; }
            .thread-row .btn { padding: 6px 10px; font-size: 11px; }

            /* ── Forms ── */
            .admin-form { max-width: 100%; }
            .form-group input, .form-group textarea, .form-group select { font-size: 16px !important; padding: 10px; }
            .btn { padding: 10px 16px; font-size: 12px; }
            .btn-sm { padding: 6px 10px; font-size: 11px; }

            /* ── Alerts ── */
            .alert { font-size: 12px; padding: 10px 12px; }
        }

        @media (max-width: 420px) {
            .stat-grid { grid-template-columns: 1fr 1fr; gap: 8px; }
            .admin-main { padding: 10px 8px; }
            .sidebar-nav a { padding: 7px 9px; font-size: 10px; }
        }
    </style>
</head>
<body>
    <div class="admin-layout">
        <nav class="sidebar">
            <div class="sidebar-brand">
                <h2>🔧 ADMIN PANEL</h2>
                <p>/board/ moderation</p>
            </div>
            <div class="sidebar-nav">
                <a href="?tab=overview" class="<?= $tab === 'overview' ? 'active' : '' ?>">📊 Overview</a>
                <a href="?tab=queue" class="<?= $tab === 'queue' ? 'active' : '' ?>">
                    📥 Media Queue
                    <?php if ($pendingTotal > 0): ?><span class="badge"><?= $pendingTotal ?></span><?php endif; ?>
                </a>
                <a href="?tab=threads" class="<?= $tab === 'threads' ? 'active' : '' ?>">📋 Threads</a>
                <a href="?tab=bans" class="<?= $tab === 'bans' ? 'active' : '' ?>">
                    🔨 Bans
                    <span class="badge green"><?= $activeBans ?></span>
                </a>
                <a href="?tab=settings" class="<?= $tab === 'settings' ? 'active' : '' ?>">⚙️ Settings</a>
                <a href="?tab=modlog" class="<?= $tab === 'modlog' ? 'active' : '' ?>">📜 Mod Log</a>
                <a href="?tab=orders" class="<?= $tab === 'orders' ? 'active' : '' ?>">
                    💳 Orders<?php if ($pendingOrders + $pendingWithdrawals > 0): ?> <span class="badge"><?= $pendingOrders + $pendingWithdrawals ?></span><?php endif; ?>
                </a>
                <a href="?action=logout" style="margin-top: 20px; color: #ff6b6b;">🚪 Logout</a>
                <a href="/board" style="color: #4a8f4a;">← Back to Board</a>
            </div>
        </nav>
        
        <main class="admin-main">
            <?php if ($success): ?><div class="alert alert-success">✅ <?= htmlspecialchars($success) ?></div><?php endif; ?>
            <?php if ($error): ?><div class="alert alert-error">⚠️ <?= htmlspecialchars($error) ?></div><?php endif; ?>
            
            <?php if ($tab === 'overview'): ?>
                <div class="page-header">
                    <h1>Dashboard</h1>
                    <p>Board overview and quick stats</p>
                </div>
                <div class="stat-grid">
                    <div class="stat-card">
                        <div class="label">Total Threads</div>
                        <div class="value"><?= count($threads) ?></div>
                    </div>
                    <div class="stat-card">
                        <div class="label">Total Posts</div>
                        <div class="value"><?= $totalPosts ?></div>
                    </div>
                    <div class="stat-card">
                        <div class="label">Pending Images</div>
                        <div class="value" style="color: <?= $pendingImages > 0 ? '#ff8c00' : '#00ff41' ?>"><?= $pendingImages ?></div>
                    </div>
                    <div class="stat-card">
                        <div class="label">Pending Media</div>
                        <div class="value" style="color: <?= $pendingMedia > 0 ? '#ff8c00' : '#00ff41' ?>"><?= $pendingMedia ?></div>
                    </div>
                    <div class="stat-card">
                        <div class="label">Active Bans</div>
                        <div class="value"><?= $activeBans ?></div>
                    </div>
                    <div class="stat-card">
                        <?php
                            $_imgReq   = $settings['require_image_approval'] ?? false;
                            $_audReq   = $settings['require_audio_approval'] ?? false;
                            $_vidReq   = $settings['require_video_approval'] ?? true;
                            $_modTypes = array_filter(['Images' => $_imgReq, 'Audio' => $_audReq, 'Video' => $_vidReq]);
                            $_modAll   = $_imgReq && $_audReq && $_vidReq;
                            $_modNone  = !$_imgReq && !$_audReq && !$_vidReq;
                        ?>
                        <div class="label">Media Approval</div>
                        <?php if ($_modNone): ?>
                            <div class="value" style="font-size: 16px; color: #00ff41;">AUTO</div>
                        <?php else: ?>
                            <div class="value" style="font-size: 13px; color: #c97a2a;">REQUIRED</div>
                            <div style="font-size: 10px; color: #b87a00; font-family: 'Courier New', monospace; margin-top: 3px; letter-spacing: 0.5px;"><?= implode(' · ', array_keys($_modTypes)) ?></div>
                        <?php endif; ?>
                    </div>
                    <div class="stat-card">
                        <div class="label">Board Status</div>
                        <div class="value" style="font-size: 16px; color: <?= $settings['board_locked'] ? '#ff4444' : '#00ff41' ?>">
                            <?= $settings['board_locked'] ? 'LOCKED' : 'OPEN' ?>
                        </div>
                    </div>
                </div>
                
                <h3 style="color: #00ff41; margin-bottom: 10px;">Recent Mod Actions</h3>
                <div class="log-container">
                    <?php foreach (array_reverse(array_slice($modlog, -20)) as $entry): ?>
                        <div class="log-entry">
                            <span class="log-time"><?= date('m/d H:i:s', $entry['time']) ?></span>
                            <span class="log-action">[<?= strtoupper($entry['action']) ?>]</span>
                            <?= htmlspecialchars($entry['details']) ?>
                        </div>
                    <?php endforeach; ?>
                    <?php if (empty($modlog)): ?>
                        <div style="color: #3a6f3a; padding: 20px; text-align: center;">No mod actions yet.</div>
                    <?php endif; ?>
                </div>

            <?php elseif ($tab === 'queue'): ?>
                <div class="page-header">
                    <h1>📥 Media Queue</h1>
                    <p><?= $pendingImages ?> image(s) · <?= $pendingMedia ?> audio/video awaiting approval</p>
                </div>

                <?php 
                $anyMediaApproval = ($settings['require_audio_approval'] ?? false) || ($settings['require_video_approval'] ?? true);
                if (!$settings['require_image_approval'] && !$anyMediaApproval): ?>
                    <div class="alert alert-success">ℹ️ All approval settings are disabled — uploads auto-approved. Configure in <a href="?tab=settings">Settings</a>.</div>
                <?php elseif (!$settings['require_image_approval']): ?>
                    <div class="alert alert-success">ℹ️ Image approval is disabled (audio/video may still be moderated).</div>
                <?php elseif (!$anyMediaApproval): ?>
                    <div class="alert alert-success">ℹ️ Audio/video approval is disabled (images still moderated).</div>
                <?php endif; ?>

                <?php
                $hasPending = false;
                foreach ($threads as $thread):
                    // ── Pending OP images (new images[] array + legacy image fallback)
                    $opImgs = (!empty($thread['images']) && is_array($thread['images'])) ? $thread['images'] : [];
                    if (empty($opImgs) && !empty($thread['image'])) $opImgs = [$thread['image']];
                    foreach ($opImgs as $imgIdx => $opImg):
                        if ($opImg['approved'] ?? true) continue;
                        $hasPending = true;
                ?>
                    <div class="image-queue-item">
                        <img src="/board_uploads/<?= htmlspecialchars($opImg['thumb'] ?? '', ENT_QUOTES, 'UTF-8') ?>" alt="pending">
                        <div class="image-queue-meta">
                            <div><strong style="color:#00ff41">🖼️ Image <?= count($opImgs) > 1 ? ($imgIdx+1).'/'.count($opImgs) : '' ?> — Thread OP</strong> No.<?= htmlspecialchars($thread['id'], ENT_QUOTES, 'UTF-8') ?></div>
                            <div style="color:#4a8f4a;font-size:11px"><?= htmlspecialchars($opImg['origName'] ?? 'unknown', ENT_QUOTES, 'UTF-8') ?> · <?= formatFileSize($opImg['size'] ?? 0) ?> · <?= date('m/d H:i', $thread['time']) ?></div>
                            <div style="color:#6baf6b;margin-top:5px;font-size:12px"><?= htmlspecialchars(substr($thread['comment'], 0, 100), ENT_QUOTES, 'UTF-8') ?>...</div>
                            <div class="image-queue-actions">
                                <form method="POST" style="display:inline"><input type="hidden" name="action" value="approve_image"><input type="hidden" name="post_id" value="<?= htmlspecialchars($thread['id'], ENT_QUOTES, 'UTF-8') ?>"><input type="hidden" name="img_index" value="<?= (int)$imgIdx ?>"><input type="hidden" name="is_reply" value="0"><button class="btn btn-green btn-sm">✅ Approve</button></form>
                                <form method="POST" style="display:inline" onsubmit="return confirm('Delete this image?')"><input type="hidden" name="action" value="reject_image"><input type="hidden" name="post_id" value="<?= htmlspecialchars($thread['id'], ENT_QUOTES, 'UTF-8') ?>"><input type="hidden" name="img_index" value="<?= (int)$imgIdx ?>"><input type="hidden" name="is_reply" value="0"><button class="btn btn-red btn-sm">❌ Reject</button></form>
                            </div>
                        </div>
                    </div>
                    <?php endforeach; ?>

                    <?php // ── Pending OP media
                    if (($thread['media'] ?? null) && !($thread['media']['approved'] ?? true)):
                        $hasPending = true;
                        $isAudio = ($thread['media']['type'] ?? '') === 'audio';
                    ?>
                    <div class="image-queue-item">
                        <div style="width:80px;height:80px;display:flex;align-items:center;justify-content:center;background:rgba(0,255,65,0.05);border:1px solid rgba(0,255,65,0.15);border-radius:4px;font-size:2em;flex-shrink:0"><?= $isAudio ? '🎤' : '🎬' ?></div>
                        <div class="image-queue-meta">
                            <div><strong style="color:#00ff41"><?= $isAudio ? '🎤 Voice Note' : '🎬 Video Clip' ?> — Thread OP</strong> No.<?= htmlspecialchars($thread['id'], ENT_QUOTES, 'UTF-8') ?></div>
                            <div style="color:#4a8f4a;font-size:11px"><?= htmlspecialchars($thread['media']['origName'] ?? 'unknown', ENT_QUOTES, 'UTF-8') ?> · <?= formatFileSize($thread['media']['size'] ?? 0) ?> · <?= date('m/d H:i', $thread['time']) ?></div>
                            <div style="color:#6baf6b;margin-top:5px;font-size:12px"><?= htmlspecialchars(substr($thread['comment'], 0, 100), ENT_QUOTES, 'UTF-8') ?>...</div>
                            <div style="margin:6px 0">
                                <?php if ($isAudio): ?>
                                <audio controls src="/board_uploads/<?= htmlspecialchars($thread['media']['file'], ENT_QUOTES, 'UTF-8') ?>" style="height:28px;max-width:300px"></audio>
                                <?php else: ?>
                                <video controls src="/board_uploads/<?= htmlspecialchars($thread['media']['file'], ENT_QUOTES, 'UTF-8') ?>" style="max-height:100px;max-width:300px"></video>
                                <?php endif; ?>
                            </div>
                            <div class="image-queue-actions">
                                <form method="POST" style="display:inline"><input type="hidden" name="action" value="approve_media"><input type="hidden" name="post_id" value="<?= htmlspecialchars($thread['id'], ENT_QUOTES, 'UTF-8') ?>"><input type="hidden" name="is_reply" value="0"><button class="btn btn-green btn-sm">✅ Approve</button></form>
                                <form method="POST" style="display:inline" onsubmit="return confirm('Delete this media file?')"><input type="hidden" name="action" value="reject_media"><input type="hidden" name="post_id" value="<?= htmlspecialchars($thread['id'], ENT_QUOTES, 'UTF-8') ?>"><input type="hidden" name="is_reply" value="0"><button class="btn btn-red btn-sm">❌ Reject</button></form>
                            </div>
                        </div>
                    </div>
                    <?php endif; ?>

                    <?php foreach ($thread['replies'] ?? [] as $reply): ?>
                    <?php
                        // ── Pending reply images
                        $rImgs = (!empty($reply['images']) && is_array($reply['images'])) ? $reply['images'] : [];
                        if (empty($rImgs) && !empty($reply['image'])) $rImgs = [$reply['image']];
                        foreach ($rImgs as $imgIdx => $rImg):
                            if ($rImg['approved'] ?? true) continue;
                            $hasPending = true;
                    ?>
                    <div class="image-queue-item">
                        <img src="/board_uploads/<?= htmlspecialchars($rImg['thumb'] ?? '', ENT_QUOTES, 'UTF-8') ?>" alt="pending">
                        <div class="image-queue-meta">
                            <div><strong style="color:#6baf6b">🖼️ Image <?= count($rImgs) > 1 ? ($imgIdx+1).'/'.count($rImgs) : '' ?> — Reply</strong> in thread <?= htmlspecialchars($thread['id'], ENT_QUOTES, 'UTF-8') ?> — No.<?= htmlspecialchars($reply['id'], ENT_QUOTES, 'UTF-8') ?></div>
                            <div style="color:#4a8f4a;font-size:11px"><?= htmlspecialchars($rImg['origName'] ?? 'unknown', ENT_QUOTES, 'UTF-8') ?> · <?= formatFileSize($rImg['size'] ?? 0) ?> · <?= date('m/d H:i', $reply['time']) ?></div>
                            <div style="color:#6baf6b;margin-top:5px;font-size:12px"><?= htmlspecialchars(substr($reply['comment'], 0, 100), ENT_QUOTES, 'UTF-8') ?>...</div>
                            <div class="image-queue-actions">
                                <form method="POST" style="display:inline"><input type="hidden" name="action" value="approve_image"><input type="hidden" name="post_id" value="<?= htmlspecialchars($reply['id'], ENT_QUOTES, 'UTF-8') ?>"><input type="hidden" name="img_index" value="<?= (int)$imgIdx ?>"><input type="hidden" name="thread_id" value="<?= htmlspecialchars($thread['id'], ENT_QUOTES, 'UTF-8') ?>"><input type="hidden" name="is_reply" value="1"><button class="btn btn-green btn-sm">✅ Approve</button></form>
                                <form method="POST" style="display:inline" onsubmit="return confirm('Delete this image?')"><input type="hidden" name="action" value="reject_image"><input type="hidden" name="post_id" value="<?= htmlspecialchars($reply['id'], ENT_QUOTES, 'UTF-8') ?>"><input type="hidden" name="img_index" value="<?= (int)$imgIdx ?>"><input type="hidden" name="thread_id" value="<?= htmlspecialchars($thread['id'], ENT_QUOTES, 'UTF-8') ?>"><input type="hidden" name="is_reply" value="1"><button class="btn btn-red btn-sm">❌ Reject</button></form>
                            </div>
                        </div>
                    </div>
                    <?php endforeach; // reply images ?>

                    <?php // ── Pending reply media
                    if (($reply['media'] ?? null) && !($reply['media']['approved'] ?? true)):
                        $hasPending = true;
                        $isAudio = ($reply['media']['type'] ?? '') === 'audio';
                    ?>
                    <div class="image-queue-item">
                        <div style="width:80px;height:80px;display:flex;align-items:center;justify-content:center;background:rgba(0,255,65,0.05);border:1px solid rgba(0,255,65,0.15);border-radius:4px;font-size:2em;flex-shrink:0"><?= $isAudio ? '🎤' : '🎬' ?></div>
                        <div class="image-queue-meta">
                            <div><strong style="color:#6baf6b"><?= $isAudio ? '🎤 Voice Note' : '🎬 Video Clip' ?> — Reply</strong> in thread <?= htmlspecialchars($thread['id'], ENT_QUOTES, 'UTF-8') ?> — No.<?= htmlspecialchars($reply['id'], ENT_QUOTES, 'UTF-8') ?></div>
                            <div style="color:#4a8f4a;font-size:11px"><?= htmlspecialchars($reply['media']['origName'] ?? 'unknown', ENT_QUOTES, 'UTF-8') ?> · <?= formatFileSize($reply['media']['size'] ?? 0) ?> · <?= date('m/d H:i', $reply['time']) ?></div>
                            <div style="color:#6baf6b;margin-top:5px;font-size:12px"><?= htmlspecialchars(substr($reply['comment'], 0, 100), ENT_QUOTES, 'UTF-8') ?>...</div>
                            <div style="margin:6px 0">
                                <?php if ($isAudio): ?>
                                <audio controls src="/board_uploads/<?= htmlspecialchars($reply['media']['file'], ENT_QUOTES, 'UTF-8') ?>" style="height:28px;max-width:300px"></audio>
                                <?php else: ?>
                                <video controls src="/board_uploads/<?= htmlspecialchars($reply['media']['file'], ENT_QUOTES, 'UTF-8') ?>" style="max-height:100px;max-width:300px"></video>
                                <?php endif; ?>
                            </div>
                            <div class="image-queue-actions">
                                <form method="POST" style="display:inline"><input type="hidden" name="action" value="approve_media"><input type="hidden" name="post_id" value="<?= htmlspecialchars($reply['id'], ENT_QUOTES, 'UTF-8') ?>"><input type="hidden" name="thread_id" value="<?= htmlspecialchars($thread['id'], ENT_QUOTES, 'UTF-8') ?>"><input type="hidden" name="is_reply" value="1"><button class="btn btn-green btn-sm">✅ Approve</button></form>
                                <form method="POST" style="display:inline" onsubmit="return confirm('Delete this media file?')"><input type="hidden" name="action" value="reject_media"><input type="hidden" name="post_id" value="<?= htmlspecialchars($reply['id'], ENT_QUOTES, 'UTF-8') ?>"><input type="hidden" name="thread_id" value="<?= htmlspecialchars($thread['id'], ENT_QUOTES, 'UTF-8') ?>"><input type="hidden" name="is_reply" value="1"><button class="btn btn-red btn-sm">❌ Reject</button></form>
                            </div>
                        </div>
                    </div>
                    <?php endif; // reply media ?>
                    <?php endforeach; // replies ?>
                <?php endforeach; // threads ?>

                <?php if (!$hasPending): ?>
                    <div style="text-align:center;padding:40px;color:#4a8f4a;">
                        <div style="font-size:3em;margin-bottom:10px">✅</div>
                        <p>Media queue is clear. No pending approvals.</p>
                    </div>
                <?php endif; ?>

            <?php elseif ($tab === 'threads'): ?>
                <div class="page-header">
                    <h1>📋 Thread Management</h1>
                    <p><?= count($threads) ?> active threads</p>
                </div>
                
                <?php foreach ($threads as $thread): ?>
                    <div class="thread-row">
                        <div class="thread-info">
                            <div>
                                <strong style="color: #00ff41;"><?= $thread['subject'] ?: '(No subject)' ?></strong>
                                <span style="color: #3a6f3a; font-size: 11px;">No.<?= $thread['id'] ?> · <?= count($thread['replies'] ?? []) ?> replies · <?= timeAgo($thread['time']) ?></span>
                                <span class="thread-badges">
                                    <?php if ($thread['sticky'] ?? false): ?><span class="badge-sticky">📌 STICKY</span><?php endif; ?>
                                    <?php if ($thread['locked'] ?? false): ?><span class="badge-locked">🔒 LOCKED</span><?php endif; ?>
                                </span>
                            </div>
                            <div style="color: #6baf6b; font-size: 11px; margin-top: 3px;">
                                ID: <?= $thread['anonId'] ?> · IP: <?= substr($thread['ip_hash'], 0, 12) ?>...
                            </div>
                        </div>
                        <form method="POST" style="display:inline">
                            <input type="hidden" name="action" value="sticky_thread">
                            <input type="hidden" name="post_id" value="<?= $thread['id'] ?>">
                            <button class="btn btn-orange btn-sm" title="Toggle Pin">📌</button>
                        </form>
                        <form method="POST" style="display:inline">
                            <input type="hidden" name="action" value="lock_thread">
                            <input type="hidden" name="post_id" value="<?= $thread['id'] ?>">
                            <button class="btn btn-orange btn-sm" title="Toggle Lock">🔒</button>
                        </form>
                        <form method="POST" style="display:inline" onsubmit="return confirm('Delete entire thread and all replies?')">
                            <input type="hidden" name="action" value="delete_post">
                            <input type="hidden" name="post_id" value="<?= $thread['id'] ?>">
                            <input type="hidden" name="is_thread" value="1">
                            <button class="btn btn-red btn-sm" title="Delete Thread">🗑️</button>
                        </form>
                        <button class="btn btn-red btn-sm" title="Ban IP" onclick="toggleBanForm('thread-ban-<?= $thread['id'] ?>')">🚫</button>
                    </div>
                    <div id="thread-ban-<?= $thread['id'] ?>" style="display:none;background:rgba(255,0,0,0.05);border:1px solid rgba(255,68,68,0.25);border-radius:4px;padding:10px 14px;margin:4px 0 6px;">
                        <form method="POST" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">
                            <input type="hidden" name="action" value="ban_user">
                            <input type="hidden" name="ip_hash" value="<?= $thread['ip_hash'] ?>">
                            <div><label style="color:#ff8888;font-size:10px;display:block">Reason</label><input type="text" name="reason" value="Violation of board rules" style="background:rgba(255,68,68,0.06);border:1px solid rgba(255,68,68,0.25);border-radius:3px;color:#ffb0b0;font-family:'Courier New',monospace;padding:4px 8px;font-size:12px;width:220px"></div>
                            <div><label style="color:#ff8888;font-size:10px;display:block">Duration</label><select name="duration" style="background:#0a0e0a;border:1px solid rgba(255,68,68,0.25);border-radius:3px;color:#ffb0b0;font-family:'Courier New',monospace;padding:4px 8px;font-size:12px"><option value="0">Permanent</option><option value="1">1 hour</option><option value="24">24 hours</option><option value="168">7 days</option><option value="720">30 days</option></select></div>
                            <button class="btn btn-red btn-sm" onclick="return confirm('Ban IP <?= substr($thread['ip_hash'],0,8) ?>...?')">🔨 Ban</button>
                            <button type="button" class="btn btn-sm" onclick="toggleBanForm('thread-ban-<?= $thread['id'] ?>')">Cancel</button>
                        </form>
                    </div>
                    <?php if (!empty($thread['replies'])): ?>
                    <details style="margin:0 0 6px;">
                        <summary style="cursor:pointer;color:#4a8f4a;font-size:11px;padding:3px 8px;background:rgba(0,255,65,0.03);border:1px solid rgba(0,255,65,0.08);border-radius:3px;list-style:none;user-select:none;">▶ <?= count($thread['replies']) ?> repl<?= count($thread['replies'])===1?'y':'ies' ?> — click to manage</summary>
                        <div style="margin-top:4px;padding-left:12px;border-left:2px solid rgba(0,255,65,0.12);">
                        <?php foreach ($thread['replies'] as $reply): ?>
                        <div style="display:flex;align-items:center;gap:6px;padding:4px 6px;border-bottom:1px solid rgba(0,255,65,0.05);flex-wrap:wrap;">
                            <span style="color:#3a6f3a;font-size:10px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                                <span style="color:#6baf6b">No.<?= $reply['id'] ?></span> · <?= timeAgo($reply['time']) ?> · ID:<?= $reply['anonId'] ?> · <span style="font-family:'Courier New',monospace"><?= substr($reply['ip_hash'],0,10) ?>...</span><br>
                                <?= htmlspecialchars(substr($reply['comment']??'',0,80), ENT_QUOTES,'UTF-8') ?>
                            </span>
                            <form method="POST" style="display:inline" onsubmit="return confirm('Delete reply <?= $reply['id'] ?>?')">
                                <input type="hidden" name="action" value="delete_post">
                                <input type="hidden" name="post_id" value="<?= $reply['id'] ?>">
                                <input type="hidden" name="thread_id" value="<?= $thread['id'] ?>">
                                <input type="hidden" name="is_reply" value="1">
                                <button class="btn btn-red btn-sm" title="Delete reply">🗑️</button>
                            </form>
                            <button class="btn btn-red btn-sm" title="Ban IP" onclick="toggleBanForm('reply-ban-<?= $reply['id'] ?>')">🚫</button>
                            <div id="reply-ban-<?= $reply['id'] ?>" style="display:none;width:100%;background:rgba(255,0,0,0.05);border:1px solid rgba(255,68,68,0.2);border-radius:3px;padding:6px 10px;margin-top:4px;">
                                <form method="POST" style="display:flex;gap:6px;flex-wrap:wrap;align-items:flex-end;">
                                    <input type="hidden" name="action" value="ban_user">
                                    <input type="hidden" name="ip_hash" value="<?= $reply['ip_hash'] ?>">
                                    <input type="text" name="reason" value="Violation of board rules" placeholder="Reason" style="background:rgba(255,68,68,0.06);border:1px solid rgba(255,68,68,0.2);border-radius:3px;color:#ffb0b0;font-family:'Courier New',monospace;padding:3px 6px;font-size:11px;width:180px">
                                    <select name="duration" style="background:#0a0e0a;border:1px solid rgba(255,68,68,0.2);border-radius:3px;color:#ffb0b0;font-family:'Courier New',monospace;padding:3px 6px;font-size:11px"><option value="0">Permanent</option><option value="1">1h</option><option value="24">24h</option><option value="168">7d</option><option value="720">30d</option></select>
                                    <button class="btn btn-red btn-sm" onclick="return confirm('Ban?')">🔨 Ban</button>
                                    <button type="button" class="btn btn-sm" onclick="toggleBanForm('reply-ban-<?= $reply['id'] ?>')">✕</button>
                                </form>
                            </div>
                        </div>
                        <?php endforeach; ?>
                        </div>
                    </details>
                    <?php endif; ?>
                <?php endforeach; ?>

            <?php elseif ($tab === 'bans'): ?>
                <div class="page-header">
                    <h1>🔨 Ban Management</h1>
                    <p><?= $activeBans ?> active ban(s)</p>
                </div>
                
                <div style="margin-bottom: 25px;">
                    <h3 style="color: #00ff41; margin-bottom: 10px; font-size: 14px;">Add New Ban</h3>
                    <form method="POST" class="admin-form" style="display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end;">
                        <input type="hidden" name="action" value="ban_user">
                        <div style="flex: 1; min-width: 200px;">
                            <label style="color: #6baf6b; font-size: 11px;">IP Address <span style="color:#4a8f4a">(plain IP or hash)</span></label>
                            <input type="text" name="ip_hash" placeholder="e.g. 1.2.3.4  — auto-hashed" required style="width: 100%; background: rgba(0,255,65,0.04); border: 1px solid rgba(0,255,65,0.2); border-radius: 4px; color: #b0ffb0; font-family: 'Courier New', monospace; padding: 6px 10px; font-size: 12px;">
                        </div>
                        <div style="flex: 1; min-width: 200px;">
                            <label style="color: #6baf6b; font-size: 11px;">Reason</label>
                            <input type="text" name="reason" value="Violation of board rules" style="width: 100%; background: rgba(0,255,65,0.04); border: 1px solid rgba(0,255,65,0.2); border-radius: 4px; color: #b0ffb0; font-family: 'Courier New', monospace; padding: 6px 10px; font-size: 12px;">
                        </div>
                        <div style="width: 120px;">
                            <label style="color: #6baf6b; font-size: 11px;">Duration (hours, 0=perm)</label>
                            <input type="number" name="duration" value="0" min="0" style="width: 100%; background: rgba(0,255,65,0.04); border: 1px solid rgba(0,255,65,0.2); border-radius: 4px; color: #b0ffb0; font-family: 'Courier New', monospace; padding: 6px 10px; font-size: 12px;">
                        </div>
                        <button class="btn btn-red">🔨 BAN</button>
                    </form>
                </div>
                
                <h3 style="color: #00ff41; margin-bottom: 10px; font-size: 14px;">Active Bans</h3>
                <table class="admin-table">
                    <thead><tr>
                        <th>IP Hash</th>
                        <th>Reason</th>
                        <th>Banned</th>
                        <th>Expires</th>
                        <th>Action</th>
                    </tr></thead>
                    <tbody>
                    <?php foreach ($bans as $ban):
                        $active = $ban['expires'] === 0 || $ban['expires'] > time();
                        if (!$active) continue;
                    ?>
                        <tr>
                            <td style="font-size: 11px; color: #6baf6b; font-family:'Courier New',monospace;" title="Full hash: <?= $ban['ip_hash'] ?>"><?= $ban['ip_hash'] ?></td>
                            <td><?= $ban['reason'] ?></td>
                            <td style="color: #3a6f3a;"><?= date('m/d/y H:i', $ban['time']) ?></td>
                            <td style="color: <?= $ban['expires'] === 0 ? '#ff4444' : '#ff8c00' ?>">
                                <?= $ban['expires'] === 0 ? 'PERMANENT' : date('m/d/y H:i', $ban['expires']) ?>
                            </td>
                            <td>
                                <form method="POST" style="display:inline" onsubmit="return confirm('Unban this user?')">
                                    <input type="hidden" name="action" value="unban">
                                    <input type="hidden" name="ip_hash" value="<?= $ban['ip_hash'] ?>">
                                    <button class="btn btn-green btn-sm">Unban</button>
                                </form>
                            </td>
                        </tr>
                    <?php endforeach; ?>
                    <?php if ($activeBans === 0): ?>
                        <tr><td colspan="5" style="text-align: center; color: #3a6f3a; padding: 20px;">No active bans.</td></tr>
                    <?php endif; ?>
                    </tbody>
                </table>

            <?php elseif ($tab === 'settings'): ?>
                <div class="page-header">
                    <h1>⚙️ Board Settings</h1>
                    <p>Configure board behavior and moderation</p>
                </div>

                <form method="POST" class="admin-form">
                    <input type="hidden" name="action" value="save_settings">

                    <h3 style="color:#00ff41;font-size:13px;margin:0 0 10px;letter-spacing:1px;text-transform:uppercase">🖼️ Allowed Upload Types</h3>
                    <div class="checkbox-row">
                        <input type="checkbox" name="allow_images" id="ai" <?= ($settings['allow_images'] ?? true) ? 'checked' : '' ?>>
                        <label for="ai">🖼️ Allow image uploads (JPG/PNG/GIF/WEBP)</label>
                    </div>
                    <div class="checkbox-row">
                        <input type="checkbox" name="allow_audio" id="aa" <?= ($settings['allow_audio'] ?? true) ? 'checked' : '' ?>>
                        <label for="aa">🎤 Allow voice notes (WebM/OGG/MP3/WAV)</label>
                    </div>
                    <div class="checkbox-row">
                        <input type="checkbox" name="allow_video" id="av" <?= ($settings['allow_video'] ?? true) ? 'checked' : '' ?>>
                        <label for="av">🎬 Allow video clips (WebM/MP4/MOV)</label>
                    </div>

                    <h3 style="color:#00ff41;font-size:13px;margin:18px 0 10px;letter-spacing:1px;text-transform:uppercase">📋 New Thread Requirements</h3>
                    <div class="form-group">
                        <label>OP post must include</label>
                        <select name="op_requires" style="background:#0a1a0a;color:#c8ffc8;border:1px solid rgba(0,255,65,0.25);padding:6px 10px;font-family:monospace;font-size:13px;width:100%;">
                            <option value="any" <?= ($settings['op_requires'] ?? 'any') === 'any' ? 'selected' : '' ?>>Anything — comment, image, or voice/video (default)</option>
                            <option value="comment" <?= ($settings['op_requires'] ?? '') === 'comment' ? 'selected' : '' ?>>Comment required</option>
                            <option value="image" <?= ($settings['op_requires'] ?? '') === 'image' ? 'selected' : '' ?>>Image required</option>
                            <option value="image_or_media" <?= ($settings['op_requires'] ?? '') === 'image_or_media' ? 'selected' : '' ?>>Image OR voice/video required</option>
                            <option value="comment_and_image" <?= ($settings['op_requires'] ?? '') === 'comment_and_image' ? 'selected' : '' ?>>Comment AND image required (strictest)</option>
                        </select>
                        <div class="hint">Controls what new thread OPs must contain. "Anything" allows voice-note-only or text-only threads.</div>
                    </div>

                    <h3 style="color:#00ff41;font-size:13px;margin:18px 0 10px;letter-spacing:1px;text-transform:uppercase">📋 Moderation / Approval</h3>
                    <div class="checkbox-row">
                        <input type="checkbox" name="require_image_approval" id="ria" <?= $settings['require_image_approval'] ? 'checked' : '' ?>>
                        <label for="ria">🖼️ Require admin approval for images</label>
                    </div>
                    <div class="form-group">
                        <div class="hint">When enabled, uploaded images show a placeholder until approved from the Media Queue.</div>
                    </div>
                    <div class="checkbox-row">
                        <input type="checkbox" name="require_audio_approval" id="raa" <?= ($settings['require_audio_approval'] ?? false) ? 'checked' : '' ?>>
                        <label for="raa">🎤 Require admin approval for voice notes</label>
                    </div>
                    <div class="form-group">
                        <div class="hint">When enabled, voice notes are hidden until approved. Off by default.</div>
                    </div>
                    <div class="checkbox-row">
                        <input type="checkbox" name="require_video_approval" id="rva" <?= ($settings['require_video_approval'] ?? true) ? 'checked' : '' ?>>
                        <label for="rva">🎬 Require admin approval for video</label>
                    </div>
                    <div class="form-group">
                        <div class="hint">When enabled, video uploads are hidden until approved. Recommended on — prevents spam/inappropriate video.</div>
                    </div>

                    <h3 style="color:#00ff41;font-size:13px;margin:18px 0 10px;letter-spacing:1px;text-transform:uppercase">🔧 Board Controls</h3>
                    <div class="checkbox-row">
                        <input type="checkbox" name="board_locked" id="bl" <?= $settings['board_locked'] ? 'checked' : '' ?>>
                        <label for="bl">🔒 Lock board (no new posts)</label>
                    </div>
                    <div class="checkbox-row">
                        <input type="checkbox" name="chat_enabled" id="ce" <?= $settings['chat_enabled'] ? 'checked' : '' ?>>
                        <label for="ce">💬 Enable live chat</label>
                    </div>

                    <h3 style="color:#00ff41;font-size:13px;margin:18px 0 10px;letter-spacing:1px;text-transform:uppercase">⏱ Rate &amp; Pagination</h3>
                    <div class="form-group">
                        <label>Rate limit (seconds between posts)</label>
                        <input type="number" name="rate_limit_seconds" value="<?= $settings['rate_limit_seconds'] ?>" min="5" max="300">
                    </div>
                    <div class="form-group">
                        <label>Threads per page</label>
                        <input type="number" name="threads_per_page" value="<?= $settings['threads_per_page'] ?? 10 ?>" min="1" max="50">
                        <div class="hint">Number of threads shown per page on the board index. Default: 10</div>
                    </div>
                    <div class="form-group">
                        <label>Reply previews per thread</label>
                        <input type="number" name="replies_preview_count" value="<?= $settings['replies_preview_count'] ?? 3 ?>" min="0" max="10">
                        <div class="hint">How many recent replies to show under each thread on the index. Default: 3</div>
                    </div>
                    <div class="form-group">
                        <label>Max media upload size (MB)</label>
                        <input type="number" name="max_media_size_mb" value="<?= (int)($settings['max_media_size_mb'] ?? 100) ?>" min="1" max="500">
                        <div class="hint">Maximum size for audio/video uploads in MB. Images are always capped at 5MB. Server nginx must also allow this size. Default: 100</div>
                    </div>

                    <h3 style="color:#00ff41;font-size:13px;margin:18px 0 10px;letter-spacing:1px;text-transform:uppercase">📢 Content</h3>
                    <div class="form-group">
                        <label>Board announcement (shown at top)</label>
                        <textarea name="announcement" placeholder="Leave empty for no announcement"><?= htmlspecialchars($settings['announcement']) ?></textarea>
                    </div>
                    <div class="form-group">
                        <label>Auto-ban words (comma separated)</label>
                        <textarea name="auto_ban_words" placeholder="word1, word2, word3"><?= htmlspecialchars($settings['auto_ban_words']) ?></textarea>
                        <div class="hint">Posts containing these words will be automatically rejected.</div>
                    </div>

                    <button class="btn btn-green">💾 SAVE SETTINGS</button>
                </form>
                
                <hr style="border-color: rgba(0,255,65,0.1); margin: 30px 0;">
                
                <h3 style="color: #ff4444; margin-bottom: 10px; font-size: 14px;">Danger Zone</h3>
                <form method="POST" onsubmit="return confirm('Clear all chat messages?')">
                    <input type="hidden" name="action" value="clear_chat">
                    <button class="btn btn-red">🗑️ Clear Chat History</button>
                </form>

            <?php elseif ($tab === 'orders'): ?>
                <div class="page-header">
                    <h1>💳 Orders &amp; Withdrawals</h1>
                    <p>Manage Prezzy card orders and bank cash-out requests</p>
                </div>

                <h2 style="font-family:'Courier New',monospace;color:#00ff41;font-size:14px;letter-spacing:2px;margin:0 0 12px;">💳 PREZZY CARD ORDERS (<?= count($cardOrders) ?>)</h2>
                <?php if (empty($cardOrders)): ?>
                    <div style="color:#3a6f3a;padding:20px;background:rgba(0,0,0,0.3);border-radius:6px;margin-bottom:24px;">No card orders yet.</div>
                <?php else: ?>
                <div style="overflow-x:auto;margin-bottom:30px;">
                <table class="admin-table">
                    <thead><tr>
                        <th>Order ID</th><th>Date</th><th>Email</th><th>TG</th>
                        <th>NZD</th><th>GOYIM</th><th>TX</th>
                        <th>Status</th><th>Update Status</th>
                    </tr></thead>
                    <tbody>
                    <?php
                    $stColors = ['pending'=>'#ffaa00','approved'=>'#5fffaf','processing'=>'#00aaff','fulfilled'=>'#00ff41','denied'=>'#ff5555'];
                    foreach (array_reverse($cardOrders) as $o):
                        $st = $o['status'] ?? 'pending';
                    ?>
                        <tr>
                            <td><code><?= htmlspecialchars($o['order_id'] ?? '') ?></code></td>
                            <td style="white-space:nowrap"><?= isset($o['created_at']) ? date('d M y H:i', $o['created_at']) : '—' ?></td>
                            <td style="max-width:150px;word-break:break-all;font-size:11px;"><?= htmlspecialchars($o['email'] ?? '—') ?></td>
                            <td style="font-size:11px;"><?= !empty($o['tg_username']) ? '@'.htmlspecialchars($o['tg_username']) : '—' ?></td>
                            <td>$<?= number_format((float)($o['card_amount'] ?? 0), 2) ?></td>
                            <td><?= number_format((float)($o['goyim_paid'] ?? $o['goyim_amount'] ?? 0)) ?></td>
                            <td><?php $tx=$o['tx_hash']??''; echo $tx ? '<a href="https://solscan.io/tx/'.htmlspecialchars($tx).'" target="_blank" style="color:#00ff41;">'.substr($tx,0,10).'…</a>' : '—'; ?></td>
                            <td>
                                <span style="color:<?= $stColors[$st] ?? '#aaa' ?>; font-weight:bold;"><?= strtoupper($st) ?></span>
                                <?php if (!empty($o['card_code'])): ?><br><small style="color:#5fffaf;font-size:10px;">Code: <?= htmlspecialchars($o['card_code']) ?></small><?php endif; ?>
                                <?php if (!empty($o['notes'])): ?><br><small style="color:#888;font-size:10px;" title="<?= htmlspecialchars($o['notes']) ?>">📝 notes</small><?php endif; ?>
                            </td>
                            <td>
                                <form method="POST" style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;">
                                    <input type="hidden" name="action"   value="update_order_status">
                                    <input type="hidden" name="order_id" value="<?= htmlspecialchars($o['order_id']??'') ?>">
                                    <select name="new_status" style="padding:3px;background:#0a1a0a;border:1px solid #2a4a2a;color:#8aff8a;font-size:11px;border-radius:3px;">
                                        <?php foreach (['pending','approved','processing','fulfilled','denied'] as $s): ?>
                                        <option value="<?= $s ?>"<?= $s===$st?' selected':'' ?>><?= ucfirst($s) ?></option>
                                        <?php endforeach; ?>
                                    </select>
                                    <input type="text" name="card_code" value="<?= htmlspecialchars($o['card_code'] ?? '') ?>" placeholder="Card code" style="width:120px;padding:3px 6px;background:#0a1a0a;border:1px solid #2a4a2a;color:#8aff8a;font-size:11px;border-radius:3px;">
                                    <input type="text" name="notes" value="<?= htmlspecialchars($o['notes'] ?? '') ?>" placeholder="Notes" style="width:100px;padding:3px 6px;background:#0a1a0a;border:1px solid #2a4a2a;color:#8aff8a;font-size:11px;border-radius:3px;">
                                    <button type="submit" class="btn btn-small" style="background:#00aa44;white-space:nowrap;">✓ Save</button>
                                </form>
                            </td>
                        </tr>
                    <?php endforeach; ?>
                    </tbody>
                </table>
                </div>
                <?php endif; ?>

                <h2 style="font-family:'Courier New',monospace;color:#00ff41;font-size:14px;letter-spacing:2px;margin:24px 0 12px;">🏦 CASH-OUT WITHDRAWALS (<?= count($withdrawals) ?>)</h2>
                <?php if (empty($withdrawals)): ?>
                    <div style="color:#3a6f3a;padding:20px;background:rgba(0,0,0,0.3);border-radius:6px;">No withdrawal requests yet.</div>
                <?php else: ?>
                <div style="overflow-x:auto;">
                <table class="admin-table">
                    <thead><tr>
                        <th>ID</th><th>Date</th><th>Destination</th><th>TG</th>
                        <th>Currency</th><th>Fiat</th><th>GOYIM</th>
                        <th>TX</th><th>Status</th><th>Update Status</th>
                    </tr></thead>
                    <tbody>
                    <?php
                    $wStColors = ['pending'=>'#ffaa00','approved'=>'#5fffaf','processing'=>'#00aaff','processed'=>'#00ff41','denied'=>'#ff5555'];
                    foreach (array_reverse($withdrawals) as $w):
                        $wst = $w['status'] ?? 'pending';
                    ?>
                        <tr>
                            <td><code><?= htmlspecialchars($w['withdrawal_id'] ?? '') ?></code></td>
                            <td style="white-space:nowrap"><?= isset($w['created_at']) ? date('d M y H:i', $w['created_at']) : '—' ?></td>
                            <td style="max-width:140px;word-break:break-all;font-size:11px;"><?= htmlspecialchars($w['dest_email'] ?? $w['dest_account'] ?? '—') ?></td>
                            <td style="font-size:11px;"><?= !empty($w['tg_username']) ? '@'.htmlspecialchars($w['tg_username']) : '—' ?></td>
                            <td><?= htmlspecialchars($w['currency'] ?? '—') ?></td>
                            <td><?= number_format((float)($w['fiat_amount'] ?? 0), 2) ?></td>
                            <td><?= number_format((float)($w['goyim_paid'] ?? 0)) ?></td>
                            <td><?php $tx=$w['tx_hash']??''; echo $tx ? '<a href="https://solscan.io/tx/'.htmlspecialchars($tx).'" target="_blank" style="color:#00ff41;">'.substr($tx,0,10).'…</a>' : '—'; ?></td>
                            <td>
                                <span style="color:<?= $wStColors[$wst] ?? '#aaa' ?>; font-weight:bold;"><?= strtoupper($wst) ?></span>
                                <?php if (!empty($w['transfer_ref'])): ?><br><small style="color:#5fffaf;font-size:10px;">Ref: <?= htmlspecialchars($w['transfer_ref']) ?></small><?php endif; ?>
                                <?php if (!empty($w['notes'])): ?><br><small style="color:#888;font-size:10px;" title="<?= htmlspecialchars($w['notes']) ?>">📝 notes</small><?php endif; ?>
                            </td>
                            <td>
                                <form method="POST" style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;">
                                    <input type="hidden" name="action"        value="update_withdrawal_status">
                                    <input type="hidden" name="withdrawal_id" value="<?= htmlspecialchars($w['withdrawal_id']??'') ?>">
                                    <select name="new_status" style="padding:3px;background:#0a1a0a;border:1px solid #2a4a2a;color:#8aff8a;font-size:11px;border-radius:3px;">
                                        <?php foreach (['pending','approved','processing','processed','denied'] as $s): ?>
                                        <option value="<?= $s ?>"<?= $s===$wst?' selected':'' ?>><?= ucfirst($s) ?></option>
                                        <?php endforeach; ?>
                                    </select>
                                    <input type="text" name="transfer_ref" value="<?= htmlspecialchars($w['transfer_ref'] ?? '') ?>" placeholder="Transfer ref" style="width:110px;padding:3px 6px;background:#0a1a0a;border:1px solid #2a4a2a;color:#8aff8a;font-size:11px;border-radius:3px;">
                                    <input type="text" name="notes" value="<?= htmlspecialchars($w['notes'] ?? '') ?>" placeholder="Notes" style="width:90px;padding:3px 6px;background:#0a1a0a;border:1px solid #2a4a2a;color:#8aff8a;font-size:11px;border-radius:3px;">
                                    <button type="submit" class="btn btn-small" style="background:#00aa44;white-space:nowrap;">✓ Save</button>
                                </form>
                            </td>
                        </tr>
                    <?php endforeach; ?>
                    </tbody>
                </table>
                </div>
                <?php endif; ?>

            <?php elseif ($tab === 'modlog'): ?>
                <div class="page-header">
                    <h1>📜 Moderation Log</h1>
                    <p>All admin actions recorded here</p>
                </div>
                
                <div class="log-container" style="max-height: 600px;">
                    <?php foreach (array_reverse($modlog) as $entry): ?>
                        <div class="log-entry">
                            <span class="log-time"><?= date('Y-m-d H:i:s', $entry['time']) ?></span>
                            <span class="log-action">[<?= strtoupper($entry['action']) ?>]</span>
                            <?= htmlspecialchars($entry['details']) ?>
                        </div>
                    <?php endforeach; ?>
                    <?php if (empty($modlog)): ?>
                        <div style="color: #3a6f3a; padding: 20px; text-align: center;">No mod actions recorded.</div>
                    <?php endif; ?>
                </div>
            <?php endif; ?>
        </main>
    </div>
    <script>
    function toggleBanForm(id) {
        var el = document.getElementById(id);
        if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
    }
    // Auto-inject CSRF tokens into all forms (including dynamically shown ones)
    function injectCsrf() {
        document.querySelectorAll('form').forEach(function(form) {
            if (form.method.toLowerCase() === 'post' && !form.querySelector('input[name="csrf_token"]')) {
                var input = document.createElement('input');
                input.type = 'hidden';
                input.name = 'csrf_token';
                input.value = '<?= htmlspecialchars(generateCsrfToken()) ?>';
                form.appendChild(input);
            }
        });
    }
    injectCsrf();
    // Re-inject when ban forms are revealed
    document.addEventListener('click', function(e) {
        if (e.target.closest && e.target.closest('button')) setTimeout(injectCsrf, 50);
    });
    </script>
</body>
</html>
<?php

function showLoginPage(string $error = ''): void {
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin Login — /board/</title>
    <link rel="icon" type="image/x-icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🐸</text></svg>">
    <meta name="robots" content="noindex, nofollow">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: #0a0e0a; color: #b0ffb0; font-family: 'Courier New', monospace; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
        .login-box {
            background: rgba(0,0,0,0.5);
            border: 1px solid rgba(0,255,65,0.2);
            border-radius: 10px;
            padding: 40px;
            width: 360px;
            text-align: center;
        }
        .login-box h1 { color: #00ff41; font-size: 18px; margin-bottom: 5px; }
        .login-box p { color: #3a6f3a; font-size: 12px; margin-bottom: 25px; }
        .login-box input {
            width: 100%;
            background: rgba(0,255,65,0.04);
            border: 1px solid rgba(0,255,65,0.2);
            border-radius: 4px;
            color: #b0ffb0;
            font-family: 'Courier New', monospace;
            font-size: 13px;
            padding: 10px 14px;
            margin-bottom: 12px;
        }
        .login-box input:focus { outline: none; border-color: #00ff41; box-shadow: 0 0 5px rgba(0,255,65,0.2); }
        .login-box button {
            width: 100%;
            background: #00ff41;
            color: #0a0e0a;
            border: none;
            border-radius: 4px;
            padding: 10px;
            font-family: 'Courier New', monospace;
            font-weight: bold;
            font-size: 14px;
            cursor: pointer;
            transition: all 0.2s;
        }
        .login-box button:hover { box-shadow: 0 0 20px rgba(0,255,65,0.4); }
        .error { color: #ff6b6b; font-size: 12px; margin-bottom: 15px; }
        .back-link { margin-top: 15px; }
        .back-link a { color: #4a8f4a; font-size: 12px; }
    </style>
</head>
<body>
    <div class="login-box">
        <h1>🔒 ADMIN LOGIN</h1>
        <p>/board/ moderation panel</p>
        <?php if ($error): ?><div class="error">⚠️ <?= htmlspecialchars($error) ?></div><?php endif; ?>
        <form method="POST">
            <input type="hidden" name="action" value="login">
            <input type="text" name="user" placeholder="Username" autocomplete="off" required>
            <input type="password" name="pass" placeholder="Password" required>
            <button type="submit">ACCESS PANEL</button>
        </form>
        <div class="back-link"><a href="/board">← Back to board</a></div>
    </div>
</body>
</html>
<?php
}
