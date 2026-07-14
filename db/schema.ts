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
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// --- custom pgvector column type -------------------------------------------------
// Drizzle core doesn't ship a pgvector type, so it's defined here using customType.
// Requires the `vector` extension enabled on the Postgres database (Neon supports this).
const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(1536)";
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
export const meetingSourceEnum = pgEnum("meeting_source", ["manual", "zoom"]);
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
// necessarily a system user). Keyed on email so the same person is recognized
// across meetings without manual dedup.
export const people = pgTable("people", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// --- meetings --------------------------------------------------------------------
export const meetings = pgTable("meetings", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id),
  zoomMeetingId: text("zoom_meeting_id"), // nullable — populated only for source = 'zoom'
  topic: text("topic").notNull(),
  startTime: timestamp("start_time", { withTimezone: true }).notNull(),
  durationMinutes: integer("duration_minutes"),
  source: meetingSourceEnum("source").notNull().default("manual"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// --- meeting_participants ----------------------------------------------------------
// Join table: which people attended which meeting.
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
  })
);

// --- transcripts -------------------------------------------------------------------
export const transcripts = pgTable("transcripts", {
  id: uuid("id").defaultRandom().primaryKey(),
  meetingId: uuid("meeting_id")
    .notNull()
    .references(() => meetings.id, { onDelete: "cascade" }),
  rawText: text("raw_text").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// --- transcript_chunks ---------------------------------------------------------------
// Chunked + embedded transcript text, for pgvector similarity search (Stage 5).
export const transcriptChunks = pgTable("transcript_chunks", {
  id: uuid("id").defaultRandom().primaryKey(),
  transcriptId: uuid("transcript_id")
    .notNull()
    .references(() => transcripts.id, { onDelete: "cascade" }),
  chunkIndex: integer("chunk_index").notNull(),
  chunkText: text("chunk_text").notNull(),
  embedding: vector("embedding"),
});

// --- meeting_insights -----------------------------------------------------------
// Claude-generated keywords/takeaways/follow-ups (Stage 2 output).
export const meetingInsights = pgTable("meeting_insights", {
  id: uuid("id").defaultRandom().primaryKey(),
  meetingId: uuid("meeting_id")
    .notNull()
    .references(() => meetings.id, { onDelete: "cascade" }),
  keywords: jsonb("keywords").$type<string[]>(),
  takeaways: jsonb("takeaways").$type<string[]>(),
  followUps: jsonb("follow_ups").$type<string[]>(),
  generatedAt: timestamp("generated_at", { withTimezone: true }).defaultNow().notNull(),
});

// --- notifications_log -------------------------------------------------------------
export const notificationsLog = pgTable("notifications_log", {
  id: uuid("id").defaultRandom().primaryKey(),
  meetingId: uuid("meeting_id")
    .notNull()
    .references(() => meetings.id, { onDelete: "cascade" }),
  channel: notificationChannelEnum("channel").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  status: notificationStatusEnum("status").notNull().default("pending"),
});

// --- relations (optional, for Drizzle's relational query API) ----------------------
export const usersRelations = relations(users, ({ many }) => ({
  meetings: many(meetings),
}));

export const meetingsRelations = relations(meetings, ({ one, many }) => ({
  owner: one(users, { fields: [meetings.ownerId], references: [users.id] }),
  participants: many(meetingParticipants),
  transcripts: many(transcripts),
  insights: many(meetingInsights),
  notifications: many(notificationsLog),
}));

export const peopleRelations = relations(people, ({ many }) => ({
  meetingParticipants: many(meetingParticipants),
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
