import { useState } from "react";
import { IconButton, ListRow, TreeRow } from "..";
import { DesktopIcon, TerminalIcon } from "../../../lib/icons";
import { Demo, GallerySection } from "./Section";

export function RowsSection() {
  const [selected, setSelected] = useState("work");
  const [open, setOpen] = useState(true);
  return (
    <GallerySection id="rows" title="ListRow and TreeRow">
      <Demo label="ListRow: clickable, selected, unfocused selection, two lines, hover, trailing actions" className="block">
        <div role="listbox" aria-label="Recent vaults" className="flex w-80 flex-col gap-px rounded border border-card-border bg-sidebar p-1">
          {["work", "home", "lab"].map((id) => (
            <ListRow
              key={id}
              role="option"
              selected={selected === id}
              onClick={() => setSelected(id)}
              title={`/Users/me/${id}.conduit`}
              leading="folderOpen"
              description={`/Users/me/${id}.conduit`}
              trailing={<IconButton size="sm" icon="close" label={`Remove ${id}`} />}
            >
              {id[0].toUpperCase() + id.slice(1)}
            </ListRow>
          ))}
          <ListRow leading="key" onClick={() => {}} description="admin · ACME" detail={<span className="flex gap-1">#prod #windows</span>}>
            With a detail line
          </ListRow>
          <ListRow selected inactive leading="database">
            Selected, list not focused
          </ListRow>
          <ListRow leading="globe" data-gallery-hover="">
            Hovered row
          </ListRow>
          <ListRow leading="key" onClick={() => {}} disabled>
            Disabled row
          </ListRow>
        </div>
      </Demo>
      <Demo label="TreeRow: twisties, leaf slot, 12px indent, selected, trailing actions on focus" className="block">
        <div role="tree" aria-label="Entries" className="flex w-80 flex-col rounded border border-card-border bg-sidebar px-1 py-1">
          <TreeRow depth={0} expanded={open} onToggle={() => setOpen((o) => !o)} leading="folder" tabIndex={0}>
            Servers
          </TreeRow>
          {open && (
            <>
              <TreeRow depth={1} leading={<TerminalIcon size={16} className="text-entry-ssh" />} selected trailing={<IconButton size="sm" icon="ellipsis" label="More" />}>
                web-01
              </TreeRow>
              <TreeRow depth={1} expanded={false} leading="folder">
                Databases
              </TreeRow>
              <TreeRow depth={1} leading={<DesktopIcon size={16} className="text-entry-rdp" />} tabIndex={-1} data-gallery-focus="">
                Focused row
              </TreeRow>
            </>
          )}
        </div>
      </Demo>
    </GallerySection>
  );
}
