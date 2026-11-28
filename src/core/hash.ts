import { createHash } from "node:crypto";

/**
 * Computes the lowercase SHA-256 hex digest of UTF-8 text or raw bytes.
 *
 * Line endings are hashed verbatim so in-memory strings and disk bytes match 1:1.
 */
export function hashContent(content: string | Uint8Array): string {
  const hash = createHash("sha256");
  if (typeof content === "string") {
    hash.update(content, "utf8");
  } else {
    hash.update(content);
  }
  return hash.digest("hex");
}

/** Returns `true` if `content` hashes to a different SHA-256 digest than `previousHash`. */
export function hasContentChanged(previousHash: string, content: string | Uint8Array): boolean {
  return hashContent(content) !== previousHash;
}
