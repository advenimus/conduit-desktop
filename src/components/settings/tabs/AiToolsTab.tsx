import { useState, useEffect } from "react";
import { invoke } from "../../../lib/electron";
import type { TabProps } from "../SettingsHelpers";
import { CloseIcon, TrashIcon } from "../../../lib/icons";

interface ToolInfo {
  name: string;
  description: string;
  category: string;
}

const CATEGORY_COLORS: Record<string, string> = {
  read: "bg-blue-500/15 text-blue-600 dark:text-blue-300 border-blue-500/25",
  execute: "bg-orange-500/15 text-orange-600 dark:text-orange-300 border-orange-500/25",
  write: "bg-purple-500/15 text-purple-600 dark:text-purple-300 border-purple-500/25",
  navigate: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-300 border-cyan-500/25",
  credential: "bg-red-500/15 text-red-600 dark:text-red-300 border-red-500/25",
  connection: "bg-green-500/15 text-green-600 dark:text-green-300 border-green-500/25",
};

function CategoryBadge({ category }: { category: string }) {
  const colors = CATEGORY_COLORS[category] ?? "bg-ink-faint/20 text-ink-muted border-ink-faint/30";
  return (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${colors}`}>
      {category}
    </span>
  );
}

export default function AiToolsTab({ settings, setSettings }: TabProps) {
  const [allTools, setAllTools] = useState<ToolInfo[]>([]);

  useEffect(() => {
    invoke<ToolInfo[]>("tool_registry_list").then(setAllTools).catch(() => {});
  }, []);

  const allowedTools = settings.tool_approval_always_allow ?? [];

  // Build enriched list of allowed tools with descriptions from registry
  const toolMap = new Map(allTools.map((t) => [t.name, t]));
  const enrichedAllowed = allowedTools.map((name) => ({
    name,
    description: toolMap.get(name)?.description ?? "",
    category: toolMap.get(name)?.category ?? "execute",
  }));

  // Group by category
  const grouped = new Map<string, typeof enrichedAllowed>();
  for (const tool of enrichedAllowed) {
    const list = grouped.get(tool.category) ?? [];
    list.push(tool);
    grouped.set(tool.category, list);
  }
  const sortedCategories = Array.from(grouped.keys()).sort();

  const handleRemove = async (toolName: string) => {
    try {
      await invoke("tool_approval_remove_allowed", { tool_name: toolName });
      setSettings((prev) => ({
        ...prev,
        tool_approval_always_allow: prev.tool_approval_always_allow.filter(
          (t) => t !== toolName
        ),
      }));
    } catch (err) {
      console.error("Failed to remove allowed tool:", err);
    }
  };

  const handleClearAll = async () => {
    try {
      await invoke("tool_approval_clear_allowed");
      setSettings((prev) => ({
        ...prev,
        tool_approval_always_allow: [],
      }));
    } catch (err) {
      console.error("Failed to clear allowed tools:", err);
    }
  };

  const handleToggleEnabled = async (enabled: boolean) => {
    try {
      await invoke("tool_approval_set_enabled", { enabled });
      setSettings((prev) => ({
        ...prev,
        tool_approval_enabled: enabled,
      }));
    } catch (err) {
      console.error("Failed to toggle tool approval:", err);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-ink mb-1">MCP Tool Approvals</h3>
        <p className="text-xs text-ink-muted">
          When enabled, AI agents must get your approval before executing MCP
          tools. You can always-allow individual tools to skip the prompt.
        </p>
      </div>

      {/* Master toggle */}
      <div className="flex items-center justify-between bg-well rounded-lg px-3 py-2.5">
        <div>
          <span className="text-sm font-medium text-ink">
            Require approval for tool calls
          </span>
          <p className="text-xs text-ink-muted mt-0.5">
            Disable to let all tools execute without prompting
          </p>
        </div>
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={settings.tool_approval_enabled ?? true}
            onChange={(e) => handleToggleEnabled(e.target.checked)}
            className="sr-only peer"
          />
          <div className="w-9 h-5 bg-raised peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-conduit-600" />
        </label>
      </div>

      {/* Always-allowed tools */}
      {(settings.tool_approval_enabled ?? true) && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-semibold text-ink-secondary uppercase tracking-wide">
              Always Allowed Tools ({allowedTools.length})
            </h4>
            {allowedTools.length > 0 && (
              <button
                onClick={handleClearAll}
                className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300 transition-colors"
              >
                <TrashIcon size={12} />
                Remove All
              </button>
            )}
          </div>

          {allowedTools.length === 0 ? (
            <div className="bg-well rounded-lg px-3 py-4 text-center">
              <p className="text-xs text-ink-muted">
                No tools are always-allowed yet. Check "Always allow" in the
                approval dialog to add tools here.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {sortedCategories.map((category) => (
                <div key={category}>
                  <div className="flex items-center gap-1.5 mb-1">
                    <CategoryBadge category={category} />
                  </div>
                  <div className="space-y-0.5">
                    {grouped.get(category)!.map((tool) => (
                      <div
                        key={tool.name}
                        className="flex items-center gap-2 bg-well rounded px-3 py-1.5 group"
                      >
                        <span className="text-xs font-mono text-ink flex-shrink-0">
                          {tool.name}
                        </span>
                        <span className="text-[10px] text-ink-muted truncate flex-1">
                          {tool.description}
                        </span>
                        <button
                          onClick={() => handleRemove(tool.name)}
                          className="p-0.5 text-ink-faint hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                          title="Remove from always-allowed"
                        >
                          <CloseIcon size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
