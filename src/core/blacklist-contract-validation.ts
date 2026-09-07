export function isContractRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasExactContractKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

export function contractCodePointLength(value: string): number {
  return Array.from(value).length;
}

export function contractJsonByteLength(value: unknown): number | null {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? contractTextByteLength(json) : null;
  } catch {
    return null;
  }
}

export function contractTextByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function valueOrNull<Value>(value: Value | undefined): Value | null {
  return value === undefined ? null : value;
}
