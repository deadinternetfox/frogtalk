# FrogTalk operator CLI helpers — source from install scripts only.
# Usage: source "$(dirname "$0")/lib/cli.sh"   (adjust path per script)

[[ -n "${FT_CLI_LOADED:-}" ]] && return 0
FT_CLI_LOADED=1

if [[ -t 1 ]] && [[ -z "${NO_COLOR:-}" ]]; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'
  C_MAGENTA=$'\033[35m'
  C_CYAN=$'\033[36m'
  C_RED=$'\033[31m'
  C_WHITE=$'\033[97m'
  C_BG_GREEN=$'\033[42m'
  C_BG_BLUE=$'\033[44m'
else
  C_RESET= C_BOLD= C_DIM= C_GREEN= C_YELLOW= C_BLUE= C_MAGENTA= C_CYAN= C_RED= C_WHITE= C_BG_GREEN= C_BG_BLUE=
fi

ft_say()     { printf "%b\n" "$*"; }
ft_blank()   { ft_say ""; }

ft_banner() {
  local title="${1:-FrogTalk}"
  local subtitle="${2:-}"
  ft_blank
  ft_say "${C_CYAN}${C_BOLD}  ╔═══════════════════════════════════════════════════════════╗${C_RESET}"
  ft_say "${C_CYAN}${C_BOLD}  ║${C_RESET}  ${C_GREEN}🐸 ${title}${C_RESET}                                          ${C_CYAN}${C_BOLD}║${C_RESET}"
  if [[ -n "$subtitle" ]]; then
    ft_say "${C_CYAN}${C_BOLD}  ║${C_RESET}  ${C_DIM}${subtitle}${C_RESET}  ${C_CYAN}${C_BOLD}║${C_RESET}"
  fi
  ft_say "${C_CYAN}${C_BOLD}  ╚═══════════════════════════════════════════════════════════╝${C_RESET}"
  ft_blank
}

ft_step() {
  ft_say "${C_MAGENTA}${C_BOLD}  ▸ $*${C_RESET}"
  ft_say "${C_DIM}  ─────────────────────────────────────────────────────────${C_RESET}"
}

ft_info()  { ft_say "    ${C_BLUE}ℹ${C_RESET}  $*"; }
ft_ok()    { ft_say "    ${C_GREEN}✔${C_RESET}  $*"; }
ft_warn()  { ft_say "    ${C_YELLOW}⚠${C_RESET}  $*"; }
ft_err()   { ft_say "    ${C_RED}✖${C_RESET}  $*"; }
ft_die()   { ft_err "$*"; exit 1; }
ft_skip()  { ft_say "    ${C_DIM}○  $*${C_RESET}"; }
ft_detail(){ ft_say "       ${C_DIM}$*${C_RESET}"; }
ft_badge() { ft_say "    ${C_BG_BLUE}${C_WHITE} $* ${C_RESET}"; }

ft_success_banner() {
  local msg="${1:-Done.}"
  ft_blank
  ft_say "${C_GREEN}${C_BOLD}  ╭─────────────────────────────────────────────────────────╮${C_RESET}"
  ft_say "${C_GREEN}${C_BOLD}  │${C_RESET}  ${C_BG_GREEN}${C_WHITE} OK ${C_RESET}  ${msg}  ${C_GREEN}${C_BOLD}│${C_RESET}"
  ft_say "${C_GREEN}${C_BOLD}  ╰─────────────────────────────────────────────────────────╯${C_RESET}"
  ft_blank
}

ft_require_cmd() {
  command -v "$1" >/dev/null 2>&1 || ft_die "Missing required command: $1"
}

ft_ask() {
  local prompt="$1" default="${2:-}" answer=""
  if [[ "${FT_ASSUME_YES:-0}" -eq 1 && -n "$default" ]]; then
    printf "%s" "$default"
    return 0
  fi
  if [[ -n "$default" ]]; then
    read -r -p "    ${C_CYAN}?${C_RESET} ${prompt} [${C_DIM}${default}${C_RESET}]: " answer
    printf "%s" "${answer:-$default}"
  else
    read -r -p "    ${C_CYAN}?${C_RESET} ${prompt}: " answer
    printf "%s" "$answer"
  fi
}

ft_ask_yes_no() {
  local prompt="$1" default="${2:-y}" answer=""
  if [[ "${FT_ASSUME_YES:-0}" -eq 1 ]]; then
    [[ "$default" =~ ^[Yy]$ ]]
    return
  fi
  if [[ "$default" == "y" ]]; then
    answer="$(ft_ask "$prompt (Y/n)" "y")"
  else
    answer="$(ft_ask "$prompt (y/N)" "n")"
  fi
  [[ "$answer" =~ ^[Yy]$ ]]
}

ft_set_env_value() {
  local file="$1" key="$2" value="$3"
  if [[ "${FT_DRY_RUN:-0}" -eq 1 ]]; then
    ft_detail "[dry-run] ${key}=${value}"
    return 0
  fi
  if grep -qE "^${key}=" "$file" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf "\n%s=%s\n" "$key" "$value" >>"$file"
  fi
}

ft_load_env_file() {
  local f="$1"
  [[ -f "$f" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" ]] && continue
    [[ "$line" != *=* ]] && continue
    export "$line" 2>/dev/null || true
  done <"$f"
}

ft_resolve_install_dir() {
  local default="${1:-/opt/frogtalk}"
  local hint="${2:-}"
  if [[ -n "$hint" && -d "$hint" ]]; then
    (cd "$hint" && pwd)
    return 0
  fi
  if [[ -d "$default" ]]; then
    (cd "$default" && pwd)
    return 0
  fi
  local script_root
  script_root="$(cd "$(dirname "${BASH_SOURCE[1]:-$0}")/../.." 2>/dev/null && pwd)" || true
  if [[ -n "$script_root" && -f "$script_root/node/main.py" ]]; then
    (cd "$script_root/.." && pwd)
    return 0
  fi
  printf "%s" "$default"
}

ft_detect_api_port() {
  local install_dir="$1"
  ft_load_env_file "$install_dir/.env"
  local port="${PORT:-8080}"
  local try_port
  for try_port in "$port" 8080 8000; do
    if curl -sf -m 3 "http://127.0.0.1:${try_port}/api/ping" >/dev/null 2>&1; then
      printf "%s" "$try_port"
      return 0
    fi
  done
  printf "%s" "${port}"
}
