import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CalendarSummary, GoogleCalendarService } from '../services/GoogleCalendarService.js';
import { CalendarApiError } from '../errors/CalendarApiError.js';

const inputShape = {
    calendarId: z
        .string()
        .min(1)
        .describe(
            'The id of a calendar that has already been shared with the service account email ' +
                '(found in Google Calendar → Settings and sharing → Integrate calendar → Calendar ID). ' +
                'For a personal Gmail calendar this is the gmail address itself.',
        ),
} as const;

const outputShape = {
    calendar: z.object({
        id: z.string(),
        summary: z.string(),
        description: z.string().optional(),
        timeZone: z.string().optional(),
        accessRole: z.enum(['freeBusyReader', 'reader', 'writer', 'owner']).optional(),
        primary: z.boolean().optional(),
        selected: z.boolean().optional(),
        hidden: z.boolean().optional(),
    }),
} as const;

/**
 * Registers the `subscribe_calendar` MCP tool. One-shot helper that
 * makes a previously-shared calendar appear in `list_calendars`.
 *
 * Why this is necessary: sharing a calendar with a service-account
 * email creates an ACL but does NOT add the calendar to the service
 * account's `calendarList`. A human user gets that auto-subscribe step
 * via the Calendar UI; a service account has to do it via API.
 */
export function registerSubscribeCalendarTool(
    server: McpServer,
    calendarService: GoogleCalendarService,
): void {
    server.registerTool(
        'subscribe_calendar',
        {
            title: 'Subscribe to a shared Google Calendar',
            description:
                "Adds a shared calendar to the service account's calendar list so it shows up in " +
                'list_calendars. The calendar must already be shared with the service account email ' +
                '(at least "See free/busy" permission). Idempotent — safe to call repeatedly.',
            inputSchema: inputShape,
            outputSchema: outputShape,
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
        },
        async (args): Promise<CallToolResult> => {
            try {
                const calendar = await calendarService.subscribeCalendar(args.calendarId);
                return {
                    content: [{ type: 'text', text: formatSubscription(calendar) }],
                    structuredContent: { calendar },
                };
            } catch (error) {
                const message =
                    error instanceof CalendarApiError
                        ? augmentNotFound(error, args.calendarId)
                        : error instanceof Error
                          ? `Unexpected error while subscribing to calendar: ${error.message}`
                          : `Unexpected error while subscribing to calendar: ${String(error)}`;
                return {
                    content: [{ type: 'text', text: message }],
                    isError: true,
                };
            }
        },
    );
}

function formatSubscription(c: CalendarSummary): string {
    const parts = [
        c.accessRole ? `access=${c.accessRole}` : null,
        c.timeZone ? `tz=${c.timeZone}` : null,
    ].filter((v): v is string => Boolean(v));
    const meta = parts.length > 0 ? ` (${parts.join(', ')})` : '';
    return `Subscribed to "${c.summary}" [${c.id}]${meta}. It will now appear in list_calendars.`;
}

/**
 * Google returns a generic 404 for "calendar id is wrong" AND for "the
 * calendar exists but isn't shared with you". Both surface as the same
 * error here, so we attach a hint pointing at the most likely cause.
 */
function augmentNotFound(error: CalendarApiError, calendarId: string): string {
    if (error.statusCode === 404) {
        return (
            `${error.message}\n\n` +
            `Hint: the calendar id "${calendarId}" was either typed incorrectly or has not been ` +
            `shared with this service account yet. In Google Calendar, open the calendar's ` +
            `"Settings and sharing" page, share it with the service account email at "See ` +
            `free/busy" or higher, then retry.`
        );
    }
    return error.message;
}
