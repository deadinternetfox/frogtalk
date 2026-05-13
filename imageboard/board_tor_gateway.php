<?php
/**
 * Tor-only Board Gateway — shown to clearnet visitors when this node is
 * configured tor_only and the request didn't arrive over Tor.
 *
 * Expects in scope:
 *   $info     — result of getBoardInfo()
 *   $settings — current settings array
 *
 * Also surfaces a few clearnet-safe peer boards so the visitor isn't
 * dead-ended: federated peers that are NOT tor-only are listed.
 */
$onion = trim((string)($settings['tor_onion_url'] ?? ''));
$onionHost = '';
if ($onion !== '') {
    $parts = parse_url($onion);
    $onionHost = $parts['host'] ?? $onion;
}
$clearnetPeers = array_values(array_filter(getFederatedPeers(false), fn($p) => empty($p['tor_only'])));
header('Cache-Control: no-store');
?><!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title><?= htmlspecialchars($info['title']) ?> — Tor-only board</title>
<style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
        margin: 0; min-height: 100vh;
        background: radial-gradient(ellipse at top, #1a0b1f 0%, #0a0a0f 70%);
        color: #e8d4f0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        display: flex; align-items: center; justify-content: center;
        padding: 32px 20px;
    }
    .gw-card {
        max-width: 640px; width: 100%;
        background: rgba(20, 10, 30, 0.75);
        border: 1px solid rgba(155, 89, 182, 0.35);
        border-radius: 16px;
        padding: 36px 32px;
        box-shadow: 0 12px 48px rgba(120, 60, 180, 0.18);
        backdrop-filter: blur(12px);
    }
    .gw-icon {
        font-size: 64px; line-height: 1; text-align: center; margin-bottom: 12px;
        filter: drop-shadow(0 0 18px rgba(155, 89, 182, 0.6));
    }
    h1 {
        font-size: 24px; text-align: center; margin: 0 0 6px;
        color: #d8b4f0; letter-spacing: 0.5px;
    }
    .gw-subtitle {
        text-align: center; color: #9c89b8; font-size: 13px; margin: 0 0 24px;
        font-family: "SFMono-Regular", Menlo, monospace;
    }
    .gw-node-id {
        text-align: center; color: #6f5b85; font-size: 11px;
        font-family: "SFMono-Regular", Menlo, monospace;
        margin: -16px 0 24px; letter-spacing: 0.5px;
    }
    .gw-explainer {
        background: rgba(155, 89, 182, 0.06);
        border-left: 3px solid rgba(155, 89, 182, 0.5);
        padding: 14px 16px; border-radius: 8px;
        font-size: 14px; line-height: 1.55; margin-bottom: 24px;
        color: #c9b8d6;
    }
    .gw-explainer strong { color: #d8b4f0; }
    .gw-steps {
        list-style: none; counter-reset: step; padding: 0; margin: 0 0 24px;
    }
    .gw-steps li {
        counter-increment: step;
        padding: 12px 16px 12px 52px; position: relative;
        background: rgba(40, 20, 60, 0.4);
        border: 1px solid rgba(155, 89, 182, 0.15);
        border-radius: 10px; margin-bottom: 10px;
        font-size: 14px; line-height: 1.5;
    }
    .gw-steps li::before {
        content: counter(step);
        position: absolute; left: 14px; top: 50%; transform: translateY(-50%);
        width: 28px; height: 28px; border-radius: 50%;
        background: linear-gradient(135deg, #9b59b6, #6b3e8a);
        color: #fff; display: flex; align-items: center; justify-content: center;
        font-weight: bold; font-size: 13px;
        box-shadow: 0 2px 8px rgba(155, 89, 182, 0.4);
    }
    .gw-onion {
        display: flex; gap: 8px; align-items: stretch; margin: 10px 0 4px;
        background: #0a0a14; border: 1px solid rgba(155, 89, 182, 0.4);
        border-radius: 8px; padding: 8px 12px;
        font-family: "SFMono-Regular", Menlo, monospace; font-size: 12px;
        word-break: break-all;
    }
    .gw-onion code { flex: 1; color: #d8b4f0; }
    .gw-onion button {
        background: rgba(155, 89, 182, 0.2); border: 1px solid rgba(155, 89, 182, 0.5);
        color: #d8b4f0; padding: 4px 12px; border-radius: 6px;
        cursor: pointer; font-size: 11px; font-family: inherit; white-space: nowrap;
        transition: all 0.15s;
    }
    .gw-onion button:hover { background: rgba(155, 89, 182, 0.35); }
    .gw-onion button.copied { background: rgba(80, 200, 120, 0.25); border-color: rgba(80, 200, 120, 0.6); color: #b8f0c8; }
    .gw-actions {
        display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; margin: 20px 0 6px;
    }
    .gw-btn {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 10px 20px; border-radius: 8px; text-decoration: none;
        font-weight: 600; font-size: 13px; transition: all 0.15s;
    }
    .gw-btn-primary {
        background: linear-gradient(135deg, #9b59b6, #6b3e8a);
        color: #fff; box-shadow: 0 4px 14px rgba(155, 89, 182, 0.35);
    }
    .gw-btn-primary:hover { transform: translateY(-1px); box-shadow: 0 6px 20px rgba(155, 89, 182, 0.5); }
    .gw-btn-secondary {
        background: rgba(155, 89, 182, 0.1); color: #d8b4f0;
        border: 1px solid rgba(155, 89, 182, 0.4);
    }
    .gw-btn-secondary:hover { background: rgba(155, 89, 182, 0.2); }
    .gw-peers {
        margin-top: 28px; padding-top: 20px;
        border-top: 1px solid rgba(155, 89, 182, 0.15);
    }
    .gw-peers h3 {
        font-size: 12px; text-transform: uppercase; letter-spacing: 1.5px;
        color: #9c89b8; margin: 0 0 12px; font-weight: 600;
    }
    .gw-peer-list { display: flex; flex-direction: column; gap: 6px; }
    .gw-peer {
        display: flex; justify-content: space-between; align-items: center; gap: 8px;
        padding: 10px 14px; background: rgba(40, 20, 60, 0.3);
        border: 1px solid rgba(155, 89, 182, 0.12); border-radius: 8px;
        text-decoration: none; color: #c9b8d6; font-size: 13px;
        transition: all 0.15s;
    }
    .gw-peer:hover { background: rgba(155, 89, 182, 0.12); border-color: rgba(155, 89, 182, 0.35); }
    .gw-peer-title { color: #d8b4f0; font-weight: 600; }
    .gw-peer-node { font-family: "SFMono-Regular", Menlo, monospace; font-size: 10px; color: #6f5b85; }
    .gw-foot { text-align: center; margin-top: 24px; font-size: 11px; color: #6f5b85; }
    .gw-foot a { color: #9c89b8; }
</style>
</head>
<body>
    <main class="gw-card">
        <div class="gw-icon">🧅</div>
        <h1><?= htmlspecialchars($info['title']) ?></h1>
        <p class="gw-subtitle"><?= htmlspecialchars($info['subtitle'] ?: 'A privacy-first FrogTalk imageboard') ?></p>
        <p class="gw-node-id">node @<?= htmlspecialchars($info['node_id']) ?><?php if (!empty($info['topic'])): ?> · #<?= htmlspecialchars($info['topic']) ?><?php endif; ?></p>

        <div class="gw-explainer">
            <strong>This board only accepts connections over Tor.</strong>
            That's deliberate — the operator runs it as a Tor hidden service so visitors can browse without
            their IP address ever being logged. The clearnet address you used isn't allowed in.
        </div>

        <ol class="gw-steps">
            <li><strong>Install <a href="https://www.torproject.org/download/" target="_blank" rel="noopener" style="color:#d8b4f0;">Tor Browser</a></strong> (or use a system Tor proxy if you know what you're doing).</li>
            <li>
                Open the board at its onion address:
                <?php if ($onion !== ''): ?>
                <div class="gw-onion">
                    <code id="gw-onion-code"><?= htmlspecialchars($onion) ?></code>
                    <button type="button" id="gw-copy-btn" onclick="gwCopyOnion()">Copy</button>
                </div>
                <?php else: ?>
                <div class="gw-onion"><code>(the operator hasn't published an onion address yet — check back later)</code></div>
                <?php endif; ?>
            </li>
            <li>Tor Browser will load the board with the same look and feel — minus the IP exposure.</li>
        </ol>

        <div class="gw-actions">
            <?php if ($onion !== ''): ?>
            <a class="gw-btn gw-btn-primary" href="<?= htmlspecialchars($onion) ?>" rel="noopener">🧅 Open onion link</a>
            <?php endif; ?>
            <a class="gw-btn gw-btn-secondary" href="https://www.torproject.org/download/" target="_blank" rel="noopener">⬇ Get Tor Browser</a>
        </div>

        <?php if (!empty($clearnetPeers)): ?>
        <div class="gw-peers">
            <h3>Browse other FrogTalk boards (clearnet)</h3>
            <div class="gw-peer-list">
                <?php foreach (array_slice($clearnetPeers, 0, 6) as $cp): ?>
                <a class="gw-peer" href="<?= htmlspecialchars($cp['url']) ?>" target="_blank" rel="noopener">
                    <span class="gw-peer-title"><?= htmlspecialchars($cp['title']) ?></span>
                    <span class="gw-peer-node">@<?= htmlspecialchars($cp['node_id']) ?><?php if (!empty($cp['topic'])): ?> · #<?= htmlspecialchars($cp['topic']) ?><?php endif; ?></span>
                </a>
                <?php endforeach; ?>
            </div>
        </div>
        <?php endif; ?>

        <p class="gw-foot">
            FrogTalk · federated imageboard ·
            <a href="https://frogtalk.xyz/" target="_blank" rel="noopener">frogtalk.xyz</a>
        </p>
    </main>
<script>
function gwCopyOnion(){
    var code = document.getElementById('gw-onion-code');
    var btn  = document.getElementById('gw-copy-btn');
    if (!code || !btn) return;
    var text = code.textContent.trim();
    var done = function(){
        btn.textContent = 'Copied ✓';
        btn.classList.add('copied');
        setTimeout(function(){ btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function(){
            var r = document.createRange(); r.selectNode(code);
            window.getSelection().removeAllRanges();
            window.getSelection().addRange(r);
            try { document.execCommand('copy'); done(); } catch(e) {}
            window.getSelection().removeAllRanges();
        });
    } else {
        var r = document.createRange(); r.selectNode(code);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(r);
        try { document.execCommand('copy'); done(); } catch(e) {}
        window.getSelection().removeAllRanges();
    }
}
</script>
</body>
</html>
