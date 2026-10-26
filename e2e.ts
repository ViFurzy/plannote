// End-to-end tests: a real Chrome driven with genuine mouse and keyboard input (Playwright's driver, no bundled browser).
// Run with `npm run e2e`. Each test gets a fresh user, so it starts on an empty home board.
import { chromium, type Page, type BrowserContext } from "playwright-core";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return; // ONLY="text size" npm run e2e: just the tests whose name contains it
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
  const moved = await box(page, ".note"), pos = (p: Page) => model(p).then((m) => m.find((e) => e.elementType === "CARD").location.position); // the other tab opened with its own view (the board is centred there), so compare board positions
  within(moved.x, start.x + 240, 4, "x on this tab"); const here = await pos(page), there = await pos(other); within(there.x, here.x, 2, "x on the other tab"); within(there.y, here.y, 2, "y on the other tab");
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

await test("drawing: a Pencil's pressure changes the stroke width, the pen size is chosen and remembered, the eraser deletes strokes it touches", async ({ page, ctx }) => {
  const cdp = await ctx.newCDPSession(page), pen = (type: string, x: number, y: number, force: number) => cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, pointerType: "pen", force });
  const sketches = async () => (await stored(page)).filter((e) => e.elementType === "SKETCH");
  await page.click("#draw"); await page.click('#pensize [data-size="9"]');
  await pen("mouseMoved", 400, 300, 0); await pen("mousePressed", 400, 300, 0.2);
  for (let i = 1; i <= 10; i++) await pen("mouseMoved", 400 + i * 20, 300 + i * 4, 0.2 + i * 0.08);
  await pen("mouseReleased", 600, 340, 0); await settle(page, 600);
  const [s] = await sketches();
  assert.equal(s.content.size, 9, "the chosen size is stored with the stroke");
  assert.ok(s.content.paths[0].every((q: number[]) => q.length === 3 && q[2] > 0 && q[2] <= 1), "every point carries its pressure");
  assert.ok(await page.locator("#canvas .sketch .ink").count() > 1, "different pressures draw as runs of different widths");
  await page.click("#draw"); await page.click("#draw"); // off and on again: the size is still selected
  assert.equal(await page.locator('#pensize [data-size="9"]').evaluate((b) => b.classList.contains("on")), true);
  await page.click("#erase");
  await page.mouse.move(500, 250); await page.mouse.down(); await page.mouse.move(500, 360, { steps: 8 }); await page.mouse.up(); await settle(page, 700);
  assert.equal(await page.locator("#canvas .sketch").count(), 0, "the eraser removed the stroke it crossed");
  assert.equal((await sketches()).length, 0, "and it is gone on the server");
  await page.keyboard.press("Control+z"); await settle(page, 900);
  assert.equal(await page.locator("#canvas .sketch").count(), 1, "undo brings it back");
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

await test("shapes: pick one from the Shape tool, type in it, resize keeps the line thickness, change kind/fill/dash/weight and colour, arrows meet the true outline", async ({ page }) => {
  const shapes = async () => (await stored(page)).filter((e) => e.elementType === "SHAPE");
  await page.click("#shape");
  assert.equal(await page.locator("#shapepop button").count(), 20, "twenty shapes to choose from");
  assert.ok((await page.locator("#shapepop button").first().boundingBox())!.height >= 44, "cells are at least 44 px tall");
  await page.click('#shapepop [data-kind="ellipse"]'); await page.keyboard.type("Hello"); await page.keyboard.press("Escape"); await settle(page, 700);
  const [s] = await shapes();
  assert.equal(s.content.kind, "ellipse"); assert.equal(s.content.textContent, "Hello", "its text is stored where search and export read it");
  assert.equal(await page.locator(".shape .text").innerText(), "Hello");
  const sw = () => page.locator(".shape .body").evaluate((p) => getComputedStyle(p).strokeWidth);
  const path0 = await page.locator(".shape .body").getAttribute("d"), sw0 = await sw();
  const r = await box(page, ".shape"); await page.locator(".shape").click({ position: { x: r.width / 2, y: r.height / 2 } });
  const se = await box(page, ".shape .grip.se"); await drag(page, mid(se), { x: mid(se).x + 120, y: mid(se).y + 60 }); await settle(page, 700);
  assert.notEqual(await page.locator(".shape .body").getAttribute("d"), path0, "the outline is drawn again at the new size");
  assert.equal(await sw(), sw0, "and its line is as thick as before");
  const [big] = await shapes(); assert.ok(big.content.width > 160 && big.content.height > 120, "the new size is stored");
  // options: kind, outline only, dashed, thick
  await page.click("#shapeKind"); await page.click('#shapepop [data-kind="star"]'); await page.click('#shapebar [data-prop=fill] [data-val=none]'); await page.click('#shapebar [data-prop=dash] [data-val=dashed]'); await page.click('#shapebar [data-prop=weight] [data-val="6"]'); await settle(page, 700);
  const [o] = await shapes(); assert.deepEqual([o.content.kind, o.content.fill, o.content.dash, o.content.weight], ["star", "none", "dashed", 6]);
  assert.equal(await page.locator(".shape").evaluate((d) => d.classList.contains("nofill") && d.classList.contains("dashed")), true);
  assert.equal(await sw(), "6px");
  await page.click('#colorbar [data-val="rose"]'); await settle(page, 600);
  assert.equal((await shapes())[0].content.color, "rose", "the colour bar works on shapes");
  await page.keyboard.press("Control+z"); await settle(page, 700); assert.equal((await shapes())[0].content.color ?? null, null, "undo");
  // an arrow leaves an ellipse on its curve, not at the corner of its box
  const p = await page.evaluate(() => { const E = (0, eval); const w = E("window") as any; return E("edgePoint")({ l: 0, t: 0, r: 200, b: 100, poly: E("shapeRings")({ kind: "ellipse" }, 200, 100)[0] }, { x: 200, y: 100 }); });
  within(p.x, 170.7, 3, "arrow end x on the ellipse"); within(p.y, 85.4, 3, "arrow end y on the ellipse");
  // every kind draws something and hostile kinds fall back to a rectangle
  const bad = await page.evaluate(() => { const S = (window as any).SHAPES; return [S.KINDS.every(([k]: string[]) => S.poly(k, 100, 60)[0].length >= 3), S.poly("constructor", 100, 60)[0].length === 4, S.poly("__proto__", 100, 60)[0].length === 4]; });
  assert.deepEqual(bad, [true, true, true]);
});

await test("shapes: search the picker in English and Polish, drag one out onto the board, the outline view lists its text", async ({ page }) => {
  const shown = () => page.locator("#shapepop button[data-kind]:visible").evaluateAll((a) => a.map((b) => (b as HTMLElement).dataset.kind));
  await page.click("#shape");
  await page.fill("#shapeq", "serce"); assert.deepEqual(await shown(), ["heart"], "Polish name");
  await page.fill("#shapeq", "storage"); assert.deepEqual(await shown(), ["cylinder"], "a search word");
  await page.fill("#shapeq", "zzz"); assert.deepEqual(await shown(), []);
  await page.fill("#shapeq", "serce");
  await drag(page, mid(await box(page, '#shapepop [data-kind="heart"]')), { x: 700, y: 400 }, 10); await settle(page, 700);
  const [s] = (await stored(page)).filter((e) => e.elementType === "SHAPE");
  assert.equal(s.content.kind, "heart", "dropped on the board");
  const c = mid(await box(page, ".shape")); within(c.x, 700, 12, "centred under the pointer x"); within(c.y, 400, 12, "centred under the pointer y");
  assert.equal(await page.locator("#shapepop").isVisible(), false, "the picker closed");
  await page.keyboard.type("Love"); await page.keyboard.press("Escape"); await settle(page, 600);
  await page.click("#outlineBtn"); await settle(page, 400);
  assert.equal(await page.locator("#olist .o-shape").count(), 1, "the outline lists the shape"); assert.match(await page.locator("#olist .o-shape").innerText(), /Heart/);
});

await test("templates: every one is well formed, the picker finds one by word, using it makes a board that opens with its cards and attached arrows", async ({ page }) => {
  const bad = await page.evaluate(() => {
    const T = (window as any).TEMPLATES, S = (window as any).SHAPES, problems: string[] = [];
    for (const t of T.list) {
      const list = T.build(t), ids = new Set(list.map((e: any) => e.id));
      if (ids.size !== list.length) problems.push(t.id + ": duplicate ids");
      if (list.length < 4) problems.push(t.id + ": too few cards");
      for (const e of list) {
        if (e.parent !== "root" && !ids.has(e.parent)) problems.push(t.id + ": missing parent");
        if (e.type === "LINE" && !(ids.has(e.content.from) && ids.has(e.content.to))) problems.push(t.id + ": loose arrow");
        if (e.type === "SHAPE" && !S.has(e.content.kind)) problems.push(t.id + ": bad shape");
        if (!/^(CARD|COLUMN|TASK_LIST|TABLE|SHAPE|SWATCH|LINK|LINE)$/.test(e.type)) problems.push(t.id + ": type " + e.type);
      }
    }
    return [T.list.length, problems];
  });
  assert.deepEqual(bad, [12, []]);
  assert.equal(await page.locator("#tplBtn").isVisible(), false, "no Add a template on the Home canvas");
  await add(page, "brd", "Work"); await page.locator("#canvas > .board").dblclick(); await settle(page, 1200); // into a board of its own
  assert.equal(await page.locator("#tplBtn").isVisible(), true, "Add a template is there inside a board");
  const b = await box(page, "#tplBtn"); assert.ok(b.x + b.width > 1300 && b.y + b.height > 700, "bottom right of the screen");
  const board = await page.evaluate(() => (0, eval)("B"));
  await page.click("#tplBtn");
  assert.equal(await page.locator("#tplgrid .tpl:visible").count(), 12, "the twelve templates");
  await page.fill("#tplq", "tasks"); assert.equal(await page.locator("#tplgrid .tpl:visible").count(), 1, "found by a word"); assert.match(await page.locator("#tplgrid .tpl:visible").innerText(), /kanban/i);
  await page.fill("#tplq", "");
  await page.locator('#tplgrid .tpl[data-id="project"]').click(); await settle(page, 1200);
  assert.equal(await page.locator("#tplpop").isVisible(), false, "the picker closed");
  assert.equal(await page.locator("#yndlg").isVisible(), false, "an empty board is filled without asking");
  assert.equal(await page.evaluate(() => (0, eval)("B")), board, "the template went into this board");
  const inside = (await stored(page));
  assert.ok(inside.filter((e) => e.elementType === "SHAPE").length >= 4 && inside.filter((e) => e.elementType === "LINE").length === 3, "the board now holds the shapes and three arrows");
  const ids = new Set(inside.map((e) => e.id));
  assert.ok(inside.filter((e) => e.elementType === "LINE").every((l) => ids.has(l.content.from) && ids.has(l.content.to)), "arrows point at the copies, not the originals");
  assert.equal(await page.locator(".shape").count() >= 4, true);
  // a board with cards asks first
  const shapes = await page.locator(".shape").count();
  await page.click("#tplBtn"); await page.locator('#tplgrid .tpl[data-id="kanban"]').click();
  assert.equal(await page.locator("#yndlg").isVisible(), true, "cards on the board: it asks");
  assert.match(await page.locator("#yntext").innerText(), /will be deleted to make room for the template/);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "ynno", "No is under the Enter key");
  await page.click("#ynno"); await settle(page, 600);
  assert.equal(await page.locator("#yndlg").isVisible(), false); assert.equal(await page.locator(".shape").count(), shapes, "No: nothing changed");
  await page.click("#tplBtn"); await page.locator('#tplgrid .tpl[data-id="kanban"]').click(); await page.keyboard.press("Escape"); await settle(page, 400);
  assert.equal(await page.locator(".shape").count(), shapes, "Escape is a No too");
  await page.click("#tplBtn"); await page.locator('#tplgrid .tpl[data-id="kanban"]').click(); await page.click("#ynyes"); await settle(page, 1500);
  assert.equal(await page.locator(".shape").count(), 0, "Yes: the old cards are gone");
  assert.ok((await stored(page)).filter((e) => e.elementType === "COLUMN").length >= 3, "and the kanban columns are there");
  await page.keyboard.press("Control+z"); await settle(page, 800); await page.keyboard.press("Control+z"); await settle(page, 800);
  assert.equal(await page.locator(".shape").count(), shapes, "two Undos bring the old cards back");
});

await test("templates in Polish: the picker follows the browser language", async () => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "pl-PL" });
  const page = await ctx.newPage(); page.setDefaultTimeout(8000); await page.goto(`${URL}/?u=pl${Date.now().toString(36)}`);
  await page.waitForFunction(() => (document.getElementById("st") as HTMLElement).dataset.state === "live");
  await add(page, "brd", "Praca"); await page.locator("#canvas > .board").dblclick(); await settle(page, 1200);
  await page.click("#tplBtn");
  assert.equal(await page.locator('#tplgrid .tpl[data-id="kanban"] b').innerText(), "Tablica kanban");
  await page.fill("#tplq", "kolumny"); assert.equal(await page.locator("#tplgrid .tpl:visible").count() >= 1, true, "found by a Polish word");
  await ctx.close();
});

await test("PNG export puts every card where it is on the board (a note and a shape both show up)", async ({ page }) => {
  await add(page, "note", "a note"); await page.click("#shape"); await page.click('#shapepop [data-kind="star"]'); await page.keyboard.press("Escape"); await settle(page, 500);
  await page.click("#gearBtn"); await page.click("#expBtn");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click('#expop [data-x="png"]')]);
  const file = join(shots, "export-check.png"); await dl.saveAs(file);
  const dark = await page.evaluate(async (b64) => { // share of pixels that are not the background, in the left and right halves
    const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const g = c.getContext("2d")!; g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data, bg = [d[0], d[1], d[2]]; let n = 0, tot = 0, edge = 0;
    for (let i = 0; i < d.length; i += 4) { tot++; if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 30) { n++; const x = (i / 4) % c.width; if (x < 40 || x > c.width - 40) edge++; } }
    return { share: n / tot, edge };
  }, readFileSync(file).toString("base64"));
  assert.ok(dark.share > 0.01, `the cards are drawn inside the picture (${dark.share})`); assert.equal(dark.edge, 0, "and nothing touches the edge padding");
});

await test("a picture larger than 2048 px is shrunk before it is uploaded; a small one is left alone", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "e2e-big-")), big = join(dir, "big.png");
  const b64 = await page.evaluate(() => { const c = document.createElement("canvas"); c.width = 3200; c.height = 1600; const g = c.getContext("2d")!; g.fillStyle = "#3e63dd"; g.fillRect(0, 0, 3200, 1600); return c.toDataURL("image/png").split(",")[1]; });
  writeFileSync(big, Buffer.from(b64, "base64"));
  await page.setInputFiles("#file", big);
  await page.waitForFunction(() => { const i = document.querySelector<HTMLImageElement>(".image img"); return !!i && i.complete && i.naturalWidth > 0; });
  assert.deepEqual(await page.locator(".image img").evaluate((i: HTMLImageElement) => [i.naturalWidth, i.naturalHeight]), [2048, 1024], "the stored picture is 2048 px on its long side, same shape");
  const small = join(dir, "two.png"); writeFileSync(small, twoColourPng());
  await page.setInputFiles("#file", small);
  await page.waitForFunction(() => document.querySelectorAll(".image img").length === 2 && [...document.querySelectorAll<HTMLImageElement>(".image img")].every((i) => i.complete && i.naturalWidth > 0));
  assert.ok((await page.locator(".image img").evaluateAll((a: HTMLImageElement[]) => a.map((i) => i.naturalWidth))).some((w) => w < 100), "a small picture keeps its own size");
  rmSync(dir, { recursive: true });
});

for (const [w, h] of [[834, 1194], [1180, 820]] as const) {
  await test(`iPad layout (${w}x${h}): nothing scrolls sideways, the bars fit, every button and field is at least 44 px`, async () => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, deviceScaleFactor: 2 });
    const page = await ctx.newPage(); page.setDefaultTimeout(8000); await page.goto(`${URL}/?u=lay${w}${Date.now().toString(36)}`);
    await page.waitForFunction(() => (document.getElementById("st") as HTMLElement).dataset.state === "live");
    const audit = () => page.evaluate((W) => {
      const small: string[] = [];
      for (const el of document.querySelectorAll("button, input, a[href], .tool")) {
        const b = el.getBoundingClientRect(), cs = getComputedStyle(el);
        if (!b.width || !b.height || cs.visibility === "hidden" || el.closest("[hidden], #canvas") || el.classList.contains("sw") || el.closest(".seg")?.querySelector(".sw")) continue; // colour dots are 32-36 px by design
        if (Math.min(b.width, b.height) < 43.5) small.push((el.id || el.className || el.tagName) + " " + Math.round(b.width) + "x" + Math.round(b.height));
      }
      return { small, wide: document.documentElement.scrollWidth > W, bars: [...document.querySelectorAll("#top, #ctx, #tools, #zoom")].filter((b) => { const r = b.getBoundingClientRect(); return r.width && (r.left < -1 || r.right > W + 1); }).map((b) => b.id) };
    }, w);
    for (const [label, act] of [["empty board", async () => {}], ["a note selected", async () => { await page.click("#note"); await page.keyboard.press("Escape"); }], ["boards panel", async () => { await page.click("#boardsBtn"); }], ["draw bar", async () => { await page.keyboard.press("Escape"); await page.click("#draw"); }]] as const) {
      await act(); await settle(page, 300);
      const r = await audit();
      assert.deepEqual(r, { small: [], wide: false, bars: [] }, `${label}: ${JSON.stringify(r)}`);
    }
    await ctx.close();
  });
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

await test("a board can be renamed after it is made: click its name once selected, or Rename in the menu (mouse); a touch tap on the name does not start editing", async ({ page }) => {
  await add(page, "brd", "Trip"); await settle(page, 400);
  const title = page.locator("#canvas > .board .title"), editing = () => title.evaluate((e) => (e as HTMLElement).isContentEditable);
  await page.mouse.click(700, 600); await settle(page, 600); // nothing selected
  await title.click(); assert.equal(await editing(), false, "the first click only selects the board");
  await settle(page, 600); // slower than a double click, which opens the board
  await title.click(); assert.equal(await editing(), true, "a second, separate click on the name edits it");
  await page.keyboard.type("Lisbon"); await page.keyboard.press("Escape"); await settle(page, 500);
  assert.equal(await title.innerText(), "Lisbon");
  assert.equal(new globalThis.URL(page.url()).hash.length <= 1, true, "and the board was not opened");
  await title.click({ button: "right" });
  await page.locator("#cmenu button", { hasText: "Rename" }).click(); assert.equal(await editing(), true, "the right-click menu has Rename");
  await page.keyboard.type("Porto"); await page.keyboard.press("Escape"); await settle(page, 500);
  assert.equal(await title.innerText(), "Porto");
  await title.dblclick(); await settle(page, 800); assert.ok(new globalThis.URL(page.url()).hash.length > 1, "a double click still opens it");

  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true });
  const t = await ctx.newPage(); t.setDefaultTimeout(8000);
  await t.goto(`${URL}/?u=ren${Date.now().toString(36)}`);
  await t.waitForFunction(() => (document.getElementById("st") as HTMLElement).dataset.state === "live");
  await t.tap("#brd"); await t.keyboard.type("Garden"); await t.keyboard.press("Escape"); await settle(t, 500);
  const tt = t.locator("#canvas > .board .title");
  await t.mouse.move(5, 5); await tt.tap(); await settle(t, 700); await tt.tap(); await settle(t, 500);
  assert.equal(await tt.evaluate((e) => (e as HTMLElement).isContentEditable), false, "touch: two slow taps on the name do not start editing");
  await ctx.close();
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

await test("export: every format in the menu downloads a real file of that type (PDF, PNG, Word, ZIP, Markdown, text, board file)", async ({ page }) => {
  await add(page, "note", "export me"); await add(page, "todo", "Tasks");
  // PDF opens the browser's print dialog (Save as PDF), so it has no file to check; "Word document" is an HTML page saved as .doc, which Word opens
  for (const fmt of ["pdf", "pdfhq"]) {
    await page.click("#gearBtn"); await page.click("#expBtn"); await page.click(`#expop [data-x="${fmt}"]`);
    await page.waitForFunction(() => /Choose Save as PDF|failed/.test(document.getElementById("exmsg")!.textContent!), null, { timeout: 15000 });
    assert.match(await page.locator("#exmsg").innerText(), /Choose Save as PDF/, `${fmt}: reaches the print dialog without an error`);
    await page.keyboard.press("Escape"); await settle(page, 200);
  }
  const magic: Record<string, (b: Buffer) => boolean> = {
    png: (b) => b.subarray(1, 4).toString() === "PNG", docx: (b) => /<html/i.test(b.toString()) && b.toString().includes("export me"),
    md: (b) => b.toString().includes("export me"), txt: (b) => b.toString().includes("export me"), json: (b) => JSON.parse(b.toString()) !== null,
  };
  const dir = mkdtempSync(join(tmpdir(), "e2e-exp-"));
  for (const [fmt, ok] of Object.entries(magic)) {
    await page.click("#gearBtn"); await page.click("#expBtn");
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 15000 }), page.click(`#expop [data-x="${fmt}"]`)]).catch((e) => { throw new Error(`${fmt}: no download (${String(e.message).split("\n")[0]})`); });
    const file = join(dir, "out-" + fmt); await dl.saveAs(file);
    const bytes = readFileSync(file); assert.ok(bytes.length > 5, `${fmt}: the file has content (${bytes.length} bytes)`); assert.ok(ok(bytes), `${fmt}: it really is one (${dl.suggestedFilename()})`);
    await page.keyboard.press("Escape"); await settle(page, 200);
  }
  rmSync(dir, { recursive: true });
  await page.click("#gearBtn"); await page.click("#expBtn");
  assert.equal(await page.locator("#exZip").isDisabled(), true, "the images ZIP is off while the board has no pictures");
});

await test("board icons: a fitting icon for the board's name (English or Polish), search by name or category in both languages, a chosen icon sticks", async ({ page }) => {
  const iconOf = (title: string) => page.evaluate((t) => (Object.values((window as any).__els()) as any[]).find((e) => e.content.title === t)?.content, title);
  const words = (name: string) => page.evaluate((n) => (0, eval)("ICON_INDEX").find((i: any) => i.name === n).words.join(" "), name);
  await add(page, "brd", "Kitchen"); await settle(page, 700);
  let c = await iconOf("Kitchen"); assert.ok(c.icon && c.iconAuto, "a new named board gets an icon of its own");
  assert.match(await words(c.icon), /kitchen|cook|food|chef|meal|egg|bread|cake|cheese|apple|coffee|salad|pizza|burger|soup|grill|bowl|glass|cup|bottle|cookie|candy|milk/, `${c.icon} fits a kitchen`);
  await add(page, "brd", "Łazienka"); await settle(page, 700);
  c = await iconOf("Łazienka"); assert.ok(c.icon && c.iconAuto, "a Polish name works too");
  assert.match(await words(c.icon), /lazienk|kapiel|prysznic|wanna|bath|shower|toilet|wash|trash/, `${c.icon} fits a bathroom`);
  const tile = await page.locator(".board", { hasText: "Kitchen" }).locator(".tile svg").count(); assert.equal(tile, 1, "the tile draws it");
  // the picker: suggestions, search, categories
  await page.locator(".board", { hasText: "Kitchen" }).click(); await page.click("#iconBtn");
  await page.waitForSelector("#iconpick:not([hidden])");
  assert.ok((await page.locator("#iconsugs .ib").count()) >= 3, "suggestions for the name are offered");
  const shown = (q: string) => page.evaluate(async (q) => { const i = document.getElementById("iconq") as HTMLInputElement; i.value = q; i.dispatchEvent(new Event("input")); return [...document.querySelectorAll<HTMLElement>("#icongrid .ib")].filter((b) => !b.hidden).map((b) => b.dataset.name); }, q);
  assert.ok((await shown("kuchnia")).includes("chef-hat"), "'kuchnia' finds the chef hat"); assert.ok((await shown("cooking")).includes("chef-hat"), "so does 'cooking'");
  assert.ok((await shown("lazienka")).includes("bath"), "no accents needed"); assert.ok((await shown("łazienka")).includes("bath"), "with accents too");
  assert.ok((await shown("podróże")).includes("plane"), "a category word in Polish shows the category"); assert.equal((await shown("zzzzqq")).length, 0, "nonsense finds nothing");
  assert.ok((await shown("")).length > 300, "an empty search shows the whole library");
  await page.click("#icongroups button >> nth=2"); assert.ok((await shown("")).length < 80, "a category narrows it");
  // choosing by hand
  await page.click("#icongroups button >> nth=0"); await page.fill("#iconq", "rocket"); await page.locator('#icongrid .ib[data-name="rocket"]').click(); await settle(page, 600);
  c = await iconOf("Kitchen"); assert.equal(c.icon, "rocket"); assert.ok(!c.iconAuto, "a chosen icon is no longer automatic");
  assert.equal(await page.locator("#iconpick").isVisible(), false, "the picker closes after a choice");
  await page.locator(".board", { hasText: "Kitchen" }).locator(".tile svg").waitFor();
});

await test("double-click on the empty board makes a note there; Ctrl+Enter adds another next to the selected one", async ({ page }) => {
  await page.mouse.dblclick(700, 400); await settle(page, 500); await page.keyboard.type("first"); await page.keyboard.press("Escape"); await settle(page, 400);
  assert.equal(await page.locator(".note").count(), 1, "a note appeared");
  const a = await box(page, ".note"); within(a.x, 700, 40, "at the pointer"); within(a.y, 400, 40, "at the pointer");
  await page.locator(".note").first().click(); await page.keyboard.press("Control+Enter"); await settle(page, 500); await page.keyboard.type("second"); await page.keyboard.press("Escape"); await settle(page, 400);
  assert.equal(await page.locator(".note").count(), 2, "Ctrl+Enter added a second note");
  const [p, q] = await page.locator(".note").evaluateAll((n) => n.map((e) => e.getBoundingClientRect().left)); assert.ok(Math.abs(q - p) > 150, "next to the first, not on top of it");
});

for (const [w, h, name] of [[393, 852, "phone"], [834, 1194, "iPad portrait"]] as const) {
  await test(`touch (${name}): double-tap makes a note, a two-finger tap undoes it, rest-then-drag on the empty board selects, a Pencil drags a card at once`, async () => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: name === "phone", deviceScaleFactor: 2 });
    const page = await ctx.newPage(); page.setDefaultTimeout(8000); await page.goto(`${URL}/?u=gest${Date.now().toString(36)}`);
    await page.waitForFunction(() => (document.getElementById("st") as HTMLElement).dataset.state === "live");
    const cdp = await ctx.newCDPSession(page), touch = (type: string, pts: any[]) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts });
    const tap = async (x: number, y: number) => { await touch("touchStart", [{ x, y, id: 1 }]); await touch("touchEnd", []); };
    const notes = () => page.locator(".note").count();
    await tap(w / 2, h / 2); await page.waitForTimeout(120); await tap(w / 2, h / 2); await settle(page, 600); await page.keyboard.press("Escape"); await settle(page, 300);
    assert.equal(await notes(), 1, "double-tap on the empty board made a note");
    await page.keyboard.type("x").catch(() => {});
    // two-finger tap = undo
    await touch("touchStart", [{ x: 100, y: h - 200, id: 1 }, { x: 180, y: h - 200, id: 2 }]); await page.waitForTimeout(60); await touch("touchEnd", []); await settle(page, 600);
    assert.equal(await notes(), 0, "a two-finger tap undid it");
    // rest then drag selects: two notes, then a press-and-hold on empty space and a drag across them
    await page.evaluate(async (w) => { const send = (0, eval)("send"), B = (0, eval)("B"); for (const [i, x] of [100, 330].entries()) await send({ type: "ELEMENT_CREATE", id: "g" + w + "-" + i, elementType: "CARD", location: { parentId: B, section: "CANVAS", position: { score: i + 1, x, y: 160 } }, content: { textContent: "n" + i }, meta: { versionId: "v1", modifiedTime: 1 } }); }, w);
    await page.reload(); await page.waitForFunction(() => document.querySelectorAll(".note").length === 2); await settle(page, 400);
    const r = await page.evaluate(() => [...document.querySelectorAll(".note")].map((n) => n.getBoundingClientRect().toJSON())), top = Math.min(...r.map((b: any) => b.top)), bot = Math.max(...r.map((b: any) => b.bottom)), left = Math.min(...r.map((b: any) => b.left)), right = Math.max(...r.map((b: any) => b.right));
    const sx = Math.max(8, left - 20), sy = top - 30; await touch("touchStart", [{ x: sx, y: sy, id: 1 }]); await page.waitForTimeout(500);
    for (let i = 1; i <= 8; i++) { await touch("touchMove", [{ x: sx + ((right + 20 - sx) * i) / 8, y: sy + ((bot + 20 - sy) * i) / 8, id: 1 }]); await page.waitForTimeout(16); }
    await touch("touchEnd", []); await settle(page, 300);
    assert.equal(await page.locator(".note.selected").count(), 2, "rest-then-drag selected both notes (no panning)");
    // the Pencil drags a card at once; the page does not pan
    const c = mid(await box(page, ".note")), v0 = await page.evaluate(() => (window as any).__view()), p0 = await page.evaluate(() => (Object.values((window as any).__els()) as any[]).find((e) => e.content.textContent === "n0").location.position.x);
    await page.mouse.click(w - 20, h - 20); // clear the selection first
    const pen = (type: string, x: number, y: number) => cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, pointerType: "pen" });
    await pen("mouseMoved", c.x, c.y); await pen("mousePressed", c.x, c.y); for (let i = 1; i <= 6; i++) await pen("mouseMoved", c.x, c.y + i * 12); await pen("mouseReleased", c.x, c.y + 72); await settle(page, 700);
    const p1 = await page.evaluate(() => (Object.values((window as any).__els()) as any[]).find((e) => e.content.textContent === "n0").location.position);
    assert.ok(p1.y > 160 + 40, `the Pencil moved the card at once (y ${p1.y})`); assert.deepEqual(await page.evaluate(() => (window as any).__view()), v0, "and the board did not pan");
    await ctx.close();
  });
}

await test("clicking the zoom percentage (or Ctrl+0) goes back to 100% with the board centred, not to the top left", async ({ page }) => {
  await add(page, "note", "centre me");
  await page.mouse.move(700, 400); await page.mouse.wheel(300, 250); await settle(page, 300); // pan it away
  await page.click("#zreset"); await settle(page, 300);
  const c = mid(await box(page, ".note")), z = await page.evaluate(() => (window as any).__view().z);
  within(c.x, (96 + 1400 - 24) / 2, 30, "centred sideways in the free area"); within(c.y, (70 + 900 - 24) / 2, 30, "centred up and down"); assert.equal(z, 0.76, "at 100%");
  await page.mouse.wheel(-200, -200); await settle(page, 200); await page.keyboard.press("Control+0"); await settle(page, 300);
  within(mid(await box(page, ".note")).x, (96 + 1400 - 24) / 2, 30, "Ctrl+0 centres too");
});

await test("icon picker: every category is reachable and the list scrolls, with a mouse wheel and at phone width", async ({ page, ctx }) => {
  const inside = (p: Page) => p.evaluate(() => { const pk = document.getElementById("iconpick")!.getBoundingClientRect(); return [...document.querySelectorAll<HTMLElement>("#icongroups button")].every((b) => { const r = b.getBoundingClientRect(); return r.left >= pk.left - 1 && r.right <= pk.right + 1; }); });
  const open = async (p: Page) => { await add(p, "brd", "Test"); await p.locator(".board").first().click(); await p.click("#iconBtn"); await p.waitForSelector("#iconpick:not([hidden])"); };
  await open(page);
  assert.equal(await inside(page), true, "desktop: no category is cut off at the side");
  const v0 = await page.evaluate(() => (window as any).__view());
  const g = await box(page, "#icongrid"); await page.mouse.move(g.x + 60, g.y + 60); await page.mouse.wheel(0, 400); await settle(page, 300);
  assert.ok((await page.evaluate(() => document.getElementById("icongrid")!.scrollTop)) > 50, "the icon list scrolls with the wheel");
  assert.deepEqual(await page.evaluate(() => (window as any).__view()), v0, "and the board behind it does not move");
  const phone = await browser.newContext({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true });
  const p = await phone.newPage(); p.setDefaultTimeout(8000); await p.goto(`${URL}/?u=ph${Date.now().toString(36)}`);
  await p.waitForFunction(() => (document.getElementById("st") as HTMLElement).dataset.state === "live");
  await open(p);
  assert.equal(await inside(p), true, "phone: no category is cut off at the side");
  const r = await p.evaluate(() => { const pk = document.getElementById("iconpick")!.getBoundingClientRect(); return { l: pk.left, r: pk.right, b: pk.bottom, w: innerWidth, h: innerHeight, wide: document.documentElement.scrollWidth }; });
  assert.ok(r.l >= 0 && r.r <= r.w && r.b <= r.h, `the picker fits the phone screen (${JSON.stringify(r)})`); assert.equal(r.wide, r.w, "nothing makes the page wider");
  await phone.close();
});

await test("a board opened for the first time is centred on the screen, not left at the top left", async ({ page, user }) => {
  await page.evaluate(async () => {
    const send = (0, eval)("send"), B = (0, eval)("B");
    for (const [i, [x, y]] of [[0, 0], [600, 0], [0, 300], [600, 300]].entries()) await send({ type: "ELEMENT_CREATE", id: "c" + i, elementType: "CARD", location: { parentId: B, section: "CANVAS", position: { score: i + 1, x, y } }, content: { textContent: "card " + i }, meta: { versionId: "v1", modifiedTime: 1 } });
  });
  const other = await browser.newContext({ viewport: { width: 1400, height: 900 } }); // a browser that has never seen this board: no remembered view
  const p = await other.newPage(); p.setDefaultTimeout(8000); await p.goto(`${URL}/?u=${user}`);
  await p.waitForFunction(() => document.querySelectorAll(".card").length === 4); await settle(p, 400);
  const r = await p.evaluate(() => { const b = [...document.querySelectorAll(".card")].map((c) => c.getBoundingClientRect()); return { l: Math.min(...b.map((x) => x.left)), r: Math.max(...b.map((x) => x.right)), t: Math.min(...b.map((x) => x.top)), b: Math.max(...b.map((x) => x.bottom)) }; });
  within((r.l + r.r) / 2, (96 + 1400 - 24) / 2, 40, "centred sideways in the free area"); within((r.t + r.b) / 2, (70 + 900 - 24) / 2, 40, "centred up and down");
  assert.ok(r.l > 90, "not left at the top left"); await other.close();
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
  const toCanvas = async (p: Page) => { await p.click("#ph-canvas"); await p.waitForFunction(() => document.getElementById("phome")!.hidden); }; // logging in lands on the boards home; these tests work on the canvas
  const form = async (p: Page, name: string, pw: string) => { await p.fill("#name", name); await p.fill("#pw", pw); await p.click("#go"); };
  try {
    const alice = await open(), bob = await open();
    await alice.waitForSelector("#f");
    await alice.click("#swap"); await form(alice, "alice", "correct horse"); await live(alice); await toCanvas(alice);
    assert.equal(await alice.evaluate(() => (window as any).ACCOUNT), "alice");
    await alice.click("#gearBtn"); await alice.click("#outBtn");
    await alice.waitForSelector("#f");
    await form(alice, "alice", "wrong password");
    await alice.waitForFunction(() => /Wrong name or password/.test(document.getElementById("err")!.textContent!));
    await form(alice, "alice", "correct horse"); await live(alice); await toCanvas(alice);

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

// welcome page, boards home (tile grid) and profile sheet (animated sections): once with a mouse and keyboard, once on a touch phone
await test("accounts: welcome page, boards home, profile sheet with animated sections, on desktop and on a touch phone", async () => {
  const as = createServer(3996, ":memory:", { accounts: true }), AURL = "http://localhost:3996";
  const ctxs: BrowserContext[] = [];
  const live = (p: Page) => p.waitForFunction(() => (document.getElementById("st") as HTMLElement)?.dataset.state === "live");
  const shown = (p: Page, sel: string) => p.waitForFunction((s) => { const n = document.querySelector(s) as HTMLElement | null; return !!n && !n.hidden && n.getBoundingClientRect().width > 0; }, sel);
  const gone = (p: Page, sel: string) => p.waitForFunction((s) => (document.querySelector(s) as HTMLElement).hidden, sel);
  const section = (p: Page, name: string) => p.locator("#psheet summary", { hasText: name });
  const settled = (p: Page, i: number) => p.waitForFunction((n) => !(document.querySelectorAll("#psheet details")[n] as any)._a, i);
  const size = async (p: Page, sel: string) => (await p.locator(sel).first().boundingBox())!;
  try {
    // --- desktop: mouse and keyboard ---
    const c = await browser.newContext({ viewport: { width: 1400, height: 900 } }); ctxs.push(c);
    const p = await c.newPage(); p.setDefaultTimeout(8000);
    await p.goto(AURL + "/"); await p.waitForSelector("#f");
    assert.match(await p.title(), /Plannote/); assert.ok(await p.locator(".pitch h2").isVisible(), "welcome: the story panel sits beside the form");
    await p.click("#swap"); assert.equal(await p.locator("#title").innerText(), "Create account");
    await p.fill("#name", "maja"); await p.fill("#pw", "correct horse"); await p.click("#show");
    assert.equal(await p.locator("#pw").getAttribute("type"), "text", "the password can be shown");
    await p.click("#go"); await live(p);

    await shown(p, "#phome");
    assert.match(await p.locator("#ph-hi").innerText(), /^Good (morning|afternoon|evening), maja$/);
    assert.match(await p.locator("#ph-res").innerText(), /Make your first board/, "a new user sees the empty state");
    await p.click("#ph-new"); await shown(p, "#nbdlg");
    assert.equal(await p.evaluate(() => document.activeElement?.id), "nb-name", "New board asks for a name first");
    await p.fill("#nb-name", "Trip to Lisbon"); await p.click("#nb-go"); await gone(p, "#phome"); await settle(p, 1200);
    assert.ok((p.url().split("#")[1] ?? "").length > 0, "it opens at once as a workspace of its own");
    assert.equal((await p.locator("#crumbs").innerText()).replace(/\s+/g, " "), "Home / Trip to Lisbon");
    assert.equal(await p.locator("#canvas > .card").count(), 0, "a fresh, empty workspace, not a tile to double-click");
    await p.click("#homeBtn"); await shown(p, "#phome"); await p.waitForSelector(".ph-card");
    assert.equal(await p.locator(".ph-card .ph-meta b").first().innerText(), "Trip to Lisbon", "the new board is a tile");
    assert.equal(await p.locator(".ph-new").count(), 1, "a New board tile leads the grid");
    await p.fill("#ph-q", "zzz"); assert.match(await p.locator("#ph-res").innerText(), /No board called “zzz”/);
    await p.fill("#ph-q", "lisb"); assert.equal(await p.locator(".ph-card").count(), 1); await p.fill("#ph-q", "");
    await p.click(".ph-card .open"); await gone(p, "#phome"); await settle(p, 400);
    assert.ok((p.url().split("#")[1] ?? "").length > 0, "opening a tile opens that board");

    await p.click("#meBtn"); await shown(p, "#psheet");
    assert.equal(await p.evaluate(() => document.activeElement?.id), "pn-close", "focus moves into the sheet");
    assert.equal(await p.locator("#psheet details").nth(1).evaluate((d: any) => d.open), false, "Appearance starts folded");
    await section(p, "Appearance").click();
    assert.equal(await p.locator("#psheet details").nth(1).evaluate((d: any) => !!d._a), true, "the section animates open");
    await settled(p, 1);
    assert.ok((await size(p, "#psheet details:nth-of-type(2) .pn-sec")).height > 40, "and ends at full height");
    await p.click('#pn-theme [data-v="dark"]'); assert.equal(await p.evaluate(() => document.documentElement.dataset.theme), "dark");
    await p.click('#pn-theme [data-v="light"]');
    await section(p, "Appearance").click(); await p.waitForFunction(() => !(document.querySelectorAll("#psheet details")[1] as any).open);

    await p.click('#psheet [data-mode="emoji"]'); await p.locator("#pn-em button").nth(3).click(); await p.click('#pn-sw button[title="rose"]'); await p.fill("#pn-display", "Maja K");
    assert.equal(await p.locator("#pn-save").isVisible(), true, "edits raise the save bar");
    await p.click("#pn-do-save"); await p.waitForFunction(() => document.querySelector(".pn-toast.show")?.textContent?.startsWith("Saved"));
    assert.equal(await p.locator("#meBtn .pn-av").innerText(), "☕"); assert.equal(await p.locator("#pn-title").innerText(), "Maja K");
    assert.equal(await p.locator("#pn-save").isVisible(), false, "saved: the bar goes");
    await p.keyboard.press("Escape"); await gone(p, "#psheet");
    assert.equal(await p.evaluate(() => document.activeElement?.id), "meBtn", "focus goes back to where it was");
    await p.reload(); await live(p);
    assert.equal(await p.locator("#meBtn .pn-av").innerText(), "☕", "the picture is kept on the server");

    await p.click("#meBtn"); await section(p, "Security").click(); await p.click("#pn-pw-open");
    await p.fill("#pn-pw [name=cur]", "nope nope nope"); await p.fill("#pn-pw [name=next]", "a new password"); await p.fill("#pn-pw [name=rep]", "a new password"); await p.click("#pn-pw .primary");
    await p.waitForFunction(() => /Wrong password/.test(document.querySelector("#pn-pw .pn-err")!.textContent!));
    await p.fill("#pn-pw [name=cur]", "correct horse"); await p.click("#pn-pw .primary"); await gone(p, "#pn-pw");
    await section(p, "Account").click(); await p.click("#pn-del-open");
    assert.equal(await p.locator("#pn-del .pn-btn.danger").isDisabled(), true, "delete stays off until the name is typed");
    await p.fill("#pn-del [name=who]", "maja"); await p.fill("#pn-del [name=pw]", "a new password");
    await p.click("#pn-del .pn-btn.danger"); await p.waitForSelector("#f");
    await p.fill("#name", "maja"); await p.fill("#pw", "a new password"); await p.click("#go");
    await p.waitForFunction(() => /Wrong name or password/.test(document.getElementById("err")!.textContent!));

    // --- a touch phone ---
    const m = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }); ctxs.push(m);
    const t = await m.newPage(); t.setDefaultTimeout(8000);
    await t.goto(AURL + "/"); await t.waitForSelector("#f");
    assert.equal(await t.locator(".pitch .feat").isVisible(), false, "phone: the story shrinks to a header");
    assert.ok((await size(t, "#go")).height >= 44, "the button is a touch target");
    assert.ok(await t.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "welcome: nothing sideways");
    await t.tap("#swap"); await t.fill("#name", "zosia"); await t.fill("#pw", "correct horse"); await t.tap("#go"); await live(t);
    await shown(t, "#phome");
    assert.ok(await t.evaluate(() => document.getElementById("phome")!.scrollWidth <= innerWidth), "home: nothing sideways");
    await t.tap("#ph-new"); await shown(t, "#nbdlg");
    const chip = await size(t, "#nb-tpl .nb-chip"); assert.ok(chip.height >= 44, "template chips are touch targets");
    await t.locator("#nb-tpl .nb-chip").nth(1).tap(); assert.ok((await t.inputValue("#nb-name")).length > 0, "picking a template names the board after it");
    await t.fill("#nb-name", "Garden"); await t.tap("#nb-go"); await gone(t, "#phome"); await settle(t, 1500);
    assert.ok((await t.locator(".card").count()) > 3, "the new workspace starts filled with the template");
    const hb = await size(t, "#homeBtn"); assert.ok(hb.width >= 44 && hb.height >= 44 && hb.x >= 0 && hb.x + hb.width <= 390, "the home button is a 44px target inside the screen");
    assert.equal(await t.locator("#meBtn").isVisible(), false, "phone: the full top bar leaves the avatar out");
    const fab = await size(t, "#tplBtn"); assert.ok(fab.height >= 40 && fab.x + fab.width <= 390 && fab.x > 150 && fab.y + fab.height < 844 - 52, "phone: Add a template sits at the bottom right, above the tool strip");
    await t.tap("#gearBtn"); await t.tap("#profileItem"); await shown(t, "#psheet"); await t.tap("#pn-close"); await gone(t, "#psheet"); // Profile is in the gear menu instead
    await t.tap("#homeBtn"); await shown(t, "#phome"); await t.waitForSelector(".ph-card");
    const tile = await size(t, ".ph-card"), cols = await t.evaluate(() => getComputedStyle(document.querySelector(".ph-grid")!).gridTemplateColumns.split(" ").length);
    assert.ok(cols === 2 && tile.width > 140, "phone: two tiles per row");
    await t.tap("#ph-me"); await shown(t, "#psheet");
    const sh = await size(t, ".pn-sheet");
    assert.ok(sh.width >= 389 && Math.abs(sh.y + sh.height - 844) < 2, "phone: the sheet rises from the bottom edge");
    assert.ok((await size(t, "#pn-close")).width >= 44 && (await size(t, "#psheet summary")).height >= 44, "close and section headers are touch targets");
    await t.locator("#psheet summary", { hasText: "Appearance" }).tap();
    assert.equal(await t.locator("#psheet details").nth(1).evaluate((d: any) => !!d._a), true, "touch: the section animates open");
    await settled(t, 1);
    await t.tap('#pn-theme [data-v="dark"]'); assert.equal(await t.evaluate(() => document.documentElement.dataset.theme), "dark");
    await t.tap("#pn-close"); await gone(t, "#psheet");
    await t.tap(".ph-card .open"); await gone(t, "#phome"); await settle(t, 400);
    assert.ok((t.url().split("#")[1] ?? "").length > 0, "touch: a tap opens the board");
  } finally { for (const x of ctxs) await x.close(); await as.close(); }
});

await browser.close(); await srv.close(); pages.close(); rmSync(shots, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.log("screenshots of failures were written to " + shots); process.exit(1); }
