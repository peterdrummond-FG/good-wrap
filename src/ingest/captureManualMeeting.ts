// Stage 0: Manual capture.
//
// This is the "getting data in" step described in the brief — it exists so the
// rest of the system can be built and proven out without depending on Zoom
// admin access. Whatever shape of input this function takes is deliberately
// the same shape Stage 6's Zoom webhook handler will eventually produce, so
// swapping the source later doesn't require touching anything downstream:
//
//   Stage 0 (this file, manual input) ─┐
//   Stage 6 (Zoom webhook, later)      ─┴─► same captureManualMeeting() call ─► DB
//
// It writes to exactly the tables Stage 1 defined for this purpose: people,
// meetings, meeting_participants, transcripts. It does NOT call Claude or
// generate embeddings — that's Stage 2 (meeting_insights, transcript_chunks),
// a separate step that would run after this one.

import { and, eq, isNull, sql } from "drizzle-orm";
import { db, schema } from "../db/client";

export interface CaptureParticipantInput {
  /** Optional — real-world captures often don't have attendee emails on hand. */
  email?: string;
  /** Required when email isn't known; used to match/create a name-only person row. */
  name?: string;
}

// Shared by captureManualMeeting (new meeting) and updateMeeting (editing an
// existing meeting's participant list, see queries.ts) so the email/name
// matching rules only live in one place. `tx` accepts either a transaction or
// the top-level `db` handle — same as everywhere else in this file.
export async function resolveParticipantIds(
  tx: Pick<typeof db, "select" | "insert">,
  participants: CaptureParticipantInput[]
): Promise<string[]> {
  const participantIds: string[] = [];
  for (const participant of participants) {
    const email = participant.email?.trim().toLowerCase();
    const name = participant.name?.trim();

    if (!email && !name) continue;

    if (email) {
      const [person] = await tx
        .insert(schema.people)
        .values({ email, name })
        .onConflictDoUpdate({
          target: schema.people.email,
          // Only overwrite `name` if a non-empty one was supplied this time,
          // so a later transcript without names doesn't erase one we already have.
          set: name ? { name } : {},
        })
        .returning({ id: schema.people.id });

      participantIds.push(person.id);
      continue;
    }

    // No email — match an existing name-only person, else create one.
    const [existing] = await tx
      .select({ id: schema.people.id })
      .from(schema.people)
      .where(and(isNull(schema.people.email), sql`lower(${schema.people.name}) = lower(${name})`))
      .limit(1);

    if (existing) {
      participantIds.push(existing.id);
      continue;
    }

    const [created] = await tx
      .insert(schema.people)
      .values({ name })
      .returning({ id: schema.people.id });

    participantIds.push(created.id);
  }
  return participantIds;
}

export interface CaptureManualMeetingInput {
  /** Meeting title/subject — maps to meetings.topic */
  topic: string;
  /** When the meeting happened. Accepts a Date or an ISO 8601 string. */
  startTime: Date | string;
  /** Optional; maps to meetings.duration_minutes */
  durationMinutes?: number;
  /** Attendees. Matched/created in `people` by email (the natural key). */
  participants: CaptureParticipantInput[];
  /** Full raw transcript text. */
  transcript: string;
  /**
   * Email of the app user who owns this meeting (maps to meetings.owner_id,
   * a `users` row — separate from `people`). Defaults to DEFAULT_OWNER_EMAIL
   * env var since this is a personal-first tool with one real user today.
   */
  ownerEmail?: string;
  /** 'manual' (default, Stage 0) or 'zoom' (Stage 6, once that's wired up). */
  source?: "manual" | "zoom";
  /** Only set for source: 'zoom' — nullable in the schema for manual entries. */
  zoomMeetingId?: string;
}

export interface CaptureManualMeetingResult {
  meetingId: string;
  transcriptId: string;
  ownerId: string;
  participantIds: string[];
}

export async function captureManualMeeting(
  input: CaptureManualMeetingInput
): Promise<CaptureManualMeetingResult> {
  const ownerEmail = input.ownerEmail ?? process.env.DEFAULT_OWNER_EMAIL;
  if (!ownerEmail) {
    throw new Error(
      "No owner email provided and DEFAULT_OWNER_EMAIL is not set in the environment."
    );
  }
  if (!input.topic.trim()) {
    throw new Error("topic is required");
  }
  if (!input.transcript.trim()) {
    throw new Error("transcript is required");
  }

  const startTime =
    typeof input.startTime === "string" ? new Date(input.startTime) : input.startTime;
  if (Number.isNaN(startTime.getTime())) {
    throw new Error(`Invalid startTime: ${input.startTime}`);
  }

  return db.transaction(async (tx) => {
    // 1. Resolve the owner (users table — the app user, not a meeting participant).
    const [owner] = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, ownerEmail))
      .limit(1);

    if (!owner) {
      throw new Error(
        `No users row found for owner email "${ownerEmail}". Create it first ` +
          `(see Project-Handoff-Brief.md Section 9 for how this was bootstrapped).`
      );
    }

    // 2. Match/create each participant in `people`.
    // Email is the strong identity key when known (upsert on email). When no
    // email is given, fall back to matching an existing name-only row
    // (email is null AND lower(name) matches), or create a new name-only row.
    // Real-world capture frequently only has names on hand — see the
    // `people_allow_name_only_identity` migration and the schema.ts comment.
    // (Logic lives in resolveParticipantIds so updateMeeting() in queries.ts
    // can reuse it when a meeting's participant list is edited later.)
    const participantIds = await resolveParticipantIds(tx, input.participants);

    // 3. Create the meeting row.
    const [meeting] = await tx
      .insert(schema.meetings)
      .values({
        ownerId: owner.id,
        topic: input.topic,
        startTime,
        durationMinutes: input.durationMinutes,
        source: input.source ?? "manual",
        zoomMeetingId: input.zoomMeetingId,
      })
      .returning({ id: schema.meetings.id });

    // 4. Link participants to the meeting.
    if (participantIds.length > 0) {
      await tx.insert(schema.meetingParticipants).values(
        participantIds.map((personId) => ({
          meetingId: meeting.id,
          personId,
        }))
      );
    }

    // 5. Store the transcript.
    const [transcript] = await tx
      .insert(schema.transcripts)
      .values({
        meetingId: meeting.id,
        rawText: input.transcript,
      })
      .returning({ id: schema.transcripts.id });

    return {
      meetingId: meeting.id,
      transcriptId: transcript.id,
      ownerId: owner.id,
      participantIds,
    };
  });
}
