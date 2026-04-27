import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
    type AvailableSlot,
    type FindAvailableSlotsOptions,
    type GoogleCalendarService,
} from '../services/GoogleCalendarService.js';
import { CalendarApiError } from '../errors/CalendarApiError.js';

/**
 * Lightweight ISO-8601 datetime validator. We avoid `z.string().datetime()`
 * because its semantics changed between Zod 3 and 4, and the SDK
 * serialises the input schema to JSON Schema for MCP clients — staying
 * with a plain `string` + `refine` keeps the contract stable.
 */
const isoDateTime = z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), {
        message: 'Must be a valid ISO 8601 date-time string (e.g. "2026-04-27T09:00:00Z").',
    });

const inputShape = {
    timeMin: isoDateTime.describe('Inclusive start of the search window (ISO 8601).'),
    timeMax: isoDateTime.describe('Exclusive end of the search window (ISO 8601).'),
    calendarIds: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe(
            'Calendars to consult. Busy intervals are unioned across all of them. ' +
                'Defaults to ["primary"] if omitted. Use list_calendars to discover ids.',
        ),
    slotDurationMinutes: z
        .number()
        .int()
        .min(5)
        .max(24 * 60)
        .optional()
        .describe('Slot length in minutes. Defaults to 60.'),
    timeZone: z
        .string()
        .optional()
        .describe('Optional IANA timezone (e.g. "Europe/Skopje") passed through to Google.'),
} as const;

const slotShape = z.object({
    start: z.string(),
    end: z.string(),
});

const outputShape = {
    slots: z.array(slotShape),
    count: z.number().int().nonnegative(),
    slotDurationMinutes: z.number().int().positive(),
    range: z.object({ timeMin: z.string(), timeMax: z.string() }),
    calendarErrors: z.record(z.string(), z.array(z.string())).optional(),
} as const;

/**
 * Registers the `find_available_slots` MCP tool. Looks up busy
 * intervals via Google's freeBusy API across the requested calendars,
 * then returns hour-aligned (by default) free slots.
 */
export function registerFindAvailableSlotsTool(
    server: McpServer,
    calendarService: GoogleCalendarService,
): void {
    server.registerTool(
        'find_available_slots',
        {
            title: 'Find available time slots',
            description:
                'Returns bookable time slots within a given window by querying Google Calendar ' +
                "freeBusy across one or more calendars. Each slot is a fixed-duration interval " +
                '(default 60 minutes, aligned to the top of the hour) that does not overlap any ' +
                'busy time on the supplied calendars.',
            inputSchema: inputShape,
            outputSchema: outputShape,
            annotations: {
                readOnlyHint: true,
                openWorldHint: true,
            },
        },
        async (args): Promise<CallToolResult> => {
            const timeMin = new Date(args.timeMin);
            const timeMax = new Date(args.timeMax);
            const calendarIds = args.calendarIds ?? ['primary'];
            const slotDurationMinutes = args.slotDurationMinutes ?? 60;

            if (timeMax.getTime() <= timeMin.getTime()) {
                return errorResult('`timeMax` must be strictly after `timeMin`.');
            }

            const opts: FindAvailableSlotsOptions = {
                timeMin,
                timeMax,
                calendarIds,
                slotDurationMinutes,
                ...(args.timeZone !== undefined ? { timeZone: args.timeZone } : {}),
            };

            try {
                const { slots, calendarErrors } = await calendarService.findAvailableSlots(opts);
                const hasErrors = Object.keys(calendarErrors).length > 0;

                return {
                    content: [
                        {
                            type: 'text',
                            text: formatSlots(slots, slotDurationMinutes, timeMin, timeMax, calendarErrors),
                        },
                    ],
                    structuredContent: {
                        slots,
                        count: slots.length,
                        slotDurationMinutes,
                        range: {
                            timeMin: timeMin.toISOString(),
                            timeMax: timeMax.toISOString(),
                        },
                        ...(hasErrors ? { calendarErrors } : {}),
                    },
                };
            } catch (error) {
                const message =
                    error instanceof CalendarApiError
                        ? error.message
                        : error instanceof Error
                          ? `Unexpected error while finding available slots: ${error.message}`
                          : `Unexpected error while finding available slots: ${String(error)}`;
                return errorResult(message);
            }
        },
    );
}

function errorResult(message: string): CallToolResult {
    return { content: [{ type: 'text', text: message }], isError: true };
}

function formatSlots(
    slots: readonly AvailableSlot[],
    slotDurationMinutes: number,
    timeMin: Date,
    timeMax: Date,
    calendarErrors: Record<string, string[]>,
): string {
    const header =
        `Searched ${timeMin.toISOString()} → ${timeMax.toISOString()} ` +
        `for ${slotDurationMinutes}-minute slots.`;

    const errorLines = Object.entries(calendarErrors).map(
        ([id, reasons]) => `! Calendar "${id}" returned errors: ${reasons.join(', ')}`,
    );

    if (slots.length === 0) {
        return [header, ...errorLines, 'No available slots in this range.'].join('\n');
    }

    const slotLines = slots.map((s) => `- ${s.start} → ${s.end}`);
    return [header, ...errorLines, `Found ${slots.length} available slot(s):`, ...slotLines].join('\n');
}
