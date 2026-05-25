#!/usr/bin/env bash
set -euo pipefail
INSTALL="${FT_INSTALL_DIR:-/opt/frogtalk}"
export FROGTALK_HOME_PAGE
FROGTALK_HOME_PAGE="$(grep -m1 '^FROGTALK_HOME_PAGE=' "$INSTALL/.env" 2>/dev/null | cut -d= -f2- || echo main)"
bash "$INSTALL/node/scripts/configure_board_identity.sh" --install-dir "$INSTALL" 2>/dev/null || true
export BOARD_URLS
php -d display_errors=0 <<'PHP'
<?php
$urls = array_filter(array_map('trim', explode(',', getenv('BOARD_URLS') ?: '')));
chdir('/opt/frogtalk/node/board');
require '/opt/frogtalk/node/board/board_config.php';
$s = loadSettings();
$s['federation_enabled'] = true;
saveSettings($s);
foreach ($urls as $u) {
    if ($u === '') continue;
    [$ok, $msg] = upsertFederatedPeer($u);
    echo ($ok ? 'OK' : 'FAIL') . " $u — $msg\n";
}
echo 'REFRESH ' . refreshFederatedPeers() . "\n";
PHP
