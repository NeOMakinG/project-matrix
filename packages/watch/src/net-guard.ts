import ipaddr from "ipaddr.js";

/**
 * Embedded IPv4 inside special IPv6 forms (mapped, compatible, NAT64, 6to4). Each of these can route
 * to an IPv4 target, so the IPv4 must pass the same checks.
 */
function embeddedV4(v6: ipaddr.IPv6): ipaddr.IPv4 | null {
  const b = v6.toByteArray();
  const v4 = (o: number) => new ipaddr.IPv4([b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!]);
  if (v6.isIPv4MappedAddress()) return v6.toIPv4Address();
  if (b.slice(0, 12).every((x) => x === 0)) return v4(12); // ::a.b.c.d (deprecated compatible form)
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return v4(12); // 64:ff9b::/96 and /48
  if (b[0] === 0x20 && b[1] === 0x02) return v4(2); // 6to4 2002::/16
  return null;
}

/** Only globally routable unicast addresses are allowed; everything else (and anything unparsable) is blocked. */
export function isPublicAddress(ip: string): boolean {
  const raw = ip.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (!ipaddr.isValid(raw)) return false;
  let addr = ipaddr.parse(raw);
  if (addr.kind() === "ipv6") {
    const v6 = addr as ipaddr.IPv6;
    const inner = embeddedV4(v6);
    if (inner) addr = inner;
    else if (v6.range() !== "unicast") return false;
    else if (raw.toLowerCase().startsWith("2001:0:") || raw.toLowerCase().startsWith("2001::"))
      return false; // Teredo
  }
  if (addr.kind() === "ipv4") {
    const v4 = addr as ipaddr.IPv4;
    if (v4.range() !== "unicast") return false;
    const [a, b2] = v4.octets;
    if (a === 100 && b2! >= 64 && b2! <= 127) return false; // CGNAT / tailnet (range() may report it as carrierGradeNat)
  }
  return true;
}
