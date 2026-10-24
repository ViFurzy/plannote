import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { createServer as createHttp, type IncomingMessage, type ServerResponse } from "node:http";
import { Server } from "socket.io";
import { unfurl, fetchImage } from "./unfurl.ts";

export type Element = {
  id: string;
  elementType: "BOARD" | "CARD" | "COLUMN" | "LINE" | "LINK" | "SKETCH" | "SWATCH" | "TABLE" | "TASK_LIST" | "DOCUMENT" | "COMMENT_THREAD" | "IMAGE" | "SHAPE";
  location: { parentId: string; section: "CANVAS" | "TRASH" | string; position: { score: number; x?: number; y?: number; [k: string]: unknown } };
  content: Record<string, unknown>;
  acl?: Record<string, number>; // root boards only; nested boards inherit
  meta: { versionId: string; modifiedTime: number; [k: string]: unknown };
};

type Action =
  | ({ type: "ELEMENT_CREATE"; channels?: string[] } & Element)
  | { type: "ELEMENT_UPDATE"; updates: { id: string; changes: Record<string, unknown>; meta: { modifiedVersionId: string; versionId: string } }[] }
  | { type: "ELEMENT_MOVE_MULTI"; moves: { id: string; location: Element["location"] }[] }
  | { type: "ELEMENT_UPDATE_ACL"; id: string; acl: Record<string, number> } // perm 0 removes the user
  | { type: "COMMENT_ADD"; id: string; text: string }; // append-only: the server stamps author and time

const READ = 1, WRITE = 2, ADMIN = 4, OWNER = READ | WRITE | ADMIN;
const validUser = (u: unknown): u is string => typeof u === "string" && /^[\w-]{1,64}$/.test(u);

// limits: one element is at most 200 KB of JSON (a stroke, a long note, a 100x20 table all fit); a connection can send 1000 actions in a burst (a big paste or import is one action per card), then 300 a second
const TYPES = new Set(["BOARD", "CARD", "COLUMN", "LINE", "LINK", "SKETCH", "SWATCH", "TABLE", "TASK_LIST", "DOCUMENT", "COMMENT_THREAD", "IMAGE", "SHAPE"]);
const MAX_ELEMENT = 200_000, BURST = 1000, PER_SECOND = 300, MAX_UPLOADS_PER_MINUTE = 30, MAX_FETCHES_PER_MINUTE = 150, MAX_SEARCHES_PER_MINUTE = 120;
const small = (v: unknown) => JSON.stringify(v).length <= MAX_ELEMENT;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
// what the browser may load: this server only (inline script/style because the client is one page), images from here, data: and blob: for export
const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

// uploads: raster images only (no SVG: it can carry script). The declared type must match the file's real first bytes.
const MAX_MEDIA = 5 * 1024 * 1024;
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  "image/png": (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/gif": (b) => b.subarray(0, 4).toString("latin1") === "GIF8",
  "image/webp": (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
};

type Result = { status: number; boards?: string[]; out?: unknown; ack?: Record<string, unknown> };

// Identity: with opts.accounts it is the user of the session cookie (sign up / log in below). Without it (tests, local use) it is
// whatever userId the client claims (socket auth / x-user-id header): authorization only, no authentication.
// SQLite is write-through: the Map serves reads, every applied change is saved as a JSON row.
export function createServer(port: number, dbFile = ":memory:", opts: { allowPrivateUnfurl?: boolean; host?: string; origins?: string[]; https?: boolean; backupDir?: string; accounts?: boolean } = {}) {
  // link previews: ten minutes of cache, and at most 20 previews a minute per user
  const previews = new Map<string, { at: number; data: unknown }>(), recent = new Map<string, number[]>(), uploads = new Map<string, number[]>(), fetched = new Map<string, number[]>(), searched = new Map<string, number[]>();
  const db = new DatabaseSync(dbFile);
  db.exec("PRAGMA journal_mode = WAL"); // readers and the writer do not block each other; also what makes a live backup safe
  db.exec("PRAGMA synchronous = NORMAL"); // with WAL a power cut can lose the last commits but never corrupts the file; far fewer disk syncs
  db.exec("CREATE TABLE IF NOT EXISTS elements (id TEXT PRIMARY KEY, json TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL, owner TEXT NOT NULL)");
  if (!(db.prepare("PRAGMA table_info(media)").all() as { name: string }[]).some((c) => c.name === "at")) db.exec("ALTER TABLE media ADD COLUMN at INTEGER"); // upload time, for the orphan sweep
  db.prepare("UPDATE media SET at = ? WHERE at IS NULL").run(Date.now());
  db.exec("CREATE TABLE IF NOT EXISTS users (name TEXT PRIMARY KEY, pw TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user TEXT NOT NULL, at INTEGER NOT NULL)"); // token = sha256 of the cookie value
  const insertMedia = db.prepare("INSERT INTO media (id, mime, data, owner, at) VALUES (?, ?, ?, ?, ?)");
  const getMedia = db.prepare("SELECT mime, data FROM media WHERE id = ?");
  const upsert = db.prepare("INSERT OR REPLACE INTO elements (id, json) VALUES (?, ?)");
  const save = (e: Element) => void upsert.run(e.id, JSON.stringify(e));
  // an action that changes many elements is one transaction, not one disk commit per element
  const batch = <T>(fn: () => T): T => { db.exec("BEGIN"); try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; } };
  const els = new Map<string, Element>(
    (db.prepare("SELECT json FROM elements").all() as { json: string }[]).map((r) => { const e: Element = JSON.parse(r.json); return [e.id, e]; }),
  );
  // parent id -> its direct children, so a board is read without scanning every element. Kept in step with every els.set and every location change.
  const children = new Map<string, Set<Element>>();
  const adopt = (e: Element) => { const s = children.get(e.location.parentId); s ? s.add(e) : children.set(e.location.parentId, new Set([e])); };
  for (const e of els.values()) adopt(e);

  // --- authorization ---
  // the board an id belongs to: strip the trash suffix, and hop out of columns
  // bounded loop: a column cycle (A in B in A) must not recurse forever
  const boardOf = (id: string): string => {
    for (let i = 0; i < 50; i++) {
      id = id.replace(/-trash$/, "");
      const e = els.get(id);
      if (e?.elementType !== "COLUMN") break;
      id = e.location.parentId;
    }
    return id;
  };
  // would putting something under `parentId` place it inside `id`? (refuses cycles: a column or board in itself)
  const inside = (parentId: string, id: string) => {
    for (let i = 0; i < 50 && parentId; i++) {
      parentId = parentId.replace(/-trash$/, "");
      if (parentId === id) return true;
      parentId = els.get(parentId)?.location.parentId ?? "";
    }
    return false;
  };
  // walk up to the nearest element carrying an acl
  function lookup(user: string, boardId: string): { perm: number } {
    let cur = boardOf(boardId);
    for (let i = 0; i < 50; i++) {
      const e = els.get(cur);
      if (!e) break;
      if (e.acl) return { perm: e.acl[user] ?? 0 };
      if (!e.location.parentId) break;
      cur = boardOf(e.location.parentId);
    }
    return { perm: 0 };
  }
  const can = (user: string, boardId: string, bit: number) => (lookup(user, boardId).perm & bit) === bit;
  // whether a card or board sits in some Trash (boardOf, above, gives the board a card is on)
  const inTrash = (e: Element) => { for (let x: Element | undefined = e, n = 0; x && n < 40; x = els.get(x.location.parentId), n++) if (x.location.section === "TRASH") return true; return false; };
  const textOf = (e: Element): string => { // every piece of text a card holds, as one string (what search looks through)
    const c = e.content as Record<string, any>, list = (v: unknown) => (Array.isArray(v) ? v : []);
    return [c.title, c.textContent, c.url, c.previewTitle, c.previewDesc, c.name, c.caption, ...list(c.tasks).map((t) => t?.text), ...list(c.rows).flat(), ...list(c.pins).map((p) => p?.text), ...list(c.messages).map((m) => m?.text)]
      .filter((v) => typeof v === "string" && v).join(" · ");
  };
  // Each user has one HOME root board, created on first request. Ids are random and joining never creates a board,
  // so nobody can squat an id. `content.owner` (not the acl) decides whose home it is, since an acl can be shared.
  function homeOf(user: string): string {
    for (const e of els.values()) if (e.content.rootType === "HOME" && e.content.owner === user) return e.id;
    const id = randomUUID().replace(/-/g, "").slice(0, 16);
    const root: Element = { id, elementType: "BOARD", location: { parentId: "", section: "ROOT", position: { score: 0 } }, content: { title: "Home", rootType: "HOME", owner: user }, acl: { [user]: OWNER }, meta: { versionId: "server-1", modifiedTime: Date.now() } };
    els.set(id, root); adopt(root); save(root);
    return id;
  }
  function joinable(user: string, channel: string) {
    const m = /^(.+)-LIVE$/.exec(channel);
    return m ? can(user, m[1], READ) : channel === `${user}-PERSONAL`;
  }

  // --- accounts: scrypt password hashes, an opaque session cookie (only its sha256 is stored) ---
  const SESSION_MS = 30 * 86_400_000, tries = new Map<string, number[]>();
  const sha = (t: string) => createHash("sha256").update(t).digest("hex");
  const scryptOf = (pw: string, salt: Buffer) => new Promise<Buffer>((ok, no) => scrypt(pw, salt, 32, (e, k) => (e ? no(e) : ok(k))));
  const throttled = (key: string, max: number) => { // at most `max` tries a minute per key
    const now = Date.now(), mine = (tries.get(key) ?? []).filter((t) => now - t < 60_000);
    tries.set(key, [...mine, now]);
    if (tries.size > 5000) tries.delete(tries.keys().next().value!);
    return mine.length >= max;
  };
  const sessionUser = (cookie?: string) => {
    const token = /(?:^|; )sid=([\w-]{43})(?:;|$)/.exec(cookie ?? "")?.[1];
    const row = token ? (db.prepare("SELECT user, at FROM sessions WHERE token = ?").get(sha(token)) as { user: string; at: number } | undefined) : undefined;
    return row && Date.now() - row.at < SESSION_MS ? row.user : undefined;
  };
  const userExists = (name: string) => !!db.prepare("SELECT 1 FROM users WHERE name = ?").get(name);
  // who is asking: the session's user with accounts, else the claimed id
  const identify = (cookie: string | undefined, claimed: unknown) => (opts.accounts ? sessionUser(cookie) : validUser(claimed) ? claimed : undefined);

  // the page and its scripts: read and gzipped once, and again only when the file changes on disk (so editing index.html still shows on the next reload); ETag makes a repeat visit a 304
  const sent = new Map<string, { m: number; raw: Buffer; gz: Buffer; etag: string }>();
  function send(req: IncomingMessage, res: ServerResponse, file: string, type: string, cache: string, variant = "", tweak?: (text: string) => string) {
    const url = new URL(file, import.meta.url), m = statSync(url).mtimeMs, key = file + "|" + variant;
    let a = sent.get(key);
    if (!a || a.m !== m) {
      const raw = tweak ? Buffer.from(tweak(readFileSync(url, "utf8"))) : readFileSync(url);
      if (sent.size > 500) sent.clear();
      sent.set(key, (a = { m, raw, gz: gzipSync(raw), etag: `"${createHash("sha1").update(raw).digest("base64url").slice(0, 16)}"` }));
    }
    res.setHeader("vary", "accept-encoding"); res.setHeader("etag", a.etag); res.setHeader("cache-control", cache);
    if (req.headers["if-none-match"] === a.etag) return void res.writeHead(304).end();
    const gz = /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
    res.writeHead(200, { "content-type": type, ...(gz && { "content-encoding": "gzip" }) }).end(gz ? a.gz : a.raw);
  }

  function apply(a: Action, user: string): Result {
    if (a.type === "ELEMENT_CREATE") {
      const board = boardOf(a.location.parentId);
      if (!can(user, board, WRITE)) return { status: 403 };
      if (els.has(a.id)) return { status: 409 };
      const { type, channels, acl, ...el } = a; // never trust a client-supplied acl
      if (typeof el.id !== "string" || !/^[\w-]{1,64}$/.test(el.id) || !TYPES.has(el.elementType) || !isObject(el.content) || !small(el)) return { status: 400 };
      el.meta = { ...el.meta, creator: user, modifiedBy: user };
      if (el.elementType === "COMMENT_THREAD") el.content = { ...el.content, messages: [] }; // messages only ever come from COMMENT_ADD
      els.set(el.id, el); adopt(el); save(el);
      return { status: 200, boards: [board], out: { type, ...el } };
    }
    if (a.type === "ELEMENT_UPDATE") {
      // all-or-nothing: version is a compare-and-swap on the client's base version
      const boards = new Set<string>();
      for (const u of a.updates) {
        const el = els.get(u.id);
        if (!el) return { status: 404 };
        if (!isObject(u.changes) || !small({ ...el.content, ...u.changes })) return { status: 400 };
        // a root board has no parent, so its own settings (background...) are authorised by itself
        const board = el.location.parentId ? boardOf(el.location.parentId) : el.id;
        if (!can(user, board, WRITE)) return { status: 403 };
        if (el.elementType === "COMMENT_THREAD" && "messages" in u.changes) return { status: 400 }; // no rewriting or deleting messages
        if (el.meta.versionId !== u.meta.modifiedVersionId) return { status: 409 };
        boards.add(board);
        if (el.elementType === "BOARD") boards.add(el.id); // people inside the board see its own settings change live, not just its tile
      }
      batch(() => {
        for (const u of a.updates) {
          const el = els.get(u.id)!;
          Object.assign(el.content, u.changes);
          el.meta.versionId = u.meta.versionId;
          el.meta.modifiedTime = Date.now();
          save(el);
        }
      });
      return { status: 200, boards: [...boards], out: { type: a.type, updates: a.updates } };
    }
    if (a.type === "ELEMENT_MOVE_MULTI") {
      const boards = new Set<string>();
      for (const m of a.moves) {
        const el = els.get(m.id);
        if (!el) return { status: 404 };
        if (inside(m.location.parentId, m.id)) return { status: 400 };
        const from = boardOf(el.location.parentId), to = boardOf(m.location.parentId);
        if (!can(user, from, WRITE) || !can(user, to, WRITE)) return { status: 403 };
        boards.add(from); boards.add(to);
      }
      batch(() => {
        for (const m of a.moves) {
          const el = els.get(m.id)!;
          children.get(el.location.parentId)?.delete(el);
          el.location = m.location;
          adopt(el);
          el.meta.locationSectionModifiedTime = Date.now();
          save(el);
        }
      });
      return { status: 200, boards: [...boards], out: { type: a.type, moves: a.moves } };
    }
    if (a.type === "COMMENT_ADD") {
      const el = els.get(a.id);
      if (!el) return { status: 404 };
      const board = boardOf(el.location.parentId);
      if (!can(user, board, WRITE)) return { status: 403 };
      const text = typeof a.text === "string" ? a.text.trim() : "";
      const msgs = el.content.messages as { id: string; by: string; at: number; text: string }[] | undefined;
      if (el.elementType !== "COMMENT_THREAD" || !Array.isArray(msgs) || !text || text.length > 2000 || msgs.length >= 500) return { status: 400 };
      const message = { id: randomUUID().slice(0, 8), by: user, at: Date.now(), text }; // author is the authenticated user, never a client field
      msgs.push(message);
      save(el);
      return { status: 200, boards: [board], out: { type: a.type, id: a.id, message }, ack: { message } };
    }
    if (a.type === "ELEMENT_UPDATE_ACL") {
      const el = els.get(a.id);
      if (!el) return { status: 404 };
      if (!can(user, a.id, ADMIN)) return { status: 403 };
      if (!isObject(a.acl) || Object.entries(a.acl).some(([u, p]) => !validUser(u) || !Number.isInteger(p) || p < 0 || p > OWNER)) return { status: 400 };
      if (opts.accounts && Object.entries(a.acl).some(([u, p]) => p && !userExists(u))) return { status: 404 }; // no sharing with a name nobody has
      if (!el.acl) { // sharing a nested board gives it its own list (nearest acl wins), starting with whoever is sharing
        if (el.elementType !== "BOARD") return { status: 400 };
        el.acl = { [user]: OWNER };
      }
      for (const [u, p] of Object.entries(a.acl)) p ? (el.acl[u] = p) : delete el.acl[u];
      save(el);
      // revoked users stop receiving broadcasts immediately
      for (const sk of io.sockets.sockets.values())
        for (const r of sk.rooms) { const m = /^(.+)-LIVE$/.exec(r); if (m && !can(sk.data.userId, m[1], READ)) sk.leave(r); }
      return { status: 200, ack: { acl: el.acl } };
    }
    return { status: 404 };
  }

  // POST /api/media (raw body, content-type image/*) -> {id}
  function upload(req: IncomingMessage, res: ServerResponse, user: string) {
    const out = (status: number, body: unknown = {}) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    const mime = String(req.headers["content-type"] ?? "").split(";")[0].trim();
    if (!Object.hasOwn(MAGIC, mime)) return out(415);
    const now = Date.now(), mine = (uploads.get(user) ?? []).filter((t) => now - t < 60_000);
    if (mine.length >= MAX_UPLOADS_PER_MINUTE) return out(429);
    uploads.set(user, [...mine, now]);
    const chunks: Buffer[] = [];
    let size = 0;
    if (Number(req.headers["content-length"]) > MAX_MEDIA) out(413);
    // answer first, then keep discarding (so the client can read the answer) and cut the connection past 2x the cap
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 2 * MAX_MEDIA) req.destroy();
      else if (size > MAX_MEDIA) res.headersSent || out(413);
      else if (!res.headersSent) chunks.push(c);
    });
    req.on("end", () => {
      if (res.writableEnded) return;
      const data = Buffer.concat(chunks);
      if (!MAGIC[mime](data)) return out(415);
      const id = randomUUID();
      insertMedia.run(id, mime, data, user, Date.now());
      out(200, { id });
    });
    req.on("error", () => {});
  }

  // REST cold-load: GET /api/boards?ids=a,b and GET /api/boards/modified?ids=a,b (header x-user-id)
  const route = (req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url!, "http://x");
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    // HSTS only over HTTPS: either the operator says so, or the proxy in front does (x-forwarded-proto)
    if (opts.https || req.headers["x-forwarded-proto"] === "https") res.setHeader("strict-transport-security", "max-age=31536000");
    if (u.pathname === "/favicon.ico") return void res.writeHead(204).end();
    if (u.pathname === "/healthz") return void res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    if (u.pathname === "/") {
      const me = opts.accounts ? sessionUser(req.headers.cookie) : undefined, cache = opts.accounts ? "no-store" : "no-cache"; // with accounts the same address is the login page or the app, depending on the session
      if (opts.accounts && !me) return send(req, res, "./login.html", "text/html", cache);
      // the user name was checked against the sign-up pattern, so it is safe inside a script
      return send(req, res, "./index.html", "text/html", cache, me ?? "", me ? (html) => html.replace('<script src="/socket.io/socket.io.js">', `<script>window.ACCOUNT=${JSON.stringify(me)}</script>$&`) : undefined);
    }
    if (u.pathname === "/portable.js") return send(req, res, "./portable.js", "text/javascript", "no-cache"); // export / import
    if (u.pathname === "/icons.js") return send(req, res, "./icons.js", "text/javascript", "no-cache"); // the board icon library
    if (u.pathname === "/shapes.js") return send(req, res, "./shapes.js", "text/javascript", "no-cache"); // shape geometry
    const reply = (status: number, body: unknown = {}) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    // media ids are unguessable (a capability URL): <img> cannot send our identity header, so reads are public by id
    const media = /^\/api\/media\/([0-9a-f-]{36})$/.exec(u.pathname);
    if (media && req.method === "GET") {
      const row = getMedia.get(media[1]) as { mime: string; data: Uint8Array } | undefined;
      if (!row) return reply(404);
      return void res.writeHead(200, { "content-type": row.mime, "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "cache-control": "private, max-age=31536000, immutable" }).end(row.data);
    }
    if (u.pathname.startsWith("/api/auth/")) {
      if (!opts.accounts) return reply(404); // the client then falls back to a self-declared id
      const cookie = (token: string, maxAge: number) => `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${opts.https || req.headers["x-forwarded-proto"] === "https" ? "; Secure" : ""}`;
      if (u.pathname === "/api/auth/me") { const me = sessionUser(req.headers.cookie); return me ? reply(200, { user: me }) : reply(401); }
      if (req.method !== "POST") return reply(405);
      if (u.pathname === "/api/auth/logout") {
        const token = /(?:^|; )sid=([\w-]{43})/.exec(req.headers.cookie ?? "")?.[1];
        if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(sha(token));
        res.setHeader("set-cookie", cookie("", 0));
        return reply(200);
      }
      const signup = u.pathname === "/api/auth/signup";
      if (!signup && u.pathname !== "/api/auth/login") return reply(404);
      let raw = "";
      req.on("data", (c: Buffer) => { raw += c; if (raw.length > 2000) req.destroy(); });
      req.on("end", async () => {
        try {
          const b = JSON.parse(raw), name = String(b?.name ?? "").trim().toLowerCase(), pw = String(b?.password ?? "");
          if (!/^[a-z0-9_-]{3,32}$/.test(name) || pw.length < 8 || pw.length > 200) return reply(400, { error: "Name: 3-32 letters, digits, - or _. Password: at least 8 characters." });
          if (throttled(signup ? "signup:" + req.socket.remoteAddress : "login:" + name, 10)) return reply(429, { error: "Too many tries, wait a minute." });
          if (signup) {
            const salt = randomBytes(16);
            if (userExists(name)) return reply(409, { error: "That name is taken." });
            db.prepare("INSERT INTO users (name, pw) VALUES (?, ?)").run(name, salt.toString("hex") + ":" + (await scryptOf(pw, salt)).toString("hex"));
          } else {
            const row = db.prepare("SELECT pw FROM users WHERE name = ?").get(name) as { pw: string } | undefined, [salt, want] = (row?.pw ?? "00:00").split(":");
            const got = await scryptOf(pw, Buffer.from(salt, "hex")); // computed even for an unknown name, so the answer takes as long
            if (!row || !timingSafeEqual(got, Buffer.from(want, "hex"))) return reply(401, { error: "Wrong name or password." });
          }
          const token = randomBytes(32).toString("base64url");
          db.prepare("INSERT INTO sessions (token, user, at) VALUES (?, ?, ?)").run(sha(token), name, Date.now());
          res.setHeader("set-cookie", cookie(token, SESSION_MS / 1000));
          reply(200, { user: name });
        } catch { reply(400, { error: "Bad request." }); }
      });
      return;
    }
    const user = identify(req.headers.cookie, req.headers["x-user-id"]);
    if (!user) return reply(401);
    if (u.pathname === "/api/media" && req.method === "POST") return upload(req, res, user);
    if (u.pathname === "/api/users/me/app-init") return reply(200, { homeBoardId: homeOf(user) });
    if (u.pathname === "/api/tree") { // every board this user can read (not in a Trash), for the boards panel: [{id, title, parent, icon, color}]
      const boards = [...els.values()].filter((e) => e.elementType === "BOARD" && !inTrash(e) && can(user, e.id, READ));
      return reply(200, { home: homeOf(user), boards: boards.map((b) => ({ id: b.id, title: String(b.content.title ?? ""), parent: boardOf(b.location.parentId), icon: b.content.icon ?? null, color: b.content.color ?? null, owner: b.acl && b.content.rootType !== "HOME" ? Object.entries(b.acl).find(([, p]) => p === OWNER)?.[0] ?? null : null })) }); // owner: only boards that carry their own acl (shared ones)
    }
    if (u.pathname === "/api/search") { // text search across every board this user can read: [{id, board, boardTitle, type, snippet}]
      const now = Date.now(), mine = (searched.get(user) ?? []).filter((t) => now - t < 60_000), q = (u.searchParams.get("q") ?? "").trim().toLowerCase().slice(0, 100);
      if (mine.length >= MAX_SEARCHES_PER_MINUTE) return reply(429);
      searched.set(user, [...mine, now]);
      if (q.length < 2) return reply(200, { hits: [] });
      const readable = new Map<string, boolean>(), hits: Record<string, unknown>[] = [];
      for (const e of els.values()) {
        if (hits.length >= 50) break;
        if (e.content.rootType === "HOME" || e.elementType === "LINE" || e.elementType === "SKETCH") continue;
        const text = textOf(e), at = text.toLowerCase().indexOf(q);
        if (at < 0) continue;
        const board = boardOf(e.location.parentId);
        if (!board) continue;
        if (!readable.has(board)) readable.set(board, can(user, board, READ));
        if (!readable.get(board) || inTrash(e)) continue;
        hits.push({ id: e.id, board, boardTitle: String(els.get(board)?.content.title ?? ""), type: e.elementType, snippet: text.slice(Math.max(0, at - 30), at + q.length + 60), at: Math.min(at, 30) });
      }
      return reply(200, { hits });
    }
    if (u.pathname === "/api/fetch-image") { // an image address from an imported file: fetched here (same address checks as link previews) and stored like an upload
      const now = Date.now(), mine = (fetched.get(user) ?? []).filter((t) => now - t < 60_000);
      if (mine.length >= MAX_FETCHES_PER_MINUTE) return reply(429);
      fetched.set(user, [...mine, now]);
      fetchImage(u.searchParams.get("url") ?? "", opts.allowPrivateUnfurl).then((img) => {
        if (!Object.hasOwn(MAGIC, img.mime) || !MAGIC[img.mime](img.data)) return reply(422, { error: "not an image" });
        const id = randomUUID();
        insertMedia.run(id, img.mime, img.data, user, Date.now());
        reply(200, { id });
      }, () => reply(422, { error: "could not fetch" })); // one answer for every failure: the reason would show what exists on the internal network
      return;
    }
    if (u.pathname === "/api/unfurl") {
      const now = Date.now(), mine = (recent.get(user) ?? []).filter((t) => now - t < 60_000), target = u.searchParams.get("url") ?? "";
      if (mine.length >= 20) return reply(429);
      recent.set(user, [...mine, now]);
      const hit = previews.get(target);
      if (hit && now - hit.at < 600_000) return reply(200, hit.data);
      // the page's picture is fetched here and stored like an upload (same type and real-bytes checks); no picture is not an error
      const withImage = async (): Promise<Record<string, unknown>> => {
        const { image, ...p } = await unfurl(target, opts.allowPrivateUnfurl);
        if (!image) return p;
        try {
          const img = await fetchImage(image, opts.allowPrivateUnfurl);
          if (!Object.hasOwn(MAGIC, img.mime) || !MAGIC[img.mime](img.data)) return p;
          const id = randomUUID();
          insertMedia.run(id, img.mime, img.data, user, Date.now());
          return { ...p, mediaId: id };
        } catch { return p; }
      };
      withImage().then(
        (data) => { if (previews.size > 500) previews.delete(previews.keys().next().value!); previews.set(target, { at: now, data }); reply(200, data); },
        () => reply(422, { error: "could not preview" }), // always the same answer: the reason would tell a caller what exists on the internal network
      );
      return;
    }
    const ids = (u.searchParams.get("ids") ?? "").split(",").filter(Boolean);
    if (!ids.every((id) => can(user, id, READ))) return reply(403);
    const kids = (id: string) => [...(children.get(id) ?? [])];
    if (u.pathname === "/api/boards") {
      const elements: Record<string, Element> = {};
      for (const id of ids) for (const e of [els.get(id), ...kids(id)]) if (e) elements[e.id] = e;
      // what a board tile shows underneath its name: nested boards, and cards (a column's cards count, the column itself and lines do not)
      const counts: Record<string, { boards: number; cards: number }> = {};
      for (const b of Object.values(elements)) {
        if (b.elementType !== "BOARD") continue;
        let boards = 0, cards = 0;
        for (const k of children.get(b.id) ?? []) {
          if (k.elementType === "BOARD") boards++;
          else if (k.elementType === "COLUMN") cards += children.get(k.id)?.size ?? 0;
          else if (k.elementType !== "LINE") cards++;
        }
        counts[b.id] = { boards, cards };
      }
      return reply(200, { elements, counts, boardIds: ids, elementCount: Object.keys(elements).length, fetchedTime: Date.now() });
    }
    if (u.pathname === "/api/boards/modified") {
      const t = (e: Element) => Math.max(e.meta.modifiedTime, Number(e.meta.locationSectionModifiedTime ?? 0));
      return reply(200, { modifiedTimes: ids.map((id) => ({ id, modifiedTime: Math.max(0, ...[els.get(id), ...kids(id)].filter((e): e is Element => !!e).map(t)) })) });
    }
    reply(404);
  };
  const http = createHttp((req, res) => { try { route(req, res); } catch { res.writeHead(500).end(); } });
  // a page from another site must not be able to open a socket as the visitor: the Origin has to be this server or a listed one
  const io = new Server(http, {
    transports: ["websocket"],
    maxHttpBufferSize: 300_000,
    allowRequest: (req, ok) => {
      const o = req.headers.origin;
      ok(null, !o || (() => { try { return new URL(o).host === req.headers.host || (opts.origins ?? []).includes(o); } catch { return false; } })());
    },
  });
  http.listen(port, opts.host);
  io.use((s, next) => {
    const userId = identify(s.handshake.headers.cookie, s.handshake.auth?.userId);
    if (!userId) return next(new Error("unauthorized"));
    s.data.userId = userId;
    next();
  });
  io.on("connection", (s) => {
    s.on("update-channels", ({ joined = [], left = [] } = {}, ack) => {
      try {
        if (!(joined as string[]).every((c) => joinable(s.data.userId, c))) return ack?.({ status: 403 });
        joined.forEach((c: string) => s.join(c));
        left.forEach((c: string) => s.leave(c));
        ack?.({ status: 200 });
      } catch { ack?.({ status: 400 }); }
    });
    let tokens = BURST, last = Date.now(); // token bucket per connection
    s.on("action", (a: Action, ack) => {
      const now = Date.now();
      tokens = Math.min(BURST, tokens + ((now - last) / 1000) * PER_SECOND); last = now;
      if (tokens < 1) return ack?.({ status: 429 });
      tokens--;
      try {
        // rooms are derived from the elements touched, never from the client's `channels`
        const r = apply(a, s.data.userId);
        if (r.status === 200 && r.boards) s.to(r.boards.map((b) => b + "-LIVE")).emit("action", r.out);
        ack?.({ status: r.status, ...r.ack });
      } catch { ack?.({ status: 400 }); }
    });
  });

  // uploads that no image card points to (an upload the user abandoned) are deleted after a day
  const sweepMedia = (maxAge = 86_400_000) => {
    const used = new Set([...els.values()].flatMap((e) => [e.content.mediaId, e.content.previewImage]).filter((m): m is string => typeof m === "string"));
    let gone = 0;
    for (const m of db.prepare("SELECT id FROM media WHERE at < ?").all(Date.now() - maxAge) as { id: string }[])
      if (!used.has(m.id)) { db.prepare("DELETE FROM media WHERE id = ?").run(m.id); gone++; }
    return gone;
  };
  // a consistent copy of the database (safe while running), the newest 7 kept
  const backup = () => {
    if (!opts.backupDir) return;
    mkdirSync(opts.backupDir, { recursive: true });
    const file = join(opts.backupDir, `boardsync-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    for (const old of readdirSync(opts.backupDir).filter((f) => /^boardsync-.*\.db$/.test(f)).sort().slice(0, -7)) rmSync(join(opts.backupDir, old));
  };
  const dropOldSessions = () => void db.prepare("DELETE FROM sessions WHERE at < ?").run(Date.now() - SESSION_MS);
  // the per-user and per-address counters only forget a key when that key comes back, so keys seen once would stay forever
  const sweepCounters = () => {
    const now = Date.now();
    for (const m of [recent, uploads, fetched, searched, tries]) for (const [k, v] of m) if (!v.length || now - v[v.length - 1] > 60_000) m.delete(k);
    for (const [k, v] of previews) if (now - v.at > 600_000) previews.delete(k);
  };
  const timers = [setInterval(sweepMedia, 3_600_000), setInterval(backup, 6 * 3_600_000), setInterval(dropOldSessions, 3_600_000), setInterval(sweepCounters, 600_000)];
  timers.forEach((t) => t.unref());
  sweepMedia(); backup(); dropOldSessions();

  // io.close() also closes the http server; resolves once the port is free
  return { els, sweepMedia, backup, close: () => new Promise<void>((done) => { timers.forEach(clearInterval); io.close(() => { db.close(); done(); }); }) };
}

if (process.argv[1]?.endsWith("server.ts")) {
  // configuration: PORT, HOST (default: all interfaces), DB, BACKUP_DIR, ORIGINS (extra allowed websocket origins, comma separated), HTTPS=1 behind a TLS proxy
  const env = process.env;
  const s = createServer(Number(env.PORT ?? 3000), env.DB ?? "boardsync.db", { host: env.HOST, backupDir: env.BACKUP_DIR, origins: env.ORIGINS?.split(",").filter(Boolean), https: env.HTTPS === "1", accounts: env.ACCOUNTS !== "0" }); // ACCOUNTS=0: the old self-declared ids
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => void s.close().then(() => process.exit(0))); // finish and flush the database before exiting
}
