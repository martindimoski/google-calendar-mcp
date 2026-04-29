/**
 * Raised when the requested `[start, end)` interval overlaps an
 * existing busy block on the target calendar. Carries the conflicting
 * intervals so the caller can surface them to the user.
 */
export class TimeSlotConflictError extends Error {
    public readonly calendarId: string;
    public readonly requested: { start: string; end: string };
    public readonly conflicts: ReadonlyArray<{ start: string; end: string }>;

    constructor(
        calendarId: string,
        requested: { start: string; end: string },
        conflicts: ReadonlyArray<{ start: string; end: string }>,
    ) {
        const conflictList = conflicts.map((c) => `${c.start} → ${c.end}`).join('; ');
        super(
            `Time slot ${requested.start} → ${requested.end} on calendar "${calendarId}" ` +
                `conflicts with existing busy block(s): ${conflictList}.`,
        );
        this.name = 'TimeSlotConflictError';
        this.calendarId = calendarId;
        this.requested = requested;
        this.conflicts = conflicts;
    }
}
