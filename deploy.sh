#!/usr/bin/env bash
set -euo pipefail

# deploy.sh — minimal uploader: rsync (preferred) or tar+ssh fallback
# Usage: ./deploy.sh [ssh_dest] [remote_dir]
# Defaults: ariane:/home/debian/transcode

SSH_DEST=${1:-ariane}
REMOTE_DIR=${2:-/home/debian/transcode}
DRY_RUN=${DRY_RUN:-0}

RSYNC_OPTS=( -avz --delete )
EXCLUDES=( 
  --exclude '.git' 
  --exclude 'node_modules' 
  --exclude 'dist' 
  --exclude '.env' 
  --exclude '*.log' 
  --exclude 'coverage' 
  --exclude '.DS_Store' 
  --exclude '.vite' 
)

if [[ "${DRY_RUN}" == "1" ]]; then
  echo "DRY RUN enabled — no changes will be made remotely."
  RSYNC_OPTS+=(--dry-run)
fi

# Ensure rsync exists locally
if ! command -v rsync >/dev/null 2>&1; then
  echo "Error: 'rsync' is required on this machine to use the rsync upload path." >&2
  exit 2
fi

echo "Uploading files to ${SSH_DEST}:${REMOTE_DIR}..."

# Prefer rsync if available on remote, otherwise tar+ssh fallback
if ssh "${SSH_DEST}" 'command -v rsync >/dev/null 2>&1'; then
  echo "Using rsync on remote host..."
  rsync "${RSYNC_OPTS[@]}" "${EXCLUDES[@]}" ./ "${SSH_DEST}:${REMOTE_DIR}/"
else
  echo "Remote host lacks rsync — using tar+ssh fallback (simple upload)."
  TAR_EXCLUDES=( --exclude .git --exclude node_modules --exclude dist --exclude .env --exclude "*.log" --exclude coverage --exclude .DS_Store --exclude .vite )
  if [[ "${DRY_RUN}" == "1" ]]; then
    echo "DRY RUN: would run tar ${TAR_EXCLUDES[*]} -czf - . | ssh ${SSH_DEST} \"mkdir -p ${REMOTE_DIR} && tar -xzf - -C ${REMOTE_DIR}\""
  else
    tar "${TAR_EXCLUDES[@]}" -czf - . | ssh "${SSH_DEST}" "mkdir -p '${REMOTE_DIR}' && tar -xzf - -C '${REMOTE_DIR}'"
  fi
fi

echo "Upload complete."

cat <<'EOF'
Notes:
- This script only uploads files to the remote. It will not restart containers or run remote build commands.
- For large repos, prefer having rsync installed on the remote host for efficient transfers.
- Use DRY_RUN=1 ./deploy.sh to preview actions without changing remote files.
EOF
