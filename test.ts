import { io } from "socket.io-client";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { createServer } from "./server.ts";
import { isPrivateAddress } from "./unfurl.ts";

const R = 1, W = 2, ADMIN = 4;
const srv = createServer(3999);
const connect = (userId: string, port = 3999) =>
  new Promise<any>((res) => { const c = io(`ws://localhost:${port}`, { transports: ["websocket"], auth: { userId } }); c.on("connect", () => res(c)); });
const emit = (c: any, ev: string, p: any) => new Promise<any>((res) => c.emit(ev, p, res));
const act = async (c: any, a: any) => (await emit(c, "action", a)).status;
const join = async (c: any, board: string) => (await emit(c, "update-channels", { joined: [board + "-LIVE"] })).status;
const next = (c: any) => new Promise<any>((res) => c.once("action", res));
const silent = (c: any) => new Promise<boolean>((res) => { const f = () => res(false); c.once("action", f); setTimeout(() => { c.off("action", f); res(true); }, 300); });
const rest = async (p: string, user?: string, port = 3999) => { const r = await fetch(`http://localhost:${port}${p}`, { headers: user ? { "x-user-id": user } : {} }); return { status: r.status, body: (await r.json()) as any }; };
const home = async (user: string, port = 3999) => (await rest("/api/users/me/app-init", user, port)).body.homeBoardId as string;
const ids = async (p: string, user: string) => Object.keys((await rest(p, user)).body.elements);

// link previews: the server must never be a way into the network it sits on
const blocked = ["127.0.0.1", "127.1.2.3", "10.0.0.5", "172.16.0.1", "172.31.255.254", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
  "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "::ffff:10.1.2.3", "64:ff9b::7f00:1", "not-an-ip"];
for (const ip of blocked) assert.equal(isPrivateAddress(ip), true, ip + " must be refused");
for (const ip of ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "192.169.0.1", "100.63.0.1", "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) assert.equal(isPrivateAddress(ip), false, ip + " is public");
const prev = (u: string, user?: string) => fetch(`http://localhost:3999/api/unfurl?url=${encodeURIComponent(u)}`, { headers: user ? { "x-user-id": user } : {} });
assert.equal((await prev("https://example.com/")).status, 401, "previews need an identity");
for (const u of ["http://127.0.0.1/", "http://localhost/", "http://[::1]/", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.1/", "http://0x7f.1/", "http://2130706433/", "http://127.0.0.1:22/", "http://example.com:22/", "ftp://example.com/", "file:///etc/passwd", "javascript:alert(1)", "http://user:pw@example.com/", "not a url"]) {
  const r = await prev(u, "pv");
  assert.equal(r.status, 422, u + " must be refused");
  assert.deepEqual(await r.json(), { error: "could not preview" }, "the refusal gives nothing away");
}
// a real fetch, against a local page (the test server is started with private addresses allowed; production never is)
const { createServer: createHttp } = await import("node:http");
const page = createHttp((req, res) => {
  if (req.url === "/page") res.writeHead(200, { "content-type": "text/html" }).end('<html><head><title>Ignored &amp; replaced</title><meta property="og:title" content="Fish &amp; Chips &#8211; the book"><meta name="description" content="A  short\n description &lt;b&gt;"><meta property="og:site_name" content="Chippy"></head><body>' + "x".repeat(900_000) + "</body></html>");
  else if (req.url === "/hop") res.writeHead(302, { location: "/page" }).end();
  else if (req.url === "/loop") res.writeHead(302, { location: "/loop" }).end();
  else if (req.url === "/shop") res.writeHead(200, { "content-type": "text/html" }).end('<title>Teapot</title><meta property="og:image" content="/pic.png">');
  else if (req.url === "/shop2") res.writeHead(200, { "content-type": "text/html" }).end('<title>Fake</title><meta property="og:image" content="/fake.png">');
  else if (req.url === "/pic.png") res.writeHead(200, { "content-type": "image/png" }).end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  else if (req.url === "/fake.png") res.writeHead(200, { "content-type": "image/png" }).end("<script>alert(1)</script>");
  else if (req.url === "/img") res.writeHead(200, { "content-type": "image/png" }).end(Buffer.from("png"));
  else res.writeHead(404).end("nope");
}).listen(3996);
const pvSrv = createServer(3995, ":memory:", { allowPrivateUnfurl: true });
const pv = async (path: string, user = "pv2") => { const r = await fetch(`http://localhost:3995/api/unfurl?url=${encodeURIComponent("http://127.0.0.1:3996" + path)}`, { headers: { "x-user-id": user } }); return { status: r.status, body: (await r.json()) as any }; };
const got1 = await pv("/page");
assert.equal(got1.status, 200);
assert.deepEqual(got1.body, { title: "Fish & Chips – the book", description: "A short description <b>", site: "Chippy" }, "og tags win, entities decoded, whitespace tidied, a 900 KB page does not hang it");
assert.equal((await pv("/hop")).body.site, "Chippy", "a redirect is followed");
assert.equal((await pv("/loop")).status, 422, "a redirect loop gives up");
assert.deepEqual((await pv("/img")).body, { site: "127.0.0.1" }, "a non-HTML answer gives just the site");
assert.equal((await pv("/missing")).status, 422);
// product pictures: fetched by the server, checked like an upload, stored; a bad picture just means no picture
const shop = await pv("/shop"), pic = shop.body.mediaId as string;
assert.equal(shop.body.title, "Teapot"); assert.match(pic, /^[0-9a-f-]{36}$/, "the og:image was downloaded and stored");
assert.equal((await fetch("http://localhost:3995/api/media/" + pic)).headers.get("content-type"), "image/png");
assert.equal((await pv("/shop2")).body.mediaId, undefined, "bytes that are not an image are dropped");
assert.equal(shop.body.image, undefined, "the remote address is not passed on");
{
  const { parsePreview } = await import("./unfurl.ts"), base = new URL("https://shop.example/a/b");
  assert.equal(parsePreview('<meta property="og:image" content="/x.jpg">', base).image, "https://shop.example/x.jpg", "relative address resolved");
  assert.equal(parsePreview('<script type="application/ld+json">{"@type":"Product","image":["https:\/\/cdn.example\/p.jpg","b"]}</script>', base).image, "https://cdn.example/p.jpg", "schema.org product picture");
  assert.equal(parsePreview('<meta property="og:image" content="javascript:alert(1)">', base).image, undefined, "only http(s)");
  assert.equal(parsePreview('<meta name="twitter:image" content="https://t.example/t.png"><meta property="og:image" content="https://o.example/o.png">', base).image, "https://o.example/o.png", "og first");
}
let limited = 0; for (let i = 0; i < 25; i++) if ((await pv("/page", "spammer")).status === 429) limited++;
assert.ok(limited >= 5, "more than 20 previews a minute from one user are refused, got " + limited + " refusals");
await pvSrv.close(); page.close();

// the export / import script is served as JavaScript
const portable = await fetch("http://localhost:3999/portable.js");
assert.equal(portable.status, 200);
assert.match(portable.headers.get("content-type") ?? "", /javascript/);
assert.match(await portable.text(), /boardsync-board/, "serves the real export/import code");

// home boards: random, per-user, idempotent; needs an identity
const B1 = await home("alice"), B2 = await home("erin");
assert.match(B1, /^[0-9a-f]{16}$/, "random id");
assert.notEqual(B1, B2, "one home per user");
assert.equal(await home("alice"), B1, "app-init is idempotent");
assert.equal((await rest("/api/users/me/app-init")).status, 401, "app-init needs an identity");

const mk = (id: string, parentId = B1) => ({ id, elementType: "CARD", location: { parentId, section: "CANVAS", position: { x: 62, y: 36, score: 65536 } }, content: { textContent: null }, meta: { versionId: "A-1", modifiedTime: 0 } });

// identity: a socket without a valid userId is refused
const anon = io("ws://localhost:3999", { transports: ["websocket"], auth: {} });
await new Promise<void>((res) => anon.on("connect_error", () => res()));
anon.close();

const [alice, bob, carol, dave] = await Promise.all(["alice", "bob", "carol", "dave"].map((u) => connect(u)));

// no squatting: joining never creates or claims a board
assert.equal(await join(alice, B1), 200, "owner joins home");
assert.equal(await join(dave, "fresh-id"), 403, "unknown board id is refused");
assert.equal(srv.els.has("fresh-id"), false, "joining did not create it");
assert.equal(await join(dave, B1), 403, "another user's home is refused");
assert.equal(await join(bob, B1), 403, "bob has no access yet");
assert.equal((await rest(`/api/boards?ids=${B1}`)).status, 401, "REST without identity");
assert.equal((await rest(`/api/boards?ids=${B1}`, "bob")).status, 403, "REST without READ");
assert.equal((await rest(`/api/boards?ids=${B1}`, "alice")).status, 200);

// only ADMIN can change the acl
assert.equal(await act(bob, { type: "ELEMENT_UPDATE_ACL", id: B1, acl: { bob: 7 } }), 403, "no self-grant");
assert.equal(await act(alice, { type: "ELEMENT_UPDATE_ACL", id: B1, acl: { bob: R | W, carol: R } }), 200);
assert.equal(await act(bob, { type: "ELEMENT_UPDATE_ACL", id: B1, acl: { bob: R | W | ADMIN } }), 403, "WRITE is not ADMIN");
assert.equal(await home("bob") === B1, false, "being granted a board does not make it your home");
assert.equal(await join(bob, B1), 200);
assert.equal(await join(carol, B1), 200);

// create: broadcast to members, client-supplied acl is dropped
const seen = next(bob);
assert.equal(await act(alice, { type: "ELEMENT_CREATE", channels: [B1 + "-LIVE"], ...mk("n1"), acl: { dave: 7 } }), 200);
const got = await seen;
assert.equal(got.id, "n1", "bob receives alice's create");
assert.equal(got.acl, undefined, "forged acl not broadcast");
assert.equal(srv.els.get("n1")!.acl, undefined, "forged acl not stored");
assert.equal(srv.els.get("n1")!.meta.creator, "alice", "creator is the authenticated user");

// update: CAS conflict, and read-only users cannot write
const upd = (base: string, v: string, text: string) => ({ type: "ELEMENT_UPDATE", updates: [{ id: "n1", changes: { textContent: text }, meta: { modifiedVersionId: base, versionId: v } }] });
assert.equal(await act(alice, upd("A-1", "A-2", "hi")), 200);
assert.equal(await act(bob, upd("A-1", "B-2", "stale")), 409, "stale base rejected");
assert.equal(await act(carol, upd("A-2", "C-3", "nope")), 403, "READ-only cannot update");
assert.equal(await act(carol, { type: "ELEMENT_CREATE", ...mk("c1") }), 403, "READ-only cannot create");
assert.equal(await act(dave, { type: "ELEMENT_CREATE", channels: [B1 + "-LIVE"], ...mk("d1") }), 403, "outsider cannot write, even naming the room");

// forged channels do not redirect a broadcast; rooms come from the element's board
const erin = await connect("erin"); // only ever in B2
assert.equal(await join(erin, B2), 200);
const stray = silent(erin);
assert.equal(await act(bob, { type: "ELEMENT_CREATE", channels: [B2 + "-LIVE"], ...mk("n2") }), 200);
assert.equal(await stray, true, "B2 room did not get a B1 action");
erin.close();

// trash move; moving into a board you cannot write is refused
const trash = { parentId: B1 + "-trash", section: "TRASH", position: { score: 65536, addedDate: 1, restoreLocation: mk("n1").location } };
assert.equal(await act(bob, { type: "ELEMENT_MOVE_MULTI", moves: [{ id: "n1", location: trash }] }), 200);
assert.equal(await act(bob, { type: "ELEMENT_MOVE_MULTI", moves: [{ id: "n2", location: { ...mk("n2").location, parentId: B2 } }] }), 403, "no write on B2");
assert.equal(await act(alice, { type: "bogus" }), 404);
assert.equal(await act(alice, null), 400, "malformed payload does not crash the server");
const n = srv.els.get("n1")!;
assert.equal(n.content.textContent, "hi");
assert.equal(n.meta.versionId, "A-2");
assert.equal(n.location.section, "TRASH");

// REST load sees the trashed card under the trash parent, per the reader's board
assert.equal((await rest(`/api/boards?ids=${B1}-trash`, "carol")).body.elements.n1.content.textContent, "hi");
assert.deepEqual((await ids(`/api/boards?ids=${B1}`, "alice")).filter((k) => k !== B1), ["n2"], "n2 stays; n1 is in the trash");
assert.ok((await rest(`/api/boards/modified?ids=${B1}-trash`, "alice")).body.modifiedTimes[0].modifiedTime > 0, "modified endpoint");

// a trashed column keeps its cards; restoring the column brings them back
const col = { ...mk("col1"), elementType: "COLUMN", content: { title: "C" } };
assert.equal(await act(alice, { type: "ELEMENT_CREATE", ...col }), 200);
const inCol = { ...mk("k1", "col1"), location: { parentId: "col1", section: "COLUMN", position: { score: 65536 } } };
assert.equal(await act(alice, { type: "ELEMENT_CREATE", ...inCol }), 200);
assert.equal(await act(carol, { type: "ELEMENT_CREATE", ...inCol, id: "k2" }), 403, "column children need WRITE on the column's board");
const colTrash = { parentId: B1 + "-trash", section: "TRASH", position: { score: 65536, addedDate: 2, restoreLocation: col.location } };
assert.equal(await act(alice, { type: "ELEMENT_MOVE_MULTI", moves: [{ id: "col1", location: colTrash }] }), 200);
assert.ok((await ids(`/api/boards?ids=${B1}-trash`, "alice")).includes("col1"), "column is listed in the trash");
assert.ok(!(await ids(`/api/boards?ids=${B1}-trash`, "alice")).includes("k1"), "its card is not listed separately");
assert.ok(!(await ids(`/api/boards?ids=${B1}`, "alice")).includes("col1"), "column is gone from the board");
assert.ok((await ids("/api/boards?ids=col1", "alice")).includes("k1"), "card is still attached to the column");
assert.equal(await act(alice, { type: "ELEMENT_MOVE_MULTI", moves: [{ id: "col1", location: col.location }] }), 200);
assert.ok((await ids(`/api/boards?ids=${B1}`, "alice")).includes("col1"), "restored");

// a column cycle is refused and cannot take the server down
const col2 = { ...mk("col2"), elementType: "COLUMN", content: { title: "D" } };
assert.equal(await act(alice, { type: "ELEMENT_CREATE", ...col2 }), 200);
const into = (id: string, parentId: string) => act(alice, { type: "ELEMENT_MOVE_MULTI", moves: [{ id, location: { parentId, section: "COLUMN", position: { score: 1 } } }] });
assert.equal(await into("col1", "col2"), 200, "column in column");
assert.equal(await into("col2", "col1"), 400, "cycle refused");
assert.equal(await into("col1", "col1"), 400, "an element cannot go inside itself");
assert.equal((await rest("/api/boards?ids=col1", "alice")).status, 200, "both columns stay reachable");

// board tiles: server-computed counts; board-level settings are authorised and broadcast correctly
const sub = { ...mk("sub1"), elementType: "BOARD", content: { title: "Sub" } };
assert.equal(await act(alice, { type: "ELEMENT_CREATE", ...sub }), 200);
const inSub = (id: string, elementType: string, parentId = "sub1") => ({ ...mk(id, parentId), elementType });
for (const e of [inSub("s-card", "CARD"), inSub("s-line", "LINE"), inSub("s-board", "BOARD"), inSub("s-col", "COLUMN"), inSub("s-k1", "CARD", "s-col"), inSub("s-k2", "CARD", "s-col"), inSub("s-gone", "CARD")])
  assert.equal(await act(alice, { type: "ELEMENT_CREATE", ...e }), 200);
assert.equal(await act(alice, { type: "ELEMENT_MOVE_MULTI", moves: [{ id: "s-gone", location: { parentId: "sub1-trash", section: "TRASH", position: { score: 1 } } }] }), 200);
const tally = (await rest(`/api/boards?ids=${B1}`, "alice")).body.counts;
assert.deepEqual(tally.sub1, { boards: 1, cards: 3 }, "1 nested board; 1 card + 2 cards inside the column; the line, the column itself and the trashed card are not counted");
const setting = (id: string, changes: object, base: string, v: string) => ({ type: "ELEMENT_UPDATE", updates: [{ id, changes, meta: { modifiedVersionId: base, versionId: v } }] });
assert.equal(await act(alice, setting(B1, { bg: "grid" }, "server-1", "A-r1")), 200, "the owner can change the root board's own background");
assert.equal(await act(bob, setting(B1, { bg: "plain" }, "A-r1", "B-r2")), 200, "a writer can too");
assert.equal(await act(carol, setting(B1, { bg: "dots" }, "B-r2", "C-r3")), 403, "a read-only member cannot");
assert.equal(await act(dave, setting(B1, { bg: "dots" }, "B-r2", "D-r3")), 403, "an outsider cannot");
const inside: any[] = [];
carol.on("action", (a: any) => inside.push(a));
assert.equal(await join(carol, "sub1"), 200, "carol also joins the nested board's room");
assert.equal(await act(alice, setting("sub1", { color: "teal" }, "A-1", "A-s2")), 200);
await new Promise((r) => setTimeout(r, 300));
assert.ok(inside.some((a) => a.type === "ELEMENT_UPDATE" && a.updates[0].id === "sub1"), "a nested board's settings reach people inside it");

// comments: author and time are stamped by the server; append-only; forged input is ignored
const thread = { ...mk("cm1"), elementType: "COMMENT_THREAD", content: { messages: [{ id: "x", by: "mallory", at: 1, text: "forged" }] } };
const threadSeen = next(bob);
assert.equal(await act(alice, { type: "ELEMENT_CREATE", ...thread }), 200);
await threadSeen;
assert.deepEqual(srv.els.get("cm1")!.content.messages, [], "a thread cannot be created with preloaded messages");
const commentSeen = next(bob);
const posted = await emit(alice, "action", { type: "COMMENT_ADD", id: "cm1", text: "  hello  ", by: "mallory" });
assert.equal(posted.status, 200);
assert.equal(posted.message.by, "alice", "author comes from the authenticated user, not the payload");
assert.equal(posted.message.text, "hello", "text is trimmed");
assert.ok(Math.abs(posted.message.at - Date.now()) < 5000, "time is stamped by the server");
const heard = await commentSeen;
assert.equal(heard.type, "COMMENT_ADD");
assert.equal(heard.message.by, "alice", "members receive the stamped message");
assert.equal(await act(carol, { type: "COMMENT_ADD", id: "cm1", text: "nope" }), 403, "READ-only cannot comment");
assert.equal(await act(dave, { type: "COMMENT_ADD", id: "cm1", text: "nope" }), 403, "outsider cannot comment");
assert.equal(await act(alice, { type: "ELEMENT_UPDATE", updates: [{ id: "cm1", changes: { messages: [] }, meta: { modifiedVersionId: "A-1", versionId: "A-9" } }] }), 400, "messages cannot be rewritten through an update");
assert.equal(await act(alice, { type: "COMMENT_ADD", id: "cm1", text: "   " }), 400, "empty comment");
assert.equal(await act(alice, { type: "COMMENT_ADD", id: "cm1", text: "x".repeat(2001) }), 400, "over the length cap");
assert.equal(await act(alice, { type: "COMMENT_ADD", id: "n1", text: "hi" }), 400, "only comment threads take comments");
assert.deepEqual(await Promise.all([act(alice, { type: "COMMENT_ADD", id: "cm1", text: "one" }), act(bob, { type: "COMMENT_ADD", id: "cm1", text: "two" })]), [200, 200]);
const kept = (srv.els.get("cm1")!.content.messages as { by: string }[]).map((m) => m.by).sort();
assert.deepEqual(kept, ["alice", "alice", "bob"], "simultaneous comments are both kept");

// media: authenticated upload, real-bytes check, size cap, public-by-id read
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const post = (body: Buffer | string, type: string, user?: string, port = 3999) =>
  fetch(`http://localhost:${port}/api/media`, { method: "POST", headers: { "content-type": type, ...(user ? { "x-user-id": user } : {}) }, body });
assert.equal((await post(PNG, "image/png")).status, 401, "upload needs an identity");
assert.equal((await post("<html></html>", "text/html", "alice")).status, 415, "only images");
assert.equal((await post("<html><script>alert(1)</script></html>", "image/png", "alice")).status, 415, "declared type must match the bytes");
assert.equal((await post(Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]), "image/png", "alice")).status, 413, "size cap");
const up = await post(PNG, "image/png", "alice");
assert.equal(up.status, 200);
const mediaId = ((await up.json()) as any).id as string;
const served = await fetch(`http://localhost:3999/api/media/${mediaId}`);
assert.equal(served.status, 200);
assert.equal(served.headers.get("content-type"), "image/png");
assert.equal(served.headers.get("x-content-type-options"), "nosniff");
assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG, "bytes round-trip");
assert.equal((await fetch("http://localhost:3999/api/media/00000000-0000-0000-0000-000000000000")).status, 404);

// revoke: bob stops receiving broadcasts and loses write access
assert.equal(await act(alice, { type: "ELEMENT_UPDATE_ACL", id: B1, acl: { bob: 0 } }), 200);
const quiet = silent(bob);
assert.equal(await act(alice, { type: "ELEMENT_CREATE", ...mk("n3") }), 200);
assert.equal(await quiet, true, "revoked user is kicked from the room");
assert.equal(await act(bob, { type: "ELEMENT_CREATE", ...mk("n4") }), 403);
assert.equal((await rest(`/api/boards?ids=${B1}`, "bob")).status, 403);
for (const c of [alice, bob, carol, dave]) c.close();
await srv.close();

// persistence: state, acl and the home board written by one server instance are loaded by the next
const dir = mkdtempSync(pathJoin(tmpdir(), "bs-"));
const file = pathJoin(dir, "t.db");
const s1 = createServer(3998, file);
const P = await home("owner", 3998);
const o = await connect("owner", 3998);
assert.equal(await join(o, P), 200);
assert.equal(await act(o, { type: "ELEMENT_CREATE", ...mk("p1", P), meta: { versionId: "P-1", modifiedTime: 0 } }), 200);
assert.equal(await act(o, { type: "ELEMENT_UPDATE", updates: [{ id: "p1", changes: { textContent: "kept" }, meta: { modifiedVersionId: "P-1", versionId: "P-2" } }] }), 200);
const pid = ((await (await post(PNG, "image/png", "owner", 3998)).json()) as any).id as string;
o.close(); await s1.close();
const s2 = createServer(3998, file);
assert.equal(s2.els.get("p1")?.content.textContent, "kept", "element survives restart");
assert.equal(s2.els.get("p1")?.meta.versionId, "P-2", "version survives restart");
assert.deepEqual(s2.els.get(P)?.acl, { owner: 7 }, "acl survives restart");
assert.equal(await home("owner", 3998), P, "home board survives restart");
assert.equal((await fetch(`http://localhost:3998/api/media/${pid}`)).status, 200, "uploaded image survives restart");
await s2.close(); rmSync(dir, { recursive: true });

console.log("ok: home boards, no squatting, acl grant/revoke, READ/WRITE/ADMIN, forged acl+channels, CAS, trash, column trash/restore, column cycle, board tiles (counts, root settings, nested broadcast), comments (server-stamped author, append-only, forgery, permissions, simultaneous posts), image upload (auth, type, real bytes, size cap, round trip), REST authz, persistence");

// hardening: security headers, origin check, size caps, flood limit, orphan sweep, backups
{
  const hdir = mkdtempSync(pathJoin(tmpdir(), "bs-h-"));
  const hs = createServer(3993, pathJoin(hdir, "h.db"), { backupDir: pathJoin(hdir, "backups"), origins: ["https://app.example"] });
  const html = await fetch("http://localhost:3993/");
  assert.match(html.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(html.headers.get("x-content-type-options"), "nosniff");
  assert.equal(html.headers.get("strict-transport-security"), null, "no HSTS over plain http");
  assert.ok((await fetch("http://localhost:3993/", { headers: { "x-forwarded-proto": "https" } })).headers.get("strict-transport-security"), "HSTS behind a TLS proxy");
  assert.equal(await (await fetch("http://localhost:3993/healthz")).text(), "ok");

  const withOrigin = (origin?: string) => new Promise<boolean>((res) => {
    const c = io("ws://localhost:3993", { transports: ["websocket"], auth: { userId: "hx" }, extraHeaders: origin ? { origin } : {} });
    c.on("connect", () => { c.close(); res(true); }); c.on("connect_error", () => { c.close(); res(false); });
  });
  assert.equal(await withOrigin(), true, "no Origin (not a browser)");
  assert.equal(await withOrigin("http://localhost:3993"), true, "this server's own page");
  assert.equal(await withOrigin("https://app.example"), true, "a listed origin");
  assert.equal(await withOrigin("https://evil.example"), false, "another site cannot open a socket as the visitor");

  const hc = await connect("hx", 3993), HB = await home("hx", 3993);
  const el = (id: string, content: any = {}, over: any = {}) => ({ type: "ELEMENT_CREATE", id, elementType: "CARD", location: { parentId: HB, section: "CANVAS", position: { score: 1, x: 0, y: 0 } }, content, meta: { versionId: id + "-1", modifiedTime: 0 }, ...over });
  assert.equal(await act(hc, el("ok1", { textContent: "hi" })), 200);
  assert.equal(await act(hc, el("big1", { textContent: "x".repeat(250_000) })), 400, "an element over 200 KB is refused (and the 300 KB socket cap would drop anything larger)");
  assert.equal(await act(hc, el("bad type", {}, {})), 400, "ids are plain tokens");
  assert.equal(await act(hc, el("t1", {}, { elementType: "NOPE" })), 400, "unknown element type");
  assert.equal(await act(hc, el("t2", "text" as any)), 400, "content must be an object");
  const grow = (n: number) => ({ type: "ELEMENT_UPDATE", updates: [{ id: "ok1", changes: { textContent: "y".repeat(n) }, meta: { modifiedVersionId: "ok1-1", versionId: "ok1-2" } }] });
  assert.equal(await act(hc, grow(250_000)), 400, "an update cannot grow an element past the cap");
  assert.equal(await act(hc, grow(10)), 200, "and the refused one changed nothing (version still ok1-1)");

  // flood: a thousand-action burst is fine, then the connection is told to slow down
  const rs = await Promise.all(Array.from({ length: 1300 }, (_, i) => emit(hc, "action", el("f" + i))));
  assert.ok(rs.filter((r) => r.status === 200).length >= 900, "bulk work (a big paste or import) goes through");
  assert.ok(rs.some((r) => r.status === 429), "a flood is limited");

  // uploads: rate limit, then the orphan sweep keeps referenced images and drops abandoned ones
  const used = ((await (await post(PNG, "image/png", "hx", 3993)).json()) as any).id as string, lost = ((await (await post(PNG, "image/png", "hx", 3993)).json()) as any).id as string;
  assert.equal(await act(hc, { ...el("img1", { mediaId: used }), elementType: "IMAGE" }), 200);
  assert.equal(hs.sweepMedia(), 0, "fresh uploads are kept for a day");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(hs.sweepMedia(10), 1, "one abandoned upload removed");
  assert.equal((await fetch(`http://localhost:3993/api/media/${used}`)).status, 200, "the used image stays");
  assert.equal((await fetch(`http://localhost:3993/api/media/${lost}`)).status, 404, "the abandoned one is gone");
  let limitedUp = 0; for (let i = 0; i < 35; i++) if ((await post(PNG, "image/png", "uploader", 3993)).status === 429) limitedUp++;
  assert.ok(limitedUp >= 5, "more than 30 uploads a minute from one user are refused, got " + limitedUp);

  // backups: a real, loadable copy of the database; only the newest 7 stay
  for (let i = 0; i < 8; i++) { hs.backup(); await new Promise((r) => setTimeout(r, 5)); }
  const { readdirSync } = await import("node:fs");
  const copies = readdirSync(pathJoin(hdir, "backups"));
  assert.equal(copies.length, 7, "old backups are pruned");
  const { DatabaseSync } = await import("node:sqlite");
  const copy = new DatabaseSync(pathJoin(hdir, "backups", copies.at(-1)!));
  assert.ok((copy.prepare("SELECT count(*) AS n FROM elements WHERE id = 'ok1'").get() as any).n === 1, "the backup holds the data");
  copy.close();
  hc.close(); await hs.close(); rmSync(hdir, { recursive: true });
  console.log("ok: hardening (security headers, origin check, size caps, flood limit, upload limit, orphan sweep, backups)");
}
