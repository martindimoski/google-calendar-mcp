import { existsSync } from 'node:fs';
import { google, type calendar_v3 } from 'googleapis';
import { CalendarApiError } from '../errors/CalendarApiError.js';
import { CalendarNotSubscribedError } from '../errors/CalendarNotSubscribedError.js';
import { TimeSlotConflictError } from '../errors/TimeSlotConflictError.js';
import { logApiError, logApiRequest, logApiResponse } from '../utils/apiLogger.js';

/**
 * Subset of Google Calendar v3 access role values, narrowed to the ones
 * relevant to this server. Matches `Schema$CalendarListEntry.accessRole`.
 */
export type CalendarAccessRole = 'freeBusyReader' | 'reader' | 'writer' | 'owner';

/**
 * DTO returned by {@link GoogleCalendarService.listCalendars}. Keeps only
 * the fields that downstream MCP tools care about — the raw Google
 * response is much larger and exposes internal etags / color metadata
 * that aren't useful to a model.
 */
export interface CalendarSummary {
    id: string;
    summary: string;
    description?: string | undefined;
    timeZone?: string | undefined;
    accessRole?: CalendarAccessRole | undefined;
    primary?: boolean | undefined;
    selected?: boolean | undefined;
    hidden?: boolean | undefined;
}

export interface ListCalendarsOptions {
    showHidden?: boolean;
    showDeleted?: boolean;
    minAccessRole?: CalendarAccessRole;
    /** 1..250, defaults to Google's server default (100) when omitted. */
    maxResults?: number;
}

export interface FindAvailableSlotsOptions {
    /** Inclusive start of the search window. */
    timeMin: Date;
    /** Exclusive end of the search window. */
    timeMax: Date;
    /** Calendars to consult. Busy intervals are unioned across all of them. */
    calendarIds: readonly string[];
    /** Slot length, in minutes. Defaults to 60. */
    slotDurationMinutes?: number;
    /** Optional IANA timezone passed through to freeBusy.query. */
    timeZone?: string;
}

export interface AvailableSlot {
    /** ISO 8601 (UTC) start time. */
    start: string;
    /** ISO 8601 (UTC) end time. */
    end: string;
}

export interface FindAvailableSlotsResult {
    slots: AvailableSlot[];
    /**
     * Per-calendar errors reported by Google (e.g. `notFound`,
     * `forbidden`). Calendars that fail are skipped, not fatal — the
     * caller decides whether the partial result is usable.
     */
    calendarErrors: Record<string, string[]>;
}

export type SendUpdatesPolicy = 'all' | 'externalOnly' | 'none';

export interface CreateEventInput {
    /** Calendar to create the event on. Must be subscribed by this server. */
    calendarId: string;
    /** Email of the user requesting the booking; added as an attendee. */
    userEmail: string;
    /** Inclusive start of the event. */
    start: Date;
    /** Exclusive end of the event. */
    end: Date;
    /** Event title. Defaults to "New event" when omitted. */
    summary?: string;
    /** Optional long-form description / notes. */
    description?: string;
    /** IANA timezone for `start` / `end`. Defaults to UTC. */
    timeZone?: string;
    /** Whether Google should email attendees. Defaults to "all". */
    sendUpdates?: SendUpdatesPolicy;
}

export interface CreatedEvent {
    id: string;
    summary: string;
    start: string;
    end: string;
    htmlLink?: string | undefined;
    organizerEmail?: string | undefined;
    attendees: string[];
    /** Email passed in as the booker; recorded in the event description. */
    bookerEmail?: string | undefined;
    /** True when no invite email was sent (always true under Option 1). */
    inviteSent: boolean;
}

/**
 * Scopes required for the tools this server exposes. Read access lists
 * calendars and events; write access is needed for creating events.
 */
const CALENDAR_SCOPES: readonly string[] = ['https://www.googleapis.com/auth/calendar'];

/**
 * Thin wrapper around the Google Calendar v3 client. It owns the
 * `GoogleAuth` instance so the JWT lifecycle (fetch/refresh access tokens)
 * is handled transparently by `googleapis`.
 *
 * Authentication uses a Service Account JSON key file whose absolute path
 * is provided via the `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` environment
 * variable. For domain-wide access to a user's calendar, impersonate that
 * user by passing `subject` in the constructor options.
 */
export class GoogleCalendarService {
    private readonly auth: InstanceType<typeof google.auth.GoogleAuth>;
    private readonly calendar: calendar_v3.Calendar;

    constructor(
        keyFilePath: string,
        options: { subject?: string; scopes?: readonly string[] } = {},
    ) {
        if (!keyFilePath || keyFilePath.trim() === '') {
            throw new Error(
                'GoogleCalendarService requires a non-empty Service Account key file path.',
            );
        }

        if (!existsSync(keyFilePath)) {
            throw new Error(
                `Google Service Account key file not found at path: ${keyFilePath}. ` +
                    'Verify GOOGLE_SERVICE_ACCOUNT_KEY_FILE points to a valid JSON key file.',
            );
        }

        const scopes = options.scopes ?? CALENDAR_SCOPES;

        this.auth = new google.auth.GoogleAuth({
            keyFile: keyFilePath,
            scopes: [...scopes],
            ...(options.subject !== undefined ? { clientOptions: { subject: options.subject } } : {}),
        });

        this.calendar = google.calendar({ version: 'v3', auth: this.auth });
    }

    /**
     * Returns the underlying Google Calendar v3 client. Service methods
     * (e.g. list calendars, insert event) are invoked via this client.
     */
    public getClient(): calendar_v3.Calendar {
        return this.calendar;
    }

    /**
     * Lists calendars visible to the configured Service Account. The
     * service account only sees calendars that have been explicitly
     * shared with its email, plus (in domain-wide-delegation mode) the
     * impersonated user's primary calendar.
     *
     * Pagination is fully unrolled here: callers get the complete list
     * in one call. If we ever need very large workspace inventories we
     * can expose `pageToken` directly.
     *
     * @throws {@link CalendarApiError} on any underlying API failure.
     */
    public async listCalendars(options: ListCalendarsOptions = {}): Promise<CalendarSummary[]> {
        const baseParams: calendar_v3.Params$Resource$Calendarlist$List = {
            ...(options.showHidden !== undefined ? { showHidden: options.showHidden } : {}),
            ...(options.showDeleted !== undefined ? { showDeleted: options.showDeleted } : {}),
            ...(options.minAccessRole !== undefined ? { minAccessRole: options.minAccessRole } : {}),
            ...(options.maxResults !== undefined ? { maxResults: options.maxResults } : {}),
        };

        const summaries: CalendarSummary[] = [];
        let pageToken: string | undefined;
        let pageCount = 0;

        try {
            do {
                const params: calendar_v3.Params$Resource$Calendarlist$List = {
                    ...baseParams,
                    ...(pageToken !== undefined ? { pageToken } : {}),
                };
                pageCount += 1;
                logApiRequest('calendarList.list', params);
                const response = await this.calendar.calendarList.list(params);
                const items = response.data.items ?? [];
                logApiResponse(
                    'calendarList.list',
                    `page=${pageCount} items=${items.length} hasNextPage=${response.data.nextPageToken ? 'yes' : 'no'}`,
                    response.data,
                );
                for (const entry of items) {
                    summaries.push(toSummary(entry));
                }
                pageToken = response.data.nextPageToken ?? undefined;
            } while (pageToken !== undefined);
        } catch (error) {
            logApiError('calendarList.list', error);
            throw new CalendarApiError('calendarList.list', error);
        }

        console.log(
            `[GCal] RESPONSE calendarList.list complete: ${summaries.length} calendar(s) across ${pageCount} page(s)`,
        );
        return summaries;
    }

    /**
     * Subscribes the service account to a calendar that has already been
     * shared with its email. This is the bridge between "the calendar
     * was shared with me" (an ACL on the calendar) and "the calendar
     * appears in my own calendar list" (`calendarList.list`).
     *
     * The call is naturally idempotent — Google returns the existing
     * entry if the service account is already subscribed.
     *
     * @throws {@link CalendarApiError} when the calendar id is unknown
     *   or the service account lacks at least free/busy access to it.
     */
    public async subscribeCalendar(calendarId: string): Promise<CalendarSummary> {
        if (!calendarId || calendarId.trim() === '') {
            throw new Error('subscribeCalendar: calendarId is required.');
        }

        const requestBody: calendar_v3.Schema$CalendarListEntry = { id: calendarId };

        try {
            logApiRequest('calendarList.insert', { id: calendarId });
            const response = await this.calendar.calendarList.insert({ requestBody });
            logApiResponse(
                'calendarList.insert',
                `subscribed id=${response.data.id ?? '<unknown>'}`,
                response.data,
            );
            return toSummary(response.data);
        } catch (error) {
            logApiError('calendarList.insert', error);
            throw new CalendarApiError('calendarList.insert', error);
        }
    }

    /**
     * Creates an event on a subscribed calendar after running three
     * pre-flight checks, in order:
     *
     *   1. The calendar must be subscribed by this server (i.e. it
     *      appears in `calendarList`). Otherwise we throw
     *      {@link CalendarNotSubscribedError} pointing at
     *      `subscribe_calendar`.
     *   2. The requested `[start, end)` interval must not overlap any
     *      busy block on that calendar. Otherwise we throw
     *      {@link TimeSlotConflictError} with the conflicting periods.
     *   3. Only after both pass do we call `events.insert`.
     *
     * The user's email is added as an attendee. Email format is
     * validated at the tool layer (Zod) and re-validated here so the
     * service is safe to call from anywhere.
     *
     * @throws {@link CalendarNotSubscribedError} when step 1 fails.
     * @throws {@link TimeSlotConflictError} when step 2 fails.
     * @throws {@link CalendarApiError} for any underlying Google failure.
     */
    public async createEvent(input: CreateEventInput): Promise<CreatedEvent> {
        const { calendarId, userEmail, start, end } = input;
        const summary = input.summary ?? 'New event';
        const sendUpdates: SendUpdatesPolicy = input.sendUpdates ?? 'all';

        if (!calendarId || calendarId.trim() === '') {
            throw new Error('createEvent: calendarId is required.');
        }
        if (!isValidEmail(userEmail)) {
            throw new Error(`createEvent: "${userEmail}" is not a valid email address.`);
        }
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
            throw new Error('createEvent: start and end must be valid dates.');
        }
        if (end.getTime() <= start.getTime()) {
            throw new Error('createEvent: end must be strictly after start.');
        }

        // --- Step 1: calendar must be in our subscribed list -------------
        await this.assertCalendarSubscribed(calendarId);

        // --- Step 2: time slot must be free -----------------------------
        const conflicts = await this.findConflicts(calendarId, start, end);
        if (conflicts.length > 0) {
            throw new TimeSlotConflictError(
                calendarId,
                { start: start.toISOString(), end: end.toISOString() },
                conflicts.map((c) => ({
                    start: new Date(c.start).toISOString(),
                    end: new Date(c.end).toISOString(),
                })),
            );
        }

        // --- Step 3: insert the event -----------------------------------
        // We deliberately do NOT pass `attendees`. A bare service account
        // (no Domain-Wide Delegation) is forbidden by Google from inviting
        // attendees — the API rejects the entire insert with
        // "Service accounts cannot invite attendees without Domain-Wide
        // Delegation of Authority." Instead, we record the booker's email
        // inside the event description so the information is preserved
        // and visible on the event itself.
        const description = composeDescription(input.description, userEmail);

        const requestBody: calendar_v3.Schema$Event = {
            summary,
            description,
            start: {
                dateTime: start.toISOString(),
                ...(input.timeZone !== undefined ? { timeZone: input.timeZone } : {}),
            },
            end: {
                dateTime: end.toISOString(),
                ...(input.timeZone !== undefined ? { timeZone: input.timeZone } : {}),
            },
        };

        try {
            // `sendUpdates` is intentionally omitted: with no attendees,
            // there is nobody to notify and Google would ignore it anyway.
            // It remains in `CreateEventInput` for forward-compat with a
            // future DWD-enabled path.
            void sendUpdates;
            logApiRequest('events.insert', { calendarId, requestBody });
            const response = await this.calendar.events.insert({
                calendarId,
                requestBody,
            });
            logApiResponse(
                'events.insert',
                `created id=${response.data.id ?? '<unknown>'} on calendarId=${calendarId}`,
                response.data,
            );
            const created = toCreatedEvent(response.data);
            return { ...created, bookerEmail: userEmail, inviteSent: false };
        } catch (error) {
            logApiError('events.insert', error);
            throw new CalendarApiError('events.insert', error);
        }
    }

    /**
     * Throws {@link CalendarNotSubscribedError} if the given calendar id
     * is not in this service account's `calendarList`. Implemented via
     * `calendarList.get` so we don't have to fetch the full list.
     */
    private async assertCalendarSubscribed(calendarId: string): Promise<void> {
        try {
            logApiRequest('calendarList.get', { calendarId });
            const response = await this.calendar.calendarList.get({ calendarId });
            logApiResponse(
                'calendarList.get',
                `subscribed id=${response.data.id ?? '<unknown>'}`,
                response.data,
            );
        } catch (error) {
            const status = extractStatusCode(error);
            if (status === 404) {
                logApiError('calendarList.get', error);
                throw new CalendarNotSubscribedError(calendarId);
            }
            logApiError('calendarList.get', error);
            throw new CalendarApiError('calendarList.get', error);
        }
    }

    /**
     * Returns busy intervals on `calendarId` that overlap with the
     * `[start, end)` window. Used by `createEvent` for the conflict
     * check; broken out so it's easy to test and reuse.
     */
    private async findConflicts(
        calendarId: string,
        start: Date,
        end: Date,
    ): Promise<Array<{ start: number; end: number }>> {
        const requestBody: calendar_v3.Schema$FreeBusyRequest = {
            timeMin: start.toISOString(),
            timeMax: end.toISOString(),
            items: [{ id: calendarId }],
        };

        let payload: calendar_v3.Schema$FreeBusyResponse;
        try {
            logApiRequest('freebusy.query (conflict-check)', requestBody);
            const response = await this.calendar.freebusy.query({ requestBody });
            payload = response.data;
            logApiResponse(
                'freebusy.query (conflict-check)',
                `busy=${payload.calendars?.[calendarId]?.busy?.length ?? 0}`,
                payload,
            );
        } catch (error) {
            logApiError('freebusy.query (conflict-check)', error);
            throw new CalendarApiError('freebusy.query', error);
        }

        const cal = payload.calendars?.[calendarId];
        if (cal?.errors && cal.errors.length > 0) {
            // freeBusy reports per-calendar errors *inside* a 200 response.
            // Surface them as a top-level failure instead of silently treating
            // the calendar as fully free.
            throw new CalendarApiError(
                'freebusy.query',
                new Error(
                    `Calendar "${calendarId}" returned errors during conflict check: ` +
                        cal.errors.map((e) => e.reason ?? 'unknown').join(', '),
                ),
            );
        }

        const overlaps: Array<{ start: number; end: number }> = [];
        const reqStart = start.getTime();
        const reqEnd = end.getTime();
        for (const period of cal?.busy ?? []) {
            if (!period.start || !period.end) continue;
            const bStart = Date.parse(period.start);
            const bEnd = Date.parse(period.end);
            if (Number.isNaN(bStart) || Number.isNaN(bEnd)) continue;
            if (bStart < reqEnd && bEnd > reqStart) {
                overlaps.push({ start: bStart, end: bEnd });
            }
        }
        return overlaps;
    }

    /**
     * Finds bookable slots within `[timeMin, timeMax)` by querying the
     * Google Calendar freeBusy API for the supplied calendars, merging
     * their busy intervals, and emitting consecutive non-overlapping
     * slots of the requested duration aligned to top-of-hour boundaries.
     *
     * Slot generation rules:
     * - Slots start at multiples of `slotDurationMinutes` from the UTC
     *   epoch — practically, that means top-of-hour for a 60-minute
     *   duration in any whole-hour-offset timezone.
     * - A slot must be entirely inside the requested range and must not
     *   overlap any merged busy interval.
     *
     * @throws {@link CalendarApiError} on freeBusy API failures.
     */
    public async findAvailableSlots(
        options: FindAvailableSlotsOptions,
    ): Promise<FindAvailableSlotsResult> {
        const { timeMin, timeMax, calendarIds, timeZone } = options;
        const slotDurationMinutes = options.slotDurationMinutes ?? 60;

        if (Number.isNaN(timeMin.getTime()) || Number.isNaN(timeMax.getTime())) {
            throw new Error('findAvailableSlots: timeMin and timeMax must be valid dates.');
        }
        if (timeMax.getTime() <= timeMin.getTime()) {
            throw new Error('findAvailableSlots: timeMax must be strictly after timeMin.');
        }
        if (calendarIds.length === 0) {
            throw new Error('findAvailableSlots: at least one calendar id is required.');
        }
        if (!Number.isInteger(slotDurationMinutes) || slotDurationMinutes <= 0) {
            throw new Error('findAvailableSlots: slotDurationMinutes must be a positive integer.');
        }

        const requestBody: calendar_v3.Schema$FreeBusyRequest = {
            timeMin: timeMin.toISOString(),
            timeMax: timeMax.toISOString(),
            items: calendarIds.map((id) => ({ id })),
            ...(timeZone !== undefined ? { timeZone } : {}),
        };

        let payload: calendar_v3.Schema$FreeBusyResponse;
        try {
            logApiRequest('freebusy.query', requestBody);
            const response = await this.calendar.freebusy.query({ requestBody });
            payload = response.data;

            const calendarsField = payload.calendars ?? {};
            const summaryParts = Object.entries(calendarsField).map(([id, cal]) => {
                const busyCount = cal.busy?.length ?? 0;
                const errCount = cal.errors?.length ?? 0;
                return `${id}=busy:${busyCount}${errCount > 0 ? ` errors:${errCount}` : ''}`;
            });
            logApiResponse(
                'freebusy.query',
                `calendars={ ${summaryParts.join(', ')} }`,
                payload,
            );
        } catch (error) {
            logApiError('freebusy.query', error);
            throw new CalendarApiError('freebusy.query', error);
        }

        const calendars = payload.calendars ?? {};
        const calendarErrors: Record<string, string[]> = {};
        const busyIntervals: Array<{ start: number; end: number }> = [];

        for (const id of calendarIds) {
            const cal = calendars[id];
            if (!cal) continue;

            if (cal.errors && cal.errors.length > 0) {
                const reasons = cal.errors
                    .map((e) => e.reason)
                    .filter((r): r is string => typeof r === 'string' && r.length > 0);
                if (reasons.length > 0) calendarErrors[id] = reasons;
            }

            for (const period of cal.busy ?? []) {
                if (!period.start || !period.end) continue;
                const start = Date.parse(period.start);
                const end = Date.parse(period.end);
                if (Number.isNaN(start) || Number.isNaN(end) || end <= start) continue;
                busyIntervals.push({ start, end });
            }
        }

        const merged = mergeIntervals(busyIntervals);
        const slots = generateAlignedSlots(
            timeMin.getTime(),
            timeMax.getTime(),
            slotDurationMinutes * 60_000,
            merged,
        );

        return { slots, calendarErrors };
    }

    /**
     * Verifies credentials by acquiring an access token. Useful as a
     * startup smoke test — throws a descriptive error if the service
     * account cannot authenticate.
     */
    public async verifyCredentials(): Promise<void> {
        try {
            const client = await this.auth.getClient();
            await client.getAccessToken();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to authenticate Google Service Account: ${message}`);
        }
    }
}

const VALID_ACCESS_ROLES: ReadonlySet<CalendarAccessRole> = new Set([
    'freeBusyReader',
    'reader',
    'writer',
    'owner',
]);

function toSummary(entry: calendar_v3.Schema$CalendarListEntry): CalendarSummary {
    if (!entry.id || !entry.summary) {
        // Google guarantees both, but the generated types are nullable.
        // Surface a precise error rather than producing an invalid DTO.
        throw new CalendarApiError(
            'calendarList.list',
            new Error('Calendar entry is missing required fields `id` or `summary`'),
        );
    }
    const accessRole =
        typeof entry.accessRole === 'string' && VALID_ACCESS_ROLES.has(entry.accessRole as CalendarAccessRole)
            ? (entry.accessRole as CalendarAccessRole)
            : undefined;

    return {
        id: entry.id,
        summary: entry.summary,
        ...(entry.description ? { description: entry.description } : {}),
        ...(entry.timeZone ? { timeZone: entry.timeZone } : {}),
        ...(accessRole !== undefined ? { accessRole } : {}),
        ...(typeof entry.primary === 'boolean' ? { primary: entry.primary } : {}),
        ...(typeof entry.selected === 'boolean' ? { selected: entry.selected } : {}),
        ...(typeof entry.hidden === 'boolean' ? { hidden: entry.hidden } : {}),
    };
}

/** RFC 5322-lite check; we deliberately keep it permissive. */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(value: string): boolean {
    return typeof value === 'string' && EMAIL_REGEX.test(value);
}

function extractStatusCode(error: unknown): number | undefined {
    if (typeof error === 'object' && error !== null) {
        const e = error as { code?: unknown; status?: unknown; response?: { status?: unknown } };
        if (typeof e.code === 'number') return e.code;
        if (typeof e.status === 'number') return e.status;
        if (typeof e.response?.status === 'number') return e.response.status;
    }
    return undefined;
}

function toCreatedEvent(event: calendar_v3.Schema$Event): CreatedEvent {
    if (!event.id) {
        throw new CalendarApiError(
            'events.insert',
            new Error('Google did not return an event id for the created event.'),
        );
    }
    const startISO = event.start?.dateTime ?? event.start?.date ?? '';
    const endISO = event.end?.dateTime ?? event.end?.date ?? '';
    const attendees = (event.attendees ?? [])
        .map((a) => a.email)
        .filter((email): email is string => typeof email === 'string' && email.length > 0);

    return {
        id: event.id,
        summary: event.summary ?? 'New event',
        start: startISO,
        end: endISO,
        attendees,
        inviteSent: false,
        ...(event.htmlLink ? { htmlLink: event.htmlLink } : {}),
        ...(event.organizer?.email ? { organizerEmail: event.organizer.email } : {}),
    };
}

/**
 * Builds the event description, preserving any caller-supplied text and
 * appending a single tagged line that records the booker's email. The
 * tag is greppable and stable so we (or a future tool) can later parse
 * it back out of an existing event.
 */
function composeDescription(userDescription: string | undefined, bookerEmail: string): string {
    const bookerLine = `Booked via MCP for: ${bookerEmail}`;
    if (userDescription === undefined || userDescription.trim() === '') {
        return bookerLine;
    }
    return `${userDescription}\n\n${bookerLine}`;
}

/**
 * Merges overlapping/adjacent intervals after sorting by start.
 * Adjacency (`a.end === b.start`) is treated as overlap — for slot
 * availability, back-to-back busy blocks should fuse into one.
 */
function mergeIntervals(
    intervals: ReadonlyArray<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
    if (intervals.length === 0) return [];
    const sorted = [...intervals].sort((a, b) => a.start - b.start);
    const merged: Array<{ start: number; end: number }> = [];
    for (const next of sorted) {
        const last = merged[merged.length - 1];
        if (last && next.start <= last.end) {
            last.end = Math.max(last.end, next.end);
        } else {
            merged.push({ start: next.start, end: next.end });
        }
    }
    return merged;
}

/**
 * Generates fixed-duration slots inside `[rangeStart, rangeEnd)` that
 * (a) start at multiples of `slotMs` from the UTC epoch and (b) do not
 * overlap any merged busy interval. Uses a single forward pass through
 * the busy list — O(slots + busy).
 */
function generateAlignedSlots(
    rangeStart: number,
    rangeEnd: number,
    slotMs: number,
    busy: ReadonlyArray<{ start: number; end: number }>,
): AvailableSlot[] {
    const firstSlotStart = Math.ceil(rangeStart / slotMs) * slotMs;
    const slots: AvailableSlot[] = [];

    let busyIdx = 0;
    for (let s = firstSlotStart; s + slotMs <= rangeEnd; s += slotMs) {
        const e = s + slotMs;

        // Advance past busy intervals that are entirely before this slot.
        while (busyIdx < busy.length) {
            const b = busy[busyIdx];
            if (b !== undefined && b.end <= s) {
                busyIdx += 1;
            } else {
                break;
            }
        }

        const candidate = busy[busyIdx];
        const overlaps = candidate !== undefined && candidate.start < e && candidate.end > s;
        if (!overlaps) {
            slots.push({
                start: new Date(s).toISOString(),
                end: new Date(e).toISOString(),
            });
        }
    }

    return slots;
}
