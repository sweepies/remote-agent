#!/bin/sh
# Box password authentication only. Dotfiles and fnox use target-local state.
set -eu
umask 077
: "${UPSTASH_BOX_API_KEY:?UPSTASH_BOX_API_KEY must be set}"

cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
BOX_SSH=$(command -v ssh)
BOX_TAR=$(command -v tar)
BOX_SSHPASS=$(command -v sshpass) || {
    printf '%s\n' 'sshpass is required on the initiating machine.' >&2
    exit 1
}
export BOX_SSH BOX_TAR BOX_SSHPASS

transport=$(mktemp -d "${TMPDIR:-/tmp}/box-bootstrap.XXXXXXXX")
trap 'rm -rf "$transport"' 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# No fnox lookup, age identity transfer, secret input file, or PTY needed.
cat > "$transport/ssh" <<'SSH'
#!/bin/sh
export SSHPASS="${UPSTASH_BOX_API_KEY:?}"
exec "$BOX_SSHPASS" -e "$BOX_SSH" -o BatchMode=no "$@"
SSH

# Darwin tar otherwise sends AppleDouble files and macOS-only xattrs to Linux.
cat > "$transport/tar" <<'TAR'
#!/bin/sh
if [ "$(uname -s)" = Darwin ]; then
    exec "$BOX_TAR" --no-xattrs --no-mac-metadata "$@"
fi
exec "$BOX_TAR" "$@"
TAR
chmod 700 "$transport/ssh" "$transport/tar"

PATH="$transport:$PATH" mise bootstrap remote box "$@"
