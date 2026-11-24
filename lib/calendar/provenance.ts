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

export function organizer(event: CalendarEvent, ownerEmail: string | null, ownerCalendar: boolean, allowlist: ReadonlySet<string>) {
  const email = normalizeEmail(event.organizerEmail);
  const isOwner = event.organizerSelf === true || event.organizerEmail === undefined ||
    (email !== undefined && (email === ownerEmail || (ownerCalendar && email === normalizeEmail(event.calendarId))));
  const kind = isOwner ? 'owner' : email && allowlist.has(email) ? 'allowlisted' : 'blocked';
  return { email, kind } as const;
}

export function attendeeEmails(event: CalendarEvent) {
  return new Set(event.attendees?.map(attendee => normalizeEmail(attendee.email)));
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
