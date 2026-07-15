<template><div /></template>

<!--
  Deprecated — replaced by the 3-panel Dashboard.vue (MeetingsPanel +
  MeetingsOverviewPanel + FollowUpsPanel components), per Peter's request
  that the flat meetings list and the recency-grouped overview both stay
  visible on the same screen instead of one replacing the other.

  Left in place rather than deleted because this sandbox couldn't remove the
  file (pre-existing permissions quirk on this mounted folder) — not imported
  by router/index.ts anymore, so it isn't part of the build. Vite's dev
  server still parses every .vue file under src/ regardless of whether
  anything imports it, so this needs a valid (if empty) <template> to avoid
  a "single file component" compile error. Safe to delete by hand.
-->
