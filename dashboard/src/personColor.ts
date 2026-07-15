// Deterministic color per person name, added 2026-07-16 per Peter's request
// so the same person always gets the same color everywhere their name shows
// up (Follow-ups panel, meeting participant lists, meeting detail) — makes
// it easy to visually scan for a specific person across the dashboard.
//
// Hashes the display-name STRING itself, not a person id — the API only
// surfaces plain name strings at this display layer (see queries.ts's
// `name ?? email ?? "Unknown"` mapping), so this is stable as long as the
// same name string is used consistently, which it is throughout the app.
const PALETTE = [
  "#63b3ed", // blue
  "#68d391", // green
  "#f6ad55", // orange
  "#fc8181", // red/coral
  "#b794f4", // violet
  "#4fd1c5", // teal
  "#f687b3", // pink
  "#f6e05e", // yellow
];

export function personColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}
