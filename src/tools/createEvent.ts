import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type {
    CreatedEvent,
    CreateEventInput,
    GoogleCalendarService,
} from '../services/GoogleCalendarService.js';
import { CalendarApiError } from '../errors/CalendarApiError.js';
import { CalendarNotSubscribedError } from '../errors/CalendarNotSubscribedError.js';
import { TimeSlotConflictError } from '../errors/TimeSlotConflictError.js';

const isoDateTime = z.string().refine((v) => !Number.isNaN(Date.parse(v)), {
    message: 'Must be a valid ISO 8601 date-time string (e.g. "2026-04-28T09:00:00Z").',
});

/**
 * RFC 5322-lite. Same regex used in the service, kept here so the tool
 * fails fast at the JSON-Schema boundary — the SDK serialises the input
 * shape to JSON Schema for the connector UI, so the error message a
 * client sees is friendlier than the service-level fallback.
 */
const email = z
    .string()
    .refine((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), {
        message: 'Must be a valid email address.',
    });

const inputShape = {
    calendarId: z
        .string()
        .min(1)
        .describe('Id of the calendar to create the event on. Must be subscribed (see subscribe_calendar).'),
    userEmail: email.describe('Email of the user requesting the booking. Added as an attendee.'),
    start: isoDateTime.describe('Inclusive event start (ISO 8601).'),
    end: isoDateTime.describe('Exclusive event end (ISO 8601).'),
    summary: z
        .string()
        .min(1)
        .max(255)
        .optional()
        .describe('Event title. Defaults to "New event" when omitted.'),
    description: z.string().optional().describe('Optional long-form notes shown on the event.'),
    timeZone: z
        .string()
        .optional()
        .describe('IANA timezone for the event (e.g. "Europe/Skopje"). Defaults to UTC.'),
    sendUpdates: z
        .enum(['all', 'externalOnly', 'none'])
        .optional()
        .describe('Whether Google should email attendees. Defaults to "all".'),
} as const;

const outputShape = {
    event: z.object({
        id: z.string(),
        summary: z.string(),
        start: z.string(),
        end: z.string(),
        htmlLink: z.string().optional(),
        organizerEmail: z.string().optional(),
        attendees: z.array(z.string()),
        bookerEmail: z.string().optional(),
        inviteSent: z.boolean(),
    }),
} as const;

/**
 * Registers the `create_event` MCP tool. Runs three pre-flight checks
 * (subscribed calendar → free time slot → valid email) before calling
 * `events.insert`. Each failure mode maps to a distinct error type and
 * a precise message in the tool result.
 */
export function registerCreateEventTool(
    server: McpServer,
    calendarService: GoogleCalendarService,
): void {
    server.registerTool(
        'create_event',
        {
            title: 'Create a Google Calendar event',
            description:
                'Books a new event on a subscribed calendar. Validates that (1) the calendar is ' +
                'subscribed by this server, (2) the requested time slot does not conflict with ' +
                'existing events, and (3) the user email is well-formed. The user email is added ' +
                'as an attendee and (by default) Google sends them an invite email.',
            inputSchema: inputShape,
            outputSchema: outputShape,
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: true,
            },
        },
        async (args): Promise<CallToolResult> => {
            const start = new Date(args.start);
            const end = new Date(args.end);

            if (end.getTime() <= start.getTime()) {
                return errorResult('`end` must be strictly after `start`.');
            }

            const input: CreateEventInput = {
                calendarId: args.calendarId,
                userEmail: args.userEmail,
                start,
                end,
                ...(args.summary !== undefined ? { summary: args.summary } : {}),
                ...(args.description !== undefined ? { description: args.description } : {}),
                ...(args.timeZone !== undefined ? { timeZone: args.timeZone } : {}),
                ...(args.sendUpdates !== undefined ? { sendUpdates: args.sendUpdates } : {}),
            };

            try {
                const event = await calendarService.createEvent(input);
                return {
                    content: [{ type: 'text', text: formatEvent(event) }],
                    structuredContent: { event },
                };
            } catch (error) {
                return errorResult(translateError(error));
            }
        },
    );
}

function errorResult(message: string): CallToolResult {
    return { content: [{ type: 'text', text: message }], isError: true };
}

function translateError(error: unknown): string {
    if (error instanceof CalendarNotSubscribedError) {
        return error.message;
    }
    if (error instanceof TimeSlotConflictError) {
        return error.message;
    }
    if (error instanceof CalendarApiError) {
        return error.message;
    }
    if (error instanceof Error) {
        return `Unexpected error while creating event: ${error.message}`;
    }
    return `Unexpected error while creating event: ${String(error)}`;
}

function formatEvent(event: CreatedEvent): string {
    const lines = [
        `Created event "${event.summary}" [${event.id}]`,
        `  ${event.start} → ${event.end}`,
    ];
    if (event.organizerEmail) {
        lines.push(`  Organizer: ${event.organizerEmail}`);
    }
    if (event.bookerEmail) {
        lines.push(`  Booker: ${event.bookerEmail} (recorded in description)`);
    }
    if (event.attendees.length > 0) {
        lines.push(`  Attendees: ${event.attendees.join(', ')}`);
    }
    if (event.htmlLink) {
        lines.push(`  Link: ${event.htmlLink}`);
    }
    if (!event.inviteSent) {
        lines.push(
            '  Note: no invite email was sent. A service account without Domain-Wide ' +
                'Delegation cannot invite attendees, so the booker is recorded in the ' +
                'event description instead.',
        );
    }
    return lines.join('\n');
}
