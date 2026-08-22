import { pruneMapToMaxSize } from "../infra/map-size.js";
import { escapeRegExp } from "../shared/regexp.js";

const MIN_SECRET_VALUE_LENGTH = 6;
const MAX_SECRET_VALUES = 512;

const registeredValues = new Map<string, true>();
// Process-lifetime credentials registered at bootstrap (audit identity key,
// edge-auth headers, provider client secrets) must not be evictable by
// ephemeral per-transfer tokens, so they live outside the bounded registry.
const pinnedValues = new Map<string, true>();
let compiledMatcher: RegExp | undefined;
let firstChars = new Set<string>();

function rebuildProbe(): void {
  firstChars = new Set(
    [...pinnedValues.keys(), ...registeredValues.keys()].map((value) => value.charAt(0)),
  );
  compiledMatcher = undefined;
}

function registerOneSecretValue(value: string): void {
  if (registeredValues.delete(value)) {
    registeredValues.set(value, true);
    return;
  }
  registeredValues.set(value, true);
  pruneMapToMaxSize(registeredValues, MAX_SECRET_VALUES);
  rebuildProbe();
}

function registerOnePinnedSecretValue(value: string): void {
  // Keep one canonical home so matcher alternation never carries duplicates.
  registeredValues.delete(value);
  if (pinnedValues.has(value)) {
    return;
  }
  pinnedValues.set(value, true);
  rebuildProbe();
}

/** Registers one resolved secret for exact-value log redaction. */
export function registerSecretValueForRedaction(value: string): void {
  if (value.length < MIN_SECRET_VALUE_LENGTH) {
    return;
  }
  // URL egress percent-encodes injected values; redact that surface form too.
  const encoded = encodeURIComponent(value);
  if (encoded !== value) {
    registerOneSecretValue(encoded);
  }
  // Captured structured payloads are serialized before persistence, so retain
  // the JSON string-content form for credentials with escaped characters.
  const jsonEscaped = JSON.stringify(value).slice(1, -1);
  if (jsonEscaped !== value) {
    registerOneSecretValue(jsonEscaped);
  }
  // Keep the raw value newest so bounded-registry eviction cannot drop the
  // active credential while retaining only a transformed representation.
  registerOneSecretValue(value);
}

/**
 * Registers a process-lifetime credential for exact-value log redaction.
 * Pinned values are exempt from bounded-registry eviction, so bootstrap
 * secrets (audit identity key, edge-auth headers, provider client secrets)
 * stay redacted even after many ephemeral token registrations.
 */
export function registerPinnedSecretValueForRedaction(value: string): void {
  if (value.length < MIN_SECRET_VALUE_LENGTH) {
    return;
  }
  const encoded = encodeURIComponent(value);
  if (encoded !== value) {
    registerOnePinnedSecretValue(encoded);
  }
  const jsonEscaped = JSON.stringify(value).slice(1, -1);
  if (jsonEscaped !== value) {
    registerOnePinnedSecretValue(jsonEscaped);
  }
  registerOnePinnedSecretValue(value);
}

/** Returns whether a value has SecretRef provenance in the process registry. */
export function isSecretValueRegisteredForRedaction(value: string): boolean {
  return pinnedValues.has(value) || registeredValues.has(value);
}

export function hasRegisteredSecretValuesForRedaction(): boolean {
  return pinnedValues.size > 0 || registeredValues.size > 0;
}

/** Replaces registered exact values while preserving the caller's mask convention. */
export function redactRegisteredSecretValues(
  text: string,
  mask: (value: string) => string,
): string {
  if (!text || (pinnedValues.size === 0 && registeredValues.size === 0)) {
    return text;
  }
  let couldMatch = false;
  for (const firstChar of firstChars) {
    if (text.includes(firstChar)) {
      couldMatch = true;
      break;
    }
  }
  if (!couldMatch) {
    return text;
  }
  compiledMatcher ??= new RegExp(
    [...pinnedValues.keys(), ...registeredValues.keys()]
      .toSorted((left, right) => right.length - left.length)
      .map(escapeRegExp)
      .join("|"),
    "g",
  );
  return text.replace(compiledMatcher, (value) => mask(value));
}

function resetSecretRedactionRegistryForTest(): void {
  pinnedValues.clear();
  registeredValues.clear();
  rebuildProbe();
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.secretRedactionRegistryTestApi")
  ] = { resetSecretRedactionRegistryForTest };
}
