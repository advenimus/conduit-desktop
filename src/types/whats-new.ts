export interface ReleaseHighlight {
  text: string;
  category?: 'feature' | 'improvement' | 'fix';
}

export interface ReleaseEntry {
  version: string;           // "0.9.7"
  date: string;              // "2026-03-19"
  title: string;             // "Dynamic RDP Resize"
  summary: string;           // One-line for the version list sidebar
  highlights: ReleaseHighlight[];  // 3-6 bullet points
  hasMedia: boolean;         // Whether demo.gif exists
}

export interface ReleaseNotesManifest {
  schema_version: 1;
  releases: ReleaseEntry[];  // Newest first
}
