// crypto.randomUUID exists only in secure contexts; self-hosted dashboards are often served over plain HTTP on a tailnet.
export function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
