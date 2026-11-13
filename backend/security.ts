import dns from "node:dns/promises";
import net from "node:net";

export class ValidationError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "ValidationError";
    this.statusCode = statusCode;
  }
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata.google.internal",
]);

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map((part) => Number.parseInt(part, 10));
  return (
    (((parts[0] ?? 0) << 24) |
      ((parts[1] ?? 0) << 16) |
      ((parts[2] ?? 0) << 8) |
      (parts[3] ?? 0)) >>>
    0
  );
}

function isPrivateIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  const ranges: [number, number][] = [
    [0x00000000, 0x00ffffff], // 0.0.0.0/8
    [0x0a000000, 0x0affffff], // 10.0.0.0/8
    [0x64400000, 0x647fffff], // 100.64.0.0/10 (CGNAT)
    [0x7f000000, 0x7fffffff], // 127.0.0.0/8 (loopback)
    [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16 (link-local / cloud metadata)
    [0xac100000, 0xac1fffff], // 172.16.0.0/12
    [0xc0000000, 0xc00000ff], // 192.0.0.0/24
    [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16
    [0xc6120000, 0xc613ffff], // 198.18.0.0/15
    [0xe0000000, 0xffffffff], // multicast & reserved
  ];
  return ranges.some(([start, end]) => value >= start && value <= end);
}

export function isPrivateOrReservedIp(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (net.isIPv4(normalized)) {
    return isPrivateIpv4(normalized);
  }
  if (net.isIPv6(normalized)) {
    if (normalized === "::" || normalized === "::1") {
      return true;
    }
    if (normalized.startsWith("::ffff:")) {
      const mappedV4 = normalized.slice("::ffff:".length);
      if (net.isIPv4(mappedV4)) {
        return isPrivateIpv4(mappedV4);
      }
    }
    // fc00::/7 (Unique local), fe80::/10 (Link-local), ff00::/8 (Multicast)
    if (
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("ff")
    ) {
      return true;
    }
    return false;
  }
  return true;
}

export async function validateRemoteVideoUrl(rawUrl: unknown): Promise<URL> {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    throw new ValidationError("A video URL is required.", 400);
  }

  const trimmed = rawUrl.trim();
  if (trimmed.length > 4096) {
    throw new ValidationError("Video URL exceeds maximum allowed length.", 400);
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ValidationError("Invalid video URL.", 400);
  }

  if (parsed.protocol !== "https:") {
    throw new ValidationError("Video URL must use HTTPS.", 400);
  }

  if (parsed.username || parsed.password) {
    throw new ValidationError("Video URL must not contain credentials.", 400);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    !hostname ||
    BLOCKED_HOSTNAMES.has(hostname) ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new ValidationError("Video URL host is not allowed.", 400);
  }

  if (net.isIP(hostname) !== 0) {
    throw new ValidationError("Video URL must not use an IP address.", 400);
  }

  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw new ValidationError("Unable to resolve video URL host.", 400);
  }

  if (addresses.length === 0) {
    throw new ValidationError("Unable to resolve video URL host.", 400);
  }

  for (const entry of addresses) {
    if (isPrivateOrReservedIp(entry.address)) {
      throw new ValidationError("Video URL resolves to a restricted address.", 400);
    }
  }

  return parsed;
}

export function sanitizeAudioTitle(rawTitle: unknown): string {
  if (typeof rawTitle !== "string") {
    return "Extracted audio";
  }

  const cleaned = rawTitle
    .replace(/\.[^/.]+$/, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);

  return cleaned || "Extracted audio";
}
