import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import CandidateMergeDialog from "../CandidateMergeDialog";
import type { CandidatePreview, CandidatePreviewRow } from "../../../types/sync";

const invoke = vi.fn<(channel: string, args?: unknown) => Promise<unknown>>();

function preview(kind: CandidatePreview["kind"], extra: Partial<CandidatePreview> = {}): CandidatePreview {
  return {
    id: "c1",
    kind,
    source: "copy",
    label: "Vault 2.conduit",
    changedFields: [],
    onlyInCopy: [],
    missingFromCopy: [],
    deletions: [],
    needsReview: true,
    ...extra,
  };
}

function showing(p: CandidatePreview): void {
  invoke.mockImplementation(async (channel) => (channel === "sync_candidate_preview" ? p : null));
  render(<CandidateMergeDialog candidateId="c1" confirmSideFilesAfter={false} />);
}

beforeEach(() => {
  window.electron = { platform: "darwin", invoke, send: vi.fn(), on: vi.fn(() => () => {}), removeListener: vi.fn() };
});

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

describe("CandidateMergeDialog (spec 4.9)", () => {
  it("says a copy's own deletions and edits are applied by Merge, not reviewed afterwards", async () => {
    const rows: CandidatePreviewRow[] = [1, 2, 3].map((i) => ({ row: { tbl: 1, rowId: `e${i}` }, title: `server ${i}` }));
    showing(preview("replica", { deletions: rows }));
    expect(await screen.findByText("Deleted in this copy (merging deletes them unless your vault changed them since) (3)")).toBeInTheDocument();
    expect(screen.getByText("Merging applies the changes in this copy. Where your vault changed the same item since, you review both versions.")).toBeInTheDocument();
    expect(screen.queryByText(/you review them after merging/)).toBeNull();
    expect(screen.queryByText(/Merging keeps both sides/)).toBeNull();
  });

  it("keeps the review wording for a copy without sync history, whose differences all become review items", async () => {
    showing(preview("synthetic", { missingFromCopy: [{ row: { tbl: 1, rowId: "e9" }, title: "server 9" }] }));
    expect(await screen.findByText("Merging keeps both sides. Values that differ become changes you review, so nothing is lost.")).toBeInTheDocument();
    expect(screen.getByText("Missing from this copy (1)")).toBeInTheDocument();
    expect(screen.getByText("Delete the missing items from the vault too")).toBeInTheDocument();
  });
});
