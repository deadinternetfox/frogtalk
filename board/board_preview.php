<?php
/**
 * Board OG Preview Generator
 * Generates 1200x630 social share images
 * URL: /board_preview.php?thread=THREAD_ID  (thread preview)
 * URL: /board_preview.php?board=index       (board index preview)
 */
require_once __DIR__ . '/board_config.php';

$boardMode = ($_GET['board'] ?? '') === 'index';
$threadId = $_GET['thread'] ?? '';

if (!$boardMode && empty($threadId)) {
    http_response_code(404);
    exit;
}

$cacheKey = $boardMode ? 'board_index' : preg_replace('/[^a-zA-Z0-9]/', '', $threadId);
$cacheFile = PREVIEW_DIR . '/og_' . $cacheKey . '.png';

// Serve cached version if fresh (5 min for threads, 10 min for index)
$cacheTTL = $boardMode ? 600 : 300;
if (file_exists($cacheFile) && (time() - filemtime($cacheFile)) < $cacheTTL) {
    header('Content-Type: image/png');
    header('Cache-Control: public, max-age=300');
    readfile($cacheFile);
    exit;
}

// Load threads
$threads = loadThreads();

// ── Board Index Preview ──
if ($boardMode) {
    $w = 1200; $h = 630;
    $img = imagecreatetruecolor($w, $h);
    $bg = imagecolorallocate($img, 10, 14, 10);
    $greenBright = imagecolorallocate($img, 0, 255, 65);
    $greenMid = imagecolorallocate($img, 107, 175, 107);
    $greenDark = imagecolorallocate($img, 58, 111, 58);
    $greenText = imagecolorallocate($img, 176, 255, 176);
    $darkPanel = imagecolorallocate($img, 15, 20, 15);
    $white = imagecolorallocate($img, 255, 255, 255);
    $black = imagecolorallocate($img, 0, 0, 0);
    
    imagefilledrectangle($img, 0, 0, $w, $h, $bg);
    
    // Header bar
    imagefilledrectangle($img, 0, 0, $w, 80, $darkPanel);
    imageline($img, 0, 80, $w, 80, $greenBright);
    imagestring($img, 5, 40, 12, "FROG BOARD", $greenBright);
    imagestring($img, 4, 40, 35, "Anonymous Imageboard", $greenDark);
    
    // Stats line
    $totalReplies = 0;
    foreach ($threads as $t) $totalReplies += count($t['replies'] ?? []);
    $stats = count($threads) . " threads | " . $totalReplies . " posts | Anonymous | No tracking";
    imagestring($img, 3, 40, 58, $stats, $greenMid);
    
    // Show up to 5 recent threads
    $y = 100;
    $shown = 0;
    foreach ($threads as $t) {
        if ($shown >= 5) break;
        $subj = mb_substr($t['subject'] ?: '(No subject)', 0, 50);
        $preview = mb_substr(strip_tags($t['comment']), 0, 80);
        $rc = count($t['replies'] ?? []);
        
        // Thread row background
        imagefilledrectangle($img, 30, $y, $w - 30, $y + 85, $darkPanel);
        imagerectangle($img, 30, $y, $w - 30, $y + 85, $greenDark);
        
        // Thread number
        imagestring($img, 3, 45, $y + 5, "No." . $t['id'], $greenDark);
        
        // Subject
        imagestring($img, 5, 45, $y + 22, $subj, $greenBright);
        
        // Comment preview
        imagestring($img, 3, 45, $y + 45, mb_substr($preview, 0, 120), $greenText);
        
        // Reply count
        imagestring($img, 3, 45, $y + 65, $rc . " replies | " . date('m/d/y', $t['time']), $greenMid);
        
        // If has image, draw indicator
        if ($t['image']) {
            imagestring($img, 3, $w - 100, $y + 35, "[IMAGE]", $greenMid);
        }
        
        $y += 95;
        $shown++;
    }
    
    // Bottom bar
    imagefilledrectangle($img, 0, $h - 50, $w, $h, $darkPanel);
    imageline($img, 0, $h - 50, $w, $h - 50, $greenDark);
    imagestring($img, 4, 40, $h - 38, "/board  |  Frog Board on FrogTalk.", $greenMid);
    
    // Frog
    $frogX = $w - 60; $frogY = $h - 35;
    imagefilledellipse($img, $frogX, $frogY, 30, 25, $greenBright);
    imagefilledellipse($img, $frogX - 5, $frogY - 5, 6, 6, $white);
    imagefilledellipse($img, $frogX + 5, $frogY - 5, 6, 6, $white);
    imagefilledellipse($img, $frogX - 5, $frogY - 5, 3, 3, $black);
    imagefilledellipse($img, $frogX + 5, $frogY - 5, 3, 3, $black);
    
    // Border
    imagerectangle($img, 0, 0, $w - 1, $h - 1, $greenBright);
    imagerectangle($img, 1, 1, $w - 2, $h - 2, $greenDark);
    
    imagepng($img, $cacheFile, 6);
    imagedestroy($img);
    header('Content-Type: image/png');
    header('Cache-Control: public, max-age=600');
    readfile($cacheFile);
    exit;
}

// ── Thread Preview ──
$thread = null;
foreach ($threads as $t) {
    if ($t['id'] === $threadId) {
        $thread = $t;
        break;
    }
}

if (!$thread) {
    http_response_code(404);
    exit;
}

// Generate the OG image: 1200x630
$w = 1200;
$h = 630;
$img = imagecreatetruecolor($w, $h);

// Colors
$bgColor = imagecolorallocate($img, 10, 14, 10);       // #0a0e0a
$greenBright = imagecolorallocate($img, 0, 255, 65);    // #00ff41
$greenMid = imagecolorallocate($img, 107, 175, 107);    // #6baf6b
$greenDark = imagecolorallocate($img, 58, 111, 58);     // #3a6f3a
$greenText = imagecolorallocate($img, 176, 255, 176);   // #b0ffb0
$borderGreen = imagecolorallocate($img, 0, 255, 65);
$white = imagecolorallocate($img, 255, 255, 255);
$black = imagecolorallocate($img, 0, 0, 0);
$darkPanel = imagecolorallocate($img, 15, 20, 15);

// Fill background
imagefilledrectangle($img, 0, 0, $w, $h, $bgColor);

// Top bar
imagefilledrectangle($img, 0, 0, $w, 60, $darkPanel);
imageline($img, 0, 60, $w, 60, $greenBright);

// "🐸 Frog Board" header
$headerFont = 5; // built-in font
imagestring($img, $headerFont, 30, 10, "FROG BOARD", $greenBright);
imagestring($img, 3, 30, 35, "Anonymous Imageboard", $greenDark);

// Right side: stats
$replyCount = count($thread['replies'] ?? []);
$statsText = $replyCount . " replies";
imagestring($img, 3, $w - 150, 20, $statsText, $greenMid);

// Thread content area
$contentY = 80;

// Thread subject
$subject = $thread['subject'] ?: '(No subject)';
$subject = mb_substr($subject, 0, 60);
// Draw subject with larger font
imagestring($img, 5, 30, $contentY, $subject, $greenBright);
$contentY += 30;

// Post info line
$infoLine = "Anonymous ID:" . $thread['anonId'] . "  " . date('m/d/y H:i', $thread['time']) . "  No." . $thread['id'];
imagestring($img, 3, 30, $contentY, $infoLine, $greenDark);
$contentY += 25;

// Horizontal rule
imageline($img, 30, $contentY, $w - 30, $contentY, $greenDark);
$contentY += 15;

// If thread has an image, render it on the left
$textStartX = 30;
$hasImage = !empty($thread['image']);
$imageApproved = $hasImage && ($thread['image']['approved'] ?? true) === true;

if ($hasImage && $imageApproved) {
    $thumbPath = UPLOAD_DIR . '/' . $thread['image']['thumb'];
    if (file_exists($thumbPath)) {
        $thumbImg = @imagecreatefromjpeg($thumbPath);
        if (!$thumbImg) $thumbImg = @imagecreatefrompng($thumbPath);
        if ($thumbImg) {
            $tw = imagesx($thumbImg);
            $th = imagesy($thumbImg);
            // Scale to fit 200x200 max
            $maxThumb = 200;
            $ratio = min($maxThumb / $tw, $maxThumb / $th, 1);
            $dw = (int)($tw * $ratio);
            $dh = (int)($th * $ratio);
            
            // Draw border
            imagerectangle($img, 28, $contentY - 2, 32 + $dw, $contentY + $dh + 2, $greenDark);
            imagecopyresampled($img, $thumbImg, 30, $contentY, 0, 0, $dw, $dh, $tw, $th);
            imagedestroy($thumbImg);
            
            $textStartX = 30 + $dw + 20;
        }
    }
} elseif ($hasImage && !$imageApproved) {
    // Draw a "pending approval" placeholder box
    $phW = 200; $phH = 150;
    $orange = imagecolorallocate($img, 255, 140, 0);
    $orangeDark = imagecolorallocate($img, 180, 100, 0);
    $orangeBg = imagecolorallocate($img, 30, 22, 10);
    imagefilledrectangle($img, 30, $contentY, 30 + $phW, $contentY + $phH, $orangeBg);
    imagerectangle($img, 30, $contentY, 30 + $phW, $contentY + $phH, $orangeDark);
    // Dashed effect - draw alternating segments
    for ($dx = 30; $dx < 30 + $phW; $dx += 8) {
        imageline($img, $dx, $contentY, min($dx + 4, 30 + $phW), $contentY, $orange);
        imageline($img, $dx, $contentY + $phH, min($dx + 4, 30 + $phW), $contentY + $phH, $orange);
    }
    for ($dy = $contentY; $dy < $contentY + $phH; $dy += 8) {
        imageline($img, 30, $dy, 30, min($dy + 4, $contentY + $phH), $orange);
        imageline($img, 30 + $phW, $dy, 30 + $phW, min($dy + 4, $contentY + $phH), $orange);
    }
    // Clock icon text
    imagestring($img, 5, 30 + ($phW / 2) - 12, $contentY + ($phH / 2) - 20, "[?]", $orange);
    imagestring($img, 3, 30 + ($phW / 2) - 40, $contentY + ($phH / 2) + 5, "Image Pending", $orangeDark);
    imagestring($img, 3, 30 + ($phW / 2) - 32, $contentY + ($phH / 2) + 22, "Approval", $orangeDark);
    $textStartX = 30 + $phW + 20;
}

// Comment text — wrap to fit
$comment = $thread['comment'];
$comment = strip_tags($comment);
$comment = preg_replace('/\s+/', ' ', $comment);
$maxCharsPerLine = ($w - $textStartX - 30) / 8; // ~8px per char at font size 4
$wrappedLines = [];
$words = explode(' ', $comment);
$currentLine = '';
foreach ($words as $word) {
    if (strlen($currentLine . ' ' . $word) > $maxCharsPerLine) {
        if ($currentLine) $wrappedLines[] = $currentLine;
        $currentLine = $word;
    } else {
        $currentLine = $currentLine ? $currentLine . ' ' . $word : $word;
    }
    if (count($wrappedLines) >= 12) break; // Max 12 lines
}
if ($currentLine && count($wrappedLines) < 12) $wrappedLines[] = $currentLine;

$lineY = $contentY;
foreach ($wrappedLines as $line) {
    // Check for greentext
    $lineColor = $greenText;
    if (str_starts_with(trim($line), '>')) {
        $lineColor = imagecolorallocate($img, 120, 153, 34); // #789922 greentext
    }
    imagestring($img, 4, $textStartX, $lineY, mb_substr($line, 0, 140), $lineColor);
    $lineY += 20;
    if ($lineY > $h - 80) break;
}

// Bottom bar
imagefilledrectangle($img, 0, $h - 50, $w, $h, $darkPanel);
imageline($img, 0, $h - 50, $w, $h - 50, $greenDark);

// Bottom text
imagestring($img, 3, 30, $h - 38, "/board  |  " . $replyCount . " replies  |  Anonymous Imageboard", $greenMid);

// Frog emoji approximation (green circle with eyes)
$frogX = $w - 60;
$frogY = $h - 35;
imagefilledellipse($img, $frogX, $frogY, 30, 25, $greenBright);
imagefilledellipse($img, $frogX - 5, $frogY - 5, 6, 6, $white);
imagefilledellipse($img, $frogX + 5, $frogY - 5, 6, 6, $white);
imagefilledellipse($img, $frogX - 5, $frogY - 5, 3, 3, $black);
imagefilledellipse($img, $frogX + 5, $frogY - 5, 3, 3, $black);

// Green border around entire image
imagerectangle($img, 0, 0, $w - 1, $h - 1, $greenBright);
imagerectangle($img, 1, 1, $w - 2, $h - 2, $greenDark);

// Save and output
imagepng($img, $cacheFile, 6);
imagedestroy($img);

header('Content-Type: image/png');
header('Cache-Control: public, max-age=300');
readfile($cacheFile);
