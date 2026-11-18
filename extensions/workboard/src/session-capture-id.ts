import { createHash } from "node:crypto";

/** The card id of a captured session, the same in every process that captures it. */
export function sessionCaptureCardId(sessionKey: string): string {
  const digest = createHash("sha256")
    .update("openclaw.workboard.session-capture.v1\0")
    .update(sessionKey)
    .digest();
  // RFC 9562 version 8 keeps the documented UUID-shaped card id while the
  // existing primary key becomes the cross-process session identity.
  digest.writeUInt8((digest.readUInt8(6) & 0x0f) | 0x80, 6);
  digest.writeUInt8((digest.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = digest.toString("hex", 0, 16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
