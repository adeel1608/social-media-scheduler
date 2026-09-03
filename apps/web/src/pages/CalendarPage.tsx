import { ChevronLeft, ChevronRight, ListFilter, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { PlatformBadge } from "../components/PlatformBadge";
import { useAuth } from "../context/AuthContext";
import { apiRequest } from "../lib/api";

type Platform = "instagram" | "tiktok" | "youtube";
interface CalendarEvent {
  id: string;
  platform: Platform;
  title: string;
  scheduledAt: string;
}

const demoEventSeed: Array<[Platform, string, string]> = [
  ["instagram", "Creative energy reset", "2026-09-03T09:30:00+10:00"],
  ["youtube", "Studio morning", "2026-09-03T11:15:00+10:00"],
  ["instagram", "September desk notes", "2026-09-04T14:00:00+10:00"],
  ["youtube", "The 5-minute layout rule", "2026-09-05T10:00:00+10:00"],
  ["tiktok", "Sunday field notes", "2026-09-06T18:30:00+10:00"],
  ["instagram", "Notes on working slowly", "2026-09-09T08:45:00+10:00"],
  ["tiktok", "Palette of the week", "2026-09-12T12:30:00+10:00"],
  ["instagram", "Palette of the week", "2026-09-12T12:30:00+10:00"],
];

const demoEvents: CalendarEvent[] = demoEventSeed.map(
  ([platform, title, scheduledAt], index) => ({
    id: `demo-${index}`,
    platform,
    title,
    scheduledAt,
  }),
);

export function CalendarPage() {
  const { demoMode, session } = useAuth();
  const [month, setMonth] = useState(() =>
    demoMode ? new Date(2026, 8, 1) : new Date(),
  );
  const [platform, setPlatform] = useState<Platform | "all">("all");
  const [liveEvents, setLiveEvents] = useState<CalendarEvent[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (demoMode || !session) return;
    const parameters = new URLSearchParams({ view: "queue", limit: "100" });
    if (platform !== "all") parameters.set("platform", platform);
    void apiRequest<{
      data: Array<{
        id: string;
        platform: Platform;
        scheduled_at_utc: string;
        posts: { title: string };
      }>;
    }>(`/api/queue?${parameters}`, session)
      .then((result) =>
        setLiveEvents(
          result.data.map((item) => ({
            id: item.id,
            platform: item.platform,
            title: item.posts.title,
            scheduledAt: item.scheduled_at_utc,
          })),
        ),
      )
      .catch((reason: unknown) =>
        setError(
          reason instanceof Error
            ? reason.message
            : "Calendar events could not be loaded.",
        ),
      );
  }, [demoMode, platform, session]);

  const cells = useMemo(() => monthCells(month), [month]);
  const source = demoMode ? demoEvents : liveEvents;
  const events = source.filter(
    (event) => platform === "all" || event.platform === platform,
  );

  return (
    <div className="calendar-page">
      <div className="calendar-toolbar">
        <div>
          <button className="soft-button" onClick={() => setMonth(new Date())}>
            Today
          </button>
          <button
            className="icon-button"
            aria-label="Previous month"
            onClick={() =>
              setMonth(
                (current) =>
                  new Date(current.getFullYear(), current.getMonth() - 1, 1),
              )
            }
          >
            <ChevronLeft size={17} />
          </button>
          <button
            className="icon-button"
            aria-label="Next month"
            onClick={() =>
              setMonth(
                (current) =>
                  new Date(current.getFullYear(), current.getMonth() + 1, 1),
              )
            }
          >
            <ChevronRight size={17} />
          </button>
          <strong className="calendar-month-title">
            {month.toLocaleDateString("en-AU", {
              month: "long",
              year: "numeric",
            })}
          </strong>
        </div>
        <div className="button-row">
          <label className="select-button">
            <ListFilter size={16} />
            <select
              value={platform}
              onChange={(event) =>
                setPlatform(event.target.value as Platform | "all")
              }
            >
              <option value="all">All platforms</option>
              <option value="instagram">Instagram</option>
              <option value="tiktok">TikTok</option>
              <option value="youtube">YouTube</option>
            </select>
          </label>
          <Link className="primary-button" to="/composer">
            <Plus size={16} /> Create post
          </Link>
        </div>
      </div>
      {error && <p className="form-error">{error}</p>}
      <section className="panel calendar-grid">
        {["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"].map((day) => (
          <div className="weekday" key={day}>
            {day}
          </div>
        ))}
        {cells.map((cell) => {
          const cellEvents = events.filter(
            (event) => melbourneDateKey(event.scheduledAt) === cell.key,
          );
          return (
            <div
              className={`calendar-day ${cell.outside ? "outside" : ""} ${cell.today ? "today" : ""}`}
              key={cell.key}
            >
              <span className="day-number">{cell.date.getDate()}</span>
              {cellEvents.map((event) => (
                <div
                  className={`calendar-event event-${event.platform}`}
                  key={event.id}
                >
                  <PlatformBadge platform={event.platform} compact />
                  <span>
                    <strong>{event.title}</strong>
                    <small>
                      {new Date(event.scheduledAt).toLocaleTimeString("en-AU", {
                        hour: "numeric",
                        minute: "2-digit",
                        timeZone: "Australia/Melbourne",
                      })}
                    </small>
                  </span>
                </div>
              ))}
            </div>
          );
        })}
      </section>
      <p className="data-note">
        All calendar times are displayed in Australia/Melbourne. Stored values
        remain UTC. Load additional queue pages from Queue when an installation
        has more than 100 upcoming targets.
      </p>
    </div>
  );
}

function monthCells(month: Date) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const mondayOffset = (first.getDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(
      month.getFullYear(),
      month.getMonth(),
      index - mondayOffset + 1,
    );
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const today = new Date();
    return {
      date,
      key,
      outside: date.getMonth() !== month.getMonth(),
      today:
        date.getFullYear() === today.getFullYear() &&
        date.getMonth() === today.getMonth() &&
        date.getDate() === today.getDate(),
    };
  });
}

function melbourneDateKey(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}
