/**
 * Minimal logger for Google Calendar API interactions. Output is split
 * into three event types so it's easy to grep / filter:
 *
 *   [GCal] REQUEST  <operation> <params>
 *   [GCal] RESPONSE <operation> <summary>     [+ payload when verbose]
 *   [GCal] ERROR    <operation> <error>
 *
 * Verbose payload logging is controlled by the `LOG_GOOGLE_RESPONSES`
 * env var. Set it to "false" / "0" to silence full-payload dumps once
 * the wiring is verified.
 */

const VERBOSE = (() => {
    const raw = process.env['LOG_GOOGLE_RESPONSES'];
    if (raw === undefined) return true;
    const normalised = raw.trim().toLowerCase();
    return normalised !== 'false' && normalised !== '0' && normalised !== '';
})();

const TAG = '[GCal]';

export function logApiRequest(operation: string, params: unknown): void {
    console.log(`${TAG} REQUEST  ${operation}`, safeStringify(params));
}

export function logApiResponse(operation: string, summary: string, payload: unknown): void {
    console.log(`${TAG} RESPONSE ${operation} ${summary}`);
    if (VERBOSE) {
        console.log(`${TAG} RESPONSE ${operation} payload:`, safeStringify(payload, 2));
    }
}

export function logApiError(operation: string, error: unknown): void {
    console.error(`${TAG} ERROR    ${operation}`, error);
}

function safeStringify(value: unknown, indent?: number): string {
    try {
        return JSON.stringify(value, replacer, indent);
    } catch {
        return String(value);
    }
}

/**
 * Trims fields that are noisy and never useful for debugging (axios
 * `request`/`config` blobs, raw HTTP headers we didn't set, etag bytes).
 */
function replacer(key: string, value: unknown): unknown {
    if (key === 'request' || key === 'config') return '[stripped]';
    if (key === 'headers' && typeof value === 'object' && value !== null) return '[stripped]';
    if (key === 'etag') return undefined;
    return value;
}
