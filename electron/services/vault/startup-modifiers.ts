/**
 * The escape hatch of docs/AUTO_UNLOCK.md 4.5: Shift (or Option on a Mac) held as Conduit starts,
 * or the --no-startup-vault switch, sends this start to the Vault Hub. Only a key held in the first
 * moments counts: one macOS probe at whenReady, then key events for 1.5 s after the window shows,
 * stopped early once a text field or the sign-in screen has focus.
 */

export const SKIP_SWITCH = 'no-startup-vault';
export const MODIFIER_WINDOW_MS = 1_500;
export const PROBE_TIMEOUT_MS = 1_500;

const SHIFT_FLAG = 0x20000;
const OPTION_FLAG = 0x80000;
const PROBE_SCRIPT = 'ObjC.import("AppKit"); $.NSEvent.modifierFlags';
const LOG = '[startup-vault]';

export type ProbeRunner = (command: string, args: readonly string[], timeoutMs: number) => Promise<string>;

export interface KeyInput {
  readonly type: string;
  readonly shift: boolean;
  readonly alt: boolean;
}

/** NSEvent.modifierFlags as osascript prints it: Shift, or Option on macOS. */
export function modifierFlagsHeld(stdout: string): boolean {
  const flags = Number.parseInt(stdout.trim(), 10);
  if (!Number.isFinite(flags) || flags < 0) return false;
  return (flags & SHIFT_FLAG) !== 0 || (flags & OPTION_FLAG) !== 0;
}

/** The one macOS probe; a timeout or any error means "not held". */
export async function probeMacModifiers(run: ProbeRunner): Promise<boolean> {
  try {
    return modifierFlagsHeld(await run('osascript', ['-l', 'JavaScript', '-e', PROBE_SCRIPT], PROBE_TIMEOUT_MS));
  } catch (err) {
    console.warn(`${LOG} modifier probe failed; treating it as not held`, { name: err instanceof Error ? err.name : 'Error' });
    return false;
  }
}

export class StartupSkip {
  private probeHeld = false;
  private seen = false;
  private windowStart: number | null = null;
  private stopped = false;

  constructor(
    private readonly platform: NodeJS.Platform,
    private readonly switchSet: boolean,
  ) {}

  setProbeResult(held: boolean): void {
    this.probeHeld = held;
  }

  /** The window shows (first time, or again after a re-arm): key events count for 1.5 s. */
  startCollector(now: number): void {
    this.windowStart = now;
    this.stopped = false;
  }

  /** A re-armed start begins with a clean slate; the switch belongs to the launch and stays. */
  rearm(now: number): void {
    this.probeHeld = false;
    this.seen = false;
    this.startCollector(now);
  }

  isCollecting(now: number): boolean {
    return this.windowStart !== null && !this.stopped && now - this.windowStart < MODIFIER_WINDOW_MS;
  }

  /** Milliseconds left in the collector window, 0 when it is closed. */
  remainingMs(now: number): number {
    if (!this.isCollecting(now) || this.windowStart === null) return 0;
    return MODIFIER_WINDOW_MS - (now - this.windowStart);
  }

  /** True when the event fell inside the collector window (it may or may not have counted). */
  noteInput(input: KeyInput, now: number): boolean {
    if (!this.isCollecting(now)) return false;
    if (input.shift || (this.platform === 'darwin' && input.alt)) this.seen = true;
    return true;
  }

  /** A text field or the sign-in screen has focus: Shift from now on is typing. */
  noteInputFocus(): void {
    this.stopped = true;
  }

  isSkipRequested(): boolean {
    return this.switchSet || this.probeHeld || this.seen;
  }
}
