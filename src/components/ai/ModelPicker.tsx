import { useState, useRef, useEffect } from "react";
import { useAiStore } from "../../stores/aiStore";
import { CheckIcon } from "../../lib/icons";
import { Button, IconButton, ListRow, Spinner, TextInput } from "../ui";

// In the flow of the chat body with the overlay look (spec 3.16), not a floating popover.
const CARD = "mx-4 mb-4 overflow-hidden rounded-lg border border-overlay-border bg-overlay";

export default function ModelPicker() {
  const models = useAiStore((s) => s.engineModelOptions);
  const selectModel = useAiStore((s) => s.selectEngineModel);
  const closePicker = useAiStore((s) => s.closeModelPicker);
  const activeSessionId = useAiStore((s) => s.activeEngineSessionId);
  const sessions = useAiStore((s) => s.engineSessions);
  const pendingModel = useAiStore((s) => s.pendingEngineModel);

  const currentModel = sessions.find((s) => s.id === activeSessionId)?.model ?? pendingModel;
  const [customInput, setCustomInput] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const customRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Focus custom input when shown
  useEffect(() => {
    if (showCustom) customRef.current?.focus();
  }, [showCustom]);

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePicker();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [closePicker]);

  // Close on click outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        closePicker();
      }
    };
    // Delay to avoid immediate close from the click that opened it
    const timer = setTimeout(() => {
      window.addEventListener("mousedown", handleClick);
    }, 100);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mousedown", handleClick);
    };
  }, [closePicker]);

  const handleSelect = (modelId: string) => {
    selectModel(modelId);
  };

  const handleCustomSubmit = () => {
    const trimmed = customInput.trim();
    if (trimmed) {
      selectModel(trimmed);
      setCustomInput("");
      setShowCustom(false);
    }
  };

  if (models.length === 0) {
    return (
      <div ref={containerRef} data-popover className={CARD}>
        <div className="flex items-center justify-center p-4 text-body text-ink-muted">
          <Spinner size={16} text="Loading models..." />
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} data-popover className={CARD}>
      <div className="flex items-center justify-between border-b border-divider px-4 py-3">
        <span className="text-body font-semibold text-ink">Select a model</span>
        <IconButton size="sm" icon="close" label="Close" onClick={closePicker} />
      </div>

      <div className="max-h-64 overflow-y-auto p-1">
        {models.map((model) => {
          const isCurrent = model.id === currentModel || (model.isDefault && !currentModel);
          return (
            <ListRow
              key={model.id}
              onClick={() => handleSelect(model.id)}
              selected={isCurrent}
              description={model.description || undefined}
              meta={isCurrent ? <CheckIcon size={16} className="text-ink" /> : undefined}
            >
              {model.name}
            </ListRow>
          );
        })}
      </div>

      <div className="border-t border-divider">
        {showCustom ? (
          <div className="flex items-center gap-2 px-4 py-3">
            <TextInput
              ref={customRef}
              value={customInput}
              onChange={(e) => setCustomInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCustomSubmit();
                if (e.key === "Escape") {
                  setShowCustom(false);
                  setCustomInput("");
                }
              }}
              placeholder="Enter model ID..."
              className="flex-1"
            />
            <Button variant="primary" onClick={handleCustomSubmit} disabled={!customInput.trim()}>
              Apply
            </Button>
          </div>
        ) : (
          <div className="p-1">
            <ListRow onClick={() => setShowCustom(true)}>
              Use custom model ID...
            </ListRow>
          </div>
        )}
      </div>
    </div>
  );
}
