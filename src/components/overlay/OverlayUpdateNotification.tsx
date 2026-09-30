import { ToastCard, type ToastCardAction, type ToastCardType } from "../ui";
import type { UpdateState } from "../../types/toast";

type UpdateAction = "install" | "dismiss" | "website";

interface Props {
  update: UpdateState;
  onAction: (action: UpdateAction) => void;
}

const TYPE: Readonly<Record<UpdateState["state"], ToastCardType>> = {
  downloading: "info",
  downloaded: "success",
  error: "error",
};

const TITLE: Readonly<Record<UpdateState["state"], string>> = {
  downloading: "Update Available",
  downloaded: "Update Ready",
  error: "Update Failed",
};

function messageFor({ state, version }: UpdateState): string {
  if (state === "error") return "Auto-update failed. You can download the latest version from our website.";
  if (state === "downloaded") return `Version ${version} is ready to install.`;
  return `Version ${version} is available.`;
}

function actionsFor(state: UpdateState["state"], onAction: (action: UpdateAction) => void): ReadonlyArray<ToastCardAction> | undefined {
  if (state === "downloaded") {
    return [
      { id: "install", label: "Restart Now", variant: "primary", icon: "refresh", onClick: () => onAction("install") },
      { id: "dismiss", label: "Later", onClick: () => onAction("dismiss") },
      { id: "website", label: "Download manually from website", icon: "externalLink", onClick: () => onAction("website") },
    ];
  }
  if (state === "error") {
    return [
      { id: "website", label: "Download from Website", variant: "primary", icon: "externalLink", onClick: () => onAction("website") },
      { id: "dismiss", label: "Later", onClick: () => onAction("dismiss") },
    ];
  }
  return undefined;
}

export default function OverlayUpdateNotification({ update, onAction }: Props) {
  const percent = update.progress ?? 0;

  return (
    <ToastCard
      type={TYPE[update.state]}
      toastId="update-notification"
      title={TITLE[update.state]}
      message={messageFor(update)}
      actions={actionsFor(update.state, onAction)}
      progress={update.state === "downloading" ? { percent, leftLabel: `${percent}% downloaded` } : undefined}
      onClose={() => onAction("dismiss")}
      className="animate-toast-in"
    />
  );
}
