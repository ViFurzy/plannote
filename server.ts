import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createServer as createHttp, type IncomingMessage, type ServerResponse } from "node:http";
import { Server } from "socket.io";
import { unfurl, fetchImage } from "./unfurl.ts";

export type Element = {
  id: string;
  elementType: "BOARD" | "CARD" | "COLUMN" | "LINE" | "LINK" | "SKETCH" | "TABLE" | "TASK_LIST" | "DOCUMENT" | "COMMENT_THREAD" | "IMAGE";
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
const TYPES = new Set(["BOARD", "CARD", "COLUMN", "LINE", "LINK", "SKETCH", "TABLE", "TASK_LIST", "DOCUMENT", "COMMENT_THREAD", "IMAGE"]);
const MAX_ELEMENT = 200_000, BURST = 1000, PER_SECOND = 300, MAX_UPLOADS_PER_MINUTE = 30;
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

// ponytail: identity is whatever userId the client claims (socket auth / x-user-id header) — this is authorization only.
// Real authentication = verify a session (e.g. better-auth) where validUser() is called.
// SQLite is write-through: the Map serves reads, every applied change is saved as a JSON row.
export function createServer(port: number, dbFile = ":memory:", opts: { allowPrivateUnfurl?: boolean; host?: string; origins?: string[]; https?: boolean; backupDir?: string } = {}) {
  // link previews: ten minutes of cache, and at most 20 previews a minute per user
  const previews = new Map<string, { at: number; data: unknown }>(), recent = new Map<string, number[]>(), uploads = new Map<string, number[]>();
  const db = new DatabaseSync(dbFile);
  db.exec("PRAGMA journal_mode = WAL"); // readers and the writer do not block each other; also what makes a live backup safe
  db.exec("CREATE TABLE IF NOT EXISTS elements (id TEXT PRIMARY KEY, json TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL, owner TEXT NOT NULL)");
  if (!(db.prepare("PRAGMA table_info(media)").all() as { name: string }[]).some((c) => c.name === "at")) db.exec("ALTER TABLE media ADD COLUMN at INTEGER"); // upload time, for the orphan sweep
  db.prepare("UPDATE media SET at = ? WHERE at IS NULL").run(Date.now());
  const insertMedia = db.prepare("INSERT INTO media (id, mime, data, owner, at) VALUES (?, ?, ?, ?, ?)");
  const getMedia = db.prepare("SELECT mime, data FROM media WHERE id = ?");
  const upsert = db.prepare("INSERT OR REPLACE INTO elements (id, json) VALUES (?, ?)");
  const save = (e: Element) => void upsert.run(e.id, JSON.stringify(e));
  const els = new Map<string, Element>(
    (db.prepare("SELECT json FROM elements").all() as { json: string }[]).map((r) => { const e: Element = JSON.parse(r.json); return [e.id, e]; }),
  );

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
  // Each user has one HOME root board, created on first request. Ids are random and joining never creates a board,
  // so nobody can squat an id. `content.owner` (not the acl) decides whose home it is, since an acl can be shared.
  function homeOf(user: string): string {
    for (const e of els.values()) if (e.content.rootType === "HOME" && e.content.owner === user) return e.id;
    const id = randomUUID().replace(/-/g, "").slice(0, 16);
    const root: Element = { id, elementType: "BOARD", location: { parentId: "", section: "ROOT", position: { score: 0 } }, content: { title: "Home", rootType: "HOME", owner: user }, acl: { [user]: OWNER }, meta: { versionId: "server-1", modifiedTime: Date.now() } };
    els.set(id, root); save(root);
    return id;
  }
  function joinable(user: string, channel: string) {
    const m = /^(.+)-LIVE$/.exec(channel);
    return m ? can(user, m[1], READ) : channel === `${user}-PERSONAL`;
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
      els.set(el.id, el); save(el);
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
      for (const u of a.updates) {
        const el = els.get(u.id)!;
        Object.assign(el.content, u.changes);
        el.meta.versionId = u.meta.versionId;
        el.meta.modifiedTime = Date.now();
        save(el);
      }
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
      for (const m of a.moves) {
        const el = els.get(m.id)!;
        el.location = m.location;
        el.meta.locationSectionModifiedTime = Date.now();
        save(el);
      }
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
      if (!el.acl || Object.entries(a.acl).some(([u, p]) => !validUser(u) || !Number.isInteger(p) || p < 0 || p > OWNER)) return { status: 400 };
      for (const [u, p] of Object.entries(a.acl)) p ? (el.acl[u] = p) : delete el.acl[u];
      save(el);
      // revoked users stop receiving broadcasts immediately
      for (const sk of io.sockets.sockets.values())
        for (const r of sk.rooms) { const m = /^(.+)-LIVE$/.exec(r); if (m && !can(sk.data.userId, m[1], READ)) sk.leave(r); }
      return { status: 200 };
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
    if (u.pathname === "/") return void res.writeHead(200, { "content-type": "text/html" }).end(readFileSync(new URL("./index.html", import.meta.url)));
    if (u.pathname === "/portable.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(readFileSync(new URL("./portable.js", import.meta.url))); // export / import
    const reply = (status: number, body: unknown = {}) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    // media ids are unguessable (a capability URL): <img> cannot send our identity header, so reads are public by id
    const media = /^\/api\/media\/([0-9a-f-]{36})$/.exec(u.pathname);
    if (media && req.method === "GET") {
      const row = getMedia.get(media[1]) as { mime: string; data: Uint8Array } | undefined;
      if (!row) return reply(404);
      return void res.writeHead(200, { "content-type": row.mime, "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "cache-control": "private, max-age=31536000, immutable" }).end(row.data);
    }
    const user = req.headers["x-user-id"];
    if (!validUser(user)) return reply(401);
    if (u.pathname === "/api/media" && req.method === "POST") return upload(req, res, user);
    if (u.pathname === "/api/users/me/app-init") return reply(200, { homeBoardId: homeOf(user) });
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
    const kids = (id: string) => [...els.values()].filter((e) => e.location.parentId === id);
    if (u.pathname === "/api/boards") {
      const elements: Record<string, Element> = {};
      for (const id of ids) for (const e of [els.get(id), ...kids(id)]) if (e) elements[e.id] = e;
      // what a board tile shows underneath its name: nested boards, and cards (a column's cards count, the column itself and lines do not)
      const byParent = new Map<string, Element[]>();
      for (const e of els.values()) { const l = byParent.get(e.location.parentId); l ? l.push(e) : byParent.set(e.location.parentId, [e]); }
      const counts: Record<string, { boards: number; cards: number }> = {};
      for (const b of Object.values(elements)) {
        if (b.elementType !== "BOARD") continue;
        let boards = 0, cards = 0;
        for (const k of byParent.get(b.id) ?? []) {
          if (k.elementType === "BOARD") boards++;
          else if (k.elementType === "COLUMN") cards += (byParent.get(k.id) ?? []).length;
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
    const userId = s.handshake.auth?.userId;
    if (!validUser(userId)) return next(new Error("unauthorized"));
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
  const timers = [setInterval(sweepMedia, 3_600_000), setInterval(backup, 6 * 3_600_000)];
  timers.forEach((t) => t.unref());
  sweepMedia(); backup();

  // io.close() also closes the http server; resolves once the port is free
  return { els, sweepMedia, backup, close: () => new Promise<void>((done) => { timers.forEach(clearInterval); io.close(() => { db.close(); done(); }); }) };
}

if (process.argv[1]?.endsWith("server.ts")) {
  // configuration: PORT, HOST (default: all interfaces), DB, BACKUP_DIR, ORIGINS (extra allowed websocket origins, comma separated), HTTPS=1 behind a TLS proxy
  const env = process.env;
  const s = createServer(Number(env.PORT ?? 3000), env.DB ?? "boardsync.db", { host: env.HOST, backupDir: env.BACKUP_DIR, origins: env.ORIGINS?.split(",").filter(Boolean), https: env.HTTPS === "1" });
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => void s.close().then(() => process.exit(0))); // finish and flush the database before exiting
}
