import { useEffect, useState } from "react";
import { PerskopThread } from "./components/PerskopThread";
import { ComposerBar } from "./components/ComposerBar";
import { Sidebar } from "./Sidebar";
import {
  loadSessions,
  newSession,
  saveSessions,
  type ChatMessage,
  type Session,
} from "./store/sessions";

type Mode = "vps" | "local";

declare global {
  interface Window {
    perskop: {
      getProviders: () => Promise<{ vps: string[]; local: string[] }>;
      getConfig: () => Promise<{ apiUrl?: string; hasToken?: boolean; error?: string }>;
      chat: (p: {
        prompt: string;
        provider: string;
        mode: Mode;
      }) => Promise<{ provider: string; output: string; memoryId?: number; via?: string }>;
      memory: () => Promise<{ items: Array<{ id: number; title: string; content: string }> }>;
    };
  }
}

export function App() {
  const [sessions, setSessions] = useState<Session[]>(() => loadSessions());
  const [activeId, setActiveId] = useState(() => loadSessions()[0]?.id ?? "");
  const [vpsProviders, setVpsProviders] = useState(["codex", "cursor"]);
  const [localProviders, setLocalProviders] = useState<string[]>([]);
  const [mode, setMode] = useState<Mode>("vps");
  const [selected, setSelected] = useState("codex");
  const [statusLine, setStatusLine] = useState("Bağlanıyor…");
  const [busy, setBusy] = useState(false);

  const active = sessions.find((s) => s.id === activeId) ?? sessions[0];
  const activeProviders = mode === "vps" ? vpsProviders : localProviders;

  useEffect(() => {
    saveSessions(sessions);
  }, [sessions]);

  useEffect(() => {
    void window.perskop.getProviders().then((p) => {
      setVpsProviders(p.vps);
      setLocalProviders(p.local);
    });
    void window.perskop.getConfig().then((c) => {
      if (c.error) setStatusLine(c.error);
      else setStatusLine(`${c.apiUrl} · bağlı`);
    });
  }, []);

  function patchSession(id: string, patch: Partial<Session>) {
    setSessions((all) =>
      all.map((s) => (s.id === id ? { ...s, ...patch, updatedAt: Date.now() } : s)),
    );
  }

  function addMessage(msg: ChatMessage) {
    if (!active) return;
    const title =
      active.messages.length === 0 && msg.role === "user"
        ? msg.text.slice(0, 48)
        : active.title;
    patchSession(active.id, {
      title,
      messages: [...active.messages, msg],
    });
  }

  async function send(text: string) {
    if (!text.trim() || busy || !active) return;
    setBusy(true);
    addMessage({
      id: crypto.randomUUID(),
      role: "user",
      text: text.trim(),
      createdAt: Date.now(),
    });
    try {
      const res = await window.perskop.chat({
        prompt: text.trim(),
        provider: selected,
        mode,
      });
      addMessage({
        id: crypto.randomUUID(),
        role: "assistant",
        text: res.output,
        provider: res.provider,
        via: res.via,
        createdAt: Date.now(),
      });
    } catch (e) {
      addMessage({
        id: crypto.randomUUID(),
        role: "error",
        text: String(e),
        createdAt: Date.now(),
      });
    } finally {
      setBusy(false);
    }
  }

  function onNewSession() {
    const s = newSession();
    setSessions((all) => [s, ...all]);
    setActiveId(s.id);
  }

  function onDeleteSession(id: string) {
    setSessions((all) => {
      const next = all.filter((s) => s.id !== id);
      if (!next.length) next.push(newSession());
      if (id === activeId) setActiveId(next[0].id);
      return next;
    });
  }

  if (!active) return null;

  return (
    <div className="flex h-full min-h-screen">
      <Sidebar
        sessions={sessions}
        activeId={active.id}
        statusLine={statusLine}
        onSelect={setActiveId}
        onNew={onNewSession}
        onDelete={onDeleteSession}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-border/60 px-5 py-3">
          <h1 className="truncate text-lg font-medium">{active.title}</h1>
          <ComposerBar
            mode={mode}
            setMode={setMode}
            selected={selected}
            setSelected={setSelected}
            providers={activeProviders}
            localAvailable={localProviders.length > 0}
          />
        </header>
        <PerskopThread
          messages={active.messages}
          busy={busy}
          onSend={send}
        />
      </main>
    </div>
  );
}
