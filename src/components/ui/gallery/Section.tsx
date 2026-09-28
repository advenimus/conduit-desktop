import type { ReactNode } from "react";
import { cx } from "../cx";

export function GallerySection({ id, title, children, className }: { id: string; title: string; children: ReactNode; className?: string }) {
  return (
    <section id={id} data-gallery-section={id} className={cx("flex flex-col gap-4 overflow-hidden rounded-lg border border-card-border bg-editor p-4", className)}>
      <h2 className="text-title font-semibold text-ink">{title}</h2>
      {children}
    </section>
  );
}

export function Demo({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-meta font-semibold text-ink-muted">{label}</p>
      <div className={cx("flex flex-wrap items-center gap-3", className)}>{children}</div>
    </div>
  );
}
