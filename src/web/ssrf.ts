/**
 * SSRF guard for agent-chosen URLs.
 *
 * Why this is stricter than the usual "block 127.0.0.1" check. An app that
 * fetches a URL the USER pasted has a human in the loop who can be blamed for
 * typing it. An agent that fetches a URL it reasoned its way to from a search
 * result has no such human: the model picks the address, and any page on the
 * open web can hand it a link to `http://169.254.169.254/latest/meta-data/`
 * and read the answer back out of the model's next sentence. On a box that
 * also runs Postgres, Supabase, Caddy and eight app servers on localhost, the
 * blast radius of one missed range is the whole fleet.
 *
 * So the rule here is allow-list-shaped rather than deny-list-shaped wherever
 * it can be: http(s) only, ports 80/443 only, no credentials, and — the part
 * that actually matters — EVERY address the hostname resolves to must be
 * public, checked again on every redirect hop rather than once at the start.
 *
 * The classic bypass this closes: a hostname that resolves to a public address
 * on the first lookup and a private one on the second (DNS rebinding), or a
 * public URL that 302s to `http://localhost:5432`. Validating the first URL
 * and then handing the rest to `fetch`'s automatic redirect following defeats
 * the whole check, which is why the reader does `redirect: "manual"` and comes
 * back through here for each hop.
 *
 * Pure except for DNS. No allow-list of "good" domains: a fleet whose thesis is
 * that anyone may publish anywhere cannot ship an agent that can only read the
 * sites we thought of.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Injectable so tests need no network and no hosts-file tricks. */
export type LookupFn = (hostname: string) => Promise<Array<{ address: string }>>;

export const defaultLookup: LookupFn = async (hostname) => {
  const entries = await dnsLookup(hostname, { all: true, verbatim: true });
  return entries.map((e) => ({ address: e.address }));
};

export type UrlVerdict =
  { ok: true; url: URL; addresses: string[] } | { ok: false; reason: string };

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const ALLOWED_PORTS = new Set(["", "80", "443"]);

/**
 * Is this a literal address we must never connect to?
 *
 * Each range is here because it addresses something that is not "the public
 * internet" — loopback, the link-local metadata service, RFC1918, carrier NAT,
 * benchmark and documentation nets, multicast and the reserved top of the
 * space. A response from any of them is a response from inside the trust
 * boundary, whatever the hostname said.
 */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return isPrivateIpv4(address);
  }
  if (family === 6) {
    return isPrivateIpv6(address);
  }
  // Not a parseable address at all. Refusing is the only safe reading: we
  // cannot prove it is public, and "unknown" must never mean "allowed".
  return true;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local — cloud metadata lives here
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 192 && b === 0) return true; // IETF protocol assignments (incl. 192.0.0.0/24)
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51) return true; // TEST-NET-2
  if (a === 203 && b === 0) return true; // TEST-NET-3
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIpv6(address: string): boolean {
  const lower = address.toLowerCase().split("%")[0] ?? "";

  // IPv4-mapped (::ffff:10.0.0.1) and IPv4-compatible forms are IPv4 questions
  // wearing an IPv6 spelling. Judge the embedded address, not the wrapper.
  const mapped = lower.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) {
    return isPrivateIpv4(mapped[1]);
  }

  if (lower === "::" || lower === "::1") return true; // unspecified, loopback
  if (lower.startsWith("fe8") || lower.startsWith("fe9")) return true; // link-local
  if (lower.startsWith("fea") || lower.startsWith("feb")) return true; // link-local
  if (/^f[cd]/.test(lower)) return true; // unique local (fc00::/7)
  if (lower.startsWith("ff")) return true; // multicast

  // 6to4 (2002::/16) and NAT64 (64:ff9b::/96) carry an IPv4 address inside.
  // Left unchecked they are a clean tunnel to 127.0.0.1.
  if (lower.startsWith("2002:")) return true;
  if (lower.startsWith("64:ff9b:")) return true;

  return false;
}

/**
 * Validate a URL for agent fetching: shape first (cheap, no network), then
 * resolve and judge every address behind the hostname.
 *
 * Returns the resolved addresses on success so the caller can log what it
 * actually talked to — a hostname proves nothing about where the bytes came
 * from, and the address is the thing an incident review needs.
 */
export async function validateFetchTarget(
  raw: string,
  lookup: LookupFn = defaultLookup,
): Promise<UrlVerdict> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "That is not a valid URL." };
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return { ok: false, reason: `Only http and https can be fetched, not ${url.protocol}` };
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    return { ok: false, reason: `Only the standard web ports are allowed, not ${url.port}.` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "A URL carrying credentials is never fetched." };
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!hostname) {
    return { ok: false, reason: "That URL has no host." };
  }

  // A literal address needs no lookup — and must not get one, since a resolver
  // asked about "127.0.0.1" will happily hand it back and the check would then
  // be judging its own input.
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      return { ok: false, reason: "That address is not on the public internet." };
    }
    return { ok: true, url, addresses: [hostname] };
  }

  let addresses: string[];
  try {
    const entries = await lookup(hostname);
    addresses = entries.map((e) => e.address);
  } catch {
    return { ok: false, reason: `The host ${hostname} could not be resolved.` };
  }

  if (addresses.length === 0) {
    return { ok: false, reason: `The host ${hostname} resolved to no addresses.` };
  }
  // EVERY address, not the first: a hostname with one public and one private A
  // record is a rebinding attack with the work already done for it.
  if (addresses.some((a) => isPrivateAddress(a))) {
    return { ok: false, reason: `The host ${hostname} resolves inside a private network.` };
  }

  return { ok: true, url, addresses };
}
