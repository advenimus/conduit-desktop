import { useState, useRef, useEffect } from "react";
import { useAiStore } from "../../stores/aiStore";
import { CheckIcon, CloseIcon, LoaderIcon } from "../../lib/icons";

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
      <div ref={containerRef} data-popover className="mx-4 mb-4 bg-panel border border-stroke rounded-lg shadow-lg overflow-hidden">
        <div className="p-4 flex items-center justify-center gap-2 text-ink-muted text-sm">
          <LoaderIcon size={16} className="animate-spin" />
          <span>Loading models...</span>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} data-popover className="mx-4 mb-4 bg-panel border border-stroke rounded-lg shadow-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-stroke">
        <span className="text-sm font-medium text-ink">Select a model</span>
        <button
          onClick={closePicker}
          className="p-1 hover:bg-raised rounded text-ink-faint hover:text-ink"
        >
          <CloseIcon size={14} />
        </button>
      </div>

      {/* Model list */}
      <div className="max-h-64 overflow-y-auto">
        {models.map((model) => {
          const isCurrent = model.id === currentModel || (model.isDefault && !currentModel);
          return (
            <button
              key={model.id}
              onClick={() => handleSelect(model.id)}
              className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors border-b border-stroke/50 last:border-0 ${
                isCurrent
                  ? "bg-conduit-600/10"
                  : "hover:bg-raised"
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-ink truncate">
                  {model.name}
                </div>
                {model.description && (
                  <div className="text-xs text-ink-faint truncate mt-0.5">
                    {model.description}
                  </div>
                )}
              </div>
              {isCurrent && (
                <CheckIcon size={16} className="text-conduit-400 flex-shrink-0" />
              )}
            </button>
          );
        })}
      </div>

      {/* Custom model input */}
      <div className="border-t border-stroke">
        {showCustom ? (
          <div className="flex items-center gap-2 px-4 py-3">
            <input
              ref={customRef}
              type="text"
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
              className="flex-1 px-3 py-1.5 bg-well border border-stroke rounded text-sm text-ink placeholder-ink-faint focus:outline-none focus:ring-1 focus:ring-conduit-500"
            />
            <button
              onClick={handleCustomSubmit}
              disabled={!customInput.trim()}
              className="px-3 py-1.5 bg-conduit-600 hover:bg-conduit-700 text-white rounded text-sm disabled:opacity-50"
            >
              Apply
            </button>
          </div>
        ) : (
          <button
            onClick={() => setShowCustom(true)}
            className="w-full px-4 py-3 text-left text-sm text-ink-muted hover:bg-raised transition-colors"
          >
            Use custom model ID...
          </button>
        )}
      </div>
    </div>
  );
}
