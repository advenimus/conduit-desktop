export interface SerializedToastAction {
  id: string;        // e.g. "toast-uuid:0" — for callback lookup
  label: string;
  variant?: 'primary' | 'default';
}

export interface SerializedToast {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  title: string;
  message?: string;
  actions?: SerializedToastAction[];
  persistent?: boolean;
  exiting?: boolean;
  progress?: { percent: number; leftLabel?: string; rightLabel?: string; speed?: string };
}

export interface UpdateState {
  state: 'downloading' | 'downloaded' | 'error';
  version: string;
  progress?: number;
  body?: string | null;
}

export interface OverlayState {
  toasts: SerializedToast[];
  update: UpdateState | null;
}
