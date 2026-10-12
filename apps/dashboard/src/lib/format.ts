export function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function percent(value: number, digits = 0): string {
  return `${(value * 100).toFixed(digits)}%`;
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour12: false, timeZone: "UTC" });
}
