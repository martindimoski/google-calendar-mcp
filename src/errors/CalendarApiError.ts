/**
 * Error raised when a Google Calendar API call fails. Captures the
 * underlying HTTP status and Google error code so MCP tool handlers can
 * surface a precise, user-readable message instead of leaking raw
 * `googleapis` exception shapes.
 */
export class CalendarApiError extends Error {
    public readonly operation: string;
    public readonly statusCode: number | undefined;
    public readonly cause: unknown;

    constructor(operation: string, cause: unknown) {
        const status = extractStatus(cause);
        const detail = extractMessage(cause);
        super(
            `Google Calendar API call \`${operation}\` failed` +
                (status !== undefined ? ` (HTTP ${status})` : '') +
                `: ${detail}`,
        );
        this.name = 'CalendarApiError';
        this.operation = operation;
        this.statusCode = status;
        this.cause = cause;
    }
}

function extractStatus(cause: unknown): number | undefined {
    if (typeof cause === 'object' && cause !== null) {
        const maybe = cause as { code?: unknown; status?: unknown; response?: { status?: unknown } };
        if (typeof maybe.code === 'number') return maybe.code;
        if (typeof maybe.status === 'number') return maybe.status;
        if (typeof maybe.response?.status === 'number') return maybe.response.status;
    }
    return undefined;
}

function extractMessage(cause: unknown): string {
    if (cause instanceof Error) return cause.message;
    if (typeof cause === 'string') return cause;
    try {
        return JSON.stringify(cause);
    } catch {
        return String(cause);
    }
}
