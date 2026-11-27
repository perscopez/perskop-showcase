import type Database from "better-sqlite3";
import type { ConnectorAccount, UnifiedCalendar } from "./types.js";

export class CalendarRegistry {
  constructor(private readonly db: Database.Database) {}

  upsertAccount(input: Omit<ConnectorAccount, "createdAt" | "updatedAt">) {
    this.db.prepare(`INSERT INTO connector_accounts (id, owner_id, source, display_name, status)
      VALUES (@id,@ownerId,@source,@displayName,@status)
      ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id, source=excluded.source, display_name=excluded.display_name, status=excluded.status, updated_at=datetime('now')`).run(input);
  }

  upsertCalendar(input: { id: string; accountId: string; sourceCalendarId: string; name: string; color: string | null; capabilities: UnifiedCalendar["capabilities"]; freshness: UnifiedCalendar["freshness"]; sourceVersion: string | null }) {
    this.db.prepare(`INSERT INTO calendar_calendars (id,account_id,source_calendar_id,name,color,capabilities_json,freshness,source_version)
      VALUES (@id,@accountId,@sourceCalendarId,@name,@color,@capabilitiesJson,@freshness,@sourceVersion)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,color=excluded.color,capabilities_json=excluded.capabilities_json,freshness=excluded.freshness,source_version=excluded.source_version,updated_at=datetime('now')`).run({ ...input, capabilitiesJson: JSON.stringify(input.capabilities) });
  }

  upsertEvent(input: { id: string; calendarId: string; sourceEventId: string; sourceVersion: string | null; eventJson: unknown; startsAt: string; endsAt: string; freshness: string }) {
    this.db.prepare(`INSERT INTO calendar_events (id,calendar_id,source_event_id,source_version,event_json,starts_at,ends_at,freshness)
      VALUES (@id,@calendarId,@sourceEventId,@sourceVersion,@eventJson,@startsAt,@endsAt,@freshness)
      ON CONFLICT(id) DO UPDATE SET source_version=excluded.source_version,event_json=excluded.event_json,starts_at=excluded.starts_at,ends_at=excluded.ends_at,freshness=excluded.freshness,updated_at=datetime('now')`).run({ ...input, eventJson: JSON.stringify(input.eventJson) });
  }

  listCalendars(ownerId: string): UnifiedCalendar[] {
    return this.db.prepare(`SELECT c.id,c.name,c.color,c.capabilities_json,c.freshness,c.source_version,a.source,c.account_id,c.source_calendar_id
      FROM calendar_calendars c JOIN connector_accounts a ON a.id=c.account_id WHERE a.owner_id=? ORDER BY c.name`).all(ownerId).map((row: any) => ({ id: row.id, name: row.name, color: row.color, capabilities: JSON.parse(row.capabilities_json), freshness: row.freshness, sourceVersion: row.source_version, source: row.source, accountId: row.account_id, calendarId: row.source_calendar_id }));
  }

  listEvents(ownerId: string, startsAt: string, endsAt: string) {
    return this.db.prepare(`SELECT e.id,e.source_event_id,e.event_json,e.starts_at,e.ends_at,e.freshness,e.source_version,c.id AS internal_calendar_id,c.source_calendar_id,c.account_id,a.source
      FROM calendar_events e JOIN calendar_calendars c ON c.id=e.calendar_id JOIN connector_accounts a ON a.id=c.account_id
      WHERE a.owner_id=? AND e.ends_at>? AND e.starts_at<? ORDER BY e.starts_at,e.id`).all(ownerId, startsAt, endsAt).map((row: any) => ({ id: row.id, ...JSON.parse(row.event_json), sourceEventId: row.source_event_id, startAt: row.starts_at, endAt: row.ends_at, freshness: row.freshness, sourceVersion: row.source_version, calendarId: row.internal_calendar_id, sourceCalendarId: row.source_calendar_id, accountId: row.account_id, source: row.source }));
  }
}
