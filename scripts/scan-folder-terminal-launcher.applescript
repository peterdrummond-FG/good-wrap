-- Source for ~/Applications/GoodWrapScanFolder.app, a login item that opens
-- Terminal and starts scan-folder-loop.sh inside it (see that script for
-- why this runs in a real Terminal window instead of a launchd daemon).
--
-- Compiled with:
--   osacompile -o ~/Applications/GoodWrapScanFolder.app scripts/scan-folder-terminal-launcher.applescript
--
-- Registered as a login item with:
--   osascript -e 'tell application "System Events" to make login item at end of login items with properties {path:"/Users/peterdrummond/Applications/GoodWrapScanFolder.app", hidden:false, name:"GoodWrapScanFolder"}'
--
-- To remove the login item later: System Settings > General > Login Items
-- & Extensions > remove "GoodWrapScanFolder" from the "Open at Login" list.

tell application "Terminal"
    activate
    do script "'/Users/peterdrummond/Documents/FG Good Wrap/good-wrap/scripts/scan-folder-loop.sh'"
end tell
