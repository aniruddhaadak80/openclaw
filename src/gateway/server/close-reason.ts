// Close reason helpers keep WebSocket handshake failure text within RFC byte limits.
import { Buffer } from "node:buffer";

/**
 * WebSocket close reason utilities.
 */
const CLOSE_REASON_MAX_BYTES = 120;

/** Truncates close reasons to the RFC-safe byte limit used during handshake failures. */
export function truncateCloseReason(reason: string, maxBytes = CLOSE_REASON_MAX_BYTES): string {
  if (!reason) {
    return "invalid handshake";
  }
  const buf = Buffer.from(reason);
  if (buf.length <= maxBytes) {
    return reason;
  }
  // Back the cut up to a UTF-8 code point boundary so the truncated reason
  // stays valid UTF-8 and never re-encodes beyond maxBytes.
  let end = maxBytes;
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }
  return buf.toString("utf8", 0, end);
}
