import { useState, useEffect } from "react";
import { useAppIcon } from "../../hooks/useAppIcon";
import { invoke } from "../../lib/electron";
import { CloseIcon } from "../../lib/icons";

interface AboutDialogProps {
  onClose: () => void;
}

export default function AboutDialog({ onClose }: AboutDialogProps) {
  const appIcon = useAppIcon();
  const [version, setVersion] = useState("");

  useEffect(() => {
    invoke<string>("app_get_version")
      .then(setVersion)
      .catch(() => setVersion(""));
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
  };

  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/50 z-50"
      onKeyDown={handleKeyDown}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div data-dialog-content className="w-full max-w-sm bg-panel rounded-lg shadow-xl" tabIndex={-1}>
        {/* Header */}
        <div className="flex items-center justify-end px-4 pt-3">
          <button
            onClick={onClose}
            className="p-1 hover:bg-raised rounded"
          >
            <CloseIcon size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="flex flex-col items-center px-6 pb-6 gap-4">
          <img
            src={appIcon}
            alt="Conduit"
            className="w-20 h-20 rounded-xl"
          />
          <div className="text-center">
            <h1 className="text-2xl font-bold">Conduit</h1>
            {version && (
              <p className="text-sm text-ink-muted mt-1">Version {version}</p>
            )}
          </div>
          <p className="text-sm text-ink-muted text-center">
            AI-Powered Remote Connection Manager
          </p>
          <button
            onClick={() => invoke("auth_open_website")}
            className="text-sm text-accent hover:underline"
          >
            conduitdesktop.com
          </button>
        </div>
      </div>
    </div>
  );
}
