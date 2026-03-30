#!/usr/bin/env bash
set -euo pipefail
trap 'echo ""; echo "[install] Interrupted"; exit 130' INT TERM

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCH_FILE="$REPO_DIR/patches/codex-statusline-command.patch"
INSTALL_BIN_DIR="$HOME/.local/bin"
PATCH_STATE_DIR_NAME=".powerbar"
PATCH_STATE_FILE_NAME="applied-statusline-command.patch"
INTERACTIVE=1
ACTION="full"
CODEX_REPO_OVERRIDE=""
FAST_BUILD=0
REFERENCE_CODEX_VERSION=""
PREBUILT_RELEASE_REPO="Qifei-C/codex-powerbar"
PREBUILT_RELEASE_TAG="codex-v0.117.0"
# Keep source builds pinned to the stable upstream release that the patch file targets.
SOURCE_BUILD_CODEX_REF="rust-v0.117.0"
FORCE_SOURCE_BUILD=0
FORCE_UPDATE=0
REPAIR_INSTALL=0
INSTALL_MUTATED=0
POWERBAR_STATE_DIR="$HOME/.powerbar"
POWERBAR_RUNTIME_DIR="$POWERBAR_STATE_DIR/dist"
POWERBAR_MANIFEST_PATH="$POWERBAR_STATE_DIR/manifest.json"
EXPECTED_STATUS_LINE='status_line = ["model-name", "model-with-reasoning", "current-dir", "project-root", "git-branch", "context-remaining", "context-used", "five-hour-limit", "weekly-limit", "fast-mode", "context-window-size"]'
EXPECTED_STATUS_CMD='status_line_command = "node '"$HOME"'/.powerbar/dist/index.js --status-line --once --no-clear --cwd \\\"$PWD\\\""'

print_step() {
  printf '\n[install] %s\n' "$1"
}

fatal() {
  echo "[install] ERROR: $1" >&2
  exit 1
}

capture_process_snapshot() {
  if [[ -n "${POWERBAR_PS_OUTPUT_OVERRIDE:-}" ]]; then
    printf '%s\n' "$POWERBAR_PS_OUTPUT_OVERRIDE"
    return 0
  fi

  if ps axww -o pid= -o command= >/dev/null 2>&1; then
    ps axww -o pid= -o command=
    return 0
  fi

  if ps -eo pid=,command= >/dev/null 2>&1; then
    ps -eo pid=,command=
    return 0
  fi

  if ps aux >/dev/null 2>&1; then
    ps aux | awk 'NR > 1 { print }'
    return 0
  fi

  if ps auxww >/dev/null 2>&1; then
    ps auxww | awk 'NR > 1 { print }'
    return 0
  fi

  return 1
}

filter_running_codex_processes() {
  grep -E '(^|[[:space:]/])codex([[:space:]]|$)|(^|[[:space:]/])codex-cli([[:space:]]|$)|@openai/codex' || true
}

list_running_codex_processes() {
  local snapshot
  snapshot="$(capture_process_snapshot 2>/dev/null || true)"
  [[ -n "$snapshot" ]] || return 0
  printf '%s\n' "$snapshot" | filter_running_codex_processes
}

ensure_codex_not_running() {
  local running
  running="$(list_running_codex_processes)"
  [[ -z "$running" ]] && return 0

  print_step "Refusing to modify Codex while it is running"
  printf '%s\n' "$running" | sed 's/^/  /'
  echo ""
  fatal "Quit all Codex sessions and rerun install.sh. This script replaces/removes the codex binary and updates ~/.codex/config.toml."
}

print_usage() {
  cat <<'USAGE'
Usage: ./install.sh [--full] [--source] [--fast] [--force] [--repair] [--uninstall] [--help]

Modes:
  default            Interactive guided setup (recommended)
  --full             One-shot full install (prebuilt binary, no prompts)
  --source           Build patched codex from source instead of downloading
  --fast             Use faster Rust build profile (thin LTO, only with --source)
  --force            Rebuild/reinstall all managed components even if unchanged
  --repair           Full repair reinstall of all managed components (useful after a broken install)
  --uninstall        Remove patched codex binary, restore config, clean PATH entries

Interactive choices:
  1. Full install (prebuilt)      Download prebuilt binary + build HUD + configure
  2. Full install (from source)   Build codex from source + build HUD + configure
  3. Build HUD only               Rebuild powerbar dist/
  4. Build HUD + update config    Rebuild HUD and wire status_line_command
  5. Repair install               Reinstall powerbar, config, and patched codex from scratch
USAGE
}

prompt_with_default() {
  local prompt="$1"
  local default_value="${2:-}"
  local reply

  if [[ -n "$default_value" ]]; then
    read -r -p "$prompt [$default_value]: " reply
    if [[ -z "$reply" ]]; then
      reply="$default_value"
    fi
  else
    read -r -p "$prompt: " reply
  fi

  printf '%s\n' "$reply"
}

confirm_prompt() {
  local prompt="$1"
  local default_answer="${2:-Y}"
  local reply
  local suffix="[Y/n]"
  if [[ "$default_answer" =~ ^[Nn]$ ]]; then
    suffix="[y/N]"
  fi

  read -r -p "$prompt $suffix " reply
  if [[ -z "$reply" ]]; then
    reply="$default_answer"
  fi

  [[ "$reply" =~ ^[Yy]$ ]]
}

ensure_command() {
  local cmd="$1"
  local hint="${2:-Install '$cmd' and rerun install.sh}"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    fatal "$hint"
  fi
}

parse_codex_version() {
  local text="$1"
  if [[ "$text" =~ codex-cli[[:space:]]+([0-9]+(\.[0-9]+){1,2}([-.][A-Za-z0-9.-]+)?) ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
  fi
}

codex_version_from_binary() {
  local binary="$1"
  [[ -x "$binary" ]] || return 0
  local output
  output="$("$binary" --version 2>/dev/null || true)"
  parse_codex_version "$output"
}

find_reference_codex_version() {
  local -a candidates=()
  local line

  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    candidates+=("$line")
  done < <(type -a -p codex 2>/dev/null | awk '!seen[$0]++')

  if [[ -d "$INSTALL_BIN_DIR" ]]; then
    local backup
    backup="$(ls -t "$INSTALL_BIN_DIR"/codex.backup.* 2>/dev/null | head -1 || true)"
    if [[ -n "$backup" ]]; then
      candidates+=("$backup")
    fi
  fi

  local candidate
  for candidate in "${candidates[@]}"; do
    [[ -x "$candidate" ]] || continue
    if [[ "$candidate" == "$INSTALL_BIN_DIR/codex" ]]; then
      continue
    fi
    local version
    version="$(codex_version_from_binary "$candidate")"
    if [[ -n "$version" && "$version" != "0.0.0" ]]; then
      printf '%s\n' "$version"
      return 0
    fi
  done

  # Fallback: query the npm registry for the latest published version.
  local npm_version
  npm_version="$(curl -sf --max-time 5 "https://registry.npmjs.org/@openai/codex/latest" 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('version',''))" 2>/dev/null || true)"
  if [[ -n "$npm_version" && "$npm_version" != "0.0.0" ]]; then
    printf '%s\n' "$npm_version"
    return 0
  fi

  return 0
}

align_codex_workspace_version() {
  local codex_repo="$1"
  local version="$2"
  [[ -n "$version" ]] || return 0

  local cargo_toml="$codex_repo/codex-rs/Cargo.toml"
  [[ -f "$cargo_toml" ]] || return 0

  local current
  current="$(
    awk '
      $0=="[workspace.package]" { in_section=1; next }
      /^\[/ && in_section { exit }
      in_section && $1=="version" && $2=="=" {
        gsub(/"/, "", $3)
        print $3
        exit
      }
    ' "$cargo_toml"
  )"

  if [[ "$current" == "$version" ]]; then
    return 0
  fi

  local tmp
  tmp="$(mktemp)"
  awk -v v="$version" '
    BEGIN { in_section=0 }
    $0=="[workspace.package]" { in_section=1; print; next }
    /^\[/ && in_section { in_section=0 }
    in_section && $1=="version" && $2=="=" {
      print "version = \"" v "\""
      next
    }
    { print }
  ' "$cargo_toml" > "$tmp"
  mv "$tmp" "$cargo_toml"
  print_step "Aligned patched Codex version to $version"
}

ensure_rust_toolchain() {
  if command -v cargo >/dev/null 2>&1; then
    return 0
  fi

  print_step "Rust toolchain not found. Installing via rustup"
  ensure_command curl "curl is required to install Rust (install curl first)"
  curl https://sh.rustup.rs -sSf | sh -s -- -y

  if [[ -f "$HOME/.cargo/env" ]]; then
    # shellcheck disable=SC1090
    . "$HOME/.cargo/env"
  fi
  ensure_command cargo "cargo still not found after rustup install"
}

ensure_linux_build_deps() {
  if [[ "$(uname -s)" != "Linux" ]]; then
    return 0
  fi

  local missing=0
  command -v clang >/dev/null 2>&1 || missing=1
  command -v clang++ >/dev/null 2>&1 || missing=1
  command -v pkg-config >/dev/null 2>&1 || missing=1
  command -v cmake >/dev/null 2>&1 || missing=1
  command -v make >/dev/null 2>&1 || missing=1

  if command -v pkg-config >/dev/null 2>&1; then
    pkg-config --exists libcap || missing=1
    pkg-config --exists libseccomp || missing=1
  fi

  if [[ $missing -eq 0 ]]; then
    return 0
  fi

  print_step "Installing Linux build deps (clang/cmake/pkg-config/libcap/libseccomp)"
  local run_as_root=()
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    if command -v sudo >/dev/null 2>&1; then
      run_as_root=(sudo)
    else
      fatal "Need root or sudo to install packages. Install clang/cmake/pkg-config/libcap/libseccomp manually and rerun."
    fi
  fi

  if command -v apt-get >/dev/null 2>&1; then
    "${run_as_root[@]}" apt-get update
    "${run_as_root[@]}" apt-get install -y clang build-essential cmake pkg-config libcap-dev libseccomp-dev
  elif command -v dnf >/dev/null 2>&1; then
    "${run_as_root[@]}" dnf install -y clang clang-tools-extra gcc gcc-c++ make cmake pkgconf-pkg-config libcap-devel libseccomp-devel
  elif command -v pacman >/dev/null 2>&1; then
    "${run_as_root[@]}" pacman -Sy --noconfirm clang base-devel cmake pkgconf libcap libseccomp
  elif command -v zypper >/dev/null 2>&1; then
    "${run_as_root[@]}" zypper --non-interactive install clang gcc gcc-c++ make cmake pkg-config libcap-devel libseccomp-devel
  else
    fatal "Unsupported package manager. Install clang/cmake/pkg-config/libcap/libseccomp manually and rerun."
  fi

  command -v pkg-config >/dev/null 2>&1 || fatal "pkg-config not found after dependency install"
  pkg-config --exists libcap || fatal "libcap not visible via pkg-config after dependency install"
  pkg-config --exists libseccomp || fatal "libseccomp not visible via pkg-config after dependency install"
}

ensure_local_bin_precedence() {
  mkdir -p "$INSTALL_BIN_DIR"
  export PATH="$INSTALL_BIN_DIR:$PATH"

  local marker_start="# >>> powerbar path >>>"
  local marker_end="# <<< powerbar path <<<"
  local line='export PATH="$HOME/.local/bin:$PATH"'
  local rc_files=("$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile" "$HOME/.bash_profile")

  for rc in "${rc_files[@]}"; do
    if [[ ! -f "$rc" ]]; then
      continue
    fi
    if grep -Fq "$marker_start" "$rc"; then
      continue
    fi
    {
      echo ""
      echo "$marker_start"
      echo "$line"
      echo "$marker_end"
    } >> "$rc"
  done
}

get_repo_powerbar_version() {
  python3 - "$REPO_DIR/package.json" <<'PY'
import json
import sys

with open(sys.argv[1], 'r', encoding='utf8') as handle:
    print(json.load(handle).get('version', ''))
PY
}

read_manifest_field() {
  local field="$1"
  if [[ ! -f "$POWERBAR_MANIFEST_PATH" ]]; then
    return 0
  fi

  python3 - "$POWERBAR_MANIFEST_PATH" "$field" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], 'r', encoding='utf8') as handle:
        data = json.load(handle)
    value = data.get(sys.argv[2], '')
    if value is None:
        value = ''
    print(value)
except Exception:
    pass
PY
}

manifest_is_current() {
  local powerbar_version="$1"
  local codex_patch_version="$2"
  [[ -f "$POWERBAR_MANIFEST_PATH" ]] || return 1
  [[ "$(read_manifest_field powerbarVersion)" == "$powerbar_version" ]] || return 1
  [[ "$(read_manifest_field codexPatchVersion)" == "$codex_patch_version" ]]
}

write_manifest() {
  local powerbar_version="$1"
  local codex_patch_version="$2"
  local installed_at
  installed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  mkdir -p "$POWERBAR_STATE_DIR"
  python3 - "$POWERBAR_MANIFEST_PATH" "$powerbar_version" "$codex_patch_version" "$installed_at" <<'PY'
import json
import os
import sys

manifest_path, powerbar_version, codex_patch_version, installed_at = sys.argv[1:5]
payload = {
    'powerbarVersion': powerbar_version,
    'codexPatchVersion': codex_patch_version,
    'installedAt': installed_at,
}
tmp_path = f'{manifest_path}.tmp'
with open(tmp_path, 'w', encoding='utf8') as handle:
    json.dump(payload, handle, indent=2)
    handle.write('\n')
os.replace(tmp_path, manifest_path)
PY
}

ensure_manifest() {
  local powerbar_version="$1"
  local codex_patch_version="$2"

  if [[ "$FORCE_UPDATE" -eq 0 ]] && manifest_is_current "$powerbar_version" "$codex_patch_version"; then
    return 1
  fi

  write_manifest "$powerbar_version" "$codex_patch_version"
  return 0
}

powerbar_runtime_is_current() {
  local repo_version="$1"
  [[ "$FORCE_UPDATE" -eq 0 ]] || return 1
  [[ -f "$POWERBAR_RUNTIME_DIR/index.js" ]] || return 1
  [[ "$(read_manifest_field powerbarVersion)" == "$repo_version" ]]
}

codex_patch_is_current() {
  [[ "$FORCE_UPDATE" -eq 0 ]] || return 1
  [[ -x "$INSTALL_BIN_DIR/codex" ]] || return 1
  [[ "$(read_manifest_field codexPatchVersion)" == "$PREBUILT_RELEASE_TAG" ]]
}

codex_config_is_current() {
  local config="$HOME/.codex/config.toml"
  [[ "$FORCE_UPDATE" -eq 0 ]] || return 1
  [[ -f "$config" ]] || return 1

  local current_cmd
  current_cmd="$(
    awk '
      /^[[:space:]]*status_line_command[[:space:]]*=/ {
        sub(/^[[:space:]]*/, "", $0)
        print
        exit
      }
    ' "$config"
  )"
  [[ "$current_cmd" == "$EXPECTED_STATUS_CMD" ]] || return 1

  grep -q '^[[:space:]]*status_line[[:space:]]*=' "$config"
}

ensure_powerbar_runtime() {
  local repo_version="$1"

  if powerbar_runtime_is_current "$repo_version"; then
    print_step "Powerbar runtime already at v$repo_version — skipping build/install"
    return 1
  fi

  build_hud
  install_powerbar_cli
  return 0
}

ensure_codex_config() {
  if codex_config_is_current; then
    print_step "Codex status-line config already current — skipping configure"
    return 1
  fi

  configure_codex
  return 0
}

ensure_codex_patch() {
  if codex_patch_is_current; then
    print_step "Patched codex already at $PREBUILT_RELEASE_TAG — skipping install"
    verify_installed_codex
    return 1
  fi

  if try_download_prebuilt; then
    verify_installed_codex
    print_step "Done"
    echo "Patched codex installed at: $INSTALL_BIN_DIR/codex (prebuilt)"
  else
    install_from_source
  fi

  return 0
}

is_codex_repo() {
  local p="$1"
  [[ -d "$p/.git" && -f "$p/codex-rs/Cargo.toml" && -f "$p/README.md" ]]
}

find_codex_repo() {
  local candidates=(
    "$REPO_DIR/_upstream/openai-codex"
    "$REPO_DIR/openai-codex"
    "$HOME/openai-codex"
    "$HOME/codex"
    "$HOME/src/openai-codex"
    "$HOME/.powerbar/vendor/openai-codex"
  )

  for c in "${candidates[@]}"; do
    if is_codex_repo "$c"; then
      echo "$c"
      return 0
    fi
  done

  return 1
}

clone_codex_repo() {
  local target="$1"
  print_step "openai/codex source not found. Cloning to $target" >&2
  mkdir -p "$(dirname "$target")"
  git clone --depth 1 https://github.com/openai/codex "$target" >&2
  echo "$target"
}

default_vendor_codex_repo() {
  echo "$HOME/.powerbar/vendor/openai-codex"
}

is_managed_vendor_repo() {
  local path="$1"
  [[ "$path" == "$(default_vendor_codex_repo)" ]]
}

refresh_managed_vendor_repo() {
  local target="$1"

  print_step "Managed Codex checkout is stale. Resetting and pulling latest" >&2
  git -C "$target" checkout -- . >/dev/null 2>&1 || true
  git -C "$target" clean -fd >/dev/null 2>&1 || true
  if git -C "$target" pull --ff-only >&2; then
    echo "$target"
    return 0
  fi

  # Pull failed (e.g. shallow clone conflict) — fall back to re-clone
  local backup="${target}.backup.$(date +%Y%m%d%H%M%S)"
  print_step "Pull failed. Backing up to $backup and re-cloning" >&2
  mv "$target" "$backup"
  clone_codex_repo "$target" >/dev/null 2>&1
  echo "$target"
}

ensure_codex_repo() {
  local preferred="${1:-}"

  if [[ -n "$preferred" ]]; then
    if is_codex_repo "$preferred"; then
      if [[ "$REPAIR_INSTALL" -eq 1 ]] && is_managed_vendor_repo "$preferred"; then
        refresh_managed_vendor_repo "$preferred"
      else
        echo "$preferred"
      fi
      return 0
    fi
    clone_codex_repo "$preferred"
    return 0
  fi

  local detected
  if detected="$(find_codex_repo 2>/dev/null)"; then
    if [[ "$REPAIR_INSTALL" -eq 1 ]] && is_managed_vendor_repo "$detected"; then
      refresh_managed_vendor_repo "$detected"
    else
      echo "$detected"
    fi
    return 0
  fi

  clone_codex_repo "$(default_vendor_codex_repo)"
}

apply_patch_if_needed() {
  local codex_repo="$1"
  local state_dir="$codex_repo/$PATCH_STATE_DIR_NAME"
  local applied_patch_file="$state_dir/$PATCH_STATE_FILE_NAME"

  mkdir -p "$state_dir"

  if [[ -f "$applied_patch_file" ]]; then
    if cmp -s "$PATCH_FILE" "$applied_patch_file"; then
      if git -C "$codex_repo" apply --reverse --check "$PATCH_FILE" >/dev/null 2>&1; then
        print_step "Patch already applied at $codex_repo"
        return 0
      fi
      fatal "Patch state says current patch is applied, but Codex source does not match. Use a clean Codex checkout."
    fi

    print_step "Updating previously applied Codex patch"
    if ! git -C "$codex_repo" apply --reverse --check "$applied_patch_file" >/dev/null 2>&1; then
      fatal "Cannot reverse previously applied Codex patch cleanly. Use a clean Codex checkout or revert local Codex changes first."
    fi
    git -C "$codex_repo" apply --reverse "$applied_patch_file"
    rm -f "$applied_patch_file"
  fi

  if git -C "$codex_repo" apply --reverse --check "$PATCH_FILE" >/dev/null 2>&1; then
    print_step "Patch already applied at $codex_repo"
    cp "$PATCH_FILE" "$applied_patch_file"
    return 0
  fi

  if ! git -C "$codex_repo" apply --check "$PATCH_FILE" >/dev/null 2>&1; then
    if is_managed_vendor_repo "$codex_repo"; then
      codex_repo="$(refresh_managed_vendor_repo "$codex_repo")"
      state_dir="$codex_repo/$PATCH_STATE_DIR_NAME"
      applied_patch_file="$state_dir/$PATCH_STATE_FILE_NAME"
      mkdir -p "$state_dir"
    else
      fatal "Codex patch does not apply cleanly. Use a clean Codex checkout or rerun with the managed vendor repo."
    fi
  fi

  print_step "Applying Codex status-line command patch"
  git -C "$codex_repo" apply "$PATCH_FILE"
  cp "$PATCH_FILE" "$applied_patch_file"
}

build_hud() {
  print_step "Building powerbar"
  ensure_command npm "npm is required (install Node.js + npm first)"
  cd "$REPO_DIR"
  npm ci
  npm run build
}

install_powerbar_cli() {
  ensure_command node "node is required to run powerbar"

  # Copy built dist to a stable location so powerbar works even if the
  # repo is moved or deleted.
  local install_dir="$HOME/.powerbar/dist"
  mkdir -p "$install_dir"
  find "$install_dir" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  cp -R "$REPO_DIR/dist/"* "$install_dir/"
  print_step "Installed powerbar runtime to $install_dir"
}

configure_codex() {
  print_step "Configuring ~/.codex/config.toml"
  "$REPO_DIR/scripts/configure-codex-statusline.sh" --repo-dir "$REPO_DIR"
}

detect_platform_asset() {
  local os arch asset
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$arch" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64)  arch="x86_64" ;;
    *)             return 1 ;;
  esac
  if [[ "$os" == "darwin" && "$arch" == "x86_64" ]]; then
    return 1
  fi
  asset="codex-${os}-${arch}.tar.gz"
  printf '%s\n' "$asset"
}

try_download_prebuilt() {
  if [[ "$FORCE_SOURCE_BUILD" -eq 1 ]]; then
    return 1
  fi

  local asset
  local detected_os detected_arch
  detected_os="$(uname -s)"
  detected_arch="$(uname -m)"
  if ! asset="$(detect_platform_asset 2>/dev/null)"; then
    if [[ "$detected_os" == "Darwin" && "$detected_arch" == "x86_64" ]]; then
      print_step "Prebuilt Intel macOS binary is no longer published — falling back to source build"
    else
      print_step "No published prebuilt binary mapping for platform ${detected_os}/${detected_arch} — falling back to source build"
    fi
    return 1
  fi
  local url="https://github.com/${PREBUILT_RELEASE_REPO}/releases/download/${PREBUILT_RELEASE_TAG}/${asset}"

  print_step "Trying prebuilt binary: $asset"
  local tmp_dir
  tmp_dir="$(mktemp -d)"

  local curl_status=0
  local http_code
  http_code="$(curl -sSL --max-time 120 -w '%{http_code}' -o "$tmp_dir/$asset" "$url" 2>/dev/null)" || curl_status=$?

  if [[ "$curl_status" -ne 0 ]]; then
    if [[ "$http_code" == "404" ]]; then
      print_step "Prebuilt release asset ${asset} not found in ${PREBUILT_RELEASE_TAG} — falling back to source build"
    else
      print_step "Failed to download prebuilt release asset from ${PREBUILT_RELEASE_TAG} (curl exit ${curl_status}, HTTP ${http_code:-000}) — falling back to source build"
    fi
    rm -rf "$tmp_dir"
    return 1
  fi

  if [[ "$http_code" != "200" ]]; then
    print_step "Prebuilt release asset ${asset} returned HTTP ${http_code} from ${PREBUILT_RELEASE_TAG} — falling back to source build"
    rm -rf "$tmp_dir"
    return 1
  fi

  if ! tar xzf "$tmp_dir/$asset" -C "$tmp_dir" 2>/dev/null; then
    print_step "Failed to extract prebuilt binary — falling back to source build"
    rm -rf "$tmp_dir"
    return 1
  fi

  if [[ ! -x "$tmp_dir/codex" ]]; then
    print_step "Prebuilt archive missing codex binary — falling back to source build"
    rm -rf "$tmp_dir"
    return 1
  fi

  local target="$INSTALL_BIN_DIR/codex"
  local use_sudo=()
  if [[ ! -w "$INSTALL_BIN_DIR" ]] && command -v sudo >/dev/null 2>&1; then
    use_sudo=(sudo)
  fi

  if (( ${#use_sudo[@]} )); then
    "${use_sudo[@]}" mkdir -p "$INSTALL_BIN_DIR"
  else
    mkdir -p "$INSTALL_BIN_DIR"
  fi

  if [[ -x "$target" && ! -L "$target" ]]; then
    local backup="$INSTALL_BIN_DIR/codex.backup.$(date +%Y%m%d%H%M%S)"
    if (( ${#use_sudo[@]} )); then
      "${use_sudo[@]}" cp "$target" "$backup"
    else
      cp "$target" "$backup"
    fi
    print_step "Backed up existing codex binary to $backup"
  fi

  if (( ${#use_sudo[@]} )); then
    "${use_sudo[@]}" cp "$tmp_dir/codex" "$target"
    "${use_sudo[@]}" chmod +x "$target"
  else
    cp "$tmp_dir/codex" "$target"
    chmod +x "$target"
  fi
  rm -rf "$tmp_dir"

  if [[ "$INSTALL_BIN_DIR" == "$HOME/.local/bin" ]]; then
    ensure_local_bin_precedence
  fi
  hash -r 2>/dev/null || true

  print_step "Installed prebuilt patched codex to $target"
  return 0
}

install_from_source() {
  local codex_repo
  codex_repo="$(ensure_codex_repo "$CODEX_REPO_OVERRIDE")"
  print_step "Using Codex source: $codex_repo"

  apply_patch_if_needed "$codex_repo"
  build_patched_codex_binary "$codex_repo"
  verify_installed_codex

  print_step "Done"
  echo "Patched codex installed at: $INSTALL_BIN_DIR/codex (built from source)"
}

build_patched_codex_binary() {
  local codex_repo="$1"

  ensure_rust_toolchain
  ensure_linux_build_deps
  align_codex_workspace_version "$codex_repo" "$REFERENCE_CODEX_VERSION"

  local cargo_profile="release"
  local cargo_flags=("--release")
  local profile_dir="release"

  if [[ "$FAST_BUILD" -eq 1 ]]; then
    print_step "Building patched Codex binary (fast mode: thin LTO, parallel codegen)"
    export CARGO_PROFILE_RELEASE_LTO="thin"
    export CARGO_PROFILE_RELEASE_CODEGEN_UNITS="16"
  else
    print_step "Building patched Codex binary (this may take 10-20 min on first run)"
  fi

  cd "$codex_repo/codex-rs"
  local build_log
  build_log="$(mktemp)"

  if ! cargo build "${cargo_flags[@]}" -p codex-cli 2>&1 | tee "$build_log"; then
    if grep -q "COMPILER BUG DETECTED" "$build_log"; then
      print_step "Detected gcc compiler bug from aws-lc-sys. Retrying with clang"
      ensure_linux_build_deps
      CC=clang CXX=clang++ cargo build "${cargo_flags[@]}" -p codex-cli
    else
      rm -f "$build_log"
      fatal "Failed to build patched Codex binary"
    fi
  fi
  rm -f "$build_log"

  local built="$codex_repo/codex-rs/target/$profile_dir/codex"
  if [[ ! -x "$built" ]]; then
    echo "Patched codex binary not found at $built"
    return 1
  fi

  local target="$INSTALL_BIN_DIR/codex"
  local use_sudo=()
  if [[ ! -w "$INSTALL_BIN_DIR" ]]; then
    if command -v sudo >/dev/null 2>&1; then
      print_step "Install directory $INSTALL_BIN_DIR requires elevated permissions"
      use_sudo=(sudo)
    else
      fatal "Cannot write to $INSTALL_BIN_DIR and sudo is not available. Run as root or use a different install path."
    fi
  fi

  if (( ${#use_sudo[@]} )); then
    "${use_sudo[@]}" mkdir -p "$INSTALL_BIN_DIR"
  else
    mkdir -p "$INSTALL_BIN_DIR"
  fi

  if [[ -x "$target" && ! -L "$target" ]]; then
    local backup="$INSTALL_BIN_DIR/codex.backup.$(date +%Y%m%d%H%M%S)"
    if (( ${#use_sudo[@]} )); then
      "${use_sudo[@]}" cp "$target" "$backup"
    else
      cp "$target" "$backup"
    fi
    print_step "Backed up existing codex binary to $backup"
  fi

  if (( ${#use_sudo[@]} )); then
    "${use_sudo[@]}" cp "$built" "$target"
    "${use_sudo[@]}" chmod +x "$target"
  else
    cp "$built" "$target"
    chmod +x "$target"
  fi
  print_step "Installed patched codex to $target"

  # Ensure ~/.local/bin is on PATH when shadowing homebrew
  if [[ "$INSTALL_BIN_DIR" == "$HOME/.local/bin" ]]; then
    ensure_local_bin_precedence
  fi
  hash -r 2>/dev/null || true
}

verify_installed_codex() {
  local expected="$INSTALL_BIN_DIR/codex"
  local resolved

  if [[ ! -x "$expected" ]]; then
    fatal "Patched codex was built but not installed to $expected"
  fi

  resolved="$(command -v codex 2>/dev/null || true)"
  if [[ "$resolved" == "$expected" ]]; then
    print_step "Verified patched codex on PATH: $resolved"
    return 0
  fi

  print_step "Notice: current shell resolves codex to: ${resolved:-<not found>}"
  print_step "Patched codex is installed at: $expected"
  print_step "Open a new shell or run: export PATH=\"$INSTALL_BIN_DIR:\$PATH\" && hash -r"
}

interactive_setup() {
  [[ -t 0 && -t 1 ]] || fatal "Interactive setup requires a terminal. Use --full instead."

  print_step "Interactive setup"
  echo "Choose install mode:"
  echo "  1) Full install (prebuilt)    — download prebuilt binary + build HUD + configure (recommended)"
  echo "  2) Full install (from source) — build codex from source (requires Rust, ~10-20 min)"
  echo "  3) Build HUD only"
  echo "  4) Build HUD + update Codex config"
  echo "  5) Repair install             — full reinstall of all managed components"

  local choice
  choice="$(prompt_with_default "Select mode" "1")"
  case "$choice" in
    1) ACTION="full" ; FORCE_SOURCE_BUILD=0 ;;
    2) ACTION="full" ; FORCE_SOURCE_BUILD=1 ;;
    3) ACTION="hud-only" ;;
    4) ACTION="hud-config" ;;
    5) ACTION="full" ; FORCE_SOURCE_BUILD=0 ; FORCE_UPDATE=1 ; REPAIR_INSTALL=1 ;;
    *) fatal "Unknown interactive selection: $choice" ;;
  esac

  if [[ "$ACTION" == "full" && "$FORCE_SOURCE_BUILD" -eq 1 ]]; then
    local detected=""
    if detected="$(find_codex_repo 2>/dev/null)"; then
      echo "[install] Detected Codex source: $detected"
      if confirm_prompt "Use this checkout?" "Y"; then
        CODEX_REPO_OVERRIDE="$detected"
      else
        CODEX_REPO_OVERRIDE="$(prompt_with_default "Codex source path to use or clone into" "$HOME/.powerbar/vendor/openai-codex")"
      fi
    else
      echo "[install] No local Codex source checkout detected."
      CODEX_REPO_OVERRIDE="$(prompt_with_default "Clone Codex source into" "$HOME/.powerbar/vendor/openai-codex")"
    fi
  fi

  print_step "Summary"
  case "$ACTION" in
    full)
      if [[ "$REPAIR_INSTALL" -eq 1 ]]; then
        echo "[install] Will fully reinstall powerbar, refresh config.toml, and reinstall patched codex"
      elif [[ "$FORCE_SOURCE_BUILD" -eq 1 ]]; then
        echo "[install] Will build powerbar, configure config.toml, build codex from source"
      else
        echo "[install] Will build powerbar, configure config.toml, download prebuilt codex"
      fi
      ;;
    hud-only)
      echo "[install] Will build powerbar only"
      ;;
    hud-config)
      echo "[install] Will build powerbar and update ~/.codex/config.toml"
      ;;
  esac
  if [[ -n "$CODEX_REPO_OVERRIDE" ]]; then
    echo "[install] Codex source path: $CODEX_REPO_OVERRIDE"
  fi

  if ! confirm_prompt "Proceed?" "Y"; then
    echo "[install] Cancelled"
    exit 0
  fi
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --full)
        INTERACTIVE=0
        shift
        ;;
      --fast)
        FAST_BUILD=1
        shift
        ;;
      --source)
        FORCE_SOURCE_BUILD=1
        shift
        ;;
      --force)
        FORCE_UPDATE=1
        shift
        ;;
      --repair)
        ACTION="full"
        INTERACTIVE=0
        FORCE_UPDATE=1
        REPAIR_INSTALL=1
        shift
        ;;
      --uninstall)
        ACTION="uninstall"
        INTERACTIVE=0
        shift
        ;;
      --help|-h)
        print_usage
        exit 0
        ;;
      *)
        fatal "Unknown argument: $1"
        ;;
    esac
  done
}

detect_existing_codex() {
  local existing
  existing="$(command -v codex 2>/dev/null || true)"
  if [[ -z "$existing" ]]; then
    INSTALL_BIN_DIR="$HOME/.local/bin"
    REFERENCE_CODEX_VERSION="$(find_reference_codex_version)"
    return 0
  fi

  local existing_dir
  existing_dir="$(dirname "$existing")"
  local install_method="unknown"

  # Resolve symlinks so we can detect homebrew Caskroom targets
  local resolved
  resolved="$(readlink -f "$existing" 2>/dev/null || realpath "$existing" 2>/dev/null || echo "$existing")"

  if [[ "$existing" == *"homebrew"* || "$existing" == *"linuxbrew"* || "$resolved" == *"Cellar"* || "$resolved" == *"Caskroom"* ]]; then
    install_method="homebrew"
  elif [[ "$existing" == *".npm"* || "$existing" == *"node_modules"* || "$existing" == *"nvm"* ]]; then
    install_method="npm"
  elif [[ "$existing" == "/usr/local/bin/codex" || "$existing" == "/usr/bin/codex" ]]; then
    # Could be npm global or manual install — check if npm knows about it
    if npm list -g @openai/codex >/dev/null 2>&1; then
      install_method="npm"
    fi
  elif [[ "$existing" == *".cargo"* ]]; then
    install_method="cargo"
  fi

  # Already our patched binary in ~/.local/bin
  if [[ "$existing_dir" == "$INSTALL_BIN_DIR" ]]; then
    print_step "Detected existing Powerbar patched binary at $existing (will be replaced)"
    REFERENCE_CODEX_VERSION="$(find_reference_codex_version)"
    return 0
  fi

  print_step "Detected existing Codex installation"
  echo "  Location: $existing"
  echo "  Installed via: $install_method"

  if [[ "$install_method" == "homebrew" ]]; then
    # Shadow homebrew installs — overwriting would break on brew upgrade
    INSTALL_BIN_DIR="$HOME/.local/bin"
    echo ""
    echo "  Homebrew-managed binary detected."
    echo "  Powerbar will install a patched binary to $INSTALL_BIN_DIR/codex"
    echo "  which takes precedence via PATH ordering (original stays untouched)."
  else
    # Overwrite npm/cargo/unknown installs in place
    INSTALL_BIN_DIR="$existing_dir"
    echo ""
    echo "  Powerbar will replace this binary with a patched version."
    echo "  A backup will be saved as codex.backup.<timestamp> in the same directory."
  fi

  echo "  To restore later, run: ./install.sh --uninstall"
  echo ""

  if [[ "$INTERACTIVE" -eq 1 && -t 0 && -t 1 ]]; then
    if ! confirm_prompt "Continue with install?" "Y"; then
      echo "[install] Cancelled"
      exit 0
    fi
  fi

  REFERENCE_CODEX_VERSION="$(find_reference_codex_version)"
}

uninstall() {
  print_step "Uninstalling Powerbar"

  # 1. Find where the current codex binary lives
  local current
  current="$(command -v codex 2>/dev/null || true)"
  local search_dirs=("$INSTALL_BIN_DIR")
  if [[ -n "$current" ]]; then
    search_dirs+=("$(dirname "$current")")
  fi

  # 2. Look for backup and restore it, or just remove patched binary
  local restored=0
  for dir in "${search_dirs[@]}"; do
    local dir_sudo=()
    if [[ -d "$dir" && ! -w "$dir" ]] && command -v sudo >/dev/null 2>&1; then
      dir_sudo=(sudo)
    fi

    local latest_backup
    latest_backup="$(ls -t "$dir"/codex.backup.* 2>/dev/null | head -1 || true)"
    if [[ -n "$latest_backup" && -f "$dir/codex" ]]; then
      "${dir_sudo[@]}" mv "$latest_backup" "$dir/codex"
      echo "  Restored original codex from backup: $dir/codex"
      # Clean remaining backups
      "${dir_sudo[@]}" rm -f "$dir"/codex.backup.* 2>/dev/null || true
      restored=1
      break
    elif [[ -f "$dir/codex" ]]; then
      "${dir_sudo[@]}" rm -f "$dir/codex"
      echo "  Removed patched binary: $dir/codex"
      break
    fi
  done

  if [[ $restored -eq 0 ]]; then
    # Clean up any stale backups
    for dir in "${search_dirs[@]}"; do
      local dir_sudo=()
      if [[ -d "$dir" && ! -w "$dir" ]] && command -v sudo >/dev/null 2>&1; then
        dir_sudo=(sudo)
      fi
      "${dir_sudo[@]}" rm -f "$dir"/codex.backup.* 2>/dev/null || true
    done
  fi

  # 3. Clean PATH entries from shell rc files
  local marker_start="# >>> powerbar path >>>"
  local marker_end="# <<< powerbar path <<<"
  local rc_files=("$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile" "$HOME/.bash_profile")
  for rc in "${rc_files[@]}"; do
    if [[ ! -f "$rc" ]]; then
      continue
    fi
    if grep -Fq "$marker_start" "$rc"; then
      local tmp
      tmp="$(mktemp)"
      awk -v ms="$marker_start" -v me="$marker_end" '
        $0 == ms { skip=1; next }
        $0 == me { skip=0; next }
        !skip { print }
      ' "$rc" > "$tmp"
      mv "$tmp" "$rc"
      echo "  Removed PATH entry from $rc"
    fi
  done

  # 3b. Remove powerbar CLI wrapper (legacy).
  local powerbar_bin="$HOME/.local/bin/powerbar"
  if [[ -f "$powerbar_bin" ]]; then
    rm -f "$powerbar_bin"
    echo "  Removed powerbar wrapper: $powerbar_bin"
  fi

  # 3c. Remove powerbar runtime and data.
  if [[ -d "$HOME/.powerbar" ]]; then
    # Keep vendor/ for now — it's handled separately in step 7.
    find "$HOME/.powerbar" -mindepth 1 -maxdepth 1 ! -name vendor -exec rm -rf {} +
    echo "  Removed powerbar runtime: $HOME/.powerbar"
  fi

  # 4. Remove status_line_command and status_line from config.toml
  local config="$HOME/.codex/config.toml"
  if [[ -f "$config" ]] && grep -qE '(status_line_command|status_line)[[:space:]]*=' "$config"; then
    local tmp
    tmp="$(mktemp)"
    grep -vE '^[[:space:]]*(status_line_command|status_line)[[:space:]]*=' "$config" > "$tmp"
    mv "$tmp" "$config"
    echo "  Removed status_line entries from $config"
  fi

  # 5. Clean legacy tmux config
  local tmux_conf="$HOME/.tmux.conf"
  local tmux_marker_start="# >>> powerbar tmux >>>"
  local tmux_marker_end="# <<< powerbar tmux <<<"
  if [[ -f "$tmux_conf" ]] && grep -Fq "$tmux_marker_start" "$tmux_conf"; then
    local tmp
    tmp="$(mktemp)"
    awk -v ms="$tmux_marker_start" -v me="$tmux_marker_end" '
      $0 == ms { skip=1; next }
      $0 == me { skip=0; next }
      !skip { print }
    ' "$tmux_conf" > "$tmp"
    mv "$tmp" "$tmux_conf"
    echo "  Removed tmux HUD config from $tmux_conf"
  fi

  # 6. Show what's active now
  hash -r 2>/dev/null || true
  local active
  active="$(command -v codex 2>/dev/null || true)"
  if [[ -n "$active" ]]; then
    print_step "Codex is now: $active"
  else
    print_step "No codex binary found in PATH. Reinstall codex via npm/cargo if needed."
  fi

  # 7. Optionally clean vendor repo and build cache
  local vendor
  vendor="$(default_vendor_codex_repo)"
  if [[ -d "$vendor" ]]; then
    local vendor_size
    vendor_size="$(du -sh "$vendor" 2>/dev/null | cut -f1)"
    if [[ -t 0 && -t 1 ]] && confirm_prompt "  Remove vendored Codex source and build cache ($vendor_size)?" "N"; then
      rm -rf "$vendor"
      echo "  Removed $vendor"
    fi
  fi

  # Clean up ~/.powerbar if it's now empty (vendor was the last thing in it).
  if [[ -d "$HOME/.powerbar" ]] && [[ -z "$(ls -A "$HOME/.powerbar" 2>/dev/null)" ]]; then
    rmdir "$HOME/.powerbar"
  fi

  print_step "Uninstall complete"
}

maybe_star_repo() {
  local repo="Qifei-C/codex-powerbar"
  [[ "$INTERACTIVE" -eq 1 ]] || return 0
  [[ "$INSTALL_MUTATED" -eq 1 ]] || return 0
  [[ -t 0 && -t 1 ]] || return 0
  if ! command -v gh >/dev/null 2>&1; then
    return 0
  fi
  if ! gh auth status >/dev/null 2>&1; then
    return 0
  fi
  # Skip if already starred
  if gh api "/user/starred/$repo" --silent >/dev/null 2>&1; then
    return 0
  fi
  echo ""
  if confirm_prompt "Enjoying Powerbar? Star the repo on GitHub to support the project?" "N"; then
    if gh api -X PUT "/user/starred/$repo" --silent >/dev/null 2>&1; then
      echo "Thanks for the star!"
    else
      echo "Could not star — you can do it manually at https://github.com/$repo"
    fi
  fi
}

main() {
  parse_args "$@"

  if [[ "$ACTION" == "uninstall" ]]; then
    print_step "Starting uninstall"
    ensure_codex_not_running
    uninstall
    return 0
  fi

  local repo_powerbar_version
  local manifest_codex_patch_version

  if [[ "$INTERACTIVE" -eq 1 ]]; then
    print_step "Starting interactive setup"
  elif [[ "$REPAIR_INSTALL" -eq 1 ]]; then
    print_step "Starting repair install"
  else
    print_step "Starting full install"
  fi
  ensure_command git "git is required (install git first)"
  ensure_command python3 "python3 is required (install Python 3 first)"

  if [[ ! -f "$PATCH_FILE" ]]; then
    echo "Patch file missing: $PATCH_FILE"
    exit 1
  fi

  ensure_codex_not_running

  repo_powerbar_version="$(get_repo_powerbar_version)"
  manifest_codex_patch_version="$(read_manifest_field codexPatchVersion)"

  if [[ "$INTERACTIVE" -eq 1 ]]; then
    interactive_setup
  fi

  if [[ "$ACTION" != "hud-only" ]]; then
    detect_existing_codex
  fi

  if [[ "$ACTION" == "hud-only" ]]; then
    if ensure_powerbar_runtime "$repo_powerbar_version"; then
      INSTALL_MUTATED=1
    fi
    ensure_manifest "$repo_powerbar_version" "$manifest_codex_patch_version" || true
    print_step "Done"
    echo "HUD available at: $REPO_DIR/dist/index.js"
    echo "Powerbar runtime available at: $POWERBAR_RUNTIME_DIR/"
    maybe_star_repo
    return 0
  fi

  if [[ "$ACTION" == "hud-config" ]]; then
    if ensure_powerbar_runtime "$repo_powerbar_version"; then
      INSTALL_MUTATED=1
    fi
    if ensure_codex_config; then
      INSTALL_MUTATED=1
    fi
    ensure_manifest "$repo_powerbar_version" "$manifest_codex_patch_version" || true
    print_step "Done"
    echo "HUD available at: $REPO_DIR/dist/index.js"
    echo "Powerbar runtime available at: $POWERBAR_RUNTIME_DIR/"
    echo "HUD command wired in ~/.codex/config.toml via [tui].status_line_command"
    maybe_star_repo
    return 0
  fi

  if [[ "$ACTION" == "full" ]]; then
    if ensure_powerbar_runtime "$repo_powerbar_version"; then
      INSTALL_MUTATED=1
    fi
    if ensure_codex_config; then
      INSTALL_MUTATED=1
    fi
    if ensure_codex_patch; then
      INSTALL_MUTATED=1
    fi
    ensure_manifest "$repo_powerbar_version" "$PREBUILT_RELEASE_TAG" || true
    print_step "Done"
  fi

  if [[ "$ACTION" == "full" ]]; then
    echo "Run Codex normally: codex"
    echo "Powerbar is invoked automatically by Codex via status_line_command"
    echo "HUD command wired in ~/.codex/config.toml via [tui].status_line_command"
  fi

  maybe_star_repo
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
