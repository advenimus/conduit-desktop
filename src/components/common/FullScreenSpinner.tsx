import { Button, Spinner } from "../ui";

interface FullScreenSpinnerProps {
  text: string;
  /** Shows "Go to Vault Hub", focused, so Enter, Space and Escape all leave (docs/AUTO_UNLOCK.md 2.3). */
  onGoToHub?: () => void;
}

export default function FullScreenSpinner({ text, onGoToHub }: FullScreenSpinnerProps) {
  return (
    <div className="flex items-center justify-center h-screen bg-editor text-ink">
      <div className="flex flex-col items-center gap-3">
        <Spinner size={24} className="text-(--c-progress)" />
        <span role="status" className="text-body text-ink-muted">
          {text}
        </span>
        {onGoToHub && (
          <Button
            autoFocus
            className="mt-2"
            onClick={onGoToHub}
            onKeyDown={(e) => {
              if (e.key === "Escape") onGoToHub();
            }}
          >
            Go to Vault Hub
          </Button>
        )}
      </div>
    </div>
  );
}
