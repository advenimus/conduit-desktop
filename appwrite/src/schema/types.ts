export type ColumnType =
  | 'uuid'
  | 'varchar'
  | 'text'
  | 'longtext'
  | 'int'
  | 'bigint'
  | 'float'
  | 'bool'
  | 'datetime'
  | 'json'
  | 'text[]';

export type ColumnDefault =
  | { kind: 'uuid' }
  | { kind: 'now'; plusSeconds?: number }
  | { kind: 'value'; value: unknown };

export interface ColumnSpec {
  type: ColumnType;
  /** Max characters for varchar columns (indexable). */
  size?: number;
  nullable: boolean;
  default?: ColumnDefault;
  /** Allowed values, the old CHECK (col = ANY (...)). */
  oneOf?: readonly string[];
  /** Max characters, the old CHECK (char_length(col) <= n). */
  maxLength?: number;
  minLength?: number;
  /** Max serialized bytes for json columns. */
  maxJsonBytes?: number;
}

export type OnDelete = 'cascade' | 'set null' | 'restrict';

export interface ForeignKey {
  column: string;
  /** 'users' means the Appwrite user (was auth.users). */
  references: string;
  onDelete: OnDelete;
}

export interface TableSpec {
  name: string;
  /** Primary key columns. A single key column is stored as the row's $id. */
  primaryKey: readonly string[];
  columns: Record<string, ColumnSpec>;
  unique?: readonly (readonly string[])[];
  indexes?: readonly (readonly string[])[];
  foreignKeys?: readonly ForeignKey[];
  /** Embeddable to-one relations: alias name to [local column, target table]. */
  embeds?: Record<string, { column: string; table: string }>;
  /** Who gets Appwrite read permission on each row, for Realtime. */
  realtime?: 'vault' | 'owner';
  realtimeColumn?: string;
}
