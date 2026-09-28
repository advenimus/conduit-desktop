import { Button, IconButton, type ButtonVariant } from "..";
import { Demo, GallerySection } from "./Section";

const VARIANTS: ReadonlyArray<ButtonVariant> = ["primary", "secondary", "ghost", "danger", "link"];

export function ButtonsSection() {
  return (
    <GallerySection id="buttons" title="Button and IconButton">
      {VARIANTS.map((variant) => (
        <Demo key={variant} label={`Button ${variant}: rest, hover, active, focus, disabled, loading`}>
          <Button variant={variant}>Rest</Button>
          <Button variant={variant} data-gallery-hover="">
            Hover
          </Button>
          <Button variant={variant} data-gallery-hover="" data-gallery-active="">
            Active
          </Button>
          <Button variant={variant} data-gallery-focus="">
            Focus
          </Button>
          <Button variant={variant} disabled>
            Disabled
          </Button>
          <Button variant={variant} loading loadingLabel="Opening...">
            Open
          </Button>
          <Button variant={variant} icon="plus">
            With icon
          </Button>
        </Demo>
      ))}
      <Demo label="Button sizes: sm 22px, md 26px, lg 32px, full width">
        <Button size="sm" variant="primary" icon="check">
          Small
        </Button>
        <Button variant="primary" icon="check">
          Medium
        </Button>
        <Button size="lg" variant="primary" icon="check">
          Large
        </Button>
        <Button size="sm" icon="refresh" iconEnd="chevronDown">
          Icon end
        </Button>
        <div className="w-60">
          <Button fullWidth variant="secondary">
            Full width
          </Button>
        </div>
      </Demo>
      <Demo label="IconButton sm 20, md 22, lg 28: rest, hover, pressed, pressed without look, danger, focus, disabled">
        {(["sm", "md", "lg"] as const).map((size) => (
          <div key={size} className="flex items-center gap-2">
            <IconButton size={size} icon="settings" label={`Settings ${size}`} />
            <IconButton size={size} icon="settings" label={`Hover ${size}`} data-gallery-hover="" />
            <IconButton size={size} icon="pin" label={`Pressed ${size}`} pressed />
            <IconButton size={size} icon="panelLeft" label={`Glyph swap ${size}`} pressed pressedLook={false} />
            <IconButton size={size} icon="trash" label={`Delete ${size}`} tone="danger" data-gallery-hover="" />
            <IconButton size={size} icon="close" label={`Focus ${size}`} data-gallery-focus="" />
            <IconButton size={size} icon="plus" label={`New ${size}`} disabled disabledReason="View-only access" />
          </div>
        ))}
      </Demo>
    </GallerySection>
  );
}
