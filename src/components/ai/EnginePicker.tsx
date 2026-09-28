import { useEffect, useState } from "react";
import { useAiStore, type EngineType } from "../../stores/aiStore";
import { invoke } from "../../lib/electron";
import EngineLogo from "./EngineLogo";
import { Badge, Button } from "../ui";
import { AI_HARNESSES } from "../../lib/ai-harnesses";

interface Props {
  /** Called after the choice is persisted and setActiveEngine has run.
   *  Caller decides what to do next (e.g. createEngineSession in chat mode,
   *  or signal the terminal-mode launch effect to fire). */
  onPick: (type: EngineType) => Promise<void> | void;
}

export default function EnginePicker({ onPick }: Props) {
  const engineAvailability = useAiStore((s) => s.engineAvailability);
  const checkEngineAvailability = useAiStore((s) => s.checkEngineAvailability);
  const setActiveEngine = useAiStore((s) => s.setActiveEngine);
  const lastChosen = useAiStore((s) => s.activeEngineType);

  const [busy, setBusy] = useState<EngineType | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    checkEngineAvailability();
  }, [checkEngineAvailability]);

  const handlePick = async (type: EngineType) => {
    setBusy(type);
    setError(null);
    try {
      const current = await invoke<Record<string, unknown>>("settings_get");
      await invoke("settings_save", {
        settings: {
          ...current,
          default_engine: type,
          engine_picker_completed: true,
        },
      });
      setActiveEngine(type);
      await onPick(type);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const handleInstall = async (type: EngineType) => {
    try {
      await invoke("engine_open_install_docs", { engineType: type });
    } catch (err) {
      console.error("Failed to open the install instructions:", err);
    }
  };

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto px-4">
      <div className="w-full max-w-sm py-4">
        <div className="mb-5 text-center">
          <p className="mb-1 text-body font-semibold text-ink">Choose your AI agent</p>
          <p className="text-label text-ink-muted">
            Conduit uses your local CLI agent. Pick which one to use — you can change this any time in Settings &gt; AI &gt; Agent.
          </p>
        </div>

        <div className="mb-4 space-y-2">
          {AI_HARNESSES.map((opt) => {
            const available = engineAvailability?.[opt.id] ?? false;
            const isLast = lastChosen === opt.id;
            const isBusy = busy === opt.id;

            return (
              <div
                key={opt.id}
                className={`rounded-md border bg-well p-3 ${isLast ? "border-accent" : "border-card-border"}`}
              >
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-selected">
                    <EngineLogo type={opt.id} size={18} className="text-ink" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="mb-0.5 flex items-center gap-2">
                      <span className="text-body font-semibold text-ink">{opt.name}</span>
                      <Badge tone={available ? "success" : "warning"}>{available ? "Installed" : "Not installed"}</Badge>
                    </div>
                    <p className="mb-2 text-label text-ink-muted">{opt.description}</p>
                    {available ? (
                      <Button
                        variant="primary"
                        onClick={() => handlePick(opt.id)}
                        disabled={busy !== null}
                        loading={isBusy}
                        loadingLabel="Starting…"
                      >
                        {`Use ${opt.name}`}
                      </Button>
                    ) : (
                      <Button variant="secondary" onClick={() => handleInstall(opt.id)}>
                        Install instructions
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {error && <p className="mb-3 text-center text-label text-danger">{error}</p>}

        <div className="flex justify-center">
          <Button variant="ghost" size="sm" icon="refresh" onClick={() => checkEngineAvailability()}>
            Re-check availability
          </Button>
        </div>
      </div>
    </div>
  );
}
