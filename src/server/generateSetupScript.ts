// Generates a personalized, double-clickable macOS setup script for the
// local watch-folder pipeline — Phase 1 of the plan's "GUI, no terminal"
// local setup (a native folder picker, no typed config), with a fully
// packaged native helper app treated as an explicit, separately-scoped
// Phase 2 follow-on (see the plan).
//
// Reuses the existing pipeline exactly: writes the same .env vars
// (TRANSCRIPT_WATCH_DIR/GOODWRAP_API_BASE_URL/LOCAL_WORKER_API_KEY) that
// .claude/skills/process-transcripts/SKILL.md and src/ingest/scanFolder.ts
// already read, and installs a per-user launchd job templated directly from
// the working com.goodwrap.scanfolder.plist — just parameterized instead of
// hardcoded to one Mac username. LOCAL_WORKER_API_KEY's value is this user's
// own personal worker key (see routes/workerKeys.ts), not the old global
// shared secret — src/server/auth.ts's requireAuth accepts either.

/** Keep to filesystem/launchd-Label-safe characters only — this becomes
 * part of a launchd Label and a plist filename. */
export function sanitizeLabelSuffix(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "user";
}

export interface SetupScriptParams {
  /** This user's own personal worker key (raw value, shown once at issuance). */
  workerKey: string;
  apiBaseUrl: string;
  /** Sanitized (see sanitizeLabelSuffix) — used for a unique launchd Label. */
  labelSuffix: string;
}

export function generateSetupScript(params: SetupScriptParams): string {
  const label = `com.goodwrap.scanfolder.${params.labelSuffix}`;

  const template = `#!/bin/bash
set -euo pipefail

echo "Good Wrap — local watch-folder setup"
echo

# 1. Native macOS folder picker — no typing required.
WATCH_DIR=$(osascript -e 'POSIX path of (choose folder with prompt "Pick your transcript watch folder")' 2>/dev/null | sed 's:/*$::') || true
if [ -z "\${WATCH_DIR:-}" ]; then
  echo "No folder selected — aborting."
  exit 1
fi
echo "Watch folder: $WATCH_DIR"

# 2. Claude Code CLI must already be installed and logged in once — this
#    setup script wraps everything else, but that one step stays manual
#    (see the plan's honest caveat about this).
CLAUDE_BIN=$(command -v claude || true)
if [ -z "$CLAUDE_BIN" ]; then
  echo
  echo "Claude Code CLI isn't installed yet. One-time setup, then re-run this script:"
  echo "  1. npm install -g @anthropic-ai/claude-code"
  echo "  2. Run: claude"
  echo "  3. Inside it, run: /login"
  exit 1
fi
echo "Found claude at: $CLAUDE_BIN"

# 3. Local good-wrap checkout — drag the folder into this window to fill it in.
echo
echo "Drag your local good-wrap folder into this window, then press Enter:"
read -r REPO_DIR
REPO_DIR="\${REPO_DIR%/}"
REPO_DIR=$(cd "$REPO_DIR" && pwd)
if [ ! -f "$REPO_DIR/package.json" ]; then
  echo "That doesn't look like the good-wrap repo (no package.json found there) — aborting."
  exit 1
fi
echo "Repo: $REPO_DIR"

# 4. Write/update this checkout's .env with your personal credentials.
ENV_FILE="$REPO_DIR/.env"
touch "$ENV_FILE"
set_env_var() {
  local key="$1" value="$2"
  if grep -q "^\${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i '' "s|^\${key}=.*|\${key}=\${value}|" "$ENV_FILE"
  else
    echo "\${key}=\${value}" >> "$ENV_FILE"
  fi
}
set_env_var "TRANSCRIPT_WATCH_DIR" "$WATCH_DIR"
set_env_var "GOODWRAP_API_BASE_URL" "__API_BASE_URL__"
set_env_var "LOCAL_WORKER_API_KEY" "__WORKER_KEY__"
echo "Updated $ENV_FILE"

# 5. Personal launchd job — templated from com.goodwrap.scanfolder.plist,
#    just parameterized per-user instead of hardcoded to one Mac username.
LOG_DIR="$REPO_DIR/logs"
mkdir -p "$LOG_DIR"
PLIST="$HOME/Library/LaunchAgents/__LABEL__.plist"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>__LABEL__</string>
  <key>ProgramArguments</key>
  <array>
    <string>$CLAUDE_BIN</string>
    <string>-p</string>
    <string>Use the process-transcripts skill to scan the transcript watch folder and process any new files.</string>
    <string>--dangerously-skip-permissions</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$REPO_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(dirname "$CLAUDE_BIN"):/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StartInterval</key>
  <integer>1200</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/scan-folder.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/scan-folder.log</string>
</dict>
</plist>
PLIST_EOF

# 6. Activate immediately (bootout-then-bootstrap so re-running this script
#    after picking a new folder cleanly replaces the old job).
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo
echo "All set — good-wrap will check your folder every 20 minutes (and once right now)."
echo "Logs: $LOG_DIR/scan-folder.log"
`;

  return template.replaceAll("__API_BASE_URL__", params.apiBaseUrl).replaceAll("__WORKER_KEY__", params.workerKey).replaceAll("__LABEL__", label);
}
