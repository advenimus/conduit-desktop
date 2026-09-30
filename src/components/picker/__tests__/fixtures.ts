import { vi } from "vitest";
import type { CredentialDto, CredentialMeta } from "../../../types/credential";

export const META: CredentialMeta[] = [
  { id: "c1", name: "Domain Admin", username: "admin", domain: "ACME", tags: ["prod", "ad", "tier0", "extra"], credential_type: null, created_at: "" },
  { id: "c2", name: "Deploy Key", username: "deploy", domain: null, tags: [], credential_type: "ssh_key", created_at: "" },
  { id: "c3", name: "Lab Box", username: null, domain: null, tags: [], credential_type: null, created_at: "" },
];

export function dto(overrides: Partial<CredentialDto> = {}): CredentialDto {
  return {
    id: "c1",
    name: "Domain Admin",
    username: "admin",
    password: "hunter2",
    domain: "ACME",
    private_key: null,
    totp_secret: null,
    tags: [],
    credential_type: null,
    public_key: null,
    fingerprint: null,
    totp_issuer: null,
    totp_label: null,
    totp_algorithm: null,
    totp_digits: null,
    totp_period: null,
    ssh_auth_method: null,
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

export type Invoke = (channel: string, args?: unknown) => Promise<unknown>;

/** Stubs window.electron with `invoke` and returns the mock. */
export function stubElectron(handler: Invoke) {
  const invoke = vi.fn<Invoke>(handler);
  vi.stubGlobal("electron", { platform: "darwin", invoke, send: vi.fn(), on: vi.fn(() => () => {}), removeListener: vi.fn() });
  return invoke;
}

/** Every icon the element draws, as markup. */
export function iconMarkup(root: ParentNode): string[] {
  return [...root.querySelectorAll("svg")].map((svg) => svg.outerHTML);
}

/** jsdom has no scrollIntoView; the list scrolls its keyboard selection into view. */
export function stubScrollIntoView() {
  Element.prototype.scrollIntoView = vi.fn();
}
