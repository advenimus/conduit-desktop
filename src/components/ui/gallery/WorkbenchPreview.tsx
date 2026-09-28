import { IconButton, TreeRow } from "..";
import { GlobeIcon, TerminalIcon } from "../../../lib/icons";

/** A small workbench so the density switch shows its gaps, radii and card borders (spec 2.9, 3.3). */
export function WorkbenchPreview() {
  return (
    <section id="workbench" data-gallery-section="workbench" className="flex h-64 flex-col overflow-hidden rounded-lg border border-card-border bg-shell">
      <div className="flex h-titlebar shrink-0 items-center justify-center text-label text-(--c-titlebar-fg)">Title bar</div>
      <div className="cv-workbench">
        <div className="cv-card flex w-60 shrink-0" data-cv-card="left">
          <div className="flex w-activitybar shrink-0 flex-col items-center gap-2 py-1">
            <IconButton size="lg" icon="explorer" label="Vault" pressed />
            <IconButton size="lg" icon="star" label="Favorites" />
            <IconButton size="lg" icon="home" label="Home" />
          </div>
          <div role="tree" aria-label="Preview entries" className="flex min-w-0 flex-1 flex-col py-1 pr-1">
            <TreeRow depth={0} expanded leading="folder">
              Servers
            </TreeRow>
            <TreeRow depth={1} leading={<TerminalIcon size={16} className="text-entry-ssh" />} selected>
              web-01
            </TreeRow>
            <TreeRow depth={1} leading={<GlobeIcon size={16} className="text-entry-web" />}>
              Router admin
            </TreeRow>
          </div>
        </div>
        <div className="cv-card flex min-w-0 flex-1 flex-col">
          <div className="cv-tabstrip">
            <div className="cv-tabs" role="tablist" aria-label="Preview sessions">
              <div className="cv-tab" role="tab" aria-selected="true" tabIndex={0}>
                <span className="cv-tab-fill" />
                <span className="cv-tab-icon">
                  <TerminalIcon size={16} className="text-entry-ssh" />
                </span>
                <span className="cv-tab-label">web-01</span>
                <span className="cv-tab-actions">
                  <IconButton size="sm" icon="close" label="Close web-01" tabIndex={-1} />
                </span>
              </div>
              <div className="cv-tab" role="tab" aria-selected="false" tabIndex={-1}>
                <span className="cv-tab-fill" />
                <span className="cv-tab-icon">
                  <GlobeIcon size={16} className="text-entry-web" />
                </span>
                <span className="cv-tab-label">Router admin</span>
                <span className="cv-tab-actions">
                  <IconButton size="sm" icon="close" label="Close Router admin" tabIndex={-1} />
                </span>
              </div>
            </div>
          </div>
          <div className="flex-1 bg-editor p-3 font-mono text-label text-ink-secondary">$ ssh admin@web-01</div>
        </div>
        <div className="cv-card w-48 shrink-0 p-2 text-label text-ink-muted" data-cv-card="aux">
          AI chat
        </div>
      </div>
      <div className="flex h-statusbar shrink-0 items-center px-1.5 text-label text-(--c-statusbar-fg)">Status bar</div>
    </section>
  );
}
