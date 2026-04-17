import { useEffect } from "react";
import { useAiStore, type EngineType } from "../../stores/aiStore";
import EngineLogo from "./EngineLogo";

const ENGINES: { type: EngineType; label: string }[] = [
  { type: "claude-code", label: "Claude Code" },
  { type: "codex", label: "Codex" },
];

export default function EngineSelector() {
  const activeEngineType = useAiStore((s) => s.activeEngineType);
  const engineAvailability = useAiStore((s) => s.engineAvailability);
  const setActiveEngine = useAiStore((s) => s.setActiveEngine);
  const checkEngineAvailability = useAiStore((s) => s.checkEngineAvailability);

  useEffect(() => {
    checkEngineAvailability();
  }, []);

  return (
    <div className="flex items-center gap-0.5 bg-well rounded-md p-0.5 border border-stroke">
      {ENGINES.map(({ type, label }) => {
        const available = engineAvailability?.[type] ?? false;
        const active = activeEngineType === type;

        return (
          <button
            key={type}
            onClick={() => setActiveEngine(type)}
            className={`flex items-center px-2 py-1 rounded text-xs transition-colors ${
              active
                ? "bg-conduit-600 text-white"
                : available
                  ? "text-ink-muted hover:text-ink hover:bg-panel"
                  : "text-ink-faint hover:text-ink-muted hover:bg-panel"
            }`}
            title={available ? label : `${label} (not installed)`}
          >
            <EngineLogo type={type} size={14} />
          </button>
        );
      })}
    </div>
  );
}
