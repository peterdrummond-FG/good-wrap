// Meeting Intelligence System — Stage 1 schema (Drizzle ORM / Postgres + pgvector)
//
// DB host: Supabase (used as plain Postgres — no Supabase Auth/Edge Functions).
// The schema below is host-agnostic; nothing here depends on Supabase-specific
// features, so it would also work unchanged against Neon or any Postgres 15+
// instance with the `vector` extension enabled.
//
// DRAFT — for review only. Do not run migrations against this until Peter confirms.
//
// Notes / assumptions made while drafting (flag these back to Peter):
// 1. All primary keys use `uuid` with `defaultRandom()`. Swap to serial/bigint if you'd
//    rather have sequential IDs — uuid was chosen so meeting/person records can be
//    created client-side (e.g. in the manual-entry form) before hitting the DB.
// 2. `embedding vector(1536)` assumes OpenAI-style 1536-dim embeddings (matches the
//    brief). If Claude's embedding model or a different provider is used, this
//    dimension will need to change.
// 3. `meeting_participants` uses a composite primary key (meeting_id, person_id)
//    rather than its own surrogate id, since the brief didn't specify one and the
//    pair is naturally unique.
// 4. Enums (`source`, `channel`, `status`) are implemented as Postgres enums via
//    pgEnum rather than plain text, for stricter validation at the DB level.
// 5. Added `updated_at` only where the brief implied mutation over time
//    (meeting_insights.generated_at covers that already, so no extra field there).
// 6. Relations (`relations(...)`) are added for convenience with Drizzle's query API
//    but are not required — they don't change the underlying SQL schema.
// 7. `users` here is a plain app-level table, separate from Supabase's built-in
//    `auth.users` (which isn't used, per Peter's decision to skip Supabase Auth).
//    If Supabase Auth is adopted later, this table would need to either be dropped
//    in favor of `auth.users` or linked to it via a foreign key — worth flagging
//    before Stage 4 if the "dashboard login gate" open decision lands on Supabase Auth.

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  primaryKey,
  customType,
  index,
  uniqueIndex,
  boolean,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

// --- custom pgvector column type -------------------------------------------------
// Drizzle core doesn't ship a pgvector type, so it's defined here using customType.
// Requires the `vector` extension enabled on the Postgres database (Neon supports this).
//
// Dimension is 384 to match the local embedding model used in
// src/pipeline/embedChunks.ts (Xenova/all-MiniLM-L6-v2, run entirely in Node —
// no external embeddings API/account). Originally drafted at 1536 assuming an
// OpenAI/Voyage-style provider; changed 2026-07-15 per Peter's preference to
// avoid adding another paid API dependency. If you ever swap the embedding
// model, this number and the model's output dimension must match exactly.
const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(384)";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return value
      .slice(1, -1)
      .split(",")
      .map((v) => Number(v));
  },
});

// --- enums -------------------------------------------------------------------------
// "upload" added 2026-07-16 alongside file-upload/folder-auto-scan capture
// (both write through captureManualMeeting the same way "manual" does — this
// value exists purely so the dashboard's source display can tell an
// unattended text-file capture apart from something Peter actually typed in).
export const meetingSourceEnum = pgEnum("meeting_source", ["manual", "upload", "zoom"]);
export const notificationChannelEnum = pgEnum("notification_channel", [
  "email",
  "chat",
  "dashboard",
]);
export const notificationStatusEnum = pgEnum("notification_status", [
  "pending",
  "sent",
  "failed",
]);
// Added 2026-07-17 alongside the companies/meeting-tagging feature. "ai" =
// last set by Claude's own transcript classification (extractInsights.ts /
// the process-transcripts skill); "manual" = Peter picked/corrected it
// himself on the meeting detail page. Once "manual", automatic
// (re)processing must never overwrite meetings.company_id again — see
// applyAiCompanyGuess in queries.ts.
export const companySourceEnum = pgEnum("company_source", ["ai", "manual"]);

// --- users ---------------------------------------------------------------------
// The people who own/log in to the system. Peter is the only row today, but
// modeled as a table from day one so this isn't a single-user hack.
export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// --- people --------------------------------------------------------------------
// Normalized identity for anyone who appears as a meeting participant (not
// necessarily a system user). Keyed on email when known, but email is optional:
// real-world capture (pasting a transcript) often doesn't have attendee emails
// on hand, so a person can be identified by name alone. Updated 2026-07-14
// (migration `people_allow_name_only_identity`) after live use showed requiring
// email up front was blocking capture. Name-only rows are deduped via a partial
// unique index on lower(name) where email is null — collisions across
// different real people with the same name are possible and accepted as a
// tradeoff at personal scale; email remains the stronger identity key when known.
export const people = pgTable("people", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").unique(),
  name: text("name"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// --- companies -------------------------------------------------------------------
// Added 2026-07-17: Flippen Group owns several distinct companies
// (Teachworthy, Teamalytics, Capturing Kids Hearts, Integrous, Galleria,
// Maisey, and others still to be added), and there was previously no way to
// tell which one a given meeting was actually about. Claude infers the best
// match from the transcript (see extractInsights.ts's `company` tool
// property) against this table's name + aliases, including a row for
// "Flippen Group" itself for internal/corporate meetings. Peter can always
// re-pick from the meeting detail page — see meetings.companySource below
// for how a manual pick is protected from being overwritten by a later
// automatic (re)process.
export const companies = pgTable("companies", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  // URL-safe identifier, also used as the logo filename under
  // dashboard/public/logos/{slug}.png (see CompanyTag.vue) — kept as an
  // explicit column rather than derived from `name` at read time so a
  // display-name tweak (e.g. capitalization) never silently breaks the
  // logo lookup or requires a matching asset rename.
  slug: text("slug").notNull().unique(),
  // Short names/abbreviations Claude should recognize in transcripts (e.g.
  // ["CKH", "Capturing Kids Hearts"]) — matched case-insensitively against
  // the transcript text, in addition to the full `name`.
  aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
  // True only for "Flippen Group" itself — lets extraction distinguish an
  // internal/corporate meeting from "couldn't tell which company."
  isInternal: boolean("is_internal").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// --- person_companies --------------------------------------------------------------
// Added 2026-07-17: which companies a person works with — set directly by
// Peter (never inferred from their meeting history), since some people work
// with exactly one company while Flippen Group staff span several. Plain
// many-to-many join, no extra columns — see setPersonCompanies in
// queries.ts, which always replaces a person's full set in one call (same
// "replace the whole list" convention as resolveParticipantIds for meeting
// participants).
export const personCompanies = pgTable(
  "person_companies",
  {
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.personId, table.companyId] }),
    companyIdIdx: index("person_companies_company_id_idx").on(table.companyId),
  })
);

// --- meetings --------------------------------------------------------------------
// zoomMeetingId stores Zoom's per-occurrence `uuid`, NOT its numeric `id` —
// `id` is reused across every occurrence of a recurring meeting, so keying
// dedup on it would collapse distinct meetings together. Partial unique index
// (added 2026-07-16 alongside the Zoom webhook, CODE-AUDIT.md's flagged risk)
// guards against a duplicate webhook delivery creating two rows for the same
// recording — the webhook handler itself also checks explicitly before
// inserting, so this index is the last-resort safety net for a genuine race
// between two concurrent retries, not the primary dedup path.
export const meetings = pgTable(
  "meetings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    zoomMeetingId: text("zoom_meeting_id"), // nullable — populated only for source = 'zoom'
    topic: text("topic").notNull(),
    startTime: timestamp("start_time", { withTimezone: true }).notNull(),
    durationMinutes: integer("duration_minutes"),
    source: meetingSourceEnum("source").notNull().default("manual"),
    // Nullable — a meeting starts uncategorized until the first processing
    // pass (or Peter) tags it. references(..., {onDelete: "set null"}) so
    // deleting a company (should that ever happen) un-tags its meetings
    // rather than failing or cascading a meeting delete.
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    // Null until companyId is first set. See companySourceEnum above for why
    // this exists — "manual" permanently protects the tag from automatic
    // reprocessing (applyAiCompanyGuess in queries.ts checks this first).
    companySource: companySourceEnum("company_source"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    zoomMeetingIdUnique: uniqueIndex("meetings_zoom_meeting_id_unique")
      .on(table.zoomMeetingId)
      .where(sql`${table.zoomMeetingId} is not null`),
    companyIdIdx: index("meetings_company_id_idx").on(table.companyId),
  })
);

// --- meeting_participants ----------------------------------------------------------
// Join table: which people attended which meeting.
// person_id gets its own index (added 2026-07-15, CODE-AUDIT.md item #7) —
// the composite PK covers (meeting_id, person_id) lookups already since
// meeting_id is the leading column, but a reverse lookup by person alone
// (e.g. "which meetings has X attended") wasn't covered.
export const meetingParticipants = pgTable(
  "meeting_participants",
  {
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.meetingId, table.personId] }),
    personIdIdx: index("meeting_participants_person_id_idx").on(table.personId),
  })
);

// --- transcripts -------------------------------------------------------------------
export const transcripts = pgTable(
  "transcripts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    rawText: text("raw_text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    meetingIdIdx: index("transcripts_meeting_id_idx").on(table.meetingId),
  })
);

// --- transcript_chunks ---------------------------------------------------------------
// Chunked + embedded transcript text, for pgvector similarity search (Stage 5).
export const transcriptChunks = pgTable(
  "transcript_chunks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    transcriptId: uuid("transcript_id")
      .notNull()
      .references(() => transcripts.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    chunkText: text("chunk_text").notNull(),
    embedding: vector("embedding"),
  },
  (table) => ({
    transcriptIdIdx: index("transcript_chunks_transcript_id_idx").on(table.transcriptId),
  })
);

// --- meeting_insights -----------------------------------------------------------
// Claude-generated keywords/takeaways/action-items/follow-ups (Stage 2 output).
//
// Added 2026-07-16 (migration `add_action_items_and_review_status`): takeaways,
// action_items, and follow_ups are now suggest-then-approve — Claude generates
// 5-8 candidates per category (see extractInsights.ts) with `approved: false`,
// and Peter picks which ones to keep (and can edit the text) on the meeting
// detail page. Keywords are NOT part of this workflow — they stay fully
// automatic, no approval step. Takeaways were later pulled out of this
// workflow too (capped at exactly 5, auto-approved — see extractInsights.ts).
//
// Distinction between action items and follow-ups (Peter's framing): action
// items are tasks Peter himself needs to do (no separate owner field needed);
// follow-ups are tasks other people need to do, or reminders of unconfirmed
// items — hence follow-ups keep a `person` field and action items don't.
//
// `reviewed_at` was originally a single meeting-wide column, but the review
// UI added a Save button per category (Action Items, Follow-ups), so one
// shared timestamp could no longer tell whether BOTH categories had actually
// been reviewed — only whichever was saved first. Split 2026-07-15 (migration
// `split_reviewed_at_per_category`, CODE-AUDIT.md items #2/#4) into
// `action_items_reviewed_at`/`follow_ups_reviewed_at`, each null until that
// category's own Save button is used at least once. The dashboard's 3-state
// badge (see computeReviewStatus in queries.ts) now reports "reviewed" only
// once both are set, and the notification gate (src/pipeline/reviewMeeting.ts)
// fires once per category the first time IT transitions null -> set, instead
// of once ever for the whole meeting.
// Replaced "timing" (today/tomorrow/this_week/next_week/unspecified) with
// "urgency" 2026-07-16 per Peter's request — he wanted suggested action
// items/follow-ups grouped by how urgent they are, not by when the
// transcript implied they'd happen. "medium" is the default absent any
// genuine urgency signal (unlike timing's "unspecified", there's no need for
// a 4th "unknown" bucket — everything defaults to a real, sortable value).
export type Urgency = "high" | "medium" | "low";

// Takeaways: plain suggest/approve, no owner or urgency concept.
export interface SuggestionItem {
  text: string;
  approved: boolean;
}

// Action items: things Peter needs to do himself.
export interface ActionItem {
  text: string;
  urgency: Urgency;
  approved: boolean;
  // Set once this item's been pushed to Asana (src/integrations/asana.ts,
  // added 2026-07-16) — the created task's gid, so the "Send to Asana"
  // button becomes a no-op re-send instead of creating a duplicate task.
  asanaTaskGid?: string;
  // Marked complete by Peter (added 2026-07-16) — greys the item out in the
  // UI but keeps it visible/listed, unlike delete which removes it outright.
  // Distinct from `approved`: approved means "this is a real item I've
  // committed to", done means "I've actually finished it." Only meaningful
  // once approved.
  done?: boolean;
}

// Follow-ups: things waiting on someone else, or unconfirmed items to revisit.
// `person` is null when no specific person is identifiable from the transcript.
export interface FollowUpItem {
  text: string;
  person: string | null;
  urgency: Urgency;
  approved: boolean;
  // Same meaning as ActionItem.done above.
  done?: boolean;
}

export const meetingInsights = pgTable(
  "meeting_insights",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    keywords: jsonb("keywords").$type<string[]>(),
    takeaways: jsonb("takeaways").$type<SuggestionItem[]>(),
    actionItems: jsonb("action_items").$type<ActionItem[]>(),
    followUps: jsonb("follow_ups").$type<FollowUpItem[]>(),
    // Null = suggestions generated but not yet reviewed/approved by Peter.
    // Set = that category's Save button has been used at least once (see
    // reviewMeeting.ts for what flips this, and regenerateCategory.ts, which
    // resets the relevant one back to null when that category is refreshed).
    actionItemsReviewedAt: timestamp("action_items_reviewed_at", { withTimezone: true }),
    followUpsReviewedAt: timestamp("follow_ups_reviewed_at", { withTimezone: true }),
    generatedAt: timestamp("generated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    meetingIdIdx: index("meeting_insights_meeting_id_idx").on(table.meetingId),
  })
);

// --- notifications_log -------------------------------------------------------------
export const notificationsLog = pgTable(
  "notifications_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    channel: notificationChannelEnum("channel").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    status: notificationStatusEnum("status").notNull().default("pending"),
  },
  (table) => ({
    meetingIdIdx: index("notifications_log_meeting_id_idx").on(table.meetingId),
  })
);

// --- relations (optional, for Drizzle's relational query API) ----------------------
export const usersRelations = relations(users, ({ many }) => ({
  meetings: many(meetings),
}));

export const meetingsRelations = relations(meetings, ({ one, many }) => ({
  owner: one(users, { fields: [meetings.ownerId], references: [users.id] }),
  company: one(companies, { fields: [meetings.companyId], references: [companies.id] }),
  participants: many(meetingParticipants),
  transcripts: many(transcripts),
  insights: many(meetingInsights),
  notifications: many(notificationsLog),
}));

export const companiesRelations = relations(companies, ({ many }) => ({
  meetings: many(meetings),
  personCompanies: many(personCompanies),
}));

export const peopleRelations = relations(people, ({ many }) => ({
  meetingParticipants: many(meetingParticipants),
  personCompanies: many(personCompanies),
}));

export const personCompaniesRelations = relations(personCompanies, ({ one }) => ({
  person: one(people, { fields: [personCompanies.personId], references: [people.id] }),
  company: one(companies, { fields: [personCompanies.companyId], references: [companies.id] }),
}));

export const meetingParticipantsRelations = relations(meetingParticipants, ({ one }) => ({
  meeting: one(meetings, {
    fields: [meetingParticipants.meetingId],
    references: [meetings.id],
  }),
  person: one(people, {
    fields: [meetingParticipants.personId],
    references: [people.id],
  }),
}));

export const transcriptsRelations = relations(transcripts, ({ one, many }) => ({
  meeting: one(meetings, { fields: [transcripts.meetingId], references: [meetings.id] }),
  chunks: many(transcriptChunks),
}));

export const transcriptChunksRelations = relations(transcriptChunks, ({ one }) => ({
  transcript: one(transcripts, {
    fields: [transcriptChunks.transcriptId],
    references: [transcripts.id],
  }),
}));

export const meetingInsightsRelations = relations(meetingInsights, ({ one }) => ({
  meeting: one(meetings, { fields: [meetingInsights.meetingId], references: [meetings.id] }),
}));

export const notificationsLogRelations = relations(notificationsLog, ({ one }) => ({
  meeting: one(meetings, { fields: [notificationsLog.meetingId], references: [meetings.id] }),
}));
