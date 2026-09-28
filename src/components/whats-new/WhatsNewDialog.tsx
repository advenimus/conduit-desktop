import { useState, useCallback, useEffect } from 'react';
import { useReleaseNotes } from './useReleaseNotes';
import { WifiOffIcon } from "../../lib/icons";
import { Button, Dialog, IconButton, Spinner } from "../ui";
import ReleaseCard from "./ReleaseCard";

interface WhatsNewDialogProps {
  onClose: () => void;
  /** When set, start on the card matching this version (auto-trigger mode) */
  initialVersion?: string;
}

export default function WhatsNewDialog({ onClose, initialVersion }: WhatsNewDialogProps) {
  const { releases, loading, error, retry } = useReleaseNotes();

  // Resolve initial step index from version
  const initialIndex = initialVersion
    ? Math.max(0, releases.findIndex((r) => r.version === initialVersion))
    : 0;

  const [currentStep, setCurrentStep] = useState(initialIndex);
  const [direction, setDirection] = useState<'left' | 'right'>('right');
  const [isAnimating, setIsAnimating] = useState(false);

  // Sync initial index when releases load
  useEffect(() => {
    if (releases.length > 0 && initialVersion) {
      const idx = releases.findIndex((r) => r.version === initialVersion);
      if (idx >= 0) setCurrentStep(idx);
    }
  }, [releases, initialVersion]);

  const goTo = useCallback(
    (next: number) => {
      if (isAnimating || next === currentStep || releases.length === 0) return;
      setDirection(next > currentStep ? 'right' : 'left');
      setIsAnimating(true);
      setTimeout(() => {
        setCurrentStep(next);
        requestAnimationFrame(() => {
          setIsAnimating(false);
        });
      }, 200);
    },
    [currentStep, isAnimating, releases.length]
  );

  const canGoPrev = currentStep > 0;
  const canGoNext = currentStep < releases.length - 1;

  // Arrow keys page through versions; Escape belongs to the dialog's layer.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (releases.length === 0) return;
      if (e.key === 'ArrowRight' && canGoNext) goTo(currentStep + 1);
      else if (e.key === 'ArrowLeft' && canGoPrev) goTo(currentStep - 1);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [releases.length, currentStep, goTo, canGoPrev, canGoNext]);

  const release = releases[currentStep];

  return (
    <Dialog open title="What's New" onClose={onClose} closeOnScrim width={896} layout="custom">
      {/* Header: version nav arrows + close button */}
      <div className="flex items-center justify-between px-4 pt-3">
        {!loading && !error && releases.length > 1 ? (
          <div className="flex items-center gap-1">
            <IconButton
              icon="chevronLeft"
              label="Previous version"
              onClick={() => canGoPrev && goTo(currentStep - 1)}
              disabled={!canGoPrev || isAnimating}
            />
            <span className="min-w-[3.5rem] text-center text-label tabular-nums text-ink-faint">
              {currentStep + 1} / {releases.length}
            </span>
            <IconButton
              icon="chevronRight"
              label="Next version"
              onClick={() => canGoNext && goTo(currentStep + 1)}
              disabled={!canGoNext || isAnimating}
            />
          </div>
        ) : (
          <div />
        )}
        <IconButton icon="close" label="Close" onClick={onClose} />
      </div>

      {loading && (
        <div className="flex h-[480px] items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <Spinner size={24} className="text-link" />
            <span className="text-body text-ink-muted">Loading release notes...</span>
          </div>
        </div>
      )}

      {!loading && (error || releases.length === 0) && (
        <div className="flex h-[480px] items-center justify-center">
          <div className="flex flex-col items-center gap-4 px-8 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-well">
              <WifiOffIcon size={28} className="text-ink-faint" />
            </div>
            <div>
              <h3 className="text-title text-ink">Release notes unavailable</h3>
              <p className="mt-1 text-body text-ink-muted">{error || 'No release notes found.'}</p>
            </div>
            <Button variant="primary" icon="refresh" onClick={retry}>
              Retry
            </Button>
          </div>
        </div>
      )}

      {!loading && !error && release && (
        <ReleaseCard
          release={release}
          step={currentStep}
          count={releases.length}
          direction={direction}
          isAnimating={isAnimating}
          onGoTo={goTo}
          onClose={onClose}
        />
      )}
    </Dialog>
  );
}
