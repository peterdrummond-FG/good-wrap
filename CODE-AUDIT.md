# Good Wrap — Code Audit (2026-07-15)

Full read-only pass over the backend (`src/`, `db/`), dashboard (`dashboard/src/`), and a security-focused sweep of the whole repo. Nothing has been changed — this is findings only, organized by severity.

## Critical

**1. Stale compiled `.js` files are being generated inside `dashboard/src/` and can shadow your real `.ts`/`.vue` source.**
`dashboard/tsconfig.json` has no `noEmit`/`outDir`, so every `vue-tsc -b` run (which the `npm run build` script calls, and which I ran earlier in this session to verify changes) writes a compiled `.js` file next to each source file — confirmed present right now: `api.js`, `main.js`, `dateBuckets.js`, `router/index.js`, and a `.vue.js` for every component/view. Several imports across the app are extensionless (e.g. `main.ts`'s `import router from "./router"`, and the `../api` / `../dateBuckets` imports in `MeetingDetail.vue`, `CaptureForm.vue`, `AskPage.vue`, and all four panel components), and Vite's default resolution can pick up a `.js` file before the `.ts`/`.vue` it was compiled from. `dashboard/src/dateBuckets.js` is already committed to git (from a prior session), meaning the `git add -A` command pattern used to push this repo will keep sweeping these stray files back in. Net effect: an edit to a `.ts`/`.vue` file can silently fail to take effect at runtime if a stale `.js` sibling wins resolution — a genuinely confusing class of bug. Fix direction: add `"noEmit": true` to `dashboard/tsconfig.json`, delete the existing stray `.js` files, add `*.js` (scoped to `dashboard/src/`) to `.gitignore`.

**2. Per-panel Save only fires the "first review" notification once, ever — the other category's first-time approvals can silently never be notified.**
`updateMeetingInsights`/`submitMeetingReview` gate notifications on `reviewedAt` transitioning null → set. Now that Action Items and Follow-ups save independently (`onSaveActionItems` / `onSaveFollowUps` in `MeetingDetail.vue`), whichever panel is saved *first* fires the one-time notification; if you then go back and approve the other panel's items for the first time, `reviewedAt` is already set, so `justReviewed` is false and nothing is sent — those approvals are never included in any notification, permanently. (I flagged a version of this after building the per-panel save, but seeing it confirmed independently across two audits makes it worth prioritizing.) Fix direction: needs a design decision — e.g. track "first review" per category instead of per meeting, or notify on every save but dedupe by item.

**3. `submitMeetingReview` always sets `markReviewed: true`, even when only `keywords` is sent.**
`ReviewMeetingInput` allows a keywords-only call, but any call through this endpoint marks the whole meeting reviewed regardless of which fields are populated. Currently no frontend caller actually sends keywords-only (dead code path today), but the API contract allows a future/accidental keywords-only call to prematurely mark a meeting "reviewed" and fire notifications with zero real approvals. Cheap to close off now while it's unused.

## Moderate

**4. Regenerating one category on an already-reviewed meeting leaves the meeting badged "Reviewed" even though that category now has fresh, unapproved candidates.** `regenerateCategory.ts` intentionally doesn't touch `reviewedAt` (by design, per its own comment), but the dashboard's review-status pill is meeting-level, so it can show "Reviewed" while, say, Action Items is sitting at zero approved with a brand-new unreviewed set underneath. Worth at least a visual cue when a category has been regenerated since the last review.

**5. Reprocessing a meeting discards all previously-approved takeaways/action items/follow-ups with no way to recover them.** `processMeeting.ts` deletes and recreates the entire `meeting_insights` row on reprocess. If you hit "Reprocess meeting" on something you'd already reviewed, every approval you made is gone and the meeting silently reverts to `needs_review`.

**6. Editing meeting metadata can wipe unsaved review checkbox changes.** `MeetingDetail.vue`'s metadata `onSave()` calls `load()`, which reseeds *both* the Action Items and Follow-ups working copies from the server. Sequence that loses data: toggle some checkboxes in Action Items or Follow-ups (unsaved) → click the separate "Edit" button to fix the meeting title → Save. The title save silently discards the in-progress review selections, with no warning. This is the same class of bug the per-panel save was built to avoid — it just leaked in through the metadata-edit path instead.

**7. No indexes on the foreign-key columns you query constantly** (`meeting_insights.meeting_id`, `transcripts.meeting_id`, `transcript_chunks.transcript_id`, `notifications_log.meeting_id`). Postgres doesn't auto-index the referencing side of a FK. Fine at your current personal scale; worth adding before data volume grows.

**8. CORS is wide open (`origin: true`) and there's no auth on any route.** Both are already known, deliberate gaps for a local personal POC (your own comments say as much), but flagging together since they compound: today, low risk on localhost; the moment this API is reachable from anywhere but your own machine (e.g. once it's on Railway), any website a browser visits could call it and read/write your meeting data.

## Minor

- `listMeetings`'s `.filter((t) => t.approved)` on takeaways is dead code — `normalizeTakeaways` forces `approved: true` unconditionally, so the filter can never remove anything. Harmless, but implies takeaways can be unapproved when they no longer can.
- `SuggestionItem.approved` (the takeaways type) is vestigial — nothing in the codebase can ever set it to `false` anymore. Not wrong, just worth a comment noting it's a fossil of the pre-"auto-approve" design.
- `meetings.zoomMeetingId` has no unique constraint — a duplicate Zoom webhook delivery could create two `meetings` rows for the same call, whenever Stage 6 lands.
- `.env.example` contains a real value (`DEFAULT_OWNER_EMAIL=peter.drummond@flippengroup.com`) rather than a placeholder. Not a secret, but templates usually ship with dummy values.
- `SubmitReviewInput.keywords` is declared in `api.ts` but no current caller ever sends it — dead optional field (related to #3 above).
- Two orphaned dashboard views (`MeetingList.vue`, `FollowUpsOverview.vue`) exist but aren't routed anywhere — self-documented as intentionally inert, just noting them.
- No Fastify schema validation on route request bodies; malformed input relies on downstream code throwing, caught per-route and turned into a 400 with the raw error message exposed. Fine for a personal tool talking only to your own dashboard.

## Accepted risks (already known, not new information)

- **No authentication/authorization anywhere in the API** — deliberate for a personal POC, to be replaced when this moves into the real "hub" app.
- **Prompt injection via transcript text** sent to Claude — theoretically a transcript could contain text trying to steer the extraction, but forced tool-use (`tool_choice: {type: "tool", ...}`) constrains output to a fixed schema, limiting the practical impact.
- No SQL injection risk found anywhere — all raw `sql` usage (`askQuestion.ts`, `captureManualMeeting.ts`) uses Drizzle's parameterized `sql` tag correctly, not string concatenation.
- No hardcoded secrets found anywhere in tracked files; `.env` is correctly gitignored and untracked.

## Suggested order of fixes

Given what's live and what's just been built, I'd tackle in this order: (1) the stale `.js` files, since it can mask any other fix you make; (2) the per-panel notification gap, since it's a silent data-loss-adjacent bug in the feature we just shipped; (3) the metadata-edit-clobbers-review-selections bug, same reason; (4) the reprocess-discards-approvals issue, since it's a one-click way to lose real work; everything else is safe to batch in afterward.
