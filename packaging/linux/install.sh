#!/usr/bin/env bash
# FerrisScope Linux installer.
#
# Downloads the latest GitHub release artifact for this host and installs it
# in whichever form the system can accept:
#
#   * .deb   on apt-based distros (Debian / Ubuntu / Mint / Pop!_OS / …)
#   * .rpm   on dnf/zypper-based distros (Fedora / RHEL / openSUSE / …)
#   * .AppImage as a fallback (or when forced with --appimage)
#
# One-liner:
#   curl -fsSL https://raw.githubusercontent.com/yzhelezko/FerrisScope/main/packaging/linux/install.sh | bash
#
# Pin a specific version:
#   curl -fsSL https://.../install.sh | FERRISSCOPE_VERSION=v0.1.0 bash
#
# Force AppImage even if apt/dnf is available:
#   curl -fsSL https://.../install.sh | bash -s -- --appimage
#
# Uninstall:
#   curl -fsSL https://.../install.sh | bash -s -- --uninstall
#
# Environment knobs:
#   FERRISSCOPE_VERSION=v0.1.0   Pin a specific release tag.
#   FERRISSCOPE_PREFIX=$HOME/... Override the AppImage install prefix
#                                (defaults to $HOME/.local/share/FerrisScope).

set -euo pipefail

REPO="yzhelezko/FerrisScope"
APP_NAME="FerrisScope"
BIN_NAME="ferrisscope"   # binary name (lowercase) — see CLAUDE.md.

PREFIX="${FERRISSCOPE_PREFIX:-${HOME}/.local/share/FerrisScope}"
BIN_DIR="${HOME}/.local/bin"
DESKTOP_DIR="${HOME}/.local/share/applications"
ICON_DIR="${HOME}/.local/share/icons/hicolor/256x256/apps"

log()  { printf '\033[1;34m[ferrisscope-install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[ferrisscope-install]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[ferrisscope-install]\033[0m %s\n' "$*" >&2; exit 1; }

require_user() {
    if [[ "$(id -u)" -eq 0 ]]; then
        die "Do not run this installer as root. Run it as your normal desktop user; \
it will call sudo itself for the .deb / .rpm install step that needs it."
    fi
}

require_cmds() {
    local missing=()
    for cmd in curl tar install chmod uname; do
        command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
    done
    if (( ${#missing[@]} > 0 )); then
        die "Missing required commands: ${missing[*]}"
    fi
}

detect_arch() {
    local arch
    arch="$(uname -m)"
    case "$arch" in
        x86_64|amd64) echo "x64" ;;
        aarch64|arm64) echo "arm64" ;;
        *) die "Unsupported architecture: $arch (only x64 and arm64 builds are published)." ;;
    esac
}

# Decide which artifact format we want, given what's available on this host.
# Returns one of: deb | rpm | appimage
detect_format() {
    local forced="${1:-auto}"
    case "$forced" in
        deb|rpm|appimage) echo "$forced"; return ;;
        auto) ;;
        *) die "Unknown format: $forced" ;;
    esac

    if command -v apt-get >/dev/null 2>&1; then
        echo "deb"; return
    fi
    if command -v dnf >/dev/null 2>&1 || command -v zypper >/dev/null 2>&1; then
        echo "rpm"; return
    fi
    echo "appimage"
}

resolve_version() {
    if [[ -n "${FERRISSCOPE_VERSION:-}" ]]; then
        local v="${FERRISSCOPE_VERSION}"
        [[ "$v" == v* ]] || v="v$v"
        echo "$v"
        return
    fi
    local api="https://api.github.com/repos/${REPO}/releases/latest"
    local tag
    tag="$(curl -fsSL "$api" | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
    [[ -n "$tag" ]] || die "Could not resolve latest release from $api. Pin one with FERRISSCOPE_VERSION=v0.1.0."
    echo "$tag"
}

# List release assets for a given tag and find the first one matching the
# given grep pattern. We use the GH API rather than guessing names because
# Tauri's bundle filenames embed the tauri version + arch and aren't stable.
find_asset_url() {
    local tag="$1" pattern="$2"
    local api="https://api.github.com/repos/${REPO}/releases/tags/${tag}"
    curl -fsSL "$api" \
      | grep -Eo '"browser_download_url":[[:space:]]*"[^"]+"' \
      | sed -E 's/.*"browser_download_url":[[:space:]]*"([^"]+)"/\1/' \
      | grep -E "$pattern" \
      | head -n1
}

# ---- install paths ------------------------------------------------------

install_deb() {
    local tag="$1" arch="$2"
    local url
    # Release workflow stamps a `-linux-<arch>` suffix on every Linux bundle.
    url="$(find_asset_url "$tag" "linux-${arch}\\.deb$" || true)"
    [[ -n "$url" ]] || die "No .deb asset found for $tag / $arch in https://github.com/${REPO}/releases/tag/${tag}"

    local tmp
    tmp="$(mktemp -d)"
    local file="$tmp/${url##*/}"
    log "Downloading $url"
    curl -fsSL "$url" -o "$file"
    log "Installing $file via apt (will prompt for sudo)"
    sudo apt-get install -y "$file"
    rm -rf "$tmp"
}

install_rpm() {
    local tag="$1" arch="$2"
    local url
    url="$(find_asset_url "$tag" "linux-${arch}\\.rpm$" || true)"
    [[ -n "$url" ]] || die "No .rpm asset found for $tag / $arch in https://github.com/${REPO}/releases/tag/${tag}"

    local tmp
    tmp="$(mktemp -d)"
    local file="$tmp/${url##*/}"
    log "Downloading $url"
    curl -fsSL "$url" -o "$file"
    if command -v dnf >/dev/null 2>&1; then
        log "Installing $file via dnf (will prompt for sudo)"
        sudo dnf install -y "$file"
    elif command -v zypper >/dev/null 2>&1; then
        log "Installing $file via zypper (will prompt for sudo)"
        sudo zypper --non-interactive install --allow-unsigned-rpm "$file"
    else
        die "Neither dnf nor zypper found; cannot install rpm. Try --appimage."
    fi
    rm -rf "$tmp"
}

install_appimage() {
    local tag="$1" arch="$2"
    local url
    url="$(find_asset_url "$tag" "linux-${arch}\\.AppImage$" || true)"
    [[ -n "$url" ]] || die "No .AppImage asset found for $tag / $arch."

    mkdir -p "$PREFIX" "$BIN_DIR" "$DESKTOP_DIR" "$ICON_DIR"
    local target="${PREFIX}/${APP_NAME}.AppImage"
    log "Downloading $url"
    curl -fsSL "$url" -o "$target"
    chmod +x "$target"

    log "Linking ${BIN_DIR}/${BIN_NAME} -> ${target}"
    ln -sf "$target" "${BIN_DIR}/${BIN_NAME}"

    # Try to extract the icon from the AppImage so the desktop entry works
    # without an externally-distributed icon. AppImages ship `.DirIcon` at
    # the top of the squashfs root; --appimage-extract-file fetches a
    # specific file without unpacking the whole image.
    local icon_dst="${ICON_DIR}/${APP_NAME}.png"
    if "$target" --appimage-extract-file '*.png' >/dev/null 2>&1; then
        local extracted
        extracted="$(find squashfs-root -maxdepth 2 -name '*.png' -print -quit 2>/dev/null || true)"
        if [[ -n "$extracted" ]]; then
            cp -f "$extracted" "$icon_dst" || true
        fi
        rm -rf squashfs-root
    fi

    cat > "${DESKTOP_DIR}/${APP_NAME}.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=${APP_NAME}
GenericName=Kubernetes IDE
Comment=Rust-native desktop IDE for Kubernetes
Exec=${target} %U
Icon=${APP_NAME}
Terminal=false
Categories=Development;
StartupWMClass=${APP_NAME}
EOF

    if command -v update-desktop-database >/dev/null 2>&1; then
        update-desktop-database "${DESKTOP_DIR}" >/dev/null 2>&1 || true
    fi
    if command -v gtk-update-icon-cache >/dev/null 2>&1; then
        gtk-update-icon-cache -t "${HOME}/.local/share/icons/hicolor" >/dev/null 2>&1 || true
    fi

    case ":$PATH:" in
        *":$BIN_DIR:"*) ;;
        *) warn "$BIN_DIR is not on your PATH. Add it to ~/.profile or ~/.bashrc so '${BIN_NAME}' resolves in your shell." ;;
    esac
}

# ---- uninstall ----------------------------------------------------------

uninstall() {
    local removed=0

    # Try the package-manager paths first.
    if command -v apt-get >/dev/null 2>&1 && dpkg -s "${BIN_NAME}" >/dev/null 2>&1; then
        log "Removing ${BIN_NAME} via apt"
        sudo apt-get remove -y "${BIN_NAME}" || true
        removed=1
    fi
    if command -v dnf >/dev/null 2>&1 && rpm -q "${BIN_NAME}" >/dev/null 2>&1; then
        log "Removing ${BIN_NAME} via dnf"
        sudo dnf remove -y "${BIN_NAME}" || true
        removed=1
    fi
    if command -v zypper >/dev/null 2>&1 && rpm -q "${BIN_NAME}" >/dev/null 2>&1; then
        log "Removing ${BIN_NAME} via zypper"
        sudo zypper --non-interactive remove "${BIN_NAME}" || true
        removed=1
    fi

    # AppImage path.
    if [[ -d "$PREFIX" ]]; then
        log "Removing $PREFIX"
        rm -rf "$PREFIX"
        removed=1
    fi
    rm -f "${BIN_DIR}/${BIN_NAME}"
    rm -f "${DESKTOP_DIR}/${APP_NAME}.desktop"
    rm -f "${ICON_DIR}/${APP_NAME}.png"

    if command -v update-desktop-database >/dev/null 2>&1; then
        update-desktop-database "${DESKTOP_DIR}" >/dev/null 2>&1 || true
    fi

    if (( removed == 0 )); then
        warn "Nothing to uninstall — no package or AppImage found."
    fi

    cat <<EOF

-------------------------------------------------------------------
${APP_NAME} is uninstalled.

Per-user state at \$XDG_CONFIG_HOME/ferrisscope/ (kubeconfig sources,
prefs, port-forwards, table views, fleet cache) is kept on purpose so
your settings survive a reinstall. Remove it by hand for a clean slate:

  rm -rf "\${XDG_CONFIG_HOME:-\$HOME/.config}/ferrisscope"
  rm -rf "\${XDG_DATA_HOME:-\$HOME/.local/share}/ferrisscope"
  rm -rf "\${XDG_CACHE_HOME:-\$HOME/.cache}/ferrisscope"

Reinstall anytime with:
  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/packaging/linux/install.sh | bash
-------------------------------------------------------------------
EOF
}

print_finish_hint() {
    cat <<EOF

-------------------------------------------------------------------
${APP_NAME} is installed.

Launch from your application menu, or from a terminal:
  ${BIN_NAME}

Update with:
  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/packaging/linux/install.sh | bash

Uninstall with:
  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/packaging/linux/install.sh | bash -s -- --uninstall

Bug reports: https://github.com/${REPO}/issues
-------------------------------------------------------------------
EOF
}

main() {
    require_user
    require_cmds

    local mode="install"
    local format="auto"
    for arg in "$@"; do
        case "$arg" in
            --uninstall) mode="uninstall" ;;
            --appimage)  format="appimage" ;;
            --deb)       format="deb" ;;
            --rpm)       format="rpm" ;;
            -h|--help)
                cat <<EOF
Usage: install.sh [--appimage|--deb|--rpm] [--uninstall]

  (no args)     Pick the best format for this distro and install.
  --appimage    Force AppImage install into ~/.local/share/FerrisScope.
  --deb         Force .deb install (apt).
  --rpm         Force .rpm install (dnf or zypper).
  --uninstall   Remove ${APP_NAME}. Per-user state is preserved.

Environment:
  FERRISSCOPE_VERSION=v0.1.0   Pin a specific release tag.
  FERRISSCOPE_PREFIX=...       AppImage install prefix.
EOF
                return 0
                ;;
            *) die "Unknown argument: $arg (try --help)" ;;
        esac
    done

    if [[ "$mode" == "uninstall" ]]; then
        uninstall
        return
    fi

    local arch version chosen
    arch="$(detect_arch)"
    chosen="$(detect_format "$format")"
    version="$(resolve_version)"

    log "Installing ${APP_NAME} ${version} (${arch}, format=${chosen})"
    case "$chosen" in
        deb)      install_deb      "$version" "$arch" ;;
        rpm)      install_rpm      "$version" "$arch" ;;
        appimage) install_appimage "$version" "$arch" ;;
    esac

    print_finish_hint
}

main "$@"
