/** Strip URLs and long base58 blobs before anything is written to logs. */
export function redact(s: unknown): string {
  return String(s ?? "")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/[1-9A-HJ-NP-Za-km-z]{80,}/g, "[redacted]")
    .slice(0, 400);
}
