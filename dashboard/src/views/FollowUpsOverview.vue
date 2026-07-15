<template><div /></template>

<!--
  Deprecated — replaced by the 3-panel Dashboard.vue (MeetingsPanel +
  MeetingsOverviewPanel + FollowUpsPanel components), so Meetings, Meetings
  Overview, and Follow-ups all show up together on one screen.

  Left in place rather than deleted because this sandbox couldn't remove the
  file (pre-existing permissions quirk on this mounted folder) — not imported
  by router/index.ts anymore, so it isn't part of the build. Vite's dev
  server still parses every .vue file under src/ regardless of whether
  anything imports it, so this needs a valid (if empty) <template> to avoid
  a "single file component" compile error. Safe to delete by hand.
-->
