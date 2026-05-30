# Securing a FrogTalk node — free, full setup

Practical, no-cost hardening for anyone self-hosting a FrogTalk node on a public
Linux VPS (Ubuntu/Debian assumed). None of this needs a paid product. Pairs with
[`operator-security.md`](operator-security.md) (app-level secrets & scaling).

> The boring truth: on a Linux server, **antivirus is not the main layer.**
> Firewalling, patching, intrusion detection and least-privilege matter far more.
> This guide is ordered by bang-for-buck.

---

## 0. Threat model in one line
Your node holds ciphertext + routing metadata + the operator's keys. Goals, in
order: (1) keep attackers off the box, (2) detect and auto-ban the ones who try,
(3) patch fast, (4) make a compromise survivable, (5) be able to destroy it.

---

## 1. Firewall — `ufw` (must-have)
Default-deny inbound, allow only what the node serves.

```bash
apt-get install -y ufw
ufw allow 22/tcp            # SSH (use your real SSH port!)
ufw allow 80/tcp            # HTTP (or skip if everything is behind a Cloudflare tunnel)
ufw allow 443/tcp           # HTTPS
ufw allow 8080/tcp          # nginx app/board upstream, if exposed
# TURN (only if this node runs coturn for calls):
ufw allow 3478/tcp; ufw allow 3478/udp; ufw allow 49152:65535/udp
ufw default deny incoming
ufw default allow outgoing
ufw --force enable
```

**Don't lock yourself out.** Allow your SSH port *before* `enable`, and keep a
second session open to verify. A safe pattern is to arm an auto-revert first:

```bash
systemd-run --on-active=300 --unit=ufw-safety --collect ufw --force disable
ufw --force enable
# open a NEW ssh session; if it works:
systemctl stop ufw-safety.timer
```

A Cloudflare-tunnelled node (cloudflared, outbound-only) often needs **only SSH**
inbound — the tunnel makes the web ports outbound.

## 2. Brute-force defence — `fail2ban` (must-have, zero risk)
```bash
apt-get install -y fail2ban
systemctl enable --now fail2ban
```
The default `sshd` jail is on out of the box. Add nginx jails if you expose it.

## 3. Intrusion detection + edge blocking — CrowdSec (must-have)
CrowdSec watches your logs, decides who's malicious (with crowd-sourced
intelligence), and a **bouncer** enforces the bans. It's the modern step up from
fail2ban and it's free.

```bash
curl -s https://install.crowdsec.net | sh
apt-get install -y crowdsec
# enforcement at the host firewall (nftables):
apt-get install -y crowdsec-firewall-bouncer-nftables
# detection content for this stack:
cscli collections install crowdsecurity/linux crowdsecurity/sshd crowdsecurity/nginx
systemctl enable --now crowdsec crowdsec-firewall-bouncer
```

> **Port-clash gotcha:** CrowdSec's local API defaults to `127.0.0.1:8080`, which
> **collides with FrogTalk's nginx**. Move it: set `127.0.0.1:8083` in
> `/etc/crowdsec/config.yaml` (`api.server.listen_uri`),
> `/etc/crowdsec/local_api_credentials.yaml` (`url`), and the bouncer yaml under
> `/etc/crowdsec/bouncers/`, then `systemctl restart crowdsec crowdsec-firewall-bouncer`.

Useful free bouncers depending on what the node runs:
- **`crowdsec-firewall-bouncer-nftables`** — drops banned IPs at the kernel. Always install this.
- **nginx bouncer** (`crowdsec-nginx-bouncer`) — application-layer block/captcha at the reverse proxy in front of the app.
- **PHP bouncer** (`crowdsec-php-bouncer`) — protects the PHP imageboard directly.
- **Cloudflare / Cloudflare Workers bouncer** — if your zone is on Cloudflare, block at the edge before traffic reaches the box (needs a Workers-scoped CF API token; Workers KV works best on a paid plan).

The other CrowdSec remediation components (AWS WAF, Fastly, HAProxy, Traefik,
Ingress-Nginx, Magento, WordPress, Windows Firewall, …) don't apply to a stock
FrogTalk node — skip them.

## 4. Automatic patching — `unattended-upgrades` (must-have)
```bash
apt-get install -y unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades   # enable security auto-updates
```

## 5. SSH hardening
- Prefer **key-based auth**; once your key works, set `PasswordAuthentication no`
  (only after you've confirmed key login — and remember any password-based deploy
  tooling will break).
- Move SSH off port 22 to cut log noise.
- Keep `PermitRootLogin` to `prohibit-password` (key-only) where possible.
- fail2ban + CrowdSec already blunt SSH brute-force if you must keep passwords.

## 6. Least privilege
Run FrogTalk as a dedicated **non-root** user (the installer uses `deploy`).
The systemd unit should never be `User=root`. The node self-destruct (below) uses
a tightly-scoped `sudoers` rule rather than running the app as root.

## 7. Strip the box to "just a FrogTalk node"
Fewer packages = smaller attack surface.
- Remove desktop/bloat: `apt purge snapd` (and any firefox/thunderbird/gnome snaps), `xserver-common`.
- Disable hardware daemons useless on a VPS: `systemctl disable --now ModemManager fwupd multipathd udisks2 upower`.
- **Remove anything that isn't FrogTalk.** If you find Docker containers, VPN/proxy
  software (xray, WireGuard tunnels, Remnawave/Amnezia, etc.) you didn't install,
  treat it as a possible compromise — investigate before wiping.
- Keep `build-essential`/`gcc` if you build the Tor vanity address (`mkp224o`) or pip C-extensions.

## 8. Privacy-respecting monitoring
Watch metrics, never content: SSH/CrowdSec ban counts, SQLite lock-waits, WS
throttles, federation signature failures, 5xx rate, TURN bandwidth, disk. Never
log message bodies or DM metadata; hash IPs in any log you keep.

---

## 9. Danger Zone — node self-destruct ("nuke")
The `/server` admin panel has a **Danger Zone → Nuke this node** button for when a
node must be destroyed (decommission, seizure risk, confirmed compromise).

How it's gated (so it can't fire by accident or by a lone stolen cookie):
1. Authenticated **node-admin** session, and
2. a **fresh PIN re-entry** (or account password if no PIN is set — with the same
   bcrypt + lockout as everywhere else), and
3. the operator must **type the node's exact name**, and
4. a final browser confirmation.

What it does (`/usr/local/sbin/frogtalk-nuke.sh`, run via a narrow sudoers grant):
stops all services → **shreds** the DB, secrets, keys, uploads, board data, `.env`,
and the Tor hidden-service identity → removes the whole install (itself included)
→ best-effort overwrites free RAM (`sdmem`) and drops caches → vacuums the journal
→ powers the box off. A **paranoid** toggle also overwrites free disk space (`sfill`).

Install the helper (one-time, as root) so the full wipe is available:
```bash
install -o root -g root -m 0500 node/deploy/frogtalk-nuke.sh /usr/local/sbin/frogtalk-nuke.sh
install -o root -g root -m 0440 node/deploy/frogtalk-nuke.sudoers /etc/sudoers.d/frogtalk-nuke
visudo -cf /etc/sudoers.d/frogtalk-nuke          # validate
apt-get install -y secure-delete                  # provides sdmem/sfill (RAM/disk shred)
```
Without the helper the button still runs in a **degraded** mode (it shreds the app
data it owns, no poweroff/RAM-shred).

**Honest limits** — say this to yourself before relying on it:
- On **SSD/NVMe**, wear-levelling means an in-place overwrite isn't guaranteed to hit
  the original cells. For a hard guarantee, also issue an ATA/NVMe secure-erase or
  have the VPS provider destroy the disk afterwards.
- "Shred RAM" can only overwrite **free** RAM + drop caches from userspace; the
  power-off then removes the charge. Cold-boot attacks remain a theoretical edge case.
- It wipes **this node only** — by design it never touches peers.
