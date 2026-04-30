#!/bin/sh
# Fun Claw runtime sandbox entrypoint.
#
# The image pre-creates /workspace (uid 10001-owned, mode 0700) and
# /tmp (mode 1777) so under normal conditions the agent user can
# write to both immediately. This script is a small belt-and-braces
# check for the case where a host bind mount lands on /workspace
# with surprising ownership — common on Linux native Docker without
# userns-remap (see docs/cross-platform.md "Bind mount permissions
# on Linux native"). On Docker Desktop (macOS/Windows) the VM layer
# translates uids transparently and this check is a no-op.
#
# The script does NOT mutate ownership — it can't, because the
# container runs as uid 10001 and chown requires root. Instead it
# fails fast with a clear message if /workspace isn't writable, so
# the runner surfaces the failure as an FC-1xxx error rather than
# letting tool calls fail mid-stream with cryptic permission errors.

set -eu

# /workspace must be writable by the running user.
if ! [ -w /workspace ]; then
    echo "funclaw-entrypoint: /workspace is not writable by uid $(id -u)." >&2
    echo "funclaw-entrypoint: this usually means a host bind mount landed with" >&2
    echo "funclaw-entrypoint: surprising ownership. See docs/cross-platform.md" >&2
    echo "funclaw-entrypoint: \"Bind mount permissions on Linux native\"." >&2
    exit 1
fi

# /tmp must exist and be writable.
if ! [ -w /tmp ]; then
    echo "funclaw-entrypoint: /tmp is not writable by uid $(id -u)." >&2
    echo "funclaw-entrypoint: docker-runner mounts /tmp as a tmpfs by default;" >&2
    echo "funclaw-entrypoint: a custom config that disables this would explain it." >&2
    exit 1
fi

exec "$@"
