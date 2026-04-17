Use the unified toast notification system for all user-facing notifications in Conduit.

## Rules

- **NEVER** create inline notification UI, custom alert components, or `window.alert()` calls
- **ALWAYS** import from `src/components/common/Toast.tsx`
- The `ToastContainer` is mounted in `App.tsx` via `NotificationStack` (bottom-right, fixed `w-sm`)
- The credential picker window has its own `ToastContainer` in `CredentialPickerApp.tsx`

## API Reference

```typescript
import { toast } from "./components/common/Toast";
// Types: ToastType, ToastAction, ToastOptions, ToastProgress are exported

// Basic — second param is optional message string
toast.success("Password copied");
toast.error("Connection failed", "Check your credentials");
toast.warning("Session disconnected");
toast.info("Processing complete");

// With action buttons — second param is ToastOptions object
toast.error("Entry limit reached", {
  message: "Upgrade your plan to add more connections",
  actions: [
    { label: "Upgrade", variant: "primary", onClick: () => openPricing() },
    { label: "Dismiss", variant: "default", onClick: () => {} },
  ],
});

// Persistent (no auto-dismiss, user must close or call dismiss)
const id = toast.info("Uploading...", { persistent: true });

// Programmatic dismiss
toast.dismiss(id);

// Update an existing toast in-place (does NOT reset auto-dismiss timer)
toast.update(id, {
  title: "Almost done...",
  message: "Processing final batch",
  progress: { percent: 90, leftLabel: "Step 3/3", rightLabel: "900 KB / 1 MB" },
});

// Custom duration (default is 5000ms)
toast.success("Saved", { duration: 3000 });

// Dismiss on action click (default: true)
toast.info("New version available", {
  actions: [{ label: "Details", variant: "primary", onClick: showChangelog }],
  dismissOnAction: false, // keep toast visible after clicking
});

// With progress bar
const progressId = toast.info("Downloading files", {
  persistent: true,
  progress: {
    percent: 0,
    leftLabel: "File 1/3 — Downloading",
    rightLabel: "0 B / 12.5 MB",
  },
});

// Update progress
toast.update(progressId, {
  progress: {
    percent: 45,
    leftLabel: "File 1/3 — Downloading",
    rightLabel: "5.6 MB / 12.5 MB",
    speed: "2.1 MB/s",
  },
});

// Complete — dismiss progress toast, show success
toast.dismiss(progressId);
toast.success("Files downloaded", "3 files copied to clipboard");
```

## ToastOptions Interface

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `message` | `string` | — | Subtitle text below title |
| `actions` | `ToastAction[]` | — | Buttons rendered below message |
| `persistent` | `boolean` | `false` | Disable auto-dismiss |
| `duration` | `number` | `5000` | Auto-dismiss delay in ms |
| `dismissOnAction` | `boolean` | `true` | Auto-dismiss when action clicked |
| `progress` | `ToastProgress` | — | Progress bar with labels (see below) |

## ToastProgress Interface

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `percent` | `number` | — | 0-100, controls bar width |
| `leftLabel` | `string` | — | Left-aligned label (e.g. "File 1/3 — Downloading") |
| `rightLabel` | `string` | — | Right-aligned label (e.g. "5.6 MB / 12.5 MB") |
| `speed` | `string` | — | Appended after rightLabel (e.g. "2.1 MB/s") |

Progress labels use `tabular-nums` for stable digit widths.

## ToastAction Interface

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `label` | `string` | — | Button text |
| `onClick` | `() => void` | — | Click handler |
| `variant` | `"primary" \| "default"` | `"default"` | `primary` = accent bg, `default` = raised bg |

## toast.update()

`toast.update(id, partial)` updates an existing toast in-place. Accepts partial fields: `title`, `message`, `progress`, `actions`. Does **not** reset auto-dismiss timers — persistent toasts stay persistent. If `id` doesn't exist, it's a no-op.

## Visual Design

- Fixed width `w-sm` (384px) container — toasts never resize
- Solid `bg-panel` background (theme-aware, opaque — never transparent)
- `border-l-4` colored accent: green (success), red (error), yellow (warning), conduit (info)
- Icon per type: CheckCircle, XCircle, AlertCircle, InfoCircle
- Text: `text-ink` title, `text-ink-secondary` message
- Progress bar: `h-1.5 bg-conduit-500 rounded-full` with smooth `transition-[width]`
- Max 5 visible; oldest non-persistent auto-dismissed on overflow
- Entry animation: `animate-toast-in` (200ms); exit: `animate-toast-out` (200ms)

## Shared Utilities

- `formatFileSize(bytes)` from `src/lib/format.ts` — formats bytes as "1.2 MB", "456 KB", etc.

## Key Files

- `src/components/common/Toast.tsx` — Component + API + types
- `src/lib/format.ts` — `formatFileSize` utility
- `src/index.css` — Animation keyframes (`toast-in`, `toast-out`)
- `src/App.tsx` — `NotificationStack` wrapper (bottom-right container)
- `src/components/picker/CredentialPickerApp.tsx` — Picker window toast mount
