import { IconBrain, IconRefresh } from "@tabler/icons-react";
import { useState } from "react";

type MemoryItem = {
  id: number;
  title: string;
  content: string;
  source?: string;
  provider?: string;
  created_at?: string;
};

type Props = {
  open: boolean;
  onToggle: () => void;
};

export function MemoryPanel({ open, onToggle }: Props) {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const data = await window.perskop.memory();
      setItems(data.items ?? []);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  function onOpen() {
    onToggle();
    if (!open) void refresh();
  }

  return (
    <div className="border-t border-border/60">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs text-muted-foreground hover:bg-background/20 hover:text-foreground"
      >
        <IconBrain size={14} />
        VPS Memory
        <span className="ml-auto">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="max-h-48 overflow-y-auto border-t border-border/40 px-3 py-2">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Son kayıtlar
            </span>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-40"
            >
              <IconRefresh size={12} className={loading ? "animate-spin" : ""} />
            </button>
          </div>
          {error && <p className="text-xs text-red-300">{error}</p>}
          {!error && items.length === 0 && !loading && (
            <p className="text-xs text-muted-foreground">Henüz kayıt yok</p>
          )}
          <ul className="space-y-2">
            {items.map((m) => (
              <li key={m.id} className="rounded-lg border border-border/30 bg-background/10 p-2">
                <p className="truncate text-xs font-medium">{m.title || `#${m.id}`}</p>
                <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
                  {m.content}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
