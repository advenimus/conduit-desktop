import { invoke } from "./electron";

let request: Promise<string> | null = null;

/** The running app version, read once per window. A failed read is tried again on the next call. */
export function getAppVersion(): Promise<string> {
  request ??= invoke<string>("app_get_version").catch((err: unknown) => {
    request = null;
    throw err;
  });
  return request;
}
