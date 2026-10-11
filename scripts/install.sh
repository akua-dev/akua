#!/bin/sh
# shellcheck shell=dash
#
# Akuapkg install script.
#
# Downloads a prebuilt `akuapkg` binary from GitHub Releases into
# $AKUAPKG_INSTALL/bin (defaulting to $HOME/.akuapkg/bin), and prints the
# `export PATH=…` line to paste into your shell config.
#
# We deliberately don't edit ~/.bashrc / ~/.zshrc / ~/.config/fish / etc
# for you — Bun tried and the script ballooned to 300 LOC of shell-rc
# detection. Printing the one line users need to paste is cleaner.
#
# Optional args:
#   $1   version tag (e.g. `v0.1.0`); defaults to latest via GitHub redirect.
#
# Optional env:
#   AKUAPKG_INSTALL       install root (default: $HOME/.akuapkg)
#   AKUAPKG_DOWNLOAD_BASE download host (default: github.com, for CDN mirrors)
#
# Keep this script simple and easily auditable. If something gets
# hairy, it probably belongs in `akuapkg` itself, not here.

set -eu

main() {
    need_cmd curl
    need_cmd tar
    need_cmd uname

    local version
    version="${1:-}"

    local triple
    triple="$(detect_triple)"

    local resolved_version
    resolved_version="$(resolve_version "$version")"

    local base="${AKUAPKG_DOWNLOAD_BASE:-https://github.com}"
    local asset="akuapkg-${resolved_version}-${triple}.tar.gz"
    local url="${base}/akua-dev/akuapkg/releases/download/${resolved_version}/${asset}"

    local install_root="${AKUAPKG_INSTALL:-$HOME/.akuapkg}"
    local bin_dir="${install_root}/bin"

    info "downloading akuapkg ${resolved_version} (${triple})"
    info "  from  ${url}"
    info "  to    ${bin_dir}/akuapkg"

    mkdir -p "$bin_dir" || error "cannot create ${bin_dir}"
    local tmpdir
    tmpdir="$(mktemp -d 2>/dev/null || mktemp -d -t 'akuapkg')"
    trap 'rm -rf "$tmpdir"' EXIT

    curl -fsSL "$url" -o "$tmpdir/akuapkg.tar.gz" \
        || error "download failed from ${url}"

    tar -xzf "$tmpdir/akuapkg.tar.gz" -C "$tmpdir" \
        || error "extract failed (corrupt archive?)"

    [ -f "$tmpdir/akuapkg" ] || error "archive did not contain the akuapkg binary"

    mv "$tmpdir/akuapkg" "$bin_dir/akuapkg"
    chmod +x "$bin_dir/akuapkg"

    success "installed akuapkg ${resolved_version} to ${bin_dir}/akuapkg"
    printf '\n'

    if ! echo ":$PATH:" | grep -q ":${bin_dir}:"; then
        info "add to your shell config:"
        printf '\n    export PATH="%s:$PATH"\n\n' "$bin_dir"
    fi

    info "verify:  ${bin_dir}/akuapkg --version"
}

# ---------------------------------------------------------------------------
# Target detection
# ---------------------------------------------------------------------------

detect_triple() {
    local sysname machine triple
    sysname="$(uname -s)"
    machine="$(uname -m)"

    case "$sysname" in
        Linux)
            # Alpine uses musl, not glibc. We don't ship musl builds yet —
            # bail rather than give them a broken glibc binary that fails
            # at runtime with a confusing dynamic-linker error.
            if [ -f /etc/alpine-release ]; then
                error "Alpine/musl is not supported yet; use a glibc-based image."
            fi
            case "$machine" in
                x86_64|amd64)  triple="x86_64-unknown-linux-gnu" ;;
                aarch64|arm64) triple="aarch64-unknown-linux-gnu" ;;
                *) error "unsupported linux arch: $machine" ;;
            esac
            ;;
        Darwin)
            # If we're running under Rosetta, prefer the native arm64
            # binary (Rosetta can run x86_64, but the arm64 one is faster
            # and matches what `uname -m` returned if run natively).
            if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
                machine="arm64"
            fi
            case "$machine" in
                x86_64)        triple="x86_64-apple-darwin" ;;
                arm64|aarch64) triple="aarch64-apple-darwin" ;;
                *) error "unsupported darwin arch: $machine" ;;
            esac
            ;;
        MINGW*|MSYS*|CYGWIN*)
            error "for Windows use the GitHub Release archive.\n"
            ;;
        *)
            error "unsupported OS: $sysname"
            ;;
    esac
    echo "$triple"
}

# ---------------------------------------------------------------------------
# Version resolution
# ---------------------------------------------------------------------------

resolve_version() {
    local input="$1"
    if [ -n "$input" ]; then
        # Accept `v0.1.0`, `0.1.0`, or `akuapkg-v0.1.0` — normalise to `v0.1.0`.
        echo "$input" | sed -e 's|^akuapkg-||' -e 's|^v\{0,1\}|v|'
        return
    fi
    # `releases/latest/download/...` redirects per-asset; to reconstruct
    # the asset URL we need the version. Cheapest way: follow the HEAD
    # redirect on `/releases/latest` itself.
    local location
    location="$(curl -fsSLI -o /dev/null -w '%{url_effective}\n' \
        https://github.com/akua-dev/akuapkg/releases/latest)"
    # URL ends with .../tag/vX.Y.Z.
    echo "$location" | sed -e 's|.*/tag/||'
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

need_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        error "required command \`$1\` not found on PATH"
    fi
}

# Colour only when stdout is a TTY. Keep output scrape-friendly in CI.
if [ -t 1 ]; then
    _reset='\033[0m'
    _bold='\033[1m'
    _red='\033[31m'
    _green='\033[32m'
    _blue='\033[34m'
else
    _reset='' _bold='' _red='' _green='' _blue=''
fi

info()    { printf '%b→%b %s\n' "$_blue" "$_reset" "$1"; }
success() { printf '%b✓%b %s\n' "$_green" "$_reset" "$1"; }
error()   { printf '%b✗%b %b%s%b\n' "$_red" "$_reset" "$_bold" "$1" "$_reset" >&2; exit 1; }

main "$@"
