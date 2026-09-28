export declare const APPEARANCE_BOOT_MARKER: "<!-- conduit:appearance-boot -->";
/** Replaces the two JSON placeholders in boot-inline.js; throws when one is missing. */
export declare function renderBootScript(source: string, table: unknown, shellColors: unknown): string;
/** Reads boot-inline.js and its two JSON tables from `dir` (default: this directory) and inlines them. */
export declare function loadBootScript(dir?: string): string;
/** Replaces the marker with an inline <script>; throws when the marker is missing or repeated. */
export declare function injectBootScript(html: string, script: string, fileName: string): string;
