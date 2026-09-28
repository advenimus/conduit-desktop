import { useState, type CSSProperties, type ReactNode } from 'react';
import { useAppIcon } from '../../hooks/useAppIcon';
import { getMediaUrl } from './useReleaseNotes';
import type { ReleaseEntry, ReleaseHighlight } from '../../types/whats-new';
import { ArrowUpIcon, BugIcon, CheckIcon, RocketIcon, SparklesIcon } from "../../lib/icons";
import { Button, Spinner, cx } from "../ui";

const LINK = "text-link underline underline-offset-2 transition-colors hover:text-link-hover";

/**
 * Parse inline markdown: `**bold**`, `[label](conduit://settings/tab)` for
 * in-app navigation, and `[label](https://…)` for external links that open
 * in the default browser.
 */
function renderHighlightText(text: string): ReactNode {
  const pattern = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(((?:conduit:\/\/settings\/|https?:\/\/)[^)]+)\)/g;
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    if (match[1] !== undefined) {
      parts.push(<strong key={key++} className="font-semibold text-ink">{match[1]}</strong>);
    } else {
      const label = match[2];
      const href = match[3];
      if (href.startsWith('conduit://settings/')) {
        const tab = href.slice('conduit://settings/'.length);
        parts.push(
          <button
            key={key++}
            type="button"
            className={LINK}
            onClick={() => {
              document.dispatchEvent(
                new CustomEvent("conduit:settings", { detail: { tab } })
              );
            }}
          >
            {label}
          </button>
        );
      } else {
        parts.push(
          <a key={key++} href={href} target="_blank" rel="noopener noreferrer" className={LINK}>
            {label}
          </a>
        );
      }
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex === 0) return text;
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

function categoryIcon(category?: ReleaseHighlight['category']) {
  switch (category) {
    case 'feature':
      return <SparklesIcon size={12} />;
    case 'improvement':
      return <ArrowUpIcon size={12} />;
    case 'fix':
      return <BugIcon size={12} />;
    default:
      return <CheckIcon size={12} />;
  }
}

function dotClass(index: number, current: number): string {
  if (index === current) return 'w-6 bg-accent';
  return index < current ? 'w-1.5 bg-accent/40' : 'w-1.5 bg-ink-faint/30';
}

interface ReleaseCardProps {
  release: ReleaseEntry;
  step: number;
  count: number;
  direction: 'left' | 'right';
  isAnimating: boolean;
  onGoTo: (step: number) => void;
  onClose: () => void;
}

/** One release of the What's New carousel: media and title on the left, highlights on the right. */
export default function ReleaseCard({ release, step, count, direction, isAnimating, onGoTo, onClose }: ReleaseCardProps) {
  const appIcon = useAppIcon();
  const [gifLoaded, setGifLoaded] = useState<Record<number, boolean>>({});
  const [gifError, setGifError] = useState<Record<number, boolean>>({});

  const slideStyle: CSSProperties = {
    ...(isAnimating
      ? { transform: `translateX(${direction === 'right' ? '-40px' : '40px'})`, opacity: 0 }
      : { transform: 'translateX(0)', opacity: 1 }),
    transition: 'transform 200ms ease-out, opacity 200ms ease-out',
  };

  return (
    <div className="flex h-[480px]">
      {/* Left panel: media and title */}
      <div className="flex w-[55%] shrink-0 flex-col px-8 pb-8">
        <div className="flex flex-1 flex-col justify-center" style={slideStyle}>
          {release.hasMedia && !gifError[step] && (
            <div className="relative mb-5 aspect-video w-full shrink-0 overflow-hidden rounded-lg border border-card-border bg-well">
              {!gifLoaded[step] && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <Spinner size={24} className="text-link" />
                </div>
              )}
              <img
                key={release.version}
                src={getMediaUrl(release.version)}
                alt={`${release.title} demo`}
                className={cx('h-full w-full object-cover transition-opacity duration-300', gifLoaded[step] ? 'opacity-100' : 'opacity-0')}
                onLoad={() => setGifLoaded((prev) => ({ ...prev, [step]: true }))}
                onError={() => setGifError((prev) => ({ ...prev, [step]: true }))}
              />
            </div>
          )}

          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-info-bg text-info">
              <RocketIcon size={20} />
            </div>
            <div className="min-w-0">
              <h3 className="text-title leading-tight text-ink">{release.title}</h3>
              <p className="mt-1 text-body leading-relaxed text-ink-muted">{release.summary}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="my-8 w-px bg-divider" />

      {/* Right panel: highlights */}
      <div className="flex min-h-0 flex-1 flex-col px-8 pb-8">
        <div className="flex min-h-0 flex-1 flex-col" style={slideStyle}>
          <div className="mb-4 flex shrink-0 items-center gap-2 pt-2">
            <img src={appIcon} alt="Conduit" className="h-7 w-7 rounded-md" />
            <span className="text-meta font-semibold text-ink-muted">v{release.version}</span>
            {release.date && <span className="text-label text-ink-faint">&middot; {release.date}</span>}
          </div>

          <ul className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
            {release.highlights.map((h, i) => (
              <li key={i} className="flex items-start gap-2.5">
                <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-info-bg text-info">
                  {categoryIcon(h.category)}
                </div>
                <span className="text-body leading-relaxed text-ink-secondary">{renderHighlightText(h.text)}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="shrink-0 pt-5">
          {count > 1 && (
            <div className="mb-5 flex items-center gap-1.5">
              {Array.from({ length: count }, (_, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => onGoTo(i)}
                  className={cx('h-1.5 rounded-full transition-all duration-300', dotClass(i, step))}
                />
              ))}
            </div>
          )}

          <div className="flex justify-end">
            <Button variant="primary" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
