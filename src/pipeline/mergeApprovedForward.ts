// Reprocessing a meeting (processMeeting.ts) and regenerating a single
// category (regenerateCategory.ts) both call Claude fresh and, before this,
// simply replaced whatever was already there — silently discarding every
// approval (and any edited wording) a real review represents
// (CODE-AUDIT.md item #5).
//
// This keeps previously-approved items exactly as they were and appends the
// newly-generated candidates alongside them, deduped by text so an obvious
// re-suggestion of an already-approved item doesn't show up twice. Only
// approved items are worth preserving this way — an unapproved candidate the
// reviewer never acted on is just Claude's opinion, and a fresh opinion is
// exactly what re-running is for.

export function mergeApprovedForward<T extends { text: string }>(
  previouslyApproved: T[],
  fresh: T[]
): T[] {
  const approvedTextsLower = new Set(previouslyApproved.map((item) => item.text.trim().toLowerCase()));
  const freshWithoutDuplicates = fresh.filter(
    (item) => !approvedTextsLower.has(item.text.trim().toLowerCase())
  );
  return [...previouslyApproved, ...freshWithoutDuplicates];
}
