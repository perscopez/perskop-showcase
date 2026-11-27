import { IconSend } from "@tabler/icons-react";
import { useEffect, useRef } from "react";
import { Streamdown } from "streamdown";
import type { ChatMessage } from "../store/sessions";
import { cn } from "../lib/utils";

type Props = {
  messages: ChatMessage[];
  busy: boolean;
  onSend: (text: string) => Promise<void>;
};

export function PerskopThread({ messages, busy, onSend }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  async function submit() {
    const text = inputRef.current?.value.trim() ?? "";
    if (!text || busy) return;
    if (inputRef.current) inputRef.current.value = "";
    await onSend(text);
  }

  return (
    <div className="flex h-full flex-1 flex-col">
      <div className="scrollbar-thin flex-1 overflow-y-auto px-4 py-6 md:px-8">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
          {messages.length === 0 && !busy && (
            <div className="py-16 text-center">
              <p className="text-xs uppercase tracking-[0.25em] text-muted-foreground">
                perskop
              </p>
              <h2 className="mt-3 text-2xl font-medium">Ne üzerinde çalışıyoruz?</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Cloud = VPS Codex/Cursor · Memory otomatik senkron
              </p>
            </div>
          )}

          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}

          {busy && (
            <div className="text-sm text-muted-foreground animate-pulse">
              Yanıt hazırlanıyor…
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="border-t border-border/60 p-4 md:px-8 md:pb-6">
        <form
          className="composer-glass mx-auto flex max-w-3xl flex-col gap-2 rounded-2xl border border-border/60 p-3 shadow-lg"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <textarea
            ref={inputRef}
            rows={2}
            placeholder="Mesaj yaz…"
            disabled={busy}
            className="w-full resize-none rounded-xl border border-border/40 bg-background/20 px-3 py-2 text-[15px] outline-none placeholder:text-muted-foreground focus:border-primary/40 disabled:opacity-50"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-40"
            >
              <IconSend size={16} />
              Gönder
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  const isError = message.role === "error";

  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-2xl border px-4 py-3",
          isUser && "rounded-br-md border-border/40 bg-user-bubble",
          !isUser && !isError && "rounded-bl-md border-border/50 bg-card/80",
          isError && "rounded-bl-md border-red-500/40 bg-red-950/30 text-red-200",
        )}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap text-[15px]">{message.text}</p>
        ) : (
          <div className="prose prose-invert prose-sm max-w-none">
            <Streamdown>{message.text}</Streamdown>
          </div>
        )}
        {!isUser && message.provider && (
          <p className="mt-2 text-[10px] uppercase tracking-wider text-muted-foreground">
            {message.provider}
            {message.via ? ` · ${message.via}` : ""}
          </p>
        )}
      </div>
    </div>
  );
}
