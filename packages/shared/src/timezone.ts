import { DateTime } from "luxon";

export const PRIMARY_TIMEZONE = "Australia/Melbourne";

export interface ZonedTimeResult {
  utc: string | null;
  valid: boolean;
  ambiguous: boolean;
  reason?: string;
}

export function localMelbourneToUtc(localIso: string): ZonedTimeResult {
  const parsed = DateTime.fromISO(localIso, {
    zone: PRIMARY_TIMEZONE,
    setZone: true,
  });
  if (!parsed.isValid) {
    return {
      utc: null,
      valid: false,
      ambiguous: false,
      reason: parsed.invalidExplanation ?? "Invalid time",
    };
  }
  const requested = localIso.slice(0, 16);
  if (parsed.toFormat("yyyy-MM-dd'T'HH:mm") !== requested) {
    return {
      utc: null,
      valid: false,
      ambiguous: false,
      reason:
        "This local time does not exist because clocks move forward for daylight saving.",
    };
  }
  const possible = parsed.getPossibleOffsets();
  if (possible.length > 1) {
    return {
      utc: null,
      valid: false,
      ambiguous: true,
      reason:
        "This local time occurs twice when daylight saving ends; choose an explicit offset.",
    };
  }
  return { utc: parsed.toUTC().toISO(), valid: true, ambiguous: false };
}

export function utcToMelbourne(utcIso: string): string {
  return DateTime.fromISO(utcIso, { zone: "utc" })
    .setZone(PRIMARY_TIMEZONE)
    .toISO()!;
}
