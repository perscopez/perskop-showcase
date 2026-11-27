export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "error";
  text: string;
  provider?: string;
  via?: string;
  createdAt: number;
};

export type Session = {
  id: string;
  title: string;
  messages: ChatMessage[];
  updatedAt: number;
};

const KEY = "perskop.sessions.v1";

export function loadSessions(): Session[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [newSession("İlk sohbet")];
    const parsed = JSON.parse(raw) as Session[];
    return parsed.length ? parsed : [newSession("İlk sohbet")];
  } catch {
    return [newSession("İlk sohbet")];
  }
}

export function saveSessions(sessions: Session[]) {
  localStorage.setItem(KEY, JSON.stringify(sessions));
}

export function newSession(title = "Yeni sohbet"): Session {
  return {
    id: crypto.randomUUID(),
    title,
    messages: [],
    updatedAt: Date.now(),
  };
}
