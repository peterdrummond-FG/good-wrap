#!/bin/bash
# Persistent replacement for the old com.goodwrap.scanfolder LaunchAgent.
#
# Why this exists (2026-07-23): the launchd-based version ran scan-folder-
# job.sh headlessly every 20 minutes, but launchd-spawned background
# processes on this Mac turned out to have flaky, intermittent access to
# files under ~/Documents — repeated `getcwd: cannot access parent
# directories: Operation not permitted` crashes, inconsistent even after
# granting the relevant binaries Full Disk Access. The one thing that
# worked every single time, with no exceptions, across many tests: running
# the exact same command interactively in a real Terminal window. So
# instead of a headless daemon, this script just loops forever inside an
# actual Terminal session, which is started automatically at login by the
# GoodWrapScanFolder.app login item (see
# scan-folder-terminal-launcher.applescript for its source).
#
# This window is meant to be left open (minimized is fine) — closing it
# stops the loop, same tradeoff as the old job silently dying, except now
# it's visible instead of invisible. Ctrl-C also stops it cleanly.

cd "/Users/peterdrummond/Documents/FG Good Wrap/good-wrap" || exit 1

LOG="logs/scan-folder.log"
mkdir -p logs

echo "=================================================="
echo "scan-folder-loop started: $(date)"
echo "Running every 20 minutes. Close this window (or Ctrl-C) to stop."
echo "Log also mirrored to: $LOG"
echo "=================================================="

while true; do
  {
    echo
    echo "--- scan-folder-loop run: $(date) ---"
    ./scripts/scan-folder-job.sh
    echo "--- next run in 20 minutes ---"
  } 2>&1 | tee -a "$LOG"
  sleep 1200
done
