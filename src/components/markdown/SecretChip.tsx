import { useEffect, useRef, useState } from "react";
import { useEntryStore } from "../../stores/entryStore";
import { toast } from "../common/Toast";
import { errorText } from "../../lib/errorText";
import { CopyIcon, EyeIcon, EyeOffIcon, KeyboardIcon, LockIcon } from "../../lib/icons";
import { getTypeableActiveSession, globalTypeText, typeIntoActiveSession } from "../../utils/autotype";
import { readChipValue, type ChipRef } from "./secretValue";

const AUTO_HIDE_MS = 30_000;

interface SecretChipProps extends ChipRef {
  label: string | null;
}

const ICON_BUTTON =
  "inline-flex items-center p-0 border-0 bg-transparent text-ink-muted hover:text-ink cursor-pointer";

/** An encrypted secret in notes or an article: shows its name, reveals, copies or types the value. */
export default function SecretChip({ kind, id, field, pending, label }: SecretChipProps) {
  const target = useEntryStore((s) => s.hiddenEntries.find((e) => e.id === id) ?? s.entries.find((e) => e.id === id));
  const hiddenEntries = useEntryStore((s) => s.hiddenEntries);
  const [value, setValue] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const name = target?.name ?? label ?? "Secret";
  const suffix = pending ? " (new)" : field && field !== "password" ? ` ${field}` : "";
  const missing = !target;
  const ref: ChipRef = { kind, id, field, pending };

  const read = async (): Promise<string | null> => {
    try {
      return await readChipValue(ref, hiddenEntries);
    } catch (err) {
      toast.error(errorText(err, "Couldn't read this secret"));
      return null;
    }
  };

  const toggle = async () => {
    if (value !== null) {
      setValue(null);
      return;
    }
    const v = await read();
    if (v === null) return;
    setValue(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setValue(null), AUTO_HIDE_MS);
  };

  const copy = async () => {
    const v = value ?? (await read());
    if (v === null) return;
    try {
      await navigator.clipboard.writeText(v);
      toast.success(`${name} copied`);
    } catch {
      toast.error("Couldn't copy the secret");
    }
  };

  const type = async () => {
    const v = await read();
    if (v === null) return;
    const inSession = !!getTypeableActiveSession();
    toast.info(inSession ? "Typing in 2s — click the target field now" : "Typing in 3s — switch to the target app now");
    try {
      await (inSession ? typeIntoActiveSession(v) : globalTypeText(v));
      toast.success(`${name} typed`);
    } catch (err) {
      toast.error(errorText(err, "Couldn't type the secret"));
    }
  };

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-1.5 align-baseline text-label ${
        missing ? "border-danger text-danger" : "border-card-border bg-well text-ink"
      }`}
      data-cv-secret-chip={id}
      title={missing ? "This secret is not in the vault any more" : undefined}
    >
      <LockIcon size={12} className="text-ink-muted" />
      {value !== null ? (
        <span className="font-mono allow-select">{value}</span>
      ) : (
        <span>
          {name}
          {suffix}
        </span>
      )}
      {!missing && (
        <>
          <button type="button" className={ICON_BUTTON} onClick={toggle} title={value !== null ? "Hide" : "Reveal"} aria-label={value !== null ? `Hide ${name}` : `Reveal ${name}`}>
            {value !== null ? <EyeOffIcon size={12} /> : <EyeIcon size={12} />}
          </button>
          <button type="button" className={ICON_BUTTON} onClick={copy} title="Copy" aria-label={`Copy ${name}`}>
            <CopyIcon size={12} />
          </button>
          <button type="button" className={ICON_BUTTON} onClick={type} title="Type into the active session" aria-label={`Type ${name}`}>
            <KeyboardIcon size={12} />
          </button>
        </>
      )}
    </span>
  );
}
