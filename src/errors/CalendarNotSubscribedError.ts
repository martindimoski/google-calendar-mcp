/**
 * Raised when an operation references a calendar that isn't in the
 * service account's `calendarList`. Distinct from a generic API error
 * because the recovery path is well-defined: subscribe to it first.
 */
export class CalendarNotSubscribedError extends Error {
    public readonly calendarId: string;

    constructor(calendarId: string) {
        super(
            `Calendar "${calendarId}" is not subscribed by this MCP server. ` +
                'Use `subscribe_calendar` first (the calendar must already be shared ' +
                'with the service account email).',
        );
        this.name = 'CalendarNotSubscribedError';
        this.calendarId = calendarId;
    }
}
