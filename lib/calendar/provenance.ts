import type { CalendarEvent } from './types.ts';

export type EventProvenance = {
  organizerEmail?: string;
  creatorEmail?: string;
  isOwnerOrganizer: boolean;
  externalInvite: boolean;
  requiresOwnerApproval: boolean;
  ownerApproved: boolean;
};

export function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cf}]/u.test(value)) return;
  const email = value.trim().toLowerCase();
  if (email.length <= 320 && /^[^\s@]+@[^\s@]+$/u.test(email)) return email;
}

export function stripAgentStatusNotes(description: string | undefined) {
  if (description === undefined) return undefined;
  const lines = description.split('\n').filter(line => !/^\[agent-status:[^\]]+\] /.test(line));
  return lines.join('\n');
}

export function organizer(event: CalendarEvent, ownerEmail: string | null, ownerCalendar: boolean, allowlist: ReadonlySet<string>, requireOrganizer = false) {
  const email = normalizeEmail(event.organizerEmail);
  const verifiedOwnerEmail = email !== undefined && ownerEmail !== null && email === ownerEmail;
  const verifiedPrimarySelf = ownerCalendar && event.organizerSelf === true && (!email || !ownerEmail || email === ownerEmail);
  const legacyCalendarWide = !requireOrganizer && (event.organizerEmail === undefined || (ownerEmail === null && event.organizerSelf === true));
  const isOwner = verifiedOwnerEmail || verifiedPrimarySelf || legacyCalendarWide;
  const kind = isOwner ? 'owner' : email && allowlist.has(email) ? 'allowlisted' : 'blocked';
  return { email, kind } as const;
}

export function attendeeEmails(event: CalendarEvent, includeDeclined = true) {
  return new Set(event.attendees
    ?.filter(attendee => includeDeclined || attendee.responseStatus !== 'declined')
    .map(attendee => normalizeEmail(attendee.email)));
}

export function invitationKey(event: CalendarEvent) {
  return event.seriesId && event.recurrenceId
    ? JSON.stringify([event.seriesId, event.recurrenceId])
    : JSON.stringify([event.providerEventId]);
}

export function eventProvenance(event: CalendarEvent, source: ReturnType<typeof organizer>, approved: boolean): EventProvenance {
  const external = source.kind !== 'owner';
  return {
    organizerEmail: source.email, creatorEmail: normalizeEmail(event.creatorEmail), isOwnerOrganizer: !external,
    externalInvite: external, requiresOwnerApproval: external, ownerApproved: !external || approved,
  };
}
