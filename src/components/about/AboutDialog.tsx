import { useState, useEffect } from "react";
import { useAppIcon } from "../../hooks/useAppIcon";
import { invoke } from "../../lib/electron";
import { Button, Dialog, IconButton } from "../ui";

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

  return (
    <Dialog open title="About Conduit" onClose={onClose} closeOnScrim width={384} layout="custom">
      <div className="flex items-center justify-end px-4 pt-3">
        <IconButton icon="close" label="Close" onClick={onClose} />
      </div>

      <div className="flex flex-col items-center gap-4 px-6 pb-6">
        <img src={appIcon} alt="Conduit" className="h-20 w-20 rounded-lg" />
        <div className="text-center">
          <h1 className="text-display text-ink">Conduit</h1>
          {version && <p className="mt-1 text-body text-ink-muted">Version {version}</p>}
        </div>
        <p className="text-center text-body text-ink-muted">AI-Powered Remote Connection Manager</p>
        <Button variant="link" size="lg" onClick={() => invoke("auth_open_website")}>
          conduitdesktop.com
        </Button>
      </div>
    </Dialog>
  );
}
