// Checks for unparsed JSON: request bodies and the files the server saves.

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- a JSON object's fields are unknown until checked
export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return Number.isFinite(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
