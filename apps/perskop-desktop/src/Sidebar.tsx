import { IconPlus, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import type { Session } from "./store/sessions";
import { cn } from "./lib/utils";
import { MemoryPanel } from "./components/MemoryPanel";

type Props = {
  sessions: Session[];
  activeId: string;
  statusLine: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
};

export function Sidebar({
  sessions,
  activeId,
  statusLine,
  onSelect,
  onNew,
  onDelete,
}: Props) {
  const [memoryOpen, setMemoryOpen] = useState(false);

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border/60 bg-card/40">
      <div className="border-b border-border/60 p-4">
        <p className="text-2xl font-semibold tracking-tight text-primary">perskop</p>
        <p className="mt-1 text-xs text-muted-foreground">Mac · VPS memory</p>
      </div>

      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs uppercase tracking-wider text-muted-foreground">
          Sohbetler
        </span>
        <button
          type="button"
          onClick={onNew}
          className="rounded-lg p-1 text-muted-foreground hover:bg-accent/30 hover:text-foreground"
          title="Yeni sohbet"
        >
          <IconPlus size={16} />
        </button>
      </div>

      <nav className="scrollbar-thin flex-1 space-y-1 overflow-y-auto px-2 pb-2">
        {sessions.map((s) => (
          <div key={s.id} className="group flex items-center gap-1">
            <button
              type="button"
              onClick={() => onSelect(s.id)}
              className={cn(
                "min-w-0 flex-1 rounded-lg px-3 py-2 text-left text-sm truncate",
                s.id === activeId
                  ? "bg-accent/50 text-foreground"
                  : "text-muted-foreground hover:bg-background/30 hover:text-foreground",
              )}
            >
              {s.title}
            </button>
            {sessions.length > 1 && (
              <button
                type="button"
                onClick={() => onDelete(s.id)}
                className="rounded p-1 text-muted-foreground opacity-0 hover:text-red-300 group-hover:opacity-100"
              >
                <IconTrash size={14} />
              </button>
            )}
          </div>
        ))}
      </nav>

      <div className="border-t border-border/60 p-3 text-xs text-muted-foreground">
        {statusLine}
      </div>
      <MemoryPanel open={memoryOpen} onToggle={() => setMemoryOpen((v) => !v)} />
    </aside>
  );
}
