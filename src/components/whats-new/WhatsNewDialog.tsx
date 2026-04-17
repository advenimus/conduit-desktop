import { useState, useCallback, useEffect } from 'react';
import { useAppIcon } from '../../hooks/useAppIcon';
import { useReleaseNotes, getMediaUrl } from './useReleaseNotes';
import type { ReleaseHighlight } from '../../types/whats-new';
import {
  ArrowUpIcon, BugIcon, CheckIcon, ChevronLeftIcon, ChevronRightIcon, CloseIcon, RefreshIcon, RocketIcon, SparklesIcon, WifiOffIcon
} from "../../lib/icons";

interface WhatsNewDialogProps {
  onClose: () => void;
  /** When set, start on the card matching this version (auto-trigger mode) */
  initialVersion?: string;
}

/**
 * Parse highlight text for inline links: `[label](conduit://settings/tab)`.
 * Renders plain text as-is and links as clickable buttons that dispatch
 * in-app navigation events.
 */
function renderHighlightText(text: string): React.ReactNode {
  const linkPattern = /\[([^\]]+)\]\(conduit:\/\/settings\/([^)]+)\)/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = linkPattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const label = match[1];
    const tab = match[2];
    parts.push(
      <button
        key={match.index}
        className="text-conduit-400 hover:text-conduit-300 underline underline-offset-2 transition-colors"
        onClick={() => {
          document.dispatchEvent(
            new CustomEvent("conduit:settings", { detail: { tab } })
          );
        }}
      >
        {label}
      </button>
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex === 0) return text;
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

function categoryIcon(category?: ReleaseHighlight['category']) {
  switch (category) {
    case 'feature':
      return <SparklesIcon size={12} className="text-conduit-500" />;
    case 'improvement':
      return <ArrowUpIcon size={12} className="text-conduit-500" />;
    case 'fix':
      return <BugIcon size={12} className="text-conduit-500" />;
    default:
      return <CheckIcon size={12} className="text-conduit-500" />;
  }
}

export default function WhatsNewDialog({ onClose, initialVersion }: WhatsNewDialogProps) {
  const appIcon = useAppIcon();
  const { releases, loading, error, retry } = useReleaseNotes();

  // Resolve initial step index from version
  const initialIndex = initialVersion
    ? Math.max(0, releases.findIndex((r) => r.version === initialVersion))
    : 0;

  const [currentStep, setCurrentStep] = useState(initialIndex);
  const [direction, setDirection] = useState<'left' | 'right'>('right');
  const [isAnimating, setIsAnimating] = useState(false);
  const [gifLoaded, setGifLoaded] = useState<Record<number, boolean>>({});
  const [gifError, setGifError] = useState<Record<number, boolean>>({});

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

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (releases.length === 0) return;
      if (e.key === 'ArrowRight' && canGoNext) goTo(currentStep + 1);
      else if (e.key === 'ArrowLeft' && canGoPrev) goTo(currentStep - 1);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, releases.length, currentStep, goTo, canGoPrev, canGoNext]);

  const slideStyle: React.CSSProperties = isAnimating
    ? {
        transform: `translateX(${direction === 'right' ? '-40px' : '40px'})`,
        opacity: 0,
      }
    : { transform: 'translateX(0)', opacity: 1 };

  const transition = 'transform 200ms ease-out, opacity 200ms ease-out';

  const release = releases[currentStep];

  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/50 z-50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-4xl mx-6">
        <div data-dialog-content className="rounded-xl border border-stroke-dim bg-panel shadow-lg overflow-hidden">
          {/* Header: version nav arrows + close button */}
          <div className="flex items-center justify-between px-4 pt-3">
            {/* Version navigation */}
            {!loading && !error && releases.length > 1 ? (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => canGoPrev && goTo(currentStep - 1)}
                  disabled={!canGoPrev || isAnimating}
                  className="p-1 rounded hover:bg-raised transition-colors disabled:opacity-30 disabled:cursor-default"
                  title="Previous version"
                >
                  <ChevronLeftIcon size={16} className="text-ink-muted" />
                </button>
                <span className="text-xs text-ink-faint tabular-nums min-w-[3.5rem] text-center">
                  {currentStep + 1} / {releases.length}
                </span>
                <button
                  onClick={() => canGoNext && goTo(currentStep + 1)}
                  disabled={!canGoNext || isAnimating}
                  className="p-1 rounded hover:bg-raised transition-colors disabled:opacity-30 disabled:cursor-default"
                  title="Next version"
                >
                  <ChevronRightIcon size={16} className="text-ink-muted" />
                </button>
              </div>
            ) : (
              <div />
            )}

            {/* Close button */}
            <button onClick={onClose} className="p-1 hover:bg-raised rounded" title="Close">
              <CloseIcon size={18} />
            </button>
          </div>

          {/* Loading state */}
          {loading && (
            <div className="flex items-center justify-center h-[480px]">
              <div className="flex flex-col items-center gap-3">
                <div className="w-8 h-8 border-2 border-conduit-500 border-t-transparent rounded-full animate-spin" />
                <span className="text-sm text-ink-muted">Loading release notes...</span>
              </div>
            </div>
          )}

          {/* Error / offline state */}
          {!loading && (error || releases.length === 0) && (
            <div className="flex items-center justify-center h-[480px]">
              <div className="flex flex-col items-center gap-4 text-center px-8">
                <div className="w-14 h-14 rounded-full bg-well/50 flex items-center justify-center">
                  <WifiOffIcon size={28} className="text-ink-faint" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-ink">Release notes unavailable</h3>
                  <p className="text-sm text-ink-muted mt-1">
                    {error || 'No release notes found.'}
                  </p>
                </div>
                <button
                  onClick={retry}
                  className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium rounded bg-conduit-500 hover:bg-conduit-600 text-white transition-colors"
                >
                  <RefreshIcon size={16} />
                  Retry
                </button>
              </div>
            </div>
          )}

          {/* Content carousel */}
          {!loading && !error && release && (
            <div className="flex h-[480px]">
              {/* ── Left Panel: GIF + Title ── */}
              <div className="w-[55%] flex-shrink-0 flex flex-col px-8 pb-8">
                <div
                  className="flex-1 flex flex-col justify-center"
                  style={{ ...slideStyle, transition }}
                >
                  {/* GIF area — only shown when release has media */}
                  {release.hasMedia && !gifError[currentStep] && (
                    <div className="w-full aspect-video rounded-lg border border-stroke overflow-hidden mb-5 bg-well/30 flex-shrink-0 relative">
                      {!gifLoaded[currentStep] && (
                        <div className="absolute inset-0 flex items-center justify-center">
                          <div className="w-6 h-6 border-2 border-conduit-500/40 border-t-conduit-500 rounded-full animate-spin" />
                        </div>
                      )}
                      <img
                        key={release.version}
                        src={getMediaUrl(release.version)}
                        alt={`${release.title} demo`}
                        className={`w-full h-full object-cover transition-opacity duration-300 ${
                          gifLoaded[currentStep] ? 'opacity-100' : 'opacity-0'
                        }`}
                        onLoad={() =>
                          setGifLoaded((prev) => ({ ...prev, [currentStep]: true }))
                        }
                        onError={() =>
                          setGifError((prev) => ({ ...prev, [currentStep]: true }))
                        }
                      />
                    </div>
                  )}

                  {/* Title + description */}
                  <div className="flex items-start gap-3">
                    <div className="w-9 h-9 rounded-lg bg-conduit-500/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <RocketIcon size={20} className="text-conduit-500" />
                    </div>
                    <div className="min-w-0">
                      <h2 className="text-lg font-semibold text-ink leading-tight">
                        {release.title}
                      </h2>
                      <p className="text-sm text-ink-muted mt-1 leading-relaxed">
                        {release.summary}
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Vertical divider */}
              <div className="w-px bg-stroke-dim my-8" />

              {/* ── Right Panel: Highlights ── */}
              <div className="flex-1 flex flex-col px-8 pb-8 min-h-0">
                <div
                  className="flex-1 flex flex-col min-h-0"
                  style={{ ...slideStyle, transition }}
                >
                  {/* Version badge — fixed at top */}
                  <div className="flex items-center gap-2 mb-4 flex-shrink-0 pt-2">
                    <img src={appIcon} alt="Conduit" className="w-7 h-7 rounded-md" />
                    <span className="text-xs font-semibold text-ink-faint uppercase tracking-wider">
                      v{release.version}
                    </span>
                    {release.date && (
                      <span className="text-xs text-ink-faint">&middot; {release.date}</span>
                    )}
                  </div>

                  {/* Highlight bullets — scrollable */}
                  <ul className="space-y-3 overflow-y-auto min-h-0 flex-1 pr-1">
                    {release.highlights.map((h, i) => (
                      <li key={i} className="flex items-start gap-2.5">
                        <div className="w-5 h-5 rounded-full bg-conduit-500/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                          {categoryIcon(h.category)}
                        </div>
                        <span className="text-sm text-ink-secondary leading-relaxed">
                          {renderHighlightText(h.text)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>

                {/* ── Fixed footer: dot indicators + close ── */}
                <div className="flex-shrink-0 pt-5">
                  {/* Dot indicators */}
                  {releases.length > 1 && (
                    <div className="flex items-center gap-1.5 mb-5">
                      {releases.map((_, i) => (
                        <button
                          key={i}
                          onClick={() => goTo(i)}
                          className={`h-1.5 rounded-full transition-all duration-300 ${
                            i === currentStep
                              ? 'w-6 bg-conduit-500'
                              : i < currentStep
                                ? 'w-1.5 bg-conduit-500/40'
                                : 'w-1.5 bg-ink-faint/30'
                          }`}
                        />
                      ))}
                    </div>
                  )}

                  {/* Close button */}
                  <div className="flex justify-end">
                    <button
                      onClick={onClose}
                      className="flex items-center justify-center px-5 py-1.5 text-sm font-medium rounded bg-conduit-500 hover:bg-conduit-600 text-white transition-colors"
                    >
                      Close
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
