// Link previews: fetch a page's title and description for a link card.
// A server that fetches URLs on request can be tricked into reaching places only the server can reach (its own services, the cloud
// metadata address, the office network). So: only http(s), only plain ports, the hostname is resolved HERE and every address must be
// public, the connection goes to the exact address that was checked (a second DNS answer cannot swap it), every redirect is checked
// again, and time and size are capped.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import http from "node:http";
import https from "node:https";

export type Preview = { title?: string; description?: string; site: string; image?: string };
const MAX_IMAGE = 3 * 1024 * 1024, MAX_BYTES = 512 * 1024, MAX_REDIRECTS = 3, PORTS = [80, 443, 8080, 8443];

// addresses the server must never connect to for a user: loopback, private networks, link-local (cloud metadata is there),
// carrier-grade NAT, multicast, the unspecified address; IPv4 and IPv6, including IPv4 hidden inside IPv6
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || a >= 224;
  }
  if (kind === 6) {
    const x = ip.toLowerCase();
    const dotted = /^(?:::ffff:|0:0:0:0:0:ffff:)(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (dotted) return isPrivateAddress(dotted[1]);
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(x);
    if (hex) { const h = parseInt(hex[1], 16), l = parseInt(hex[2], 16); return isPrivateAddress(`${h >> 8}.${h & 255}.${l >> 8}.${l & 255}`); }
    return x === "::" || x === "::1" || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x) || x.startsWith("64:ff9b:");
  }
  return true; // not an address at all: refuse
}

type Got = { status: number; headers: http.IncomingHttpHeaders; body: Buffer; truncated: boolean };
function get(url: URL, addr: { address: string; family: number }, accept: string, maxBytes: number): Promise<Got> {
  const lib = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request({
      host: addr.address, family: addr.family, port: url.port || undefined, path: url.pathname + url.search, method: "GET",
      servername: url.hostname, // TLS: the certificate is checked against the real name even though we connect to the checked IP
      headers: { host: url.host, "user-agent": "Mozilla/5.0 (compatible; boardsync-link-preview/1)", accept, "accept-language": "en,pl;q=0.8" },
      timeout: 4000,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0, truncated = false;
      const done = () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), truncated });
      res.on("data", (c: Buffer) => { size += c.length; chunks.push(c); if (size > maxBytes) { truncated = true; done(); req.destroy(); } }); // the head of a page is all we need
      res.on("end", done);
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end();
  });
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
  const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
});
const clip = (s: string | undefined, n: number) => (s ? decode(s).replace(/\s+/g, " ").trim().slice(0, n) || undefined : undefined);
function meta(html: string, key: string): string | undefined {
  const tag = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, "i").exec(html)?.[0];
  return tag ? /content=["']([^"']*)["']/i.exec(tag)?.[1] : undefined;
}
// the picture a page offers for itself: Open Graph / Twitter card, then a product's schema.org JSON-LD, then <link rel="image_src">
function imageOf(head: string, base: URL): string | undefined {
  const ld = [...head.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join("\n"); // not any script: pages have unrelated "image" keys
  const raw = meta(head, "og:image:secure_url") ?? meta(head, "og:image") ?? meta(head, "twitter:image") ?? meta(head, "twitter:image:src")
    ?? /"image"\s*:\s*\[?\s*"([^"]+)"/.exec(ld)?.[1] ?? /"image"\s*:\s*\{[^}]*?"url"\s*:\s*"([^"]+)"/.exec(ld)?.[1]
    ?? /<link[^>]+rel=["']image_src["'][^>]*href=["']([^"']+)["']/i.exec(head)?.[1];
  const text = decode(raw ?? "").trim().replace(/\\\//g, "/");
  if (!text) return undefined; // an empty value would resolve to the page itself
  try { const u = new URL(text, base); return /^https?:$/.test(u.protocol) && u.href !== base.href ? u.href : undefined; } catch { return undefined; }
}
export function parsePreview(html: string, url: URL): Preview {
  const head = html.slice(0, 400_000);
  return {
    title: clip(meta(head, "og:title") ?? /<title[^>]*>([^<]*)<\/title>/i.exec(head)?.[1], 200),
    description: clip(meta(head, "og:description") ?? meta(head, "description"), 300),
    site: clip(meta(head, "og:site_name"), 80) ?? url.hostname.replace(/^www\./, ""),
    image: imageOf(head, url),
  };
}

// every request, and every redirect, goes through the same checks
async function fetchChecked(raw: string, allowPrivate: boolean, accept: string, maxBytes: number): Promise<{ url: URL; res: Got }> {
  let url = new URL(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("unsupported link");
    if (!allowPrivate && !PORTS.includes(Number(url.port || (url.protocol === "https:" ? 443 : 80)))) throw new Error("unsupported port");
    const host = url.hostname.replace(/^\[|\]$/g, ""), literal = isIP(host);
    const addrs = literal ? [{ address: host, family: literal }] : await lookup(host, { all: true });
    if (!addrs.length) throw new Error("not found");
    if (!allowPrivate && addrs.some((a) => isPrivateAddress(a.address))) throw new Error("blocked address");
    const res = await get(url, addrs[0], accept, maxBytes);
    if (res.status >= 300 && res.status < 400 && res.headers.location) { url = new URL(res.headers.location, url); continue; } // checked again at the top
    if (res.status >= 400) throw new Error("page returned " + res.status);
    return { url, res };
  }
  throw new Error("too many redirects");
}

export async function unfurl(raw: string, allowPrivate = false): Promise<Preview> {
  const { url, res } = await fetchChecked(raw, allowPrivate, "text/html,application/xhtml+xml", MAX_BYTES);
  return /html/i.test(String(res.headers["content-type"] ?? "")) ? parsePreview(res.body.toString("utf8"), url) : { site: url.hostname.replace(/^www\./, "") };
}

// the picture itself, fetched by the server (never hot-linked: shops block it and it would show them every viewer's address)
export async function fetchImage(raw: string, allowPrivate = false): Promise<{ mime: string; data: Buffer }> {
  const { res } = await fetchChecked(raw, allowPrivate, "image/png,image/jpeg,image/webp,image/gif", MAX_IMAGE);
  if (res.truncated) throw new Error("image too large");
  return { mime: String(res.headers["content-type"] ?? "").split(";")[0].trim(), data: res.body };
}
