// Surrogate-safe UTF-16 string slicing helpers.
//
// Kept dependency-free (no node: imports) so browser/UI bundles can import them
// without dragging in filesystem/runtime code. See utils.ts, which re-exports
// these for the broad runtime surface.

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

/** Moves a chunk boundary away from the middle of a UTF-16 surrogate pair. */
export function avoidTrailingHighSurrogateBreak(text: string, start: number, end: number): number {
  if (
    end <= start ||
    end >= text.length ||
    !isHighSurrogate(text.charCodeAt(end - 1)) ||
    !isLowSurrogate(text.charCodeAt(end))
  ) {
    return end;
  }
  const adjusted = end - 1;
  return adjusted > start ? adjusted : end + 1;
}

let graphemeSegmenter: Intl.Segmenter | undefined;

function getGraphemeSegmenter(): Intl.Segmenter | undefined {
  try {
    graphemeSegmenter ??=
      typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
        ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
        : undefined;
  } catch {
    graphemeSegmenter = undefined;
  }
  return graphemeSegmenter;
}

/**
 * Moves a proposed UTF-16 cut backward to an extended grapheme cluster
 * boundary so multi-code-unit symbols (ZWJ emoji, flags, skin-tone modifiers,
 * combining sequences, Indic clusters) stay whole across chunk boundaries.
 * Falls back to the surrogate-pair clamp when Intl.Segmenter is unavailable.
 */
export function avoidTrailingGraphemeBreak(text: string, start: number, end: number): number {
  const surrogateSafeEnd = avoidTrailingHighSurrogateBreak(text, start, end);
  if (surrogateSafeEnd <= start || surrogateSafeEnd >= text.length) {
    return surrogateSafeEnd;
  }
  const segmenter = getGraphemeSegmenter();
  if (!segmenter) {
    return surrogateSafeEnd;
  }
  for (const segment of segmenter.segment(text)) {
    const segmentEnd = segment.index + segment.segment.length;
    if (segmentEnd < surrogateSafeEnd) {
      continue;
    }
    if (segment.index < surrogateSafeEnd && segmentEnd > surrogateSafeEnd) {
      // Cut strictly inside this cluster. Move back to its start so the symbol
      // stays whole; when the cluster already begins at/after the window start,
      // emit it whole by extending forward instead (mirrors the surrogate
      // helper's forward escape) so chunking still makes progress.
      if (segment.index > start) {
        return segment.index;
      }
      return Math.min(segmentEnd, text.length);
    }
    return surrogateSafeEnd;
  }
  return surrogateSafeEnd;
}

/** Slices a UTF-16 string without returning dangling surrogate halves at either edge. */
export function sliceUtf16Safe(input: string, start: number, end?: number): string {
  const len = input.length;

  let from = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
  let to = end === undefined ? len : end < 0 ? Math.max(len + end, 0) : Math.min(end, len);

  if (to <= from) {
    return "";
  }

  if (from > 0 && from < len) {
    const codeUnit = input.charCodeAt(from);
    if (isLowSurrogate(codeUnit) && isHighSurrogate(input.charCodeAt(from - 1))) {
      from += 1;
    }
  }

  if (to > 0 && to < len) {
    const codeUnit = input.charCodeAt(to - 1);
    if (isHighSurrogate(codeUnit) && isLowSurrogate(input.charCodeAt(to))) {
      to -= 1;
    }
  }

  return input.slice(from, to);
}

/** Truncates a UTF-16 string without cutting a surrogate pair in half. */
export function truncateUtf16Safe(input: string, maxLen: number): string {
  const limit = Math.max(0, Math.floor(maxLen));
  if (input.length <= limit) {
    return input;
  }
  return sliceUtf16Safe(input, 0, limit);
}

/** Truncates text and appends a marker while preserving the caller's reserved width contract. */
export function truncateWithMarker(
  value: string,
  max: number,
  options: { marker: string; reserve: number; trimEnd: boolean },
): string {
  if (value.length <= max) {
    return value;
  }
  const prefix = truncateUtf16Safe(value, max - options.reserve);
  return `${options.trimEnd ? prefix.trimEnd() : prefix}${options.marker}`;
}
