// Telegram tests cover progress text clipping behavior.
import {
  avoidTrailingGraphemeBreak,
  sliceUtf16Safe,
} from "openclaw/plugin-sdk/text-utility-runtime";

const TELEGRAM_PROGRESS_MAX_CHARS = 300;

/**
 * Clips Telegram progress text to at most {@link TELEGRAM_PROGRESS_MAX_CHARS} UTF-16 code units,
 * slicing on a grapheme boundary so a surrogate pair or extended cluster
 * (ZWJ emoji, flag) straddling the limit is dropped whole rather than leaving
 * broken halves in the payload.
 */
export function clipTelegramProgressText(text: string): string {
  if (text.length <= TELEGRAM_PROGRESS_MAX_CHARS) {
    return text;
  }
  // Slice on a cluster boundary so an emoji (or any astral/multi-code-point
  // character) that straddles the limit is dropped whole instead of leaving a
  // lone \uD83D-style high surrogate before the ellipsis, which serializes to
  // an invalid character in the Telegram Bot API payload.
  const clipped = sliceUtf16Safe(text, 0, TELEGRAM_PROGRESS_MAX_CHARS - 1);
  return `${text.slice(0, avoidTrailingGraphemeBreak(clipped, 0, clipped.length)).trimEnd()}…`;
}
