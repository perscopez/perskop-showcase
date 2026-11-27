export const CALENDAR_CONNECTOR_SOURCES = ["icloud", "google", "ics", "mac_inventory"] as const;
export type CalendarConnectorSource = (typeof CALENDAR_CONNECTOR_SOURCES)[number];

export type ConnectorStatus = "connected" | "needs_reauth" | "error" | "disabled";
export type CalendarFreshness = "fresh" | "stale" | "unknown";

export type ConnectorCapabilities = {
  read: boolean;
  create: boolean;
  update: boolean;
  delete: boolean;
};

export type ConnectorAccount = {
  id: string;
  ownerId: string;
  source: CalendarConnectorSource;
  displayName: string;
  status: ConnectorStatus;
  createdAt: string;
  updatedAt: string;
};

export type CalendarIdentity = {
  source: CalendarConnectorSource;
  accountId: string;
  calendarId: string;
};

export type UnifiedCalendar = CalendarIdentity & {
  id: string;
  name: string;
  color: string | null;
  capabilities: ConnectorCapabilities;
  freshness: CalendarFreshness;
  sourceVersion: string | null;
};

export type UnifiedCalendarEvent = CalendarIdentity & {
  id: string;
  sourceEventId: string;
  sourceVersion: string | null;
  title: string;
  notes: string | null;
  location: string | null;
  url: string | null;
  startAt: string;
  endAt: string;
  timezone: string;
  allDay: boolean;
  recurrenceRule: string | null;
  freshness: CalendarFreshness;
};
