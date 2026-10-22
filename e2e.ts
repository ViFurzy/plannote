// End-to-end tests: a real Chrome driven with genuine mouse and keyboard input (Playwright's driver, no bundled browser).
// Run with `npm run e2e`. Each test gets a fresh user, so it starts on an empty home board.
import { chromium, type Page, type BrowserContext } from "playwright-core";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./server.ts";

const PORT = 3997, URL = `http://localhost:${PORT}`;
const srv = createServer(PORT, ":memory:", { allowPrivateUnfurl: true }); // so link previews can be tested against a local page
const pages = (await import("node:http")).createServer((req, res) => {
  if (req.url === "/pic.png") return void res.writeHead(200, { "content-type": "image/png" }).end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  res.writeHead(200, { "content-type": "text/html" }).end('<meta property="og:image" content="/pic.png"><title>Fallback title</title><meta property="og:title" content="A Real Page"><meta name="description" content="What it is about"><meta property="og:site_name" content="Example Site">');
}).listen(3994);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const shots = mkdtempSync(join(tmpdir(), "e2e-"));
let n = 0;

type T = { page: Page; ctx: BrowserContext; user: string };
async function fresh(user = `e2e${Date.now().toString(36)}${n++}`, hash = "", waitLive = true): Promise<T> {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  (page as any).errors = errors;
  await page.goto(`${URL}/?u=${user}${hash}`);
  if (waitLive) await page.waitForFunction(() => (document.getElementById("st") as HTMLElement).dataset.state === "live");
  return { page, ctx, user };
}
const box = async (page: Page, sel: string) => { const b = await page.locator(sel).first().boundingBox(); if (!b) throw new Error("not visible: " + sel); return b; };
const mid = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
async function drag(page: Page, a: { x: number; y: number }, b: { x: number; y: number }, steps = 12) {
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps }); await page.mouse.up();
}
const model = (page: Page) => page.evaluate(() => Object.values((window as any).__els()) as any[]);
// what the SERVER holds for the board being viewed (not just what the page thinks)
const stored = (page: Page) => page.evaluate(async () => Object.values((await (await fetch("/api/boards?ids=" + (0, eval)("B"), { headers: { "x-user-id": (0, eval)("uid") } })).json()).elements) as any[]);
const settle = (page: Page, ms = 600) => page.waitForTimeout(ms);
const add = async (page: Page, tool: string, text?: string) => { await page.click("#" + tool); if (text) await page.keyboard.type(text); await page.keyboard.press("Escape"); await settle(page, 400); };

const results: { name: string; ok: boolean; err?: string }[] = [];
async function test(name: string, fn: (t: T) => Promise<void>) {
  const t = await fresh();
  try {
    await fn(t);
    const errs = (t.page as any).errors as string[];
    assert.deepEqual(errs, [], "page errors: " + errs.join(" | "));
    results.push({ name, ok: true }); console.log("  ok   " + name);
  } catch (e: any) {
    results.push({ name, ok: false, err: e.message });
    console.log("  FAIL " + name + "\n       " + String(e.message).split("\n").slice(0, 6).join("\n       ") + "\n       " + String(e.stack).split("\n").find((l) => l.includes("e2e.ts"))?.trim());
    await t.page.screenshot({ path: join(shots, name.replace(/\W+/g, "-") + ".png") }).catch(() => {});
  } finally { await t.ctx.close(); }
}
const within = (v: number, want: number, tol: number, what: string) => assert.ok(Math.abs(v - want) <= tol, `${what}: got ${v}, wanted ${want} (+-${tol})`);

console.log("end-to-end tests (real Chrome, real mouse and keyboard)");

await test("note: create, type, and the server stores it", async ({ page }) => {
  await add(page, "note", "hello e2e");
  assert.ok((await stored(page)).some((e) => e.content.textContent === "hello e2e"));
});

await test("drag a note with the mouse; a second tab of the same user sees it move live", async ({ page, ctx, user }) => {
  await add(page, "note", "drag me");
  const other = await ctx.newPage();
  await other.goto(`${URL}/?u=${user}`); await other.waitForFunction(() => (document.getElementById("st") as HTMLElement).dataset.state === "live");
  const a = mid(await box(page, ".note"));
  await drag(page, a, { x: a.x + 240, y: a.y + 160 });
  await settle(page, 900);
  const moved = await box(page, ".note"), there = await box(other, ".note");
  within(moved.x, 110 + 240, 4, "x on this tab"); within(there.x, moved.x, 2, "x on the other tab"); within(there.y, moved.y, 2, "y on the other tab");
  const s = (await stored(page)).find((e) => e.elementType === "CARD");
  within(s.location.position.x, 350, 4, "x stored on the server");
});

await test("column: drop a note in, drag it back out", async ({ page }) => {
  await add(page, "note", "inside"); await add(page, "col", "Todo");
  const note = mid(await box(page, ".note")), col = await box(page, ".column");
  await drag(page, note, { x: col.x + 60, y: col.y + 50 });
  await page.waitForSelector(".column .kids .note");
  const kid = mid(await box(page, ".column .kids .note"));
  await drag(page, kid, { x: 1100, y: 600 });
  await page.waitForSelector("#canvas > .note");
  assert.equal(await page.locator(".column .kids .note").count(), 0);
  within((await box(page, "#canvas > .note")).x, 1100, 160, "landed near the drop point");
});

await test("selection box with the mouse, group drag, then Delete and undo", async ({ page }) => {
  await add(page, "note", "a"); await add(page, "note", "b"); await add(page, "note", "c");
  const cards = await page.locator("#canvas > .note").evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }));
  const l = Math.min(...cards.map((c) => c.x)), t = Math.min(...cards.map((c) => c.y)), r = Math.max(...cards.map((c) => c.x + c.w)), b = Math.max(...cards.map((c) => c.y + c.h));
  await drag(page, { x: l - 18, y: t - 18 }, { x: r + 18, y: b + 18 });
  assert.equal(await page.locator(".card.selected").count(), 3, "marquee selected all three");
  const before = await page.locator("#canvas > .note").first().boundingBox();
  await drag(page, mid(before!), { x: mid(before!).x + 150, y: mid(before!).y + 90 });
  await settle(page);
  const after = await page.locator("#canvas > .note").first().boundingBox();
  within(after!.x - before!.x, 150, 4, "group moved together");
  await page.keyboard.press("Delete"); await settle(page);
  assert.equal(await page.locator("#canvas > .note").count(), 0);
  await page.keyboard.press("Control+z"); await settle(page, 900);
  assert.equal(await page.locator("#canvas > .note").count(), 3, "one undo brought all three back");
});

await test("drag a note onto Trash, then Restore it from the panel", async ({ page }) => {
  await add(page, "note", "bin me");
  await drag(page, mid(await box(page, ".note")), mid(await box(page, "#trashBtn")));
  await settle(page, 900);
  assert.equal(await page.locator("#canvas > .note").count(), 0);
  await page.click("#trashBtn"); await page.getByRole("button", { name: "Restore" }).click(); await settle(page, 900);
  assert.equal(await page.locator("#canvas > .note").count(), 1);
});

await test("zoom with ctrl+wheel and pan with the wheel; the view is remembered after a reload", async ({ page }) => {
  await add(page, "note", "zoom");
  await page.mouse.move(700, 400);
  await page.keyboard.down("Control"); await page.mouse.wheel(0, -200); await page.keyboard.up("Control");
  await settle(page, 300);
  const z = await page.evaluate(() => (window as any).__view().z);
  assert.ok(z > 1.2, "zoomed in, z=" + z);
  const y0 = await page.evaluate(() => (window as any).__view().y);
  await page.mouse.wheel(0, 120); await settle(page, 300);
  within(y0 - (await page.evaluate(() => (window as any).__view().y)), 120, 2, "panned by the wheel delta");
  await settle(page, 600);
  await page.reload(); await page.waitForFunction(() => (document.getElementById("st") as HTMLElement).dataset.state === "live"); await settle(page, 600);
  const z2 = await page.evaluate(() => (window as any).__view().z);
  within(z2, z, 0.01, "zoom restored after reload");
});

await test("resize a note by its edge handles: width, height, and the server keeps them", async ({ page }) => {
  await add(page, "note", "grow");
  await page.locator(".note").first().hover();
  const e = mid(await box(page, ".note .grip.e")), w0 = (await box(page, ".note")).width;
  await drag(page, e, { x: e.x + 90, y: e.y });
  await settle(page, 800);
  within((await box(page, ".note")).width, w0 + 90, 4, "wider");
  const s = mid(await box(page, ".note .grip.s")), h0 = (await box(page, ".note")).height;
  await drag(page, s, { x: s.x, y: s.y + 110 });
  await settle(page, 800);
  within((await box(page, ".note")).height, h0 + 110, 4, "taller");
  const saved = (await stored(page)).find((x) => x.elementType === "CARD");
  within(saved.content.width, w0 + 90, 4, "width saved"); assert.ok(saved.content.height > h0 + 80, "height saved");
});

await test("draw with the pen: every stroke saves by itself, Esc stops, undo removes the last", async ({ page }) => {
  await page.click("#draw");
  const stroke = async (pts: [number, number][]) => { await page.mouse.move(...pts[0]); await page.mouse.down(); for (const p of pts.slice(1)) await page.mouse.move(p[0], p[1], { steps: 6 }); await page.mouse.up(); await settle(page, 400); };
  await stroke([[400, 300], [460, 380], [520, 300]]);
  await stroke([[400, 450], [520, 450]]);
  await page.keyboard.press("Escape"); await settle(page, 300);
  assert.equal(await page.locator("#canvas .sketch").count(), 2, "two strokes saved without a Done button");
  assert.equal((await stored(page)).filter((e) => e.elementType === "SKETCH").length, 2, "both are on the server");
  await page.keyboard.press("Control+z"); await settle(page, 900);
  assert.equal(await page.locator("#canvas .sketch").count(), 1);
});

await test("lines attach to cards and follow them when a card moves", async ({ page }) => {
  await add(page, "note", "A"); await add(page, "note", "B");
  const ids = await page.locator("#canvas > .note").evaluateAll((els) => els.map((e) => e.id));
  const a = mid(await box(page, `#${ids[0]}`)), b = mid(await box(page, `#${ids[1]}`));
  await page.click("#line"); await drag(page, a, b); await settle(page, 900);
  const line = (await model(page)).find((e) => e.elementType === "LINE");
  assert.deepEqual([line.content.from, line.content.to], [ids[0], ids[1]], "both ends attached");
  const edge = () => page.evaluate((id) => {
    const l = document.querySelector(".card.line .vis")!, nums = l.getAttribute("d")!.match(/-?\d+(\.\d+)?/g)!.map(Number);
    const all: any = (0, eval)("els"), v: any = (0, eval)("view"), ln = Object.values(all).find((e: any) => e.elementType === "LINE") as any, p = ln.location.position;
    const x = (p.x + nums[2]) * v.z + v.x, y = (p.y + nums[3]) * v.z + v.y, r = document.getElementById(id)!.getBoundingClientRect();
    return Math.min(Math.abs(x - r.left), Math.abs(x - r.right), Math.abs(y - r.top), Math.abs(y - r.bottom));
  }, ids[1]);
  within(await edge(), 0, 2, "end sits on B's edge");
  await drag(page, b, { x: b.x + 120, y: b.y + 220 }); await settle(page, 900);
  within(await edge(), 0, 2, "end still on B's edge after B moved");
});

await test("colour picker: click the wheel, apply, the card takes the colour", async ({ page }) => {
  await add(page, "note", "paint me");
  await page.locator("#canvas > .note").click();
  await page.locator("#colorbar .sw.custom").click();
  const w = await box(page, "#wheel");
  await page.mouse.click(w.x + 3, w.y + w.height / 2); // the far left of the wheel is red
  await page.click("#pok"); await settle(page, 800);
  const bg = await page.locator("#canvas > .note").evaluate((e) => getComputedStyle(e).backgroundColor);
  const [r, g, b] = bg.match(/\d+/g)!.map(Number);
  assert.ok(r > 200 && g < 60 && b < 60, "red-ish background, got " + bg);
  assert.ok((await stored(page)).some((e) => /^#[0-9a-f]{6}$/i.test(e.content.color ?? "")), "stored as a #rrggbb colour");
});

await test("copy, paste and duplicate with the keyboard", async ({ page }) => {
  await add(page, "note", "clone me");
  await page.locator("#canvas > .note").click();
  await page.keyboard.press("Control+d"); await settle(page, 900);
  assert.equal(await page.locator("#canvas > .note").count(), 2, "duplicate");
  await page.keyboard.press("Control+c"); await page.mouse.move(800, 500);
  await page.keyboard.press("Control+v"); await settle(page, 900);
  assert.equal(await page.locator("#canvas > .note").count(), 3, "paste");
  await page.keyboard.press("Control+z"); await settle(page, 900);
  assert.equal(await page.locator("#canvas > .note").count(), 2, "paste undone in one step");
});

await test("search dims the rest and finds a card by its text", async ({ page }) => {
  await add(page, "note", "alpha"); await add(page, "note", "needle in here"); await add(page, "note", "gamma");
  await page.keyboard.press("/"); await page.keyboard.type("needle");
  await settle(page, 400);
  assert.equal(await page.locator(".card.found").count(), 1);
  assert.equal(await page.locator("#qcount").innerText(), "1 match");
  await page.keyboard.press("Escape"); await settle(page, 200);
  assert.equal(await page.locator(".card.found").count(), 0);
});

await test("export a board file and import it back as a new board", async ({ page }) => {
  await add(page, "note", "keep me"); await add(page, "todo", "List");
  await page.click("#expBtn");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click('#expop [data-x="json"]')]);
  const dir = mkdtempSync(join(tmpdir(), "e2e-dl-")), file = join(dir, "board.boardsync.json");
  await dl.saveAs(file);
  await page.keyboard.press("Escape");
  await page.click("#impBtn"); await page.setInputFiles("#impfile", file);
  await page.waitForFunction(() => !(document.getElementById("impgo") as HTMLButtonElement).disabled);
  await page.click("#impgo");
  await page.waitForFunction(() => /Imported/.test(document.getElementById("impinfo")!.textContent!), null, { timeout: 15000 });
  await page.click("#impno"); await settle(page, 600);
  assert.equal(await page.locator("#canvas > .board").count(), 1, "the import is a new board tile");
  await page.locator("#canvas > .board").dblclick(); await settle(page, 1500);
  assert.equal(await page.locator("#canvas > .note").count(), 1);
  assert.equal(await page.locator("#canvas > .todo").count(), 1);
  rmSync(dir, { recursive: true });
});

await test("import a Milanote-style Markdown file", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "e2e-md-")), file = join(dir, "milanote.md");
  writeFileSync(file, "# Plan\n\nFirst note\n\n- [ ] one\n- [x] two\n\n## Backlog\n\nlater\n\n# Sub\n\nhello\n");
  await page.click("#impBtn"); await page.setInputFiles("#impfile", file);
  await page.waitForFunction(() => /2 boards/.test(document.getElementById("impinfo")!.textContent!));
  await page.click("#impgo");
  await page.waitForFunction(() => /Imported/.test(document.getElementById("impinfo")!.textContent!), null, { timeout: 15000 });
  await page.click("#impno"); await settle(page, 500);
  await page.locator("#canvas > .board").dblclick(); await settle(page, 1500);
  assert.equal(await page.locator("#canvas > .note").count(), 1, "the note");
  assert.equal(await page.locator("#canvas > .todo .task").count(), 2, "the two tasks");
  assert.equal(await page.locator("#canvas > .column").count(), 1, "the ## heading became a column");
  assert.equal(await page.locator("#canvas > .board").count(), 1, "the second # heading became a sub-board");
  rmSync(dir, { recursive: true });
});

await test("two users: sharing a board, then live edits both ways", async ({ page }) => {
  const home = await page.evaluate(() => (0, eval)("HOME"));
  const bob = await fresh(`bob${Date.now().toString(36)}`, `#${home}`, false); // not live yet: he has no access to this board
  await bob.page.waitForFunction(() => /No access/.test(document.getElementById("st")!.textContent!));
  const granted: any = await page.evaluate(([who]) => new Promise((r) => (0, eval)("s").emit("action", { type: "ELEMENT_UPDATE_ACL", id: (0, eval)("HOME"), acl: { [who]: 3 } }, r)), [bob.user]);
  assert.equal(granted.status, 200);
  await bob.page.reload(); await bob.page.waitForFunction(() => (document.getElementById("st") as HTMLElement).dataset.state === "live");
  await add(page, "note", "from the owner");
  await bob.page.waitForSelector("#canvas > .note");
  await add(bob.page, "note", "from bob");
  await page.waitForFunction(() => document.querySelectorAll("#canvas > .note").length === 2);
  assert.deepEqual((await page.locator("#canvas > .note .text").allInnerTexts()).sort(), ["from bob", "from the owner"]);
  await bob.ctx.close();
});

const home = (page: Page) => page.locator("#crumbs a", { hasText: "Home" }).click();

await test("rich note: bold and a list are saved, shown, and exported to Markdown", async ({ page }) => {
  await page.click("#note"); await page.keyboard.type("plain ");
  await page.keyboard.press("Control+b"); await page.keyboard.type("loud"); await page.keyboard.press("Control+b");
  assert.equal(await page.locator("#fmt").isVisible(), true, "the formatting bar shows while editing");
  await page.keyboard.press("Enter"); await page.click('#fmt [data-c="insertUnorderedList"]'); await page.keyboard.type("one"); await page.keyboard.press("Enter"); await page.keyboard.type("two");
  await page.keyboard.press("Escape"); await settle(page, 800);
  assert.equal(await page.locator("#fmt").isVisible(), false, "the bar hides afterwards");
  assert.equal(await page.locator(".note .text b").innerText(), "loud");
  assert.deepEqual(await page.locator(".note .text li").allInnerTexts(), ["one", "two"]);
  const s = (await stored(page)).find((e) => e.elementType === "CARD");
  assert.match(s.content.html, /<b>loud<\/b>/); assert.match(s.content.textContent, /plain loud/);
  await page.reload(); await page.waitForFunction(() => (document.getElementById("st") as HTMLElement).dataset.state === "live"); await settle(page, 500);
  assert.equal(await page.locator(".note .text b").innerText(), "loud", "still formatted after a reload");
  await page.click("#expBtn");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click('#expop [data-x="md"]')]);
  const dir = mkdtempSync(join(tmpdir(), "e2e-md-")), file = join(dir, "n.md"); await dl.saveAs(file);
  const md = (await import("node:fs")).readFileSync(file, "utf8");
  assert.match(md, /\*\*loud\*\*/); assert.match(md, /- one\n- two/);
  rmSync(dir, { recursive: true });
});

await test("link card: the preview (title, description, site) appears, syncs, and undo restores the old link", async ({ page }) => {
  await page.click("#link"); await page.keyboard.type("http://127.0.0.1:3994/one"); await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".link .ptitle")?.textContent === "A Real Page", null, { timeout: 8000 });
  assert.equal(await page.locator(".link .pdesc").innerText(), "What it is about");
  assert.equal(await page.locator(".link .domain").innerText(), "Example Site");
  await page.waitForFunction(() => { const i = document.querySelector<HTMLImageElement>(".link .thumb"); return !!i && !i.hidden && i.naturalWidth > 0; }, null, { timeout: 5000 });
  const s = (await stored(page)).find((e) => e.elementType === "LINK");
  assert.equal(s.content.previewTitle, "A Real Page", "stored on the server, so everyone sees it");
  assert.match(s.content.previewImage, /^[0-9a-f-]{36}$/, "the product picture is stored too");
  // editing the URL clears the old preview in the same step; undo brings the old link AND its preview back
  await page.locator(".link").dblclick(); await page.keyboard.press("Control+a"); await page.keyboard.type("http://127.0.0.1:3994/two"); await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".link .title")?.textContent === "http://127.0.0.1:3994/two");
  await settle(page, 800);
  await page.keyboard.press("Control+z"); await settle(page, 1000);
  assert.equal(await page.locator(".link .title").innerText(), "http://127.0.0.1:3994/one");
  assert.equal(await page.locator(".link .ptitle").innerText(), "A Real Page", "the old preview came back with the old URL");
  assert.equal(await page.locator(".link .thumb").isVisible(), true, "and its picture");
});

await test("link card: a private address gets no preview, and nothing breaks", async ({ page }) => {
  await page.click("#link"); await page.keyboard.type("http://169.254.169.254/latest/meta-data/"); await page.keyboard.press("Enter");
  await settle(page, 1500);
  assert.equal(await page.locator(".link .ptitle").innerText(), "");
  assert.equal(await page.locator(".link .title").innerText(), "http://169.254.169.254/latest/meta-data/", "it is still a normal link card");
});

await test("table: type with Tab/Enter, add a row and a column, reload, export to Markdown", async ({ page }) => {
  await page.click("#table");
  await page.keyboard.type("Item"); await page.keyboard.press("Tab"); await page.keyboard.type("Qty"); await page.keyboard.press("Tab"); await page.keyboard.type("Note");
  await page.keyboard.press("Enter"); // down one row, same column
  await page.keyboard.type("Tea");
  await page.click('.sheet [data-t="row"]'); await page.click('.sheet [data-t="col"]'); await settle(page, 800);
  const s = (await stored(page)).find((e) => e.elementType === "TABLE");
  assert.deepEqual(s.content.rows[0], ["Item", "Qty", "Note", ""], "header row, with the new column");
  assert.equal(s.content.rows[1][2], "Tea", "Enter moved straight down from the Note cell");
  assert.equal(s.content.rows.length, 4, "the extra row");
  await page.reload(); await page.waitForFunction(() => (document.getElementById("st") as HTMLElement).dataset.state === "live"); await settle(page, 500);
  assert.equal(await page.locator(".sheet .cell").count(), 16);
  assert.equal(await page.locator(".sheet tr.head .cell").first().inputValue(), "Item");
  await page.click("#expBtn");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click('#expop [data-x="md"]')]);
  const dir = mkdtempSync(join(tmpdir(), "e2e-md-")), file = join(dir, "t.md"); await dl.saveAs(file);
  assert.match((await import("node:fs")).readFileSync(file, "utf8"), /\| Item \| Qty \| Note \|  \|\n\| --- \| --- \| --- \| --- \|\n\|  \|  \| Tea \|  \|/);
  rmSync(dir, { recursive: true });
});

await test("table: a Markdown table imports as a table card", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "e2e-md-")), file = join(dir, "t.md");
  writeFileSync(file, "# Sheet\n\n| a | b |\n| --- | --- |\n| 1 | 2 \\| 3 |\n");
  await page.click("#impBtn"); await page.setInputFiles("#impfile", file);
  await page.waitForFunction(() => /1 board/.test(document.getElementById("impinfo")!.textContent!));
  await page.click("#impgo");
  await page.waitForFunction(() => /Imported/.test(document.getElementById("impinfo")!.textContent!), null, { timeout: 15000 });
  await page.click("#impno"); await settle(page, 500);
  await page.locator("#canvas > .board").dblclick(); await settle(page, 1500);
  assert.deepEqual((await stored(page)).find((e) => e.elementType === "TABLE").content.rows, [["a", "b"], ["1", "2 | 3"]]);
  rmSync(dir, { recursive: true });
});

await test("rich note: hostile HTML from another client is neutralised", async ({ page }) => {
  await add(page, "note", "x");
  const result = await page.evaluate(() => {
    const el: any = Object.values((window as any).__els()).find((e: any) => e.elementType === "CARD");
    el.content.html = '<b onclick="window.__xss=1">ok</b><img src=x onerror="window.__xss=2"><script>window.__xss=3</script><a href="javascript:window.__xss=4">bad</a><a href="https://example.com/">good</a><iframe src="//evil"></iframe>';
    (0, eval)("render")(el);
    const t = document.querySelector(".note .text")!;
    return { html: t.innerHTML, xss: (window as any).__xss ?? null, bad: t.querySelectorAll("img, script, iframe, [onclick], [onerror]").length, hrefs: [...t.querySelectorAll("a")].map((a) => a.getAttribute("href")) };
  });
  assert.equal(result.xss, null, "nothing ran"); assert.equal(result.bad, 0, "no dangerous elements or attributes: " + result.html);
  assert.deepEqual(result.hrefs, ["https://example.com/"], "only the http(s) link survives, the javascript: one is plain text");
  assert.match(result.html, /<b>ok<\/b>/); assert.match(result.html, /bad/);
});

await test("cut a card and paste it into another board: a real move, undoable", async ({ page }) => {
  await add(page, "note", "travel"); await add(page, "brd", "Away");
  const id = await page.locator("#canvas > .note").evaluate((e) => e.id);
  await page.locator("#canvas > .note").click();
  await page.keyboard.press("Control+x"); await settle(page, 300);
  assert.equal(await page.locator("#canvas > .note.cut").count(), 1, "the cut card is shown faded");
  await page.locator("#canvas > .board").dblclick(); await settle(page, 1500);
  await page.mouse.move(600, 400); await page.keyboard.press("Control+v"); await settle(page, 1200);
  assert.equal(await page.locator("#canvas > .note").count(), 1, "it arrived in the other board");
  assert.equal(await page.locator("#canvas > .note").evaluate((e) => e.id), id, "the same card, not a copy");
  await home(page); await settle(page, 1500);
  assert.equal(await page.locator("#canvas > .note").count(), 0, "and it left the first board");
  assert.equal(await page.locator("#canvas > .board .sub").innerText(), "1 card", "the tile's count follows");
});

await test("drag a card onto a board tile to move it inside", async ({ page }) => {
  await add(page, "note", "into the box"); await add(page, "brd", "Box");
  await drag(page, mid(await box(page, "#canvas > .note")), mid(await box(page, "#canvas > .board .tile")));
  await settle(page, 1000);
  assert.equal(await page.locator("#canvas > .note").count(), 0);
  assert.equal(await page.locator("#canvas > .board .sub").innerText(), "1 card");
  await page.keyboard.press("Control+z"); await settle(page, 900); // undo brings it back out
  assert.equal(await page.locator("#canvas > .note").count(), 1, "undo put the card back on this board");
  await page.keyboard.press("Control+Shift+z"); await settle(page, 900); // redo moves it in again
  assert.equal(await page.locator("#canvas > .note").count(), 0);
  await page.locator("#canvas > .board").dblclick(); await settle(page, 1500);
  assert.equal(await page.locator("#canvas > .note").count(), 1);
  assert.equal(await page.locator("#canvas > .note .text").innerText(), "into the box");
});

await test("copy a whole board and paste it: its contents come along", async ({ page }) => {
  await add(page, "brd", "Orig");
  await page.locator("#canvas > .board").dblclick(); await settle(page, 1500);
  await add(page, "note", "n1"); await add(page, "todo", "T");
  await home(page); await settle(page, 1500);
  await page.locator("#canvas > .board").click();
  await page.keyboard.press("Control+c"); await settle(page, 800);
  await page.mouse.move(800, 500); await page.keyboard.press("Control+v"); await settle(page, 1800);
  assert.equal(await page.locator("#canvas > .board").count(), 2, "a second board tile");
  assert.deepEqual(await page.locator("#canvas > .board .sub").allInnerTexts(), ["2 cards", "2 cards"], "the copy reports the same contents");
  await page.locator("#canvas > .board.selected").dblclick(); await settle(page, 1500);
  assert.equal(await page.locator("#canvas > .note").count(), 1);
  assert.equal(await page.locator("#canvas > .todo").count(), 1);
});

await browser.close(); await srv.close(); pages.close(); rmSync(shots, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.log("screenshots of failures were written to " + shots); process.exit(1); }
