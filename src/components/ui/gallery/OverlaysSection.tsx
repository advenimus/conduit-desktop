import { useRef, useState, type ReactNode } from "react";
import { Button, Callout, Dialog, FormField, Menu, MenuHeader, MenuItem, MenuSeparator, PasswordInput, Popover, TextInput, type DialogLayer, type DialogTone } from "..";
import { DialogBody, DialogContext, DialogFooter, DialogHeader } from "../DialogParts";
import { Demo, GallerySection } from "./Section";

/** The dialog's look without its behavior (no freeze, no focus trap), so the gallery stays usable. */
function DialogPreview({ title, tone, children, footer }: { title: string; tone?: DialogTone; children: ReactNode; footer: ReactNode }) {
  return (
    <DialogContext.Provider value={{ titleId: `preview-${title}`, title, tone, hideClose: false, onClose: () => {} }}>
      <div className="flex w-[400px] flex-col overflow-hidden rounded-lg border border-overlay-border bg-overlay text-ink shadow-modal">
        <DialogHeader />
        <DialogBody>{children}</DialogBody>
        <DialogFooter>{footer}</DialogFooter>
      </div>
    </DialogContext.Provider>
  );
}

function MenuPreview() {
  return (
    <div className="w-56 rounded-lg border border-overlay-border bg-overlay text-ink shadow-overlay">
      <Menu aria-label="Vault menu preview" autoFocus={false}>
        <MenuHeader>Vaults</MenuHeader>
        <MenuItem icon="lock" onSelect={() => {}}>
          Lock vault
        </MenuItem>
        <MenuItem icon="folderOpen" onSelect={() => {}} data-gallery-focus="">
          Open another vault
        </MenuItem>
        <MenuItem icon="plus" onSelect={() => {}}>
          Create a vault
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon="trash" danger onSelect={() => {}}>
          Delete
        </MenuItem>
        <MenuItem icon="ban" onSelect={() => {}} disabled>
          Disabled item
        </MenuItem>
      </Menu>
    </div>
  );
}

function LiveDialogs() {
  const [open, setOpen] = useState<null | "plain" | "form" | "stacked">(null);
  const [password, setPassword] = useState("");
  const close = () => setOpen(null);
  const layer: DialogLayer = open === "stacked" ? "stacked" : "base";
  return (
    <>
      <Button onClick={() => setOpen("plain")}>Open a dialog</Button>
      <Button onClick={() => setOpen("form")}>Open a form dialog</Button>
      <Button onClick={() => setOpen("stacked")}>Open a stacked dialog</Button>
      <Dialog
        open={open === "plain" || open === "stacked"}
        onClose={close}
        title={open === "stacked" ? "Delete forever?" : "About Conduit"}
        tone={open === "stacked" ? "danger" : undefined}
        layer={layer}
        size="sm"
        closeOnScrim
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant={open === "stacked" ? "danger" : "primary"} onClick={close}>
              {open === "stacked" ? "Delete" : "Done"}
            </Button>
          </>
        }
      >
        <p className="text-ink-muted">Escape, the Close button and a click on the scrim close this dialog. Tab stays inside it.</p>
      </Dialog>
      <Dialog
        open={open === "form"}
        onClose={close}
        title="Unlock vault"
        icon="lock"
        onSubmit={close}
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button type="submit" variant="primary">
              Unlock
            </Button>
          </>
        }
      >
        <FormField label="Master password">
          <PasswordInput autoFocus placeholder="Enter master password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </FormField>
        <Callout tone="danger">That password did not work.</Callout>
      </Dialog>
    </>
  );
}

function LivePopover() {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button ref={anchor} iconEnd="chevronDown" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        Open a menu
      </Button>
      <Popover anchorRef={anchor} open={open} onClose={() => setOpen(false)} padding={false}>
        <Menu aria-label="Live menu" onClose={() => setOpen(false)}>
          <MenuItem icon="pencil" onSelect={() => {}}>
            Rename
          </MenuItem>
          <MenuItem icon="copy" onSelect={() => {}}>
            Duplicate
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon="trash" danger onSelect={() => {}}>
            Delete
          </MenuItem>
        </Menu>
      </Popover>
    </>
  );
}

export function OverlaysSection() {
  return (
    <GallerySection id="overlays" title="Dialog, Popover and Menu">
      <Demo label="Dialog (static preview): plain, tone tiles" className="items-start">
        <DialogPreview title="Rename vault" footer={<><Button>Cancel</Button><Button variant="primary">Rename</Button></>}>
          <FormField label="Vault name">
            <TextInput placeholder="Enter new vault name" defaultValue="Work" />
          </FormField>
        </DialogPreview>
        <DialogPreview title="Take over this vault?" tone="warn" footer={<><Button>Not now</Button><Button variant="primary">Take over</Button></>}>
          <p className="text-ink-muted">Another device has this vault open.</p>
        </DialogPreview>
        <DialogPreview title="Delete forever?" tone="danger" footer={<><Button>Cancel</Button><Button variant="danger">Delete</Button></>}>
          <p className="text-ink-muted">This cannot be undone.</p>
        </DialogPreview>
      </Demo>
      <Demo label="Menu (static preview; the second item is focused)" className="items-start">
        <MenuPreview />
      </Demo>
      <Demo label="Live: dialogs (base and stacked layers, a form dialog) and a popover menu">
        <LiveDialogs />
        <LivePopover />
      </Demo>
    </GallerySection>
  );
}
