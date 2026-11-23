export function compactValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null) return undefined;
  if (Array.isArray(value)) {
    const items = value.map((item) => compactValue(item)).filter((item) => item !== undefined);
    return items;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      const next = compactValue(raw);
      if (next !== undefined) out[key] = next;
    }
    return out;
  }
  return value;
}

export function compactStringify(value: unknown): string {
  return JSON.stringify(compactValue(value));
}