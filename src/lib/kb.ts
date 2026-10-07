// The contract rules live once, in the main-process folder, so desktop has a single copy to keep in
// step with iOS (docs/KNOWLEDGE_BASE.md). They are pure and safe to bundle into the renderer.
export * from "../../electron/services/knowledge/kb-model";
export * from "../../electron/services/knowledge/kb-inherit";
export * from "../../electron/services/knowledge/kb-revisions";
export * from "../../electron/services/knowledge/notes-split";
export * from "../../electron/services/knowledge/changelog";
export * from "../../electron/services/secrets/secret-refs";
export { countPlaintextSecrets, hasPlaintextSecrets } from "../../electron/services/secrets/secret-convert-plan";
