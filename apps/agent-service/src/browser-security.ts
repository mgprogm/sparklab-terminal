import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.azure.internal",
]);

/** Validate a public HTTP(S) destination, including every resolved address. */
export async function validateBrowserUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("browser URL must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("browser URL must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("browser URL must not contain embedded credentials");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    !hostname ||
    BLOCKED_HOSTS.has(hostname) ||
    hostname.endsWith(".localhost")
  ) {
    throw new Error("browser destination is not public");
  }

  await resolvePublicBrowserHost(hostname);
  return url;
}

/** Resolve once and return only addresses already proven public (DNS-rebinding safe for callers that connect by IP). */
export async function resolvePublicBrowserHost(
  hostname: string,
): Promise<string[]> {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    !normalized ||
    BLOCKED_HOSTS.has(normalized) ||
    normalized.endsWith(".localhost")
  ) {
    throw new Error("browser destination is not public");
  }
  const addresses = isIP(normalized)
    ? [{ address: normalized }]
    : await lookup(normalized, { all: true, verbatim: true });
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => !isPublicIp(address))
  ) {
    throw new Error(
      "browser destination resolves to a private or reserved address",
    );
  }
  return addresses.map(({ address }) => address);
}

export function isPublicIp(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0] ?? address;
  if (isIP(normalized) === 4) {
    const octets = normalized.split(".").map(Number);
    const [a = 0, b = 0, c = 0] = octets;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (isIP(normalized) === 6) {
    const hextets = expandIpv6(normalized);
    if (!hextets) return false;
    const [first = 0, second = 0, third = 0, fourth = 0] = hextets;
    return !(
      first === 0 || // unspecified, loopback, IPv4-compatible/mapped
      (first & 0xfe00) === 0xfc00 || // unique-local fc00::/7
      (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
      (first & 0xffc0) === 0xfec0 || // deprecated site-local fec0::/10
      (first & 0xff00) === 0xff00 || // multicast ff00::/8
      (first === 0x0100 && second === 0 && third === 0 && fourth === 0) || // discard-only 100::/64
      (first === 0x0064 && second === 0xff9b) || // NAT64 special-use prefixes
      (first === 0x2001 && second <= 0x01ff) || // IETF protocol/special assignments
      (first === 0x2001 && second === 0x0db8) || // documentation
      first === 0x2002 || // 6to4 can embed private IPv4
      first === 0x3fff || // documentation
      first === 0x5f00 // segment-routing SIDs, not public destinations
    );
  }
  return false;
}

function expandIpv6(address: string): number[] | null {
  const [left = "", right = ""] = address.split("::", 2);
  const leftParts = left ? left.split(":") : [];
  const rightParts = right ? right.split(":") : [];
  const missing = 8 - leftParts.length - rightParts.length;
  if ((!address.includes("::") && missing !== 0) || missing < 0) return null;
  const parts = [
    ...leftParts,
    ...Array.from({ length: missing }, () => "0"),
    ...rightParts,
  ];
  if (parts.length !== 8) return null;
  const values = parts.map((part) => Number.parseInt(part || "0", 16));
  return values.every(
    (value) => Number.isInteger(value) && value >= 0 && value <= 0xffff,
  )
    ? values
    : null;
}
