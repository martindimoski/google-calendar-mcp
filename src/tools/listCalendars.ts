import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
    type CalendarSummary,
    type GoogleCalendarService,
    type ListCalendarsOptions,
} from '../services/GoogleCalendarService.js';
import { CalendarApiError } from '../errors/CalendarApiError.js';

const inputShape = {
    showHidden: z
        .boolean()
        .optional()
        .describe('Include hidden calendars. Defaults to false.'),
    showDeleted: z
        .boolean()
        .optional()
        .describe('Include calendars the user has deleted. Defaults to false.'),
    minAccessRole: z
        .enum(['freeBusyReader', 'reader', 'writer', 'owner'])
        .optional()
        .describe('Filter to calendars where the service account has at least this role.'),
    maxResults: z
        .number()
        .int()
        .min(1)
        .max(250)
        .optional()
        .describe('Per-page page size sent to Google. Pagination is unrolled server-side.'),
} as const;

const outputShape = {
    calendars: z.array(
        z.object({
            id: z.string(),
            summary: z.string(),
            description: z.string().optional(),
            timeZone: z.string().optional(),
            accessRole: z.enum(['freeBusyReader', 'reader', 'writer', 'owner']).optional(),
            primary: z.boolean().optional(),
            selected: z.boolean().optional(),
            hidden: z.boolean().optional(),
        }),
    ),
    count: z.number().int().nonnegative(),
} as const;

/**
 * Registers the `list_calendars` MCP tool. Invokes
 * {@link GoogleCalendarService.listCalendars} and shapes the result into
 * a `CallToolResult` with both human-readable text and structured JSON.
 */
export function registerListCalendarsTool(
    server: McpServer,
    calendarService: GoogleCalendarService,
): void {
    server.registerTool(
        'list_calendars',
        {
            title: 'List Google Calendars',
            description:
                'Returns every calendar that the configured Google Service Account has access to. ' +
                'Use this before any tool that operates on a specific calendar to discover its `id`. ' +
                'Note: a service account only sees calendars that have been explicitly shared with its email.',
            inputSchema: inputShape,
            outputSchema: outputShape,
            annotations: {
                readOnlyHint: true,
                openWorldHint: true,
            },
        },
        async (args): Promise<CallToolResult> => {
            const opts: ListCalendarsOptions = {
                ...(args.showHidden !== undefined ? { showHidden: args.showHidden } : {}),
                ...(args.showDeleted !== undefined ? { showDeleted: args.showDeleted } : {}),
                ...(args.minAccessRole !== undefined ? { minAccessRole: args.minAccessRole } : {}),
                ...(args.maxResults !== undefined ? { maxResults: args.maxResults } : {}),
            };

            try {
                const calendars = await calendarService.listCalendars(opts);
                return {
                    content: [{ type: 'text', text: formatCalendars(calendars) }],
                    structuredContent: { calendars, count: calendars.length },
                };
            } catch (error) {
                const message =
                    error instanceof CalendarApiError
                        ? error.message
                        : error instanceof Error
                          ? `Unexpected error while listing calendars: ${error.message}`
                          : `Unexpected error while listing calendars: ${String(error)}`;
                return {
                    content: [{ type: 'text', text: message }],
                    isError: true,
                };
            }
        },
    );
}

function formatCalendars(calendars: readonly CalendarSummary[]): string {
    if (calendars.length === 0) {
        return (
            'No calendars are visible to this service account. ' +
            'Share a calendar with the service account email (or configure domain-wide delegation) and try again.'
        );
    }
    const lines = calendars.map((c) => {
        const flags = [
            c.primary ? 'primary' : null,
            c.accessRole ?? null,
            c.timeZone ?? null,
            c.hidden ? 'hidden' : null,
        ]
            .filter((v): v is string => Boolean(v))
            .join(', ');
        return `- ${c.summary} [${c.id}]${flags ? ` (${flags})` : ''}`;
    });
    return `Found ${calendars.length} calendar(s):\n${lines.join('\n')}`;
}
