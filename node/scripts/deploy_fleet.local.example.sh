# Maintainer-only fleet deploy (gitignored copy: deploy_fleet.local.sh).
# Normal node operators never need this — use install.sh setup + federation.
#
#   cp node/scripts/deploy_fleet.local.example.sh node/scripts/deploy_fleet.local.sh
#   $EDITOR node/scripts/deploy_fleet.local.sh
#
# Host format: IP or hostname:ssh_port
export FLEET_HOSTS=(
  "your.main.server:22"
  "your.tor.relay:2222"
)

# Optional password SSH (requires sshpass). Keys are preferred.
declare -A FLEET_SSH_PASS=(
  # ["your.vps.ip"]="only-if-keyless"
)

export FLEET_SSH_USER="${FLEET_SSH_USER:-root}"
export FLEET_SSH_KEY="${FLEET_SSH_KEY:-$HOME/.ssh/id_ed25519}"
