// Password hashing for gateway auth (A2, user/pass revision).
//
// Uses Node's built-in scrypt (memory-hard, no native deps). Stored format:
//
//   scrypt$<N>$<r>$<p>$<saltBase64>$<hashBase64>
//
// `$` never appears in base64, so a plain split is unambiguous. Params are
// embedded so they can be raised later without invalidating existing hashes.
import crypto from "node:crypto";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;
// scrypt memory ≈ 128 * N * r bytes; give verify headroom above the default
// 32 MiB so reasonable stored params never throw ERR_CRYPTO_INVALID_SCRYPT_PARAMS.
const MAX_MEM = 128 * 1024 * 1024;

export function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_LEN);
  const hash = crypto.scryptSync(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAX_MEM,
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64"),
    hash.toString("base64"),
  ].join("$");
}

/** True when `stored` parses as a scrypt hash string we can verify against. */
export function isValidHashString(stored) {
  return parseHash(stored) !== null;
}

function parseHash(stored) {
  if (typeof stored !== "string") return null;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4], "base64");
  const hash = Buffer.from(parts[5], "base64");
  if (!Number.isInteger(N) || N < 2 || (N & (N - 1)) !== 0) return null;
  if (!Number.isInteger(r) || r < 1) return null;
  if (!Number.isInteger(p) || p < 1) return null;
  if (128 * N * r > MAX_MEM) return null;
  if (salt.length < 8 || hash.length < 16) return null;
  return { N, r, p, salt, hash };
}

/**
 * Timing-safe verify. Runs the full scrypt derivation on every call with a
 * parseable hash; returns false (never throws) on malformed input.
 */
export function verifyPassword(password, stored) {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  let derived;
  try {
    derived = crypto.scryptSync(password, parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: MAX_MEM,
    });
  } catch {
    return false;
  }
  return crypto.timingSafeEqual(derived, parsed.hash);
}
