// End-to-end tests: a real Chrome driven with genuine mouse and keyboard input (Playwright's driver, no bundled browser).
// Run with `npm run e2e`. Each test gets a fresh user, so it starts on an empty home board.
import { chromium, type Page, type BrowserContext } from "playwright-core";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { createServer } from "./server.ts";

const ZOOM = 0.76; // the zoom a board opens at (shown as 100%)
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
  const start = await box(page, ".note"), a = mid(start);
  await drag(page, a, { x: a.x + 240, y: a.y + 160 });
  await settle(page, 900);
  const moved = await box(page, ".note"), there = await box(other, ".note");
  within(moved.x, start.x + 240, 4, "x on this tab"); within(there.x, moved.x, 2, "x on the other tab"); within(there.y, moved.y, 2, "y on the other tab");
  const s = (await stored(page)).find((e) => e.elementType === "CARD");
  within(s.location.position.x, (start.x + 240) / ZOOM, 4, "x stored on the server (the view is not panned: board x is screen x over the zoom)");
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

await test("zoom: one wheel notch is one 15% step whatever the wheel reports; pinch stays proportional; steps return to 100%", async ({ page }) => {
  await add(page, "note", "zoom"); await page.mouse.move(700, 400);
  const z = () => page.evaluate(() => (window as any).__view().z);
  const wheel = async (dy: number) => { await page.keyboard.down("Control"); await page.mouse.wheel(0, dy); await page.keyboard.up("Control"); await settle(page, 150); };
  within(await z(), 0.76, 0, "starts at 100% (which is 76% of natural size)"); const dots = () => page.evaluate(() => !document.body.classList.contains("nodots")); assert.equal(await dots(), true, "dots at 100%");
  for (const dy of [-100, -120, -53, -400]) { const before = await z(); await wheel(dy); within((await z()) / before, 1.15, 0.002, `a notch of ${dy} is one step`); }
  for (let i = 0; i < 4; i++) await wheel(100);
  assert.equal(await z(), 0.76, "four steps in and four out come back to exactly 100%");
  await wheel(100); within(await z(), 0.76 / 1.15, 0.002, "a notch out is a step out"); assert.equal(await dots(), false, "no dots below 100%");
  await wheel(100); await wheel(-100); await wheel(-100);
  const before = await z(); await wheel(-5);
  const ratio = (await z()) / before; assert.ok(ratio > 1.03 && ratio < 1.07, `a small pinch-like delta zooms a little, not a whole step (x${ratio.toFixed(3)})`);
  for (let i = 0; i < 20; i++) await wheel(-100);
  assert.equal(await z(), 1.52, "zoom stops at 200%");
  await page.click("#zreset"); await page.click("#zin"); within(await z(), 0.76 * 1.15, 0.001, "the + button uses the same step");
});

await test("zoom with ctrl+wheel and pan with the wheel; the view is remembered after a reload", async ({ page }) => {
  await add(page, "note", "zoom");
  await page.mouse.move(700, 400);
  await page.keyboard.down("Control"); await page.mouse.wheel(0, -200); await page.keyboard.up("Control");
  await settle(page, 300);
  const z = await page.evaluate(() => (window as any).__view().z);
  within(z, 0.76 * 1.15, 0.001, "one wheel notch (even a big one, -200) is exactly one 15% step");
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
  within(saved.content.width, (w0 + 90) / ZOOM, 4, "width saved"); assert.ok(saved.content.height > h0 + 80, "height saved");
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
  await page.click("#gearBtn"); await page.click("#expBtn");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click('#expop [data-x="json"]')]);
  const dir = mkdtempSync(join(tmpdir(), "e2e-dl-")), file = join(dir, "board.boardsync.json");
  await dl.saveAs(file);
  await page.keyboard.press("Escape");
  await page.click("#gearBtn"); await page.click("#impBtn"); await page.setInputFiles("#impfile", file);
  await page.waitForFunction(() => !(document.getElementById("impgo") as HTMLButtonElement).disabled);
  await page.click("#impgo");
  await page.waitForFunction(() => /Imported/.test(document.getElementById("impinfo")!.textContent!), null, { timeout: 15000 });
  await page.waitForSelector("#impdlg", { state: "hidden" }); // it closes by itself when the import had no warnings await settle(page, 600);
  assert.equal(await page.locator("#canvas > .board").count(), 1, "the import is a new board tile");
  await page.locator("#canvas > .board").dblclick(); await settle(page, 1500);
  assert.equal(await page.locator("#canvas > .note").count(), 1);
  assert.equal(await page.locator("#canvas > .todo").count(), 1);
  rmSync(dir, { recursive: true });
});

await test("import a Milanote-style Markdown file", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "e2e-md-")), file = join(dir, "milanote.md");
  writeFileSync(file, "# Plan\n\nFirst note\n\n- [ ] one\n- [x] two\n\n## Backlog\n\nlater\n\n# Sub\n\nhello\n");
  await page.click("#gearBtn"); await page.click("#impBtn"); await page.setInputFiles("#impfile", file);
  await page.waitForFunction(() => /2 boards/.test(document.getElementById("impinfo")!.textContent!));
  await page.click("#impgo");
  await page.waitForFunction(() => /Imported/.test(document.getElementById("impinfo")!.textContent!), null, { timeout: 15000 });
  await page.waitForSelector("#impdlg", { state: "hidden" }); // it closes by itself when the import had no warnings await settle(page, 500);
  await page.locator("#canvas > .board").dblclick(); await settle(page, 1500);
  assert.equal(await page.locator("#canvas > .note").count(), 1, "the note");
  assert.equal(await page.locator("#canvas > .todo .task").count(), 2, "the two tasks");
  assert.equal(await page.locator("#canvas > .column").count(), 1, "the ## heading became a column");
  assert.equal(await page.locator("#canvas > .board").count(), 1, "the second # heading became a sub-board");
  rmSync(dir, { recursive: true });
});

await test("import a real Milanote export: pictures are downloaded, captions, bold, lists, links, empty to-do rows", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "e2e-md-")), file = join(dir, "Domek.md"), pic = "http://127.0.0.1:3994/pic.png";
  writeFileSync(file, [
    "# Domek", "", "## Ideas", "",
    `![**Cap one**](${pic})`, "",
    `![Photo by [Ann](https://example.com/ann)](${pic})`, "",
    `![Image from Domek](${pic})`, "",
    "- Longan juice", "",
    "**bold** and a [link](https://example.com/x)", "",
    "[A shop - Link](http://127.0.0.1:3994/one)", "", "250 pln", "",
    "[Shelf unit](http://127.0.0.1:3994/one)", "", "Description from the export", "", "A separate note", "", "### **Inside heading**", "",
    "## Checklists", "", "- [ ] a", "- [x] b", "- [ ] Walka z air china- noclegi w Pekinie i jeszcze dużo więcej tekstu żeby zawinąć", "- [ ]", "## Overview", "", "## **Daty**", "", "Table element string placeholder", "", "### **Transport Details**", "", "## Last", "", "in last", "",
  ].join("\n"));
  await page.click("#gearBtn"); await page.click("#impBtn"); await page.setInputFiles("#impfile", file);
  await page.waitForFunction(() => /1 board/.test(document.getElementById("impinfo")!.textContent!));
  await page.click("#impgo");
  await page.waitForFunction(() => /Imported/.test(document.getElementById("impinfo")!.textContent!), null, { timeout: 20000 });
  const info = await page.locator("#impinfo").innerText();
  assert.doesNotMatch(info, /could not be downloaded/, "all three pictures came through");
  await page.waitForSelector("#impdlg", { state: "hidden" }); // it closes by itself when the import had no warnings await settle(page, 500);
  await page.locator("#canvas > .board").dblclick(); await settle(page, 1800);
  const cols = page.locator("#canvas > .column");
  assert.deepEqual(await cols.locator(".title").allInnerTexts().then((t) => t.filter(Boolean).slice(0, 1)), ["Ideas"], "no ** left in the column name");
  const imgs = cols.first().locator(".kids .image");
  assert.equal(await imgs.count(), 3, "three real picture cards, not links");
  assert.deepEqual(await imgs.locator(".title").allInnerTexts(), ["Cap one", "Photo by Ann", ""], "captions cleaned; Milanote's default caption dropped");
  assert.ok(await imgs.first().locator("img").evaluate((i: HTMLImageElement) => i.src.includes("/api/media/") && i.naturalWidth > 0), "the picture is stored here");
  assert.equal(await cols.first().locator(".kids .link").count(), 2);
  assert.equal(await cols.first().locator(".kids .link .ptitle").first().innerText(), "A Real Page", "a bare link takes the site's title");
  assert.equal(await cols.first().locator(".kids .link .ptitle").nth(1).innerText(), "Shelf unit", "the title from the export wins");
  assert.equal(await cols.first().locator(".kids .link .pdesc").nth(1).innerText(), "Description from the export", "the paragraph after a titled link is its description");
  assert.deepEqual(await cols.first().locator(".kids .note .text").allInnerTexts(), ["Longan juice", "bold and a link", "250 pln", "A separate note", "Inside heading"], "no duplicate description note; after a bare link the next paragraph stays a note");
  assert.deepEqual(await cols.first().locator(".kids .note li").allInnerTexts(), ["Longan juice"], "a bullet became a list");
  assert.equal(await cols.first().locator(".kids .note b").innerText(), "bold");
  assert.equal(await cols.first().locator(".kids .note a").getAttribute("href"), "https://example.com/x");
  assert.equal(await cols.nth(1).locator(".task").count(), 3, "the empty to-do row is dropped");
  const long = cols.nth(1).locator(".task textarea").nth(2);
  assert.ok(await long.evaluate((t: HTMLTextAreaElement) => t.clientHeight > 30 && t.scrollWidth <= t.clientWidth + 1), "a long task wraps onto more lines instead of running out of the card");
  const colW = (await box(page, "#canvas > .column >> nth=0")).width, head = await box(page, "#canvas > .column >> nth=0 >> .kids .note.heading");
  assert.ok(head.width <= colW, `a heading inside a column (${head.width}px) fits it (${colW}px)`);
  assert.equal(await cols.count(), 4, "Ideas, Checklists, Overview, Last: the bold ## headings are not columns");
  assert.equal(await cols.nth(2).locator(".kids > .card").count(), 0, "nothing was pushed into Overview by what follows it");
  assert.deepEqual(await page.locator("#canvas > .note.heading .text").allInnerTexts(), ["Daty", "Transport Details"], "bold headings are notes on the board");
  assert.equal(await page.locator("#canvas > .sheet").count(), 1, "the table placeholder follows them on the board, as an empty table");
  assert.deepEqual(await cols.nth(3).locator(".kids .note .text").allInnerTexts(), ["in last"], "the next real column starts again");
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
  await page.click("#gearBtn"); await page.click("#expBtn");
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
  await page.click("#gearBtn"); await page.click("#expBtn");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click('#expop [data-x="md"]')]);
  const dir = mkdtempSync(join(tmpdir(), "e2e-md-")), file = join(dir, "t.md"); await dl.saveAs(file);
  assert.match((await import("node:fs")).readFileSync(file, "utf8"), /\| Item \| Qty \| Note \|  \|\n\| --- \| --- \| --- \| --- \|\n\|  \|  \| Tea \|  \|/);
  rmSync(dir, { recursive: true });
});

await test("table: a Markdown table imports as a table card", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "e2e-md-")), file = join(dir, "t.md");
  writeFileSync(file, "# Sheet\n\n| a | b |\n| --- | --- |\n| 1 | 2 \\| 3 |\n");
  await page.click("#gearBtn"); await page.click("#impBtn"); await page.setInputFiles("#impfile", file);
  await page.waitForFunction(() => /1 board/.test(document.getElementById("impinfo")!.textContent!));
  await page.click("#impgo");
  await page.waitForFunction(() => /Imported/.test(document.getElementById("impinfo")!.textContent!), null, { timeout: 15000 });
  await page.waitForSelector("#impdlg", { state: "hidden" }); // it closes by itself when the import had no warnings await settle(page, 500);
  await page.locator("#canvas > .board").dblclick(); await settle(page, 1500);
  assert.deepEqual((await stored(page)).find((e) => e.elementType === "TABLE").content.rows, [["a", "b"], ["1", "2 | 3"]]);
  rmSync(dir, { recursive: true });
});

await test("link card: your own picture when the site gives none (button, then paste), undoable", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "e2e-pic-")), file = join(dir, "p.png");
  writeFileSync(file, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  await page.click("#link"); await page.keyboard.type("http://169.254.169.254/shop"); await page.keyboard.press("Enter"); await settle(page, 1200);
  assert.equal(await page.locator(".link .thumb").isHidden(), true, "no picture from the site");
  await page.locator(".link .pic").click({ trial: false }).catch(() => {});
  await page.setInputFiles("#file", file);
  await page.waitForFunction(() => { const i = document.querySelector<HTMLImageElement>(".link .thumb"); return !!i && !i.hidden && i.naturalWidth > 0; }, null, { timeout: 5000 });
  assert.match((await stored(page)).find((e) => e.elementType === "LINK").content.previewImage, /^[0-9a-f-]{36}$/);
  assert.equal((await stored(page)).filter((e) => e.elementType === "IMAGE").length, 0, "it did not create a separate image card");
  await page.keyboard.press("Control+z"); await settle(page, 800);
  assert.equal(await page.locator(".link .thumb").isHidden(), true, "undo removes the picture");
  rmSync(dir, { recursive: true });
});

// a tiny PNG made here: the left half red, the right half blue (so a palette has two clear colours)
const crc = (b: Buffer) => { let c, t = -1; for (const x of b) { c = (t ^ x) & 255; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t = (t >>> 8) ^ c; } return (t ^ -1) >>> 0; };
function twoColourPng(): Buffer {
  const chunk = (type: string, data: Buffer) => { const body = Buffer.concat([Buffer.from(type), data]), len = Buffer.alloc(4), sum = Buffer.alloc(4); len.writeUInt32BE(data.length); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(8, 4); ihdr[8] = 8; ihdr[9] = 2; // 8x8, 8-bit RGB
  const rows = Buffer.concat(Array.from({ length: 8 }, () => Buffer.concat([Buffer.from([0]), ...Array.from({ length: 8 }, (_, x) => Buffer.from(x < 4 ? [255, 0, 0] : [0, 0, 255]))])));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

await test("colour card: pick a colour, it is stored; colours from a picture make cards", async ({ page }) => {
  await page.click("#swatch");
  assert.equal(await page.locator("#picker").isVisible(), true, "a new colour card opens the picker");
  const w = await box(page, "#wheel");
  await page.mouse.click(w.x + 3, w.y + w.height / 2); await page.click("#pok"); await settle(page, 700);
  const hex = await page.locator(".swatch .hex").innerText();
  assert.match(hex, /^#[0-9a-f]{6}$/); assert.ok((await stored(page)).some((e) => e.elementType === "SWATCH" && e.content.color === hex), "stored");
  const dir = mkdtempSync(join(tmpdir(), "e2e-pal-")), file = join(dir, "two.png"); writeFileSync(file, twoColourPng());
  await page.setInputFiles("#file", file);
  await page.waitForSelector(".image img"); await page.waitForFunction(() => (document.querySelector(".image img") as HTMLImageElement).complete);
  await page.locator(".image").hover(); await page.click("#imgPal"); await settle(page, 900);
  const made = (await stored(page)).filter((e) => e.elementType === "SWATCH").map((e) => e.content.color);
  assert.ok(made.includes("#0000ff") && made.includes("#ff0000"), "the picture's red and blue became colour cards, got " + made);
  rmSync(dir, { recursive: true });
});

await test("image: caption, crop (original kept) and numbered pins", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "e2e-img-")), file = join(dir, "two.png"); writeFileSync(file, twoColourPng());
  await page.setInputFiles("#file", file);
  await page.waitForFunction(() => { const i = document.querySelector<HTMLImageElement>(".image img"); return !!i && i.complete && i.naturalWidth > 0; });
  await page.locator(".image .frame").dblclick(); await page.keyboard.type("Sunset"); await page.keyboard.press("Enter"); await settle(page, 700);
  assert.equal((await stored(page)).find((e) => e.elementType === "IMAGE").content.caption, "Sunset");
  assert.equal(await page.locator(".image .title").innerText(), "Sunset");
  // crop: drag the bottom-right handle inwards, then Done
  const before = await box(page, ".image .frame");
  await page.click("#imgCrop");
  const h = mid(await box(page, ".image .crop .br"));
  await drag(page, h, { x: h.x - before.width * 0.3, y: h.y - before.height * 0.3 });
  await page.click("#imgCrop"); await settle(page, 800);
  const k = (await stored(page)).find((e) => e.elementType === "IMAGE").content.crop;
  assert.ok(k && k.w < 0.6 && k.h < 0.6 && k.x === 0.1, "a smaller rectangle was saved, got " + JSON.stringify(k));
  assert.ok(parseFloat(await page.locator(".image .frame img").evaluate((i: HTMLElement) => i.style.width)) > 150, "the picture is magnified so the card shows only the cropped part");
  assert.ok((await stored(page)).find((e) => e.elementType === "IMAGE").content.mediaId, "the original picture is still there");
  // pin: Pin button, click the picture, answer the prompt
  page.once("dialog", (d) => d.accept("look at this"));
  await page.click("#imgPin"); const f = mid(await box(page, ".image .frame")); await page.mouse.click(f.x, f.y); await settle(page, 800);
  const pins = (await stored(page)).find((e) => e.elementType === "IMAGE").content.pins;
  assert.equal(pins.length, 1); assert.equal(pins[0].text, "look at this");
  assert.ok(pins[0].x > 0.1 && pins[0].x < 0.7, "pin stored in the original's coordinates, got " + pins[0].x);
  assert.equal(await page.locator(".image .pin").innerText(), "1");
  // an empty answer removes the pin
  page.once("dialog", (d) => d.accept("")); await page.click(".image .pin"); await settle(page, 700);
  assert.equal((await stored(page)).find((e) => e.elementType === "IMAGE").content.pins.length, 0);
  rmSync(dir, { recursive: true });
});

await test("right-click menus: new card at the pointer, lock position, order, trash", async ({ page }) => {
  await page.mouse.click(700, 400, { button: "right" });
  assert.equal(await page.locator("#cmenu").isVisible(), true, "canvas menu opens");
  await page.locator("#cmenu button", { hasText: "New Note" }).click(); await page.keyboard.type("made by menu"); await page.keyboard.press("Escape"); await settle(page, 500);
  const n = await box(page, ".note"); within(n.x, 700, 12, "the note lands where you right-clicked"); within(n.y, 400, 12, "and at the same height");
  await page.locator(".note").click({ button: "right" });
  assert.match(await page.locator("#cmenu .meta").innerText(), /^Created by you/);
  await page.locator("#cmenu button", { hasText: "Lock Position" }).click(); await settle(page, 600);
  assert.equal((await stored(page)).find((e) => e.elementType === "CARD").content.locked, true);
  const a = mid(await box(page, ".note")); await drag(page, a, { x: a.x + 150, y: a.y + 90 }); await settle(page, 600);
  within((await box(page, ".note")).x, n.x, 2, "a locked card does not move");
  await page.locator(".note").click({ button: "right" }); await page.locator("#cmenu button", { hasText: "Unlock Position" }).click(); await settle(page, 400);
  await page.locator(".note").click({ button: "right" }); await page.locator("#cmenu button", { hasText: "Bring to Front" }).click(); await settle(page, 600);
  assert.ok((await stored(page)).find((e) => e.elementType === "CARD").content.z >= 1, "z-order saved");
  await page.locator(".note").click({ button: "right" }); await page.locator("#cmenu button", { hasText: "Move to Trash" }).click(); await settle(page, 600);
  assert.equal(await page.locator("#canvas > .note").count(), 0);
});

await test("heading card exports as ### and imports back as a heading; presentation mode hides the chrome", async ({ page }) => {
  await page.click("#heading"); await page.keyboard.type("Big title"); await page.keyboard.press("Escape"); await settle(page, 500);
  assert.equal(await page.locator(".note.heading").count(), 1);
  assert.equal(await page.locator(".note.heading .text").evaluate((e) => parseFloat(getComputedStyle(e).fontSize)) >= 26, true, "set large");
  await page.click("#gearBtn"); await page.click("#expBtn");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click('#expop [data-x="md"]')]);
  const dir = mkdtempSync(join(tmpdir(), "e2e-h-")), file = join(dir, "h.md"); await dl.saveAs(file);
  assert.match((await import("node:fs")).readFileSync(file, "utf8"), /^### Big title$/m);
  rmSync(dir, { recursive: true });
  await page.click("#presentBtn");
  assert.equal(await page.locator("#tools").isVisible(), false, "toolbar hidden"); assert.equal(await page.locator("#top").isVisible(), false);
  assert.equal(await page.locator(".note.heading").isVisible(), true, "the cards stay");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#tools").isVisible(), true, "Esc brings the toolbar back");
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

const posOf = async (page: Page) => (await stored(page)).filter((e) => e.elementType === "CARD").map((e) => ({ x: e.location.position.x, y: e.location.position.y, z: e.content.z })).sort((a, b) => a.x - b.x || a.y - b.y);

await test("keyboard: arrows nudge 1px (Shift: 10px) as one undo step; Ctrl+Shift+Up/Down reorders", async ({ page }) => {
  await add(page, "note", "one"); await settle(page, 300);
  const [a0] = await posOf(page);
  await page.locator(".note").first().click();
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowDown"); await settle(page, 900);
  const [a1] = await posOf(page);
  assert.equal(a1.x, a0.x + 3, "three plain presses move 3px"); assert.equal(a1.y, a0.y + 10, "Shift moves 10px");
  await page.keyboard.press("Control+z"); await settle(page, 700);
  const [a2] = await posOf(page);
  assert.deepEqual({ x: a2.x, y: a2.y }, { x: a0.x, y: a0.y }, "the whole burst undoes in one step");
  // two overlapping notes: send the first one to the back and the second to the front by keyboard
  await page.mouse.click(1000, 600); await page.keyboard.press("Escape");
  await add(page, "note", "two");
  const notes = page.locator(".note");
  assert.equal(await notes.count(), 2);
  await notes.nth(0).click(); await page.keyboard.press("Control+Shift+ArrowUp"); await settle(page, 700);
  const z0 = (await model(page)).find((e) => e.content.textContent === "one").content.z;
  await notes.nth(0).click(); await page.keyboard.press("Control+Shift+ArrowDown"); await settle(page, 700);
  const z1 = (await model(page)).find((e) => e.content.textContent === "one").content.z;
  assert.ok(z0 > z1, `front (${z0}) is above back (${z1})`);
});

await test("keyboard: Alt-drag copies a card, the original stays", async ({ page }) => {
  await add(page, "note", "orig"); await settle(page, 300);
  const b = await box(page, ".note"), from = mid(b);
  await page.keyboard.down("Alt"); await drag(page, from, { x: from.x + 260, y: from.y + 120 }); await page.keyboard.up("Alt"); await settle(page, 1000);
  const ps = await posOf(page);
  assert.equal(ps.length, 2, "an original and a copy");
  within(ps[1].x - ps[0].x, 260 / ZOOM, 6, "the copy lands where it was dropped"); within(ps[1].y - ps[0].y, 120 / ZOOM, 6, "...and down");
  assert.deepEqual((await model(page)).filter((e) => e.elementType === "CARD").map((e) => e.content.textContent), ["orig", "orig"]);
  await page.keyboard.press("Control+z"); await settle(page, 700);
  assert.equal((await posOf(page)).length, 1, "undo removes the copy");
});

await test("rich note: markdown shortcuts, highlight, quote, code, link, centre, and Markdown export", async ({ page }) => {
  await page.click("#note");
  await page.keyboard.type("# Title"); await page.keyboard.press("Enter");
  await page.keyboard.type(". apple"); await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
  await page.keyboard.type("1. first"); await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
  await page.keyboard.type("> wise words"); await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
  await page.keyboard.type("hot take"); await page.keyboard.press("Shift+Home"); await page.keyboard.press("Control+j");
  await page.keyboard.press("End"); await page.keyboard.press("Enter");
  await page.keyboard.type("site"); await page.keyboard.press("Shift+Home");
  page.once("dialog", (d) => d.accept("https://example.com/"));
  await page.keyboard.press("Control+k");
  await page.keyboard.press("End"); await page.keyboard.press("Enter");
  await page.keyboard.type("middle"); await page.click('#fmt [data-c="center"]');
  await page.keyboard.press("Enter"); await page.click('#fmt [data-c="code"]'); await page.keyboard.type("let x = 1");
  await page.keyboard.press("Escape"); await settle(page, 800);
  const t = page.locator(".note .text");
  assert.equal(await t.locator("h3").innerText(), "Title");
  assert.deepEqual(await t.locator("ul li").allInnerTexts(), ["apple"]);
  assert.deepEqual(await t.locator("ol li").allInnerTexts(), ["first"]);
  assert.equal(await t.locator("blockquote").innerText(), "wise words");
  assert.equal(await t.locator("mark").innerText(), "hot take");
  assert.equal(await t.locator("a").getAttribute("href"), "https://example.com/");
  assert.equal(await t.locator("pre").innerText(), "let x = 1");
  assert.equal(await t.locator('[align="center"]').count() > 0, true, "centred line");
  const s = (await stored(page)).find((e) => e.elementType === "CARD");
  assert.match(s.content.html, /<mark>hot take<\/mark>/); assert.doesNotMatch(s.content.html, /style=|<span/);
  await page.reload(); await page.waitForFunction(() => (document.getElementById("st") as HTMLElement).dataset.state === "live"); await settle(page, 500);
  assert.equal(await page.locator(".note .text mark").innerText(), "hot take", "still formatted after a reload");
  await page.click("#gearBtn"); await page.click("#expBtn");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click('#expop [data-x="md"]')]);
  const dir = mkdtempSync(join(tmpdir(), "e2e-md-")), file = join(dir, "n.md"); await dl.saveAs(file);
  const md = (await import("node:fs")).readFileSync(file, "utf8");
  assert.match(md, /### Title/); assert.match(md, /- apple/); assert.match(md, /1\. first/); assert.match(md, /> wise words/);
  assert.match(md, /\[site\]\(https:\/\/example\.com\/\)/); assert.match(md, /```\nlet x = 1\n```/);
  rmSync(dir, { recursive: true });
});

await test("image toolbar: download the original, colour strip, rotate (crop and pins turn with it), undo", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "e2e-img-")), file = join(dir, "two.png"), bytes = twoColourPng(); writeFileSync(file, bytes);
  await page.setInputFiles("#file", file);
  const loaded = () => page.waitForFunction(() => { const i = document.querySelector<HTMLImageElement>(".image img"); return !!i && i.complete && i.naturalWidth > 0; });
  await loaded();
  const img = () => page.locator(".image img").evaluate((i: HTMLImageElement) => [i.naturalWidth, i.naturalHeight]);
  const rec = async () => (await stored(page)).find((e) => e.elementType === "IMAGE").content;
  // download: the stored file, byte for byte, under its own name
  await page.locator(".image").click({ button: "right" });
  const [dl] = await Promise.all([page.waitForEvent("download"), page.locator("#cmenu button", { hasText: "Download Original" }).click()]);
  assert.equal(dl.suggestedFilename(), "two.png");
  const saved = join(dir, "saved.png"); await dl.saveAs(saved);
  assert.equal((await import("node:fs")).readFileSync(saved).length, bytes.length, "the download is the stored original");
  // colour strip: pick a colour with the image selected
  await page.locator(".image .frame").click(); await settle(page, 300);
  assert.equal(await page.locator("#colorbar").isVisible(), true, "the colour bar is offered for a picture");
  await page.locator('#colorbar [data-val="teal"]').click(); await settle(page, 600);
  assert.equal((await rec()).color, "teal");
  assert.equal(await page.locator(".image").evaluate((d) => getComputedStyle(d, "::before").height), "8px", "a strip along the top edge");
  const [card, tint] = await page.evaluate(() => { const t = document.createElement("div"); t.style.background = "var(--tint-teal)"; document.body.append(t); const c = getComputedStyle(t).backgroundColor; t.remove(); return [getComputedStyle(document.querySelector(".image")!).backgroundColor, c]; });
  assert.notEqual(card, tint, "...and not a fill: the card itself keeps its normal background");
  // rotate, with a crop and a pin that must turn with the picture
  const before = await rec(), [w0, h0] = await img();
  await page.evaluate(() => { const el = Object.values((window as any).__els() as any).find((e: any) => e.elementType === "IMAGE"); return (0, eval)("update")(el, { crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.3 }, pins: [{ x: 0.2, y: 0.4, text: "p" }] }); });
  await settle(page, 600);
  await page.locator(".image").hover(); await page.click("#imgRotate"); await settle(page, 1200); await loaded();
  const after = await rec(), [w1, h1] = await img();
  assert.notEqual(after.mediaId, before.mediaId, "a new, turned picture");
  assert.deepEqual([w1, h1], [h0, w0], "width and height swapped");
  within(after.crop.x, 0.5, 1e-6, "crop x"); within(after.crop.y, 0.1, 1e-6, "crop y"); within(after.crop.w, 0.3, 1e-6, "crop w"); within(after.crop.h, 0.5, 1e-6, "crop h");
  within(after.pins[0].x, 0.6, 1e-6, "pin x"); within(after.pins[0].y, 0.2, 1e-6, "pin y"); assert.equal(after.pins[0].text, "p");
  // undo restores the old picture, crop and pin together
  await page.keyboard.press("Control+z"); await settle(page, 900);
  const undone = await rec();
  assert.equal(undone.mediaId, before.mediaId); within(undone.crop.x, 0.1, 1e-6, "crop x back"); within(undone.pins[0].x, 0.2, 1e-6, "pin x back");
  rmSync(dir, { recursive: true });
});

await test("import Markdown: ==highlight==, a > quote and a fenced code block become formatted notes, and export writes them back", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "e2e-md-")), file = join(dir, "fmt.md");
  writeFileSync(file, ["# Fmt", "", "a ==hot== take", "", "> wise words", "", "```", "let x = 1", "```", ""].join("\n"));
  await page.click("#gearBtn"); await page.click("#impBtn"); await page.setInputFiles("#impfile", file);
  await page.waitForFunction(() => /1 board/.test(document.getElementById("impinfo")!.textContent!));
  await page.click("#impgo"); await page.waitForSelector("#impdlg", { state: "hidden" });
  await page.locator("#canvas > .board").dblclick(); await settle(page, 1500);
  assert.equal(await page.locator(".note mark").innerText(), "hot");
  assert.equal(await page.locator(".note blockquote").innerText(), "wise words");
  assert.equal(await page.locator(".note pre").innerText(), "let x = 1");
  await page.click("#gearBtn"); await page.click("#expBtn");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click('#expop [data-x="md"]')]);
  const out = join(dir, "out.md"); await dl.saveAs(out);
  const md = (await import("node:fs")).readFileSync(out, "utf8");
  assert.match(md, /a ==hot== take/); assert.match(md, /> wise words/); assert.match(md, /```\nlet x = 1\n```/);
  rmSync(dir, { recursive: true });
});

await test("several pictures chosen at once land in one \"Unsorted\" column (one undo step); a single picture stays a plain card", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "e2e-img-")), a = join(dir, "a.png"), b = join(dir, "b.png"); writeFileSync(a, twoColourPng()); writeFileSync(b, twoColourPng());
  await page.setInputFiles("#file", [a, b]);
  await page.waitForSelector("#canvas > .column .kids .image"); await settle(page, 800);
  assert.equal(await page.locator("#canvas > .column").count(), 1, "one column");
  assert.equal(await page.locator("#canvas > .column > .title").innerText(), "Unsorted");
  assert.equal(await page.locator("#canvas > .column .kids .image").count(), 2, "both pictures are inside it");
  assert.equal(await page.locator("#canvas > .image").count(), 0, "none loose on the board");
  await page.keyboard.press("Control+z"); await settle(page, 800);
  assert.equal(await page.locator("#canvas > .column").count(), 0, "one undo removes the whole column");
  await page.setInputFiles("#file", [a, b]); await page.waitForSelector("#canvas > .column .kids .image"); await settle(page, 1000);
  await page.reload(); await page.waitForFunction(() => (document.getElementById("st") as HTMLElement).dataset.state === "live"); await settle(page, 1200);
  assert.equal(await page.locator("#canvas > .column .kids .image").count(), 2, "saved on the server: still there after a reload");
  await page.locator("#canvas > .column").click({ button: "right" }); await page.locator("#cmenu button", { hasText: "Move to Trash" }).click(); await settle(page, 600);
  await page.setInputFiles("#file", a); await page.waitForSelector("#canvas > .image"); await settle(page, 500);
  assert.equal(await page.locator("#canvas > .column").count(), 0, "a single picture makes no column");
  rmSync(dir, { recursive: true });
});

await test("link card: the address of one of our boards becomes a shortcut that opens it in the same tab", async ({ page, ctx }) => {
  const hash = () => page.evaluate(() => location.hash);
  await add(page, "brd", "Inner"); await settle(page, 400);
  await page.locator(".board").first().dblclick(); await page.waitForFunction(() => location.hash.length > 1); await settle(page, 800);
  const id = (await hash()).slice(1);
  await page.keyboard.press("Control+["); await settle(page, 600);
  await page.click("#link"); await page.keyboard.type(`${URL}/#${id}`); await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".link .ptitle")?.textContent === "Inner", null, { timeout: 8000 });
  assert.equal(await page.locator(".link .domain").innerText(), "Board");
  assert.equal(await page.locator(".link").evaluate((d) => d.classList.contains("shortcut")), true);
  assert.equal(await page.locator(".link .thumb").isVisible(), false, "no page preview was fetched");
  assert.equal((await stored(page)).find((e) => e.elementType === "LINK").content.boardId, id);
  await page.locator(".link").hover(); await page.locator(".link .go").click(); await settle(page, 800);
  assert.equal(await hash(), "#" + id, "it opened the board");
  assert.equal(ctx.pages().length, 1, "in the same tab");
});

await test("note text: colour and size from the format bar are saved and shown; the default colour and size take them off; nothing else gets through", async ({ page }) => {
  const look = () => page.locator(".note .text").evaluate((t) => { const n = document.createTreeWalker(t, NodeFilter.SHOW_TEXT).nextNode()!; const cs = getComputedStyle(n.parentElement!); return [cs.color, cs.fontSize]; });
  const html = async () => (await stored(page)).find((e) => e.elementType === "CARD").content.html as string | null;
  await page.click("#note"); await page.keyboard.type("paint me"); await page.keyboard.press("Control+a");
  await page.click('#fmt [data-c="colour"]'); await page.click('#fmtPal [data-color="#e5484d"]');
  await page.click('#fmt [data-c="sizeUp"]');
  await page.keyboard.press("Escape"); await settle(page, 900);
  assert.deepEqual(await look(), ["rgb(229, 72, 77)", "15px"], "red, one size up (+1px)");
  const h = (await html())!; assert.match(h, /color:#e5484d/); assert.match(h, /font-size:15px/); assert.match(h, /paint me/);
  await page.reload(); await page.waitForFunction(() => (document.getElementById("st") as HTMLElement).dataset.state === "live"); await settle(page, 600);
  assert.deepEqual(await look(), ["rgb(229, 72, 77)", "15px"], "still coloured after a reload");
  await page.locator(".note").click(); await page.keyboard.press("Enter"); await page.keyboard.press("Control+a");
  await page.click('#fmt [data-c="sizeUp"]'); assert.equal((await look())[1], "16px", "+ again: 16px");
  await page.click('#fmt [data-c="sizeDown"]'); await page.click('#fmt [data-c="sizeDown"]'); assert.equal((await look())[1], "14px", "two A- bring it back to the normal size");
  await page.click('#fmt [data-c="colour"]'); await page.click('#fmtPal [data-color=""]');
  await page.keyboard.press("Escape"); await settle(page, 900);
  assert.equal(await html(), null, "no colour and normal size: the note is plain text again");
  // the sanitiser keeps a checked colour and size and nothing else
  const clean = await page.evaluate(() => (0, eval)("cleanHtml")('<span style="color:#00ff00;position:fixed;font-size:999px;background:url(//x)" onclick="alert(1)">x</span><span style="font-size:20px">y</span><span style="color:red">z</span><span style="color:rgb(1, 2, 3)">w</span>'));
  assert.equal(clean, '<span style="color:#00ff00">x</span><span style="font-size:20px">y</span>z<span style="color:#010203">w</span>');
});

await test("drawing: choose the pen colour, strokes keep it, selected drawings can be recoloured, the choice is remembered", async ({ page }) => {
  const stroke = (y: number) => drag(page, { x: 600, y }, { x: 760, y: y + 30 }, 8);
  const sketches = async () => (await stored(page)).filter((e) => e.elementType === "SKETCH").sort((a, b) => a.location.position.y - b.location.position.y);
  const strokes = () => page.locator(".sketch .ink").evaluateAll((a) => a.map((p) => getComputedStyle(p).stroke));
  await page.click("#draw");
  assert.equal(await page.locator("#drawbar .sw").count() >= 10, true, "a row of colours in the drawing bar");
  await stroke(300);
  await page.click('#drawbar [data-val="#e5484d"]'); await stroke(400);
  await page.keyboard.press("Escape"); await settle(page, 900);
  const [first, second] = await sketches();
  assert.equal(first.content.color, undefined, "the default pen stores no colour (it follows light/dark)");
  assert.equal(second.content.color, "#e5484d");
  const [c1, c2] = await strokes(); assert.notEqual(c1, "rgb(229, 72, 77)"); assert.equal(c2, "rgb(229, 72, 77)", "the red stroke is drawn red");
  await page.keyboard.press("Control+a");
  assert.equal(await page.locator("#inkbar").isVisible(), true, "selected drawings offer the colours too");
  await page.click('#inkbar [data-val="#3e63dd"]'); await settle(page, 900);
  assert.deepEqual((await sketches()).map((s) => s.content.color), ["#3e63dd", "#3e63dd"], "both recoloured in one action");
  assert.deepEqual(await strokes(), ["rgb(62, 99, 221)", "rgb(62, 99, 221)"]);
  await page.keyboard.press("Control+z"); await settle(page, 900);
  assert.deepEqual((await sketches()).map((s) => s.content.color ?? null), [null, "#e5484d"], "undo restores both colours");
  await page.reload(); await page.waitForFunction(() => (document.getElementById("st") as HTMLElement).dataset.state === "live");
  await page.click("#draw");
  assert.equal(await page.locator('#drawbar [data-val="#e5484d"]').evaluate((b) => b.classList.contains("on")), true, "the pen colour is remembered");
});

await test("boards panel: a tree of your boards, the recent ones, search across all boards (only yours), jump to the card", async ({ page }) => {
  const hash = () => page.evaluate(() => location.hash);
  const rows = () => page.locator("#blist .row").allInnerTexts().then((t) => t.map((x) => x.replace(/[▸▾]/g, "").trim()));
  await add(page, "brd", "Alpha"); await settle(page, 400);
  await page.locator(".board").first().dblclick(); await page.waitForFunction(() => location.hash.length > 1); await settle(page, 800);
  const alpha = (await hash()).slice(1);
  await add(page, "note", "needle in the haystack"); await add(page, "brd", "Beta"); await settle(page, 600);
  await page.keyboard.press("Control+["); await settle(page, 800);
  await page.click("#boardsBtn"); await page.waitForSelector("#blist .row");
  assert.equal(await page.locator("#bpanel").isVisible(), true, "the panel opens");
  assert.ok((await rows()).includes("Home") && (await rows()).includes("Alpha"), "Home and Alpha are listed");
  assert.equal((await rows()).includes("Beta"), false, "Beta is inside Alpha, which is collapsed");
  assert.equal(await page.locator("#blist h4", { hasText: "Recent" }).count(), 1, "Alpha was visited, so there is a Recent list");
  await page.locator("#blist .row", { hasText: "Alpha" }).last().locator(".caret").click();
  assert.ok((await rows()).includes("Beta"), "opening Alpha shows Beta under it");
  await page.locator("#blist .row", { hasText: "Beta" }).click(); await page.waitForFunction((a) => location.hash.length > 1 && location.hash !== "#" + a, alpha); await settle(page, 800);
  assert.equal(await page.locator("#crumbs a").last().innerText(), "Beta", "clicking a board opens it");
  assert.equal(await page.locator("#bpanel").isVisible(), false, "and the panel closes");
  // search across every board: Ctrl+F, type, the hit names its board, click jumps there and selects the card
  await page.keyboard.press("Control+f"); await page.keyboard.type("haystack");
  await page.waitForSelector("#blist .hit");
  assert.match(await page.locator("#blist .hit").first().innerText(), /Alpha/); assert.equal(await page.locator("#blist .hit mark").first().innerText(), "haystack");
  await page.locator("#blist .hit").first().click(); await page.waitForFunction((a) => location.hash === "#" + a, alpha); await page.waitForSelector(".note.selected"); await settle(page, 500);
  const n = await box(page, ".note.selected"); assert.ok(n.x > 0 && n.x + n.width < 1400 && n.y > 0 && n.y + n.height < 900, "the found card is on screen");
  // someone else cannot find it, and does not see these boards
  const other = await fresh();
  await other.page.keyboard.press("Control+f"); await other.page.keyboard.type("haystack"); await other.page.waitForFunction(() => /Nothing found/.test(document.getElementById("blist")!.innerText));
  assert.equal(await other.page.locator("#blist .hit").count(), 0, "another user's search does not reach your boards");
  assert.match(await other.page.locator("#blist h4").first().innerText(), /Nothing found/);
  await other.page.locator("#bq").fill(""); await other.page.waitForSelector("#blist .row");
  assert.equal((await other.page.locator("#blist .row").allInnerTexts()).some((t) => /Alpha|Beta/.test(t)), false, "nor their names in the tree");
  await other.ctx.close();
});

await test("outline: the board as an editable list in reading order; text edits, ticks and the text options reach the board", async ({ page }) => {
  await add(page, "note", "first note"); await add(page, "todo", "Groceries"); await add(page, "col", "Column A"); await settle(page, 600);
  await page.click("#outlineBtn");
  assert.equal(await page.locator("#outline").isVisible(), true);
  const items = await page.locator("#olist > .o-item").allInnerTexts();
  assert.equal(items.length, 3, "a note, a to-do list and a column");
  assert.match(items[0], /first note/); assert.match(items[1], /Groceries/); assert.match(items[2], /Column A/);
  await page.locator("#olist .o-text").first().click();
  assert.equal(await page.locator("#fmt").isVisible(), true, "the same text options appear in the left panel");
  await page.keyboard.press("Control+a"); await page.keyboard.type("changed in the outline"); await page.keyboard.press("Escape"); await settle(page, 800);
  assert.equal((await stored(page)).find((e) => e.elementType === "CARD").content.textContent, "changed in the outline");
  await page.locator("#olist .o-task input[type=checkbox]").check(); await settle(page, 800);
  assert.equal((await stored(page)).find((e) => e.elementType === "TASK_LIST").content.tasks[0].done, true, "a tick in the outline is a tick on the board");
  await page.locator("#olist .o-col .o-title").click(); await page.keyboard.press("Control+a"); await page.keyboard.type("Renamed"); await page.keyboard.press("Enter"); await settle(page, 800);
  assert.equal((await stored(page)).find((e) => e.elementType === "COLUMN").content.title, "Renamed");
  await page.keyboard.press("Escape"); await settle(page, 300);
  assert.equal(await page.locator("#outline").isVisible(), false, "Esc closes it");
  assert.equal(await page.locator("#canvas > .note .text").innerText(), "changed in the outline", "the board shows the edit");
  // a card edited on the board shows up in the open outline
  await page.click("#outlineBtn");
  await page.evaluate(() => { const el = Object.values((window as any).__els() as any).find((e: any) => e.elementType === "CARD"); return (0, eval)("update")(el, { textContent: "from the board" }); });
  await page.waitForFunction(() => /from the board/.test(document.getElementById("olist")!.innerText), null, { timeout: 4000 });
});

await test("theme: Ctrl+Shift+D and the Theme button switch light/dark and the choice is remembered", async ({ page }) => {
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const first = await theme(), firstBg = await bg();
  assert.ok(first === "light" || first === "dark", "it starts with the system's choice");
  await page.keyboard.press("Control+Shift+D");
  const second = await theme();
  assert.notEqual(second, first, "the shortcut switches it"); assert.notEqual(await bg(), firstBg, "and the colours really change");
  await page.reload(); await page.waitForFunction(() => (document.getElementById("st") as HTMLElement).dataset.state === "live");
  assert.equal(await theme(), second, "the choice is remembered after a reload");
  await page.click("#gearBtn"); await page.click("#themeBtn");
  assert.equal(await theme(), first, "the button switches it back");
  assert.equal((await model(page)).filter((e) => e.elementType === "CARD").length, 0, "Ctrl+Shift+D did not duplicate anything");
});

await test("keyboard: Ctrl+[ and Ctrl+] go back and forward, Ctrl+U goes up to the parent board", async ({ page }) => {
  const hash = () => page.evaluate(() => location.hash);
  await add(page, "brd", "Inner"); await settle(page, 400);
  await page.locator(".board").first().dblclick(); await page.waitForFunction(() => location.hash.length > 1); await settle(page, 800);
  const inner = await hash();
  await page.keyboard.press("Control+["); await settle(page, 600);
  assert.equal(await hash(), "", "back to the home board");
  await page.keyboard.press("Control+]"); await settle(page, 600);
  assert.equal(await hash(), inner, "forward into the board again");
  await page.keyboard.press("Control+u"); await page.waitForFunction(() => location.hash === "" || location.hash === "#"); await settle(page, 500);
  assert.equal(await page.locator(".board").count(), 1, "Ctrl+U is the parent: the home board with the tile");
});

await test("link card: hide and show its picture, description and address from the menu", async ({ page }) => {
  await page.click("#link"); await page.keyboard.type("http://127.0.0.1:3994/one"); await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".link .ptitle")?.textContent === "A Real Page", null, { timeout: 8000 });
  await page.waitForFunction(() => { const i = document.querySelector<HTMLImageElement>(".link .thumb"); return !!i && !i.hidden && i.naturalWidth > 0; }, null, { timeout: 5000 });
  const pick = async (label: string) => { await page.locator(".link").click({ button: "right" }); await page.locator("#cmenu button", { hasText: label }).click(); await settle(page, 500); };
  const shown = (sel: string) => page.locator(sel).isVisible();
  assert.equal(await shown(".link .thumb") && await shown(".link .pdesc") && await shown(".link .title"), true);
  await pick("Hide Picture"); assert.equal(await shown(".link .thumb"), false, "picture hidden");
  await pick("Hide Description"); assert.equal(await shown(".link .pdesc"), false, "description hidden");
  await pick("Hide Address"); assert.equal(await shown(".link .title"), false, "address hidden");
  assert.equal(await shown(".link .ptitle"), true, "the title stays");
  const s = (await stored(page)).find((e) => e.elementType === "LINK");
  assert.deepEqual([s.content.hideImage, s.content.hideDesc, s.content.hideUrl], [true, true, true], "saved");
  await page.reload(); await page.waitForFunction(() => (document.getElementById("st") as HTMLElement).dataset.state === "live"); await settle(page, 600);
  assert.equal(await shown(".link .thumb"), false, "still hidden after a reload");
  await pick("Show Picture"); await pick("Show Description"); await pick("Show Address");
  assert.equal(await shown(".link .thumb") && await shown(".link .pdesc") && await shown(".link .title"), true, "everything is back");
});

await test("top-bar popups open under their own button and close on a click elsewhere or Esc", async ({ page }) => {
  for (const [btn, pop, owner] of [["bgBtn", "bgpop", "gearBtn"], ["expBtn", "expop", "gearBtn"], ["boardsBtn", "bpanel", "boardsBtn"]]) {
    if (owner === "gearBtn") await page.click("#gearBtn"); // background and export live in the settings menu; their popup opens under the gear
    await page.click("#" + btn);
    const b = (await page.locator("#" + owner).boundingBox())!, p = (await page.locator("#" + pop).boundingBox())!;
    assert.ok(Math.abs(p.x - b.x) < 2 || p.x === 8 || p.x + p.width > 1000, `${pop} sits at its button`);
    assert.ok(p.y >= b.y + b.height && p.y - (b.y + b.height) < 20, `${pop} is just under its button`);
    await page.mouse.click(700, 500); // empty board
    assert.equal(await page.locator("#" + pop).isVisible(), false, `${pop} closes on a click on the board`);
    if (owner === "gearBtn") await page.click("#gearBtn");
    await page.click("#" + btn); await page.keyboard.press("Escape");
    assert.equal(await page.locator("#" + pop).isVisible(), false, `${pop} closes on Esc`);
  }
});

await test("left panel: drag a tool onto the board adds it under the pointer; a click still adds; dropping on the panel adds nothing", async ({ page }) => {
  const from = mid(await box(page, "#heading"));
  await drag(page, from, { x: 800, y: 450 });
  await settle(page, 600);
  const h = (await stored(page)).find((e) => e.content.heading);
  assert.ok(h, "the dragged heading was created and stored");
  const hb = await box(page, ".note.heading");
  within(hb.x + hb.width / 2, 800, 40, "centred on the drop x"); within(hb.y, 450 - 24, 30, "just above the drop y");
  await page.keyboard.press("Escape");
  await drag(page, mid(await box(page, "#todo")), mid(await box(page, "#table")));
  await settle(page, 400);
  assert.equal(await page.locator(".tasklist, .todo").count(), 0, "dropped back on the panel: nothing added");
  await page.click("#note"); await page.keyboard.press("Escape"); await settle(page, 400);
  assert.equal(await page.locator(".note").count(), 2, "a plain click on a tool still adds a card");
});

await test("opening a board clears the selection and its option panels; a selected card shows a bold resize corner", async ({ page }) => {
  await add(page, "brd", "Inner"); await settle(page, 400);
  await page.locator(".board").first().click(); await settle(page, 200);
  assert.equal(await page.locator("#colorbar").isVisible(), true, "one click: selected, colour options shown");
  assert.equal(await page.locator("#iconbar").isVisible(), true);
  await page.locator(".board").first().dblclick(); await page.waitForFunction(() => location.hash.length > 1); await settle(page, 800);
  for (const bar of ["#colorbar", "#iconbar", "#fmt"]) assert.equal(await page.locator(bar).isVisible(), false, `${bar} is gone inside the new board`);
  await add(page, "note", "x"); await page.locator(".note").click(); await settle(page, 200);
  const corner = await page.locator(".note.selected > .grip.se").evaluate((g) => { const a = getComputedStyle(g, "::after"); return [a.borderRightWidth, a.borderBottomWidth]; });
  assert.deepEqual(corner, ["4px", "4px"], "bold corner on the selected card");
});

await test("heading can be given a background colour", async ({ page }) => {
  await add(page, "heading", "Title");
  assert.notEqual(await page.locator(".note.heading").evaluate((e) => getComputedStyle(e).backgroundColor), "rgb(255, 255, 255)");
  const bare = await page.locator(".note.heading").evaluate((e) => getComputedStyle(e).backgroundColor);
  await page.locator(".note.heading").click({ position: { x: 4, y: 4 } });
  await page.locator("#colorbar .sw[data-val=orange], #colorbar .sw:not(.none):not(.custom)").first().click(); await settle(page, 600);
  assert.notEqual(await page.locator(".note.heading").evaluate((e) => getComputedStyle(e).backgroundColor), bare, "the heading now has a background");
});

await test("settings: Present is a full-screen icon at the bottom right; the top bar has no Background/Present/Theme text buttons", async ({ page }) => {
  const names = await page.locator("#top .btn:visible").allTextContents();
  assert.ok(!names.some((t) => /Background|Present|Theme|Export|Import/.test(t)), "none of them are in the top bar: " + names.join(","));
  const g = await box(page, "#gearBtn"); assert.ok(g.x > 1200, "the gear is at the top right");
  const z = await box(page, "#zoom"), pb = await box(page, "#presentBtn"); assert.ok(pb.x >= z.x && pb.y > 700, "the full-screen icon sits in the bottom-right pill");
});

await test("text size: type px by hand for the selected text", async ({ page }) => {
  await page.click("#note"); await page.keyboard.type("big words"); await page.keyboard.press("Control+a");
  await page.fill("#fsize", "50"); await page.press("#fsize", "Enter"); await settle(page, 700);
  const px = await page.locator(".note .text span").first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
  assert.equal(px, 50, "50px, past the old 32px maximum");
  await page.click("#fmt [data-c=sizeUp]"); await settle(page, 300);
  assert.equal(await page.inputValue("#fsize"), "51", "+ steps by 1px");
});

await test("iPhone 14 Pro: the page never zooms or scrolls, touch fields are 16px, adding a card leaves the bars where they are", async () => {
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
  const page = await ctx.newPage(); page.setDefaultTimeout(8000);
  await page.goto(`${URL}/?u=iph${Date.now().toString(36)}`);
  await page.waitForFunction(() => (document.getElementById("st") as HTMLElement).dataset.state === "live");
  const snap = () => page.evaluate(() => ({
    scale: visualViewport!.scale, scroll: [scrollX, scrollY], wide: document.documentElement.scrollWidth, top: document.getElementById("top")!.getBoundingClientRect().top,
    body: document.body.getBoundingClientRect().toJSON(), inner: [innerWidth, innerHeight], max: document.querySelector('meta[name=viewport]')!.getAttribute("content"),
    fonts: ["q", "bq", "fsize"].map((id) => parseFloat(getComputedStyle(document.getElementById(id)!).fontSize)),
  }));
  const a = await snap();
  assert.match(a.max!, /maximum-scale=1/, "the viewport tag forbids page zoom, so iOS cannot zoom into a focused field");
  assert.ok(a.fonts.every((f) => f >= 16), "fields are 16px on touch screens: " + a.fonts);
  await page.tap("#note"); await page.keyboard.type("hello"); await settle(page, 500);
  const b = await snap();
  assert.equal(b.scale, 1, "no page zoom after adding a card"); assert.deepEqual(b.scroll, [0, 0], "the page did not scroll"); assert.equal(b.top, 0, "the top bar stayed put");
  assert.equal(b.wide, a.wide, "nothing got wider"); assert.deepEqual([b.body.width, b.body.height], [b.inner[0], b.inner[1]], "the page is exactly the visible screen");
  await ctx.close();
});

await test("iPhone 14 Pro: the options bar stays inside the screen and scrolls sideways; the colour picker fits", async () => {
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage(); page.setDefaultTimeout(8000);
  await page.goto(`${URL}/?u=bar${Date.now().toString(36)}`);
  await page.waitForFunction(() => (document.getElementById("st") as HTMLElement).dataset.state === "live");
  await page.tap("#note"); await settle(page, 500);
  const r = await page.evaluate(() => { const c = document.getElementById("ctx")!, b = c.getBoundingClientRect(); return { l: b.left, r: b.right, ta: getComputedStyle(c).touchAction, w: innerWidth }; });
  assert.ok(r.l >= 0 && r.r <= r.w, "the bar is inside the screen: " + JSON.stringify(r));
  assert.match(r.ta, /pan-x/, "the bar can be swiped sideways");
  await page.evaluate(() => { document.getElementById("picker")!.hidden = false; });
  const p = await page.evaluate(() => { const b = document.getElementById("picker")!.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: innerWidth, h: innerHeight }; });
  assert.ok(p.l >= 0 && p.r <= p.w && p.t >= 0 && p.b <= p.h, "the picker fits the screen: " + JSON.stringify(p));
  await ctx.close();
});

await test("phone: one row top bar, nothing wider than the screen, tap targets 40px, one finger pans, two fingers pinch-zoom", async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage(); page.setDefaultTimeout(8000);
  await page.goto(`${URL}/?u=phone${Date.now().toString(36)}`);
  await page.waitForFunction(() => (document.getElementById("st") as HTMLElement).dataset.state === "live");
  const m = await page.evaluate(() => ({
    wide: document.documentElement.scrollWidth, bar: document.getElementById("top")!.getBoundingClientRect().height,
    small: [...document.querySelectorAll<HTMLElement>("#top .btn, #zoom .btn, .tool")].filter((e) => { const r = e.getBoundingClientRect(); return r.width < 40 || r.height < 40; }).length,
    tools: document.getElementById("tools")!.getBoundingClientRect().bottom,
  }));
  assert.equal(m.wide, 390, "no sideways scroll"); assert.ok(m.bar < 60, "top bar is one row"); assert.equal(m.small, 0, "every button is at least 40px");
  assert.ok(m.tools <= 844, "tools are on screen");
  const cdp = await ctx.newCDPSession(page), pt = (id: number, x: number, y: number) => ({ x, y, id });
  const touch = (type: string, pts: any[]) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts });
  const view = () => page.evaluate(() => ({ t: document.getElementById("canvas")!.style.transform, z: document.getElementById("zreset")!.textContent }));
  const v0 = await view();
  await touch("touchStart", [pt(1, 200, 400)]); await touch("touchMove", [pt(1, 260, 470)]); await touch("touchMove", [pt(1, 300, 520)]); await touch("touchEnd", []);
  const v1 = await view(); assert.notEqual(v1.t, v0.t, "one finger pans the board"); assert.equal(v1.z, v0.z, "panning does not zoom");
  await touch("touchStart", [pt(1, 150, 400), pt(2, 250, 400)]); await touch("touchMove", [pt(1, 100, 400), pt(2, 300, 400)]); await touch("touchMove", [pt(1, 60, 400), pt(2, 340, 400)]); await touch("touchEnd", []);
  const v2 = await view(); assert.ok(parseInt(v2.z!) > 100, `two fingers apart zoom in (${v2.z})`);
  await ctx.close();
});

await test("touch: a quick drag that starts on a card pans the board; resting on the card first lets you drag it", async () => {
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage(); page.setDefaultTimeout(8000);
  await page.goto(`${URL}/?u=hold${Date.now().toString(36)}`);
  await page.waitForFunction(() => (document.getElementById("st") as HTMLElement).dataset.state === "live");
  await add(page, "note", "hold me");
  const cdp = await ctx.newCDPSession(page), touch = (type: string, pts: any[]) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts });
  const state = () => page.evaluate(() => ({ view: document.getElementById("canvas")!.style.transform, card: (Object.values((window as any).__els()) as any[]).find((e) => e.content.textContent === "hold me").location.position.x }));
  const c = mid(await box(page, ".note")), s0 = await state();
  await touch("touchStart", [{ x: c.x, y: c.y, id: 1 }]); await touch("touchMove", [{ x: c.x + 40, y: c.y + 10, id: 1 }]); await touch("touchMove", [{ x: c.x + 80, y: c.y + 20, id: 1 }]); await touch("touchEnd", []); await settle(page, 2500); // the flick glides on for a moment
  let s1 = await state();
  assert.notEqual(s1.view, s0.view, "the board panned"); assert.equal(s1.card, s0.card, "the card stayed where it was");
  await page.evaluate(() => (document.getElementById("zreset") as HTMLElement).click()); await settle(page, 300); s1 = await state(); // the flick may have thrown the card off screen
  const c2 = mid(await box(page, ".note"));
  await touch("touchStart", [{ x: c2.x, y: c2.y, id: 1 }]); await settle(page, 500);
  await touch("touchMove", [{ x: c2.x + 60, y: c2.y, id: 1 }]); await touch("touchMove", [{ x: c2.x + 120, y: c2.y, id: 1 }]); await touch("touchEnd", []); await settle(page, 700);
  const s2 = await state();
  assert.equal(s2.view, s1.view, "held first: the board did not pan"); assert.ok(s2.card > s1.card + 50, `the card moved (${s1.card} -> ${s2.card})`);
  await ctx.close();
});

await test("big board: 900 cards and 99 lines open quickly, dragging them stays smooth, selecting is quick", async ({ page }) => {
  const N = 900, ok = await page.evaluate(async (n) => {
    const send = (0, eval)("send"), B = (0, eval)("B"), made: Promise<{ status: number }>[] = [];
    for (let i = 0; i < n; i++) made.push(send({ type: "ELEMENT_CREATE", id: "bulk" + i, elementType: "CARD", location: { parentId: B, section: "CANVAS", position: { score: i + 1, x: (i % 30) * 190, y: Math.floor(i / 30) * 110 } }, content: { textContent: "card " + i }, meta: { versionId: "v1", modifiedTime: 1 } }));
    for (let i = 0; i < 99; i++) made.push(send({ type: "ELEMENT_CREATE", id: "ln" + i, elementType: "LINE", location: { parentId: B, section: "CANVAS", position: { score: n + i + 1, x: 0, y: 0 } }, content: { x1: 0, y1: 0, x2: 0, y2: 0, from: "bulk" + i, to: "bulk" + (i + 1) }, meta: { versionId: "v1", modifiedTime: 1 } }));
    return (await Promise.all(made)).every((r) => r.status === 200);
  }, N);
  assert.ok(ok, "the cards were created");
  const t0 = Date.now(); await page.reload(); await page.waitForFunction((n) => document.querySelectorAll(".card").length >= n + 99, N, { timeout: 20000 }); const load = Date.now() - t0;
  const a = mid(await box(page, "#bulk0")), b = { x: a.x + 160, y: a.y + 90 };
  await page.mouse.click(a.x, a.y); // select one card that has a line on it, then drag it
  const t1 = Date.now(); await drag(page, a, b, 40); const dragMs = Date.now() - t1;
  const t2 = Date.now(); await page.keyboard.press("Control+a"); await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(0)))); const selMs = Date.now() - t2;
  assert.match((await page.locator("#bulk0").getAttribute("aria-label")) ?? "", /^note: card 0/, "cards are labelled for screen readers");
  console.log(`       (900 cards + 99 lines: load ${load} ms, a 40-step drag ${dragMs} ms, select all ${selMs} ms)`);
  assert.ok(load < 6000, `loads in under 6s (${load} ms)`); assert.ok(dragMs < 3000, `the drag takes under 3s (${dragMs} ms)`); assert.ok(selMs < 1500, `select all takes under 1.5s (${selMs} ms)`);
});

await test("conflict: an edit on a stale version is retried on the fresh card, without reloading the board", async ({ page }) => {
  await add(page, "note", "one"); await add(page, "note", "two");
  const out = await page.evaluate(async () => {
    const els = (0, eval)("els"), update = (0, eval)("update"), cards = Object.values(els) as any[];
    const a = cards.find((e) => e.content.textContent === "one"), other = document.getElementById(cards.find((e) => e.content.textContent === "two").id)!;
    (other as any).mark = "same node"; // a full reload of the board would replace this element
    a.meta.versionId = "somebody-else-got-there-first";
    const ok = await update(a, { color: "orange" });
    return { ok, mark: (document.getElementById(other.id) as any).mark, color: a.content.color };
  });
  assert.equal(out.ok, true, "the edit went through on the second try"); assert.equal(out.mark, "same node", "the board was not reloaded"); assert.equal(out.color, "orange");
  assert.ok((await stored(page)).some((e) => e.content.textContent === "one" && e.content.color === "orange"), "the server has it");
});

await test("touch: a flick tosses the board, which glides on and stops by itself; a slow drag that stops before lifting does not", async () => {
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage(); page.setDefaultTimeout(8000);
  await page.goto(`${URL}/?u=toss${Date.now().toString(36)}`);
  await page.waitForFunction(() => (document.getElementById("st") as HTMLElement).dataset.state === "live");
  const cdp = await ctx.newCDPSession(page), touch = (type: string, pts: any[]) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts });
  const x = () => page.evaluate(() => (window as any).__view().x);
  const swipe = async (still: boolean) => {
    await touch("touchStart", [{ x: 150, y: 400, id: 1 }]);
    for (let i = 1; i <= 8; i++) { await touch("touchMove", [{ x: 150 + i * 20, y: 400, id: 1 }]); await page.waitForTimeout(16); }
    if (still) await page.waitForTimeout(250);
    await touch("touchEnd", []);
  };
  const x0 = await x(); await swipe(false); const x1 = await x(); await page.waitForTimeout(150); const x2 = await x();
  assert.ok(x1 - x0 > 100, "the finger moved the board"); assert.ok(x2 - x1 > 20, `the board kept gliding after release (${x1} -> ${x2})`);
  await page.waitForTimeout(2500); const x3 = await x(); await page.waitForTimeout(300);
  assert.equal(await x(), x3, "and it came to a stop");
  const y0 = await x(); await swipe(true); const y1 = await x(); await page.waitForTimeout(300);
  assert.equal(await x(), y1, `resting before lifting: no toss (moved ${y1 - y0})`);
  await ctx.close();
});

// accounts: a second server with logins on; two browsers (alice, bob) go through the login page and the Share dialog
await test("accounts: the login page, sign up, log out and in; sharing a board by username gives that user access", async () => {
  const as = createServer(3993, ":memory:", { accounts: true }), AURL = "http://localhost:3993";
  const ctxs: BrowserContext[] = [];
  const open = async () => { const c = await browser.newContext({ viewport: { width: 1400, height: 900 } }); ctxs.push(c); const p = await c.newPage(); p.setDefaultTimeout(8000); await p.goto(AURL + "/"); return p; };
  const live = (p: Page) => p.waitForFunction(() => (document.getElementById("st") as HTMLElement)?.dataset.state === "live");
  const form = async (p: Page, name: string, pw: string) => { await p.fill("#name", name); await p.fill("#pw", pw); await p.click("#go"); };
  try {
    const alice = await open(), bob = await open();
    await alice.waitForSelector("#f");
    await alice.click("#swap"); await form(alice, "alice", "correct horse"); await live(alice);
    assert.equal(await alice.evaluate(() => (window as any).ACCOUNT), "alice");
    await alice.click("#gearBtn"); await alice.click("#outBtn");
    await alice.waitForSelector("#f");
    await form(alice, "alice", "wrong password");
    await alice.waitForFunction(() => /Wrong name or password/.test(document.getElementById("err")!.textContent!));
    await form(alice, "alice", "correct horse"); await live(alice);

    await bob.click("#swap"); await form(bob, "bob", "correct horse"); await live(bob);

    await alice.click("#brd"); await alice.keyboard.type("Together"); await alice.keyboard.press("Escape"); await settle(alice, 600);
    await alice.locator("#canvas > .board").dblclick(); await settle(alice, 1500);
    await add(alice, "note", "from alice");
    const url = alice.url();

    await alice.click("#gearBtn"); await alice.click("#shareBtn");
    await alice.fill("#shareuser", "ghost"); await alice.click("#shareadd");
    await alice.waitForFunction(() => /Nobody is called ghost/.test(document.getElementById("sharemsg")!.textContent!));
    await alice.fill("#shareuser", "bob"); await alice.click("#shareadd");
    await alice.waitForFunction(() => /bob/.test(document.getElementById("sharelist")!.textContent!));

    await bob.goto(url); await live(bob); await settle(bob, 800);
    assert.ok((await model(bob)).some((e) => e.content.textContent === "from alice"), "bob sees alice's note on the shared board");
    await add(bob, "note", "from bob"); await settle(alice, 600);
    assert.ok((await model(alice)).some((e) => e.content.textContent === "from bob"), "and alice sees bob's note live");
    await bob.click("#boardsBtn"); await bob.waitForSelector("#blist .row");
    assert.match(await bob.locator("#blist").innerText(), /Shared with you[\s\S]*Together[\s\S]*from alice/, "the board is listed under Shared with you, with its owner");
    await bob.keyboard.press("Escape");
    await bob.click("#gearBtn"); await bob.click("#shareBtn");
    assert.equal(await bob.locator("#shareadd").isDisabled(), true, "bob can edit but not change who has access");
  } finally { for (const c of ctxs) await c.close(); await as.close(); }
});

await browser.close(); await srv.close(); pages.close(); rmSync(shots, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.log("screenshots of failures were written to " + shots); process.exit(1); }
