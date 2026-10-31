#!/usr/bin/env bash
set -euo pipefail

show_help() {
    cat <<'EOF'
Usage: ./install.sh [VENCORD_PATH] [--skip-build]

Installs the GrammarFixer userplugin into your Vencord checkout.

Arguments:
  VENCORD_PATH   Path to your Vencord checkout. Defaults to $VENCORD_DIR when set.

Options:
  --skip-build   Copy files without running corepack pnpm build.
  --help, -h     Show this help.
EOF
}

VENCORD_PATH="${VENCORD_DIR:-}"
SKIP_BUILD=0

while [ "$#" -gt 0 ]; do
    case "$1" in
        --skip-build) SKIP_BUILD=1; shift ;;
        --help|-h) show_help; exit 0 ;;
        --vencord-path) VENCORD_PATH="${2:-}"; shift 2 ;;
        *) VENCORD_PATH="$1"; shift ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "$VENCORD_PATH" ]; then
    if [ -f "package.json" ] && [ -d "src" ]; then
        VENCORD_PATH="$(pwd)"
    else
        printf 'Path to your Vencord checkout: '
        read -r VENCORD_PATH
    fi
fi

if [ -z "$VENCORD_PATH" ]; then
    echo "Vencord path is required. Pass it as an argument or set VENCORD_DIR." >&2
    exit 1
fi

VENCORD_ROOT="$(cd "$VENCORD_PATH" && pwd)"

if [ ! -f "$VENCORD_ROOT/package.json" ]; then
    echo "Not a Vencord checkout: missing package.json at $VENCORD_ROOT" >&2
    exit 1
fi

if [ ! -d "$VENCORD_ROOT/src" ]; then
    echo "Not a Vencord checkout: missing src directory at $VENCORD_ROOT" >&2
    exit 1
fi

TARGET="$VENCORD_ROOT/src/userplugins/grammarFixer"

if [ "$SCRIPT_DIR" != "$TARGET" ]; then
    # replace the whole folder so files removed from the plugin don't linger
    rm -rf "$TARGET"
    mkdir -p "$TARGET"
    (cd "$SCRIPT_DIR" && tar --exclude=.git -cf - .) | (cd "$TARGET" && tar -xf -)
fi

if [ "$SKIP_BUILD" -eq 0 ]; then
    if command -v pnpm >/dev/null 2>&1; then
        (cd "$VENCORD_ROOT" && pnpm build)
    else
        (cd "$VENCORD_ROOT" && corepack pnpm build)
    fi
fi

echo "Installed GrammarFixer to $TARGET"
echo "Enable GrammarFixer in Vencord settings, then fully quit and restart Discord."
