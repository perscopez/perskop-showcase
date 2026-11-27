type Mode = "vps" | "local";

type Props = {
  mode: Mode;
  setMode: (m: Mode) => void;
  selected: string;
  setSelected: (p: string) => void;
  providers: string[];
  localAvailable: boolean;
};

export function ComposerBar({
  mode,
  setMode,
  selected,
  setSelected,
  providers,
  localAvailable,
}: Props) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Pill label="cloud" active={mode === "vps"} onClick={() => setMode("vps")} />
      <Pill
        label="local"
        active={mode === "local"}
        onClick={() => setMode("local")}
        disabled={!localAvailable}
      />
      <span className="mx-1 h-4 w-px bg-border/60" />
      {providers.map((p) => (
        <Pill
          key={p}
          label={p}
          active={selected === p}
          onClick={() => setSelected(p)}
        />
      ))}
    </div>
  );
}

function Pill({
  label,
  active,
  onClick,
  disabled,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={
        active
          ? "rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
          : "rounded-full border border-border/50 px-3 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
      }
    >
      {label}
    </button>
  );
}
