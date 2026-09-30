/**
 * A snapshot's diff.json moved to a new key epoch (spec 4.8 and 5.10, after a password change
 * on this device): every secret value a ring key opens is re-encrypted under the ring's current
 * epoch, so the old password no longer opens it and undo keeps working. Values no ring key
 * opens stay as they are (undo skips them either way). Pure; import through snapshots.ts.
 */

import { asBlob, registerDef } from './catalog.js';
import { encryptSecret, readSecret } from './key-epoch.js';
import { decodeValue, encodeValue, type EncodedValue } from './value-codec.js';
import type { SnapshotFile } from './snapshots-codec.js';
import type { ChangedFieldRecord, DeletedRowRecord } from './snapshots-types.js';
import type { KeyRing } from './types.js';

export interface RekeyedSnapshotFile {
  readonly file: SnapshotFile;
  /** Secret values moved to the current epoch. */
  readonly reencrypted: number;
  /** Secret values no ring key opens, left as they were. */
  readonly unreadable: number;
}

class SecretMover {
  reencrypted = 0;
  unreadable = 0;

  constructor(
    private readonly ring: KeyRing,
    private readonly randomBytes: (n: number) => Buffer,
  ) {}

  move(enc: EncodedValue): EncodedValue {
    const ct = asBlob(decodeValue(enc));
    if (ct === null) return enc;
    const read = readSecret(ct, this.ring);
    if (read.kind === 'current') return enc;
    if (read.kind === 'undecryptable') {
      this.unreadable++;
      return enc;
    }
    this.reencrypted++;
    return encodeValue(encryptSecret(read.plaintext, this.ring.current, this.randomBytes));
  }

  deleted(r: DeletedRowRecord): DeletedRowRecord {
    const values = Object.entries(r.values).map(([reg, enc]) => {
      const secret = registerDef({ tbl: r.row.tbl, rowId: r.row.rowId, reg })?.secret === true;
      return [reg, secret ? this.move(enc) : enc] as const;
    });
    return { ...r, values: Object.fromEntries(values) };
  }

  changed(c: ChangedFieldRecord): ChangedFieldRecord {
    return c.secret ? { ...c, before: this.move(c.before), after: this.move(c.after) } : c;
  }
}

export function rekeySnapshotFile(file: SnapshotFile, ring: KeyRing, randomBytes: (n: number) => Buffer): RekeyedSnapshotFile {
  const mover = new SecretMover(ring, randomBytes);
  const diff = { ...file.diff, deleted: file.diff.deleted.map((r) => mover.deleted(r)), changed: file.diff.changed.map((c) => mover.changed(c)) };
  return {
    file: { meta: { ...file.meta, epochId: ring.current.epochId }, diff },
    reencrypted: mover.reencrypted,
    unreadable: mover.unreadable,
  };
}
