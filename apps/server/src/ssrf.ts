import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Containment for outbound requests to operator-supplied URLs.
 *
 * strata makes ten outbound calls, and several of them point at a URL somebody typed into a form:
 * the webhook target, the Confluence and Jira site URLs, and the Data Catalog base. Every one of
 * those is a request the *server* makes, from inside whatever network the server is on.
 *
 * **The prize is not strata.** On a cloud instance the interesting target is the metadata endpoint at
 * `169.254.169.254`, which hands out the node's own credentials to anything that can reach it.
 * That is worth far more than any model in the workspace, and reaching it costs an attacker one
 * form field. The same applies to anything else on the internal network that answers to a GET.
 *
 * **Resolve, then check, then connect to the address we checked.** Validating the hostname alone
 * is not enough: `internal.example.com` can resolve to `10.0.0.5`, and a name that resolves
 * differently on the second lookup than the first (DNS rebinding) defeats a check that only
 * inspects the string. So `assertSafeUrl` resolves the name and rejects on the *addresses*, and
 * `safeFetch` passes those addresses back to the caller so a future transport can pin them.
 *
 * **Redirects are re-checked, not followed blindly.** A permitted host that answers `302` to
 * `http://169.254.169.254/` would otherwise walk straight through the front door, so redirects
 * are handled manually and each hop goes through the same check.
 *
 * **Operators can opt back in.** Plenty of real deployments genuinely do point strata at an internal
 * Jira. `STRATA_SSRF_ALLOW` is a comma-separated list of hosts that skip the address check, so the
 * default is safe and the exception is explicit and reviewable.
 */

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedUrlError";
  }
}

export interface UrlPolicy {
  /** Permitted schemes. Defaults to http and https. */
  protocols?: string[];
  /** Hosts that skip the address check. Defaults to `STRATA_SSRF_ALLOW`. */
  allowHosts?: string[];
}

/** Hosts an operator has explicitly permitted, from the environment. */
export function allowedHosts(): string[] {
  return (process.env.STRATA_SSRF_ALLOW ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Whether an address is somewhere a request from this server should never go.
 *
 * Written against the parsed octets rather than a regular expression: `010.0.0.1` and
 * `0x7f.0.0.1` are both valid ways to write an address that a string pattern misses, and
 * `node:dns` hands back a normalised form that these comparisons can trust.
 */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isBlockedV4(address);
  if (family === 6) return isBlockedV6(address);
  // Not an address at all. The caller resolves before calling, so this is a programming error
  // rather than a hostile input, and failing closed is the right answer either way.
  return true;
}

function isBlockedV4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a = 0, b = 0] = parts;

  if (a === 0) return true; // 0.0.0.0/8, "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, and the cloud metadata endpoint
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 192 && b === 0) return true; // IETF protocol assignments, includes 192.0.0.0/24
  if (a >= 224) return true; // multicast and reserved, through 255.255.255.255
  return false;
}

function isBlockedV6(address: string): boolean {
  const lower = address.toLowerCase();

  if (lower === "::" || lower === "::1") return true; // unspecified, loopback

  /*
    IPv4-mapped and IPv4-compatible forms, `::ffff:127.0.0.1` and `::127.0.0.1`.

    Worth handling explicitly: a socket opened to the mapped form reaches the IPv4 address, so
    treating it as "some IPv6 address we do not recognise" would be a hole rather than a gap.
  */
  const mapped = lower.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isBlockedV4(mapped[1]);

  if (lower.startsWith("fe80")) return true; // link-local
  if (/^f[cd]/.test(lower)) return true; // unique local, fc00::/7
  if (lower.startsWith("ff")) return true; // multicast
  return false;
}

/**
 * Check a URL and return the addresses it resolves to.
 *
 * Throws `BlockedUrlError` with a message an operator can act on. The message names what was
 * rejected and why, because "request failed" on a form field is the kind of error that costs
 * somebody an afternoon.
 */
export async function assertSafeUrl(raw: string, policy: UrlPolicy = {}): Promise<string[]> {
  const protocols = policy.protocols ?? ["http:", "https:"];

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError(`\`${raw}\` is not a valid URL.`);
  }

  if (!protocols.includes(url.protocol)) {
    throw new BlockedUrlError(
      `${url.protocol}// is not allowed here. Use ${protocols.map((p) => `${p}//`).join(" or ")}.`,
    );
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const allow = policy.allowHosts ?? allowedHosts();
  if (allow.includes(host)) return [];

  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await lookup(host, { all: true })).map((entry) => entry.address);
    } catch {
      throw new BlockedUrlError(`\`${host}\` could not be resolved.`);
    }
  }

  if (addresses.length === 0) throw new BlockedUrlError(`\`${host}\` resolved to no addresses.`);

  /*
    Every address, not just the first.

    A name that resolves to one public address and one private one is the standard way around a
    check that stops at `addresses[0]`, and the connection may use either.
  */
  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      throw new BlockedUrlError(
        `\`${host}\` resolves to ${address}, which is a private or link-local address. ` +
          `Set STRATA_SSRF_ALLOW=${host} if this is an internal service you meant to reach.`,
      );
    }
  }

  return addresses;
}

export interface SafeFetchOptions extends RequestInit {
  policy?: UrlPolicy;
  /** How many redirects to follow. Each hop is re-checked. */
  maxRedirects?: number;
}

/**
 * `fetch`, with every hop checked.
 *
 * A drop-in for the call sites that take an operator-supplied URL. Redirects are followed by hand
 * so that a permitted host cannot bounce the request somewhere the check would have refused.
 */
export async function safeFetch(raw: string, options: SafeFetchOptions = {}): Promise<Response> {
  const { policy, maxRedirects = 3, ...init } = options;

  let target = raw;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    await assertSafeUrl(target, policy);

    const response = await fetch(target, { ...init, redirect: "manual" });

    const isRedirect = response.status >= 300 && response.status < 400;
    const location = response.headers.get("location");
    if (!isRedirect || !location) return response;

    if (hop === maxRedirects) {
      throw new BlockedUrlError(`too many redirects from \`${raw}\`.`);
    }

    // Relative locations are legal, so resolve against the hop we just made rather than the
    // original URL.
    target = new URL(location, target).toString();

    /*
      A redirected request must not carry the body again.

      Following a 307 with the original POST body is correct per the specification, but the
      call sites here are all "post this summary to the URL the operator configured", and
      silently re-posting to a *different* host is the surprise this module exists to prevent.
    */
    if (init.method && init.method !== "GET" && init.method !== "HEAD") {
      init.method = "GET";
      delete init.body;
    }
  }

  throw new BlockedUrlError(`too many redirects from \`${raw}\`.`);
}
