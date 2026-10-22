// Export and import. Shares the page's globals (els, B, fetchBoards, send, newElement...), loaded after the main script.
// Export mirrors Milanote's menu: board layout (PDF, PNG), linear document (Word, Markdown, plain text), ZIP of images; plus a board
// file that keeps everything. Import reads a board file, a Milanote Markdown / plain-text export, and Milanote's ZIP of images.
(() => {
const MAX_ELEMENTS = 5000, MAX_IMAGE = 5 * 1024 * 1024, MAX_TEXT = 8 * 1024 * 1024, SUPPORTED_IMAGES = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const MEDIA_ID = /^[0-9a-f-]{36}$/;
const p2 = (n) => String(n).padStart(2, "0");
const stamp = () => { const d = new Date(); return `${String(d.getFullYear()).slice(2)}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}`; };
const slug = (s) => String(s || "board").replace(/[\\/:*?"<>|]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "board";
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function save(name, data, type) {
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([data], { type })), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
const blobToDataUrl = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
async function mediaBlob(id) {
  if (!MEDIA_ID.test(id ?? "")) throw new Error("bad image id");
  const r = await fetch("/api/media/" + id);
  if (!r.ok) throw new Error("image unavailable (HTTP " + r.status + ")");
  return r.blob();
}

// ---------------------------------------------------------------------------------------------------------------------
// reading a board: the board and, optionally, everything inside its sub-boards, in reading order (top to bottom, then left to right)
const reading = (a, b) => a.location.position.y - b.location.position.y || a.location.position.x - b.location.position.x;
const byScore = (a, b) => a.location.position.score - b.location.position.score;
async function level(id) { // a board's direct children, and what is inside its columns
  const base = await fetchBoards([id]);
  const kids = Object.values(base).filter((e) => e.location.parentId === id && e.location.section !== "TRASH" && KIND[e.elementType]);
  const cols = kids.filter((e) => e.elementType === "COLUMN").map((e) => e.id);
  return { self: base[id], kids, inner: cols.length ? await fetchBoards(cols) : {} };
}
async function buildTree(id, sub, depth = 0, seen = new Set()) {
  if (seen.has(id) || depth > 12) return null;
  seen.add(id);
  const { self, kids, inner } = await level(id);
  const node = { id, title: self?.content.title || "Untitled board", items: [] };
  for (const e of kids.sort(reading)) {
    if (e.elementType === "COLUMN") node.items.push({ ...e, kids: Object.values(inner).filter((k) => k.location.parentId === e.id && KIND[k.elementType]).sort(byScore) });
    else if (e.elementType === "BOARD") node.items.push({ ...e, sub: sub ? await buildTree(e.id, true, depth + 1, seen) : null });
    else node.items.push(e);
  }
  return node;
}
// every image in a tree, with the file name it gets in the ZIP and in the document's links
function imageList(node, out = []) {
  const walk = (e) => { if (e.elementType === "IMAGE" && MEDIA_ID.test(e.content.mediaId ?? "")) out.push(e); (e.kids ?? []).forEach(walk); if (e.sub) imageList(e.sub, out); };
  node.items.forEach(walk);
  return out;
}
function imageNames(node) {
  const names = new Map();
  imageList(node).forEach((e, i) => {
    const raw = String(e.content.name ?? "image"), ext = (/\.(png|jpe?g|gif|webp)$/i.exec(raw)?.[1] ?? "png").toLowerCase();
    names.set(e.content.mediaId, `images/${i + 1}-${slug(raw.replace(/\.[^.]*$/, ""))}.${ext}`); // the same name in the document's links and in the ZIP
  });
  return names;
}

// ---------------------------------------------------------------------------------------------------------------------
// linear documents. Markdown follows Milanote's own: the board is "# Title", a sub-board "# Title" too, a column "## Title",
// a note is a paragraph, a to-do item is "- [ ] text".
const noteText = (e) => String(e.content.textContent ?? "").trim();
// a rich note as Markdown: bold, italic, strikethrough, links, lists and headings survive; everything else is plain text
function htmlToMd(html) {
  const doc = new DOMParser().parseFromString("<body>" + cleanHtml(html), "text/html");
  const walk = (n) => [...n.childNodes].map((c) => {
    if (c.nodeType === 3) return c.textContent;
    const tag = c.tagName, inner = () => walk(c).join("");
    if (tag === "B" || tag === "STRONG") return `**${inner()}**`;
    if (tag === "I" || tag === "EM") return `*${inner()}*`;
    if (tag === "S" || tag === "STRIKE") return `~~${inner()}~~`;
    if (tag === "A") return `[${inner()}](${c.getAttribute("href")})`;
    if (tag === "BR") return "\n";
    if (tag === "UL" || tag === "OL") return "\n" + [...c.children].map((li, i) => `${tag === "OL" ? i + 1 + "." : "-"} ${walk(li).join("").trim()}`).join("\n") + "\n";
    if (/^H[1-3]$/.test(tag)) return `\n### ${inner()}\n`;
    if (tag === "MARK") return `==${inner()}==`;
    if (tag === "BLOCKQUOTE") return "\n" + inner().trim().split("\n").map((l) => "> " + l).join("\n") + "\n";
    if (tag === "PRE") return "\n```\n" + c.textContent.replace(/\n+$/, "") + "\n```\n";
    if (tag === "DIV" || tag === "P") return "\n" + inner() + "\n";
    return inner();
  });
  return walk(doc.body).join("").replace(/\n{3,}/g, "\n\n").trim();
}
// a table's rows, made safe to print (cells can hold anything another client sent)
const gridOf = (c) => (Array.isArray(c.rows) ? c.rows.slice(0, 100) : []).map((r) => (Array.isArray(r) ? r.slice(0, 20).map((v) => String(v ?? "")) : []));
const mdCell = (v) => v.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
function mdTable(c, out) {
  const g = gridOf(c), w = Math.max(1, ...g.map((r) => r.length));
  if (!g.length) return;
  const row = (r) => "| " + Array.from({ length: w }, (_, i) => mdCell(r[i] ?? "")).join(" | ") + " |";
  out.push(row(g[0]), "| " + Array(w).fill("---").join(" | ") + " |", ...g.slice(1).map(row), "");
}
const linkUrl = (c) => safeUrl(c.url ?? "")?.href ?? String(c.url ?? ""); // a typed "example.com" becomes https://example.com/, like the link card's Open button
function mdItem(e, o, out) {
  const c = e.content;
  if (e.elementType === "CARD") { const t = c.html ? htmlToMd(c.html) : noteText(e); if (t) out.push(c.heading ? "### " + t.replace(/\s*\n\s*/g, " ") : t, ""); }
  else if (e.elementType === "TASK_LIST") { if (c.title) out.push(c.title); (c.tasks ?? []).forEach((t) => out.push(`- [${t.done ? "x" : " "}] ${t.text}`)); out.push(""); }
  else if (e.elementType === "TABLE") mdTable(c, out);
  else if (e.elementType === "SWATCH") out.push(String(c.color ?? ""), "");
  else if (e.elementType === "LINK") out.push(`[${c.previewTitle || linkUrl(c)}](${linkUrl(c)})`, "");
  else if (e.elementType === "IMAGE") out.push(`![${c.caption || c.name || "image"}](${o.names.get(c.mediaId) ?? ""})`, "");
  else if (e.elementType === "COLUMN") { out.push(`## ${c.title || "Column"}`, ""); e.kids.forEach((k) => mdItem(k, o, out)); }
  else if (e.elementType === "BOARD") e.sub ? mdBoard(e.sub, o, out) : out.push(`# ${c.title || "Untitled board"}`, "");
}
function mdBoard(node, o, out = []) { out.push(`# ${node.title}`, ""); node.items.forEach((e) => mdItem(e, o, out)); return out; }
const mdText = (node) => mdBoard(node, { names: imageNames(node) }).join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
function txtItem(e, out) {
  const c = e.content;
  if (e.elementType === "CARD") { const t = noteText(e); if (t) out.push(t, ""); }
  else if (e.elementType === "TASK_LIST") { if (c.title) out.push(c.title); (c.tasks ?? []).forEach((t) => out.push(`[${t.done ? "x" : " "}] ${t.text}`)); out.push(""); }
  else if (e.elementType === "SWATCH") out.push(String(c.color ?? ""), "");
  else if (e.elementType === "TABLE") { gridOf(c).forEach((r) => out.push(r.join("\t"))); out.push(""); }
  else if (e.elementType === "LINK") out.push(linkUrl(c), "");
  else if (e.elementType === "IMAGE") out.push(`[image: ${c.caption || c.name || "image"}]`, "");
  else if (e.elementType === "COLUMN") { out.push((c.title || "Column").toUpperCase(), ""); e.kids.forEach((k) => txtItem(k, out)); }
  else if (e.elementType === "BOARD") e.sub ? txtBoard(e.sub, out) : out.push((c.title || "Untitled board").toUpperCase(), "");
}
function txtBoard(node, out = []) { out.push(node.title.toUpperCase(), ""); node.items.forEach((e) => txtItem(e, out)); return out; }
const txtText = (node) => txtBoard(node).join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
// Word opens an HTML document saved as .doc; images are embedded so the file stands alone
async function docHtml(node) {
  const imgs = new Map();
  for (const e of imageList(node)) if (!imgs.has(e.content.mediaId)) imgs.set(e.content.mediaId, await blobToDataUrl(await mediaBlob(e.content.mediaId)).catch(() => ""));
  const item = (e) => {
    const c = e.content;
    if (e.elementType === "CARD") return c.html ? `<div>${cleanHtml(c.html)}</div>` : noteText(e) ? `<p>${esc(noteText(e)).replace(/\n/g, "<br>")}</p>` : "";
    if (e.elementType === "TASK_LIST") return (c.title ? `<p><b>${esc(c.title)}</b></p>` : "") + `<ul style="list-style:none">${(c.tasks ?? []).map((t) => `<li>${t.done ? "&#9745;" : "&#9744;"} ${esc(t.text)}</li>`).join("")}</ul>`;
    if (e.elementType === "SWATCH" && HEX.test(c.color ?? "")) return `<p><span style="background:${c.color};color:${c.color}">&#9608;&#9608;&#9608;</span> ${c.color}</p>`;
    if (e.elementType === "TABLE") return `<table border="1" style="border-collapse:collapse">${gridOf(c).map((r, i) => `<tr>${r.map((v) => `<${i ? "td" : "th"}>${esc(v)}</${i ? "td" : "th"}>`).join("")}</tr>`).join("")}</table>`;
    if (e.elementType === "LINK") return `<p><a href="${esc(linkUrl(c))}">${esc(linkUrl(c))}</a></p>`;
    if (e.elementType === "IMAGE") return imgs.get(c.mediaId) ? `<p><img src="${imgs.get(c.mediaId)}" alt="${esc(c.name)}" style="max-width:480px"></p>` : "";
    if (e.elementType === "COLUMN") return `<h2>${esc(c.title || "Column")}</h2>` + e.kids.map(item).join("");
    if (e.elementType === "BOARD") return e.sub ? board(e.sub) : `<h1>${esc(c.title || "Untitled board")}</h1>`;
    return "";
  };
  const board = (n) => `<h1>${esc(n.title)}</h1>` + n.items.map(item).join("");
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>${esc(node.title)}</title></head><body>${board(node)}</body></html>`;
}

// ---------------------------------------------------------------------------------------------------------------------
// ZIP (stored, no compression: images are already compressed). Written and read here so there is no dependency.
const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (u8) => { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = crcTable[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function makeZip(files) { // [{ name, data: Uint8Array }]
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), loc = new DataView(new ArrayBuffer(30)), cen = new DataView(new ArrayBuffer(46));
    loc.setUint32(0, 0x04034b50, true); loc.setUint16(4, 20, true); loc.setUint16(6, 0x0800, true); loc.setUint16(12, 0x21, true);
    loc.setUint32(14, crc, true); loc.setUint32(18, f.data.length, true); loc.setUint32(22, f.data.length, true); loc.setUint16(26, name.length, true);
    parts.push(loc.buffer, name, f.data);
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true); cen.setUint16(14, 0x21, true);
    cen.setUint32(16, crc, true); cen.setUint32(20, f.data.length, true); cen.setUint32(24, f.data.length, true); cen.setUint16(28, name.length, true); cen.setUint32(42, offset, true);
    central.push(cen.buffer, name);
    offset += 30 + name.length + f.data.length;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, central.reduce((n, x) => n + (x.byteLength ?? x.length), 0), true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: "application/zip" });
}
async function readZip(buf) { // -> [{ name, bytes() }]
  const v = new DataView(buf), u8 = new Uint8Array(buf);
  let e = u8.length - 22;
  while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error("not a ZIP file");
  const n = v.getUint16(e + 10, true), out = [];
  let p = v.getUint32(e + 16, true);
  for (let i = 0; i < n; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error("damaged ZIP file");
    const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true), nl = v.getUint16(p + 28, true), xl = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true), off = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nl));
    if (!name.endsWith("/")) out.push({
      name,
      bytes: async () => {
        const start = off + 30 + v.getUint16(off + 26, true) + v.getUint16(off + 28, true), raw = u8.subarray(start, start + csize);
        if (method === 0) return raw;
        if (method !== 8) throw new Error("unsupported ZIP compression");
        return new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
      },
    });
    p += 46 + nl + xl + cl;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// PNG of the board layout: the cards are cloned with their computed styles into an SVG foreignObject and rasterised
async function renderPng(scale) {
  const cards = topCards();
  if (!cards.length) throw new Error("the board is empty");
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const c of cards) {
    const k = (c.classList.contains("line") || c.classList.contains("sketch") ? c.querySelector("svg") ?? c : c).getBoundingClientRect(), a = toBoard(k.left, k.top), z = toBoard(k.right, k.bottom);
    l = Math.min(l, a.x); t = Math.min(t, a.y); r = Math.max(r, z.x); b = Math.max(b, z.y);
  }
  const pad = 40, W = Math.ceil(r - l + 2 * pad), H = Math.ceil(b - t + 2 * pad), px = Math.min(scale, 16000 / Math.max(W, H));
  const root = document.createElement("div");
  root.style.cssText = `position:relative;width:${W}px;height:${H}px;overflow:hidden;background:${getComputedStyle(document.body).backgroundColor};font-family:${getComputedStyle(document.body).fontFamily}`;
  const inline = (src, dst) => {
    const cs = getComputedStyle(src);
    dst.setAttribute("style", [...cs].map((p) => `${p}:${cs.getPropertyValue(p)}`).join(";"));
    if (src.tagName === "INPUT") { dst.setAttribute("value", src.value); src.checked ? dst.setAttribute("checked", "") : dst.removeAttribute("checked"); }
    [...src.children].forEach((c, i) => inline(c, dst.children[i]));
  };
  for (const card of cards) {
    const clone = card.cloneNode(true), cs = getComputedStyle(card);
    inline(card, clone); // first: the clone must still match the original child for child
    clone.querySelectorAll(".grip, .h").forEach((n) => n.remove()); // then drop the editing handles
    ["selected", "found", "dragging", "attach-target"].forEach((c) => clone.classList.remove(c));
    clone.style.left = parseFloat(cs.left) - l + pad + "px"; clone.style.top = parseFloat(cs.top) - t + pad + "px"; clone.style.outline = "none"; clone.style.opacity = "1";
    root.append(clone);
  }
  for (const img of root.querySelectorAll("img")) img.src = await blobToDataUrl(await (await fetch(img.src)).blob()).catch(() => "");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><foreignObject x="0" y="0" width="100%" height="100%">${new XMLSerializer().serializeToString(root)}</foreignObject></svg>`;
  const img = new Image();
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  await img.decode();
  const canvas = Object.assign(document.createElement("canvas"), { width: Math.round(W * px), height: Math.round(H * px) });
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((res, rej) => canvas.toBlob((blob) => (blob ? res(blob) : rej(new Error("the browser could not draw the board"))), "image/png"));
}
// PDF: the PNG on a printable page; the browser's print dialog does the rest ("Save as PDF")
async function printPdf(scale) {
  const url = URL.createObjectURL(await renderPng(scale));
  const frame = Object.assign(document.createElement("iframe"), { style: "position:fixed;width:0;height:0;border:0" });
  document.body.append(frame);
  frame.srcdoc = `<html><body style="margin:0"><style>@page{margin:8mm}img{width:100%;max-height:98vh;object-fit:contain}</style><img src="${url}"></body></html>`;
  await new Promise((res) => (frame.onload = res));
  await frame.contentDocument.querySelector("img").decode();
  frame.contentWindow.focus(); frame.contentWindow.print();
  setTimeout(() => { frame.remove(); URL.revokeObjectURL(url); }, 60000);
}

// ---------------------------------------------------------------------------------------------------------------------
// the board file: everything under this board (layout, colours, icons, nested boards, images) as JSON, images embedded
async function collectAll(id, root, out, seen = new Set()) {
  if (seen.has(id) || out.length > MAX_ELEMENTS) return;
  seen.add(id);
  const { kids, inner } = await level(id);
  const slim = (e) => ({ id: e.id, type: e.elementType, parent: e.location.parentId === root ? "root" : e.location.parentId, section: e.location.section, position: e.location.position, content: e.content });
  for (const e of kids) {
    out.push(slim(e));
    if (e.elementType === "COLUMN") Object.values(inner).filter((k) => k.location.parentId === e.id && KIND[k.elementType]).forEach((k) => out.push(slim(k)));
    if (e.elementType === "BOARD") await collectAll(e.id, root, out, seen);
  }
}
async function boardFile() {
  const root = B, elements = [], media = {};
  await collectAll(root, root, elements);
  for (const e of elements) if (e.type === "IMAGE" && MEDIA_ID.test(e.content.mediaId ?? "") && !media[e.content.mediaId]) {
    try { const blob = await mediaBlob(e.content.mediaId); media[e.content.mediaId] = { type: blob.type, data: (await blobToDataUrl(blob)).split(",")[1] }; } catch { /* a missing image is skipped, the card stays */ }
  }
  const self = els[root] ?? (await fetchBoards([root]))[root];
  return { format: "boardsync-board", version: 1, exportedAt: new Date().toISOString(), board: { title: self?.content.title || "Board", content: self?.content ?? {} }, elements, media };
}

// ---------------------------------------------------------------------------------------------------------------------
// the export menu
const menu = $("expop"), say = (m) => ($("exmsg").textContent = m ?? "");
async function refreshMenu() {
  say("");
  const zip = $("exZip");
  zip.disabled = true; zip.textContent = "Checking for images...";
  try { const n = imageList(await buildTree(B, $("exSub").checked)).length; zip.disabled = !n; zip.textContent = n ? `Generate ZIP (${n} image${n === 1 ? "" : "s"})` : "No files found on this board"; }
  catch { zip.textContent = "Generate ZIP"; zip.disabled = false; }
}
$("expBtn").onclick = () => { menu.hidden = !menu.hidden; if (!menu.hidden) refreshMenu(); };
$("exSub").onchange = refreshMenu;
addEventListener("pointerdown", (e) => { if (!menu.hidden && !e.target.closest("#expop, #expBtn")) menu.hidden = true; });
menu.onclick = async (e) => {
  const b = e.target.closest("button[data-x]");
  if (!b || b.disabled) return;
  const kind = b.dataset.x, sub = $("exSub").checked;
  say("Generating...");
  try {
    if (kind === "json") {
      const f = await boardFile();
      save(`${slug(f.board.title)}-${stamp()}.boardsync.json`, JSON.stringify(f), "application/json");
      say(`Saved ${f.elements.length} cards and ${Object.keys(f.media).length} images.`);
    } else if (kind === "png") { save(`${slug(els[B]?.content.title)}-${stamp()}.png`, await renderPng(2), "image/png"); say("Saved."); }
    else if (kind === "pdf" || kind === "pdfhq") { await printPdf(kind === "pdf" ? 1.5 : 3); say("Choose Save as PDF in the print dialog."); }
    else {
      const tree = await buildTree(B, sub), name = `${slug(tree.title)}-${stamp()}`;
      if (kind === "md") save(name + ".md", mdText(tree), "text/markdown");
      else if (kind === "txt") save(name + ".txt", txtText(tree), "text/plain");
      else if (kind === "docx") save(name + ".doc", await docHtml(tree), "application/msword");
      else if (kind === "zip") {
        const names = imageNames(tree), files = [];
        for (const e of imageList(tree)) {
          const blob = await mediaBlob(e.content.mediaId), path = names.get(e.content.mediaId);
          if (!files.some((f) => f.name === path)) files.push({ name: path, data: new Uint8Array(await blob.arrayBuffer()) });
        }
        save(`${name}-images.zip`, makeZip(files), "application/zip");
      }
      say("Saved.");
    }
  } catch (err) { say("Export failed: " + (err.message ?? err)); }
};

// ---------------------------------------------------------------------------------------------------------------------
// reading Markdown / plain text. Headings: the first "# " names the board; later "# " lines are sub-boards (Milanote prints a
// sub-board as "# Title"); "## " is a column. Paragraphs are notes, "- [ ]" lines a to-do list, a bare link or image gets its own card.
const TASK = /^\s*[-*+]\s+\[([ xX])\](?:\s+(.*))?$/; // Milanote also exports empty items as a bare "- [ ]"
// inline Markdown reduced to plain text (titles, captions): **bold**, *italic*, ~~strike~~ and [text](url) lose their marks
const plain = (s) => String(s).replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/(\*\*|__|~~)(.+?)\1/g, "$2").replace(/==(?=\S)(.+?)(?<=\S)==/g, "$1").replace(/(^|[^*\w])[*_]([^*_\n]+)[*_](?![*\w])/g, "$1$2").trim();
// ...and as the small HTML a rich note stores (bold, italic, strike, http links); everything else is escaped text
const inlineHtml = (s) => esc(s)
  .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
  .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (m, a, b) => `<b>${a ?? b}</b>`)
  .replace(/~~(.+?)~~/g, "<s>$1</s>")
  .replace(/==(?=\S)(.+?)(?<=\S)==/g, "<mark>$1</mark>")
  .replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, "$1<i>$2</i>");
function parseMd(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n"), blocks = [];
  for (let i = 0; i < lines.length;) {
    const ln = lines[i];
    let m;
    if (!ln.trim() || /^\s*(---+|\*\*\*+|___+)\s*$/.test(ln)) { i++; continue; }
    if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(ln)) && plain(m[2])) { blocks.push({ t: "h", level: m[1].length, text: plain(m[2]), bold: /^(\*\*|__).+\1$/.test(m[2].trim()) }); i++; continue; }
    if (/^\s*```/.test(ln)) { const code = []; for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]); i++; blocks.push({ t: "p", text: code.join("\n"), raw: true }); continue; }
    const tasks = (title) => {
      let list = [], m2;
      while (i < lines.length && (m2 = TASK.exec(lines[i]))) { list.push({ text: plain(m2[2] ?? ""), done: m2[1] !== " " }); i++; }
      list = list.filter((t) => t.text); // the empty rows Milanote keeps at the end of a list are dropped, unless the list is only that
      blocks.push({ t: "tasks", title, tasks: list.length ? list : [{ text: "", done: false }] });
    };
    if (TASK.test(ln)) { tasks(null); continue; }
    if (/^\s*\|.*\|\s*$/.test(ln) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) { // | a | b | table, then its --- separator row
      const cells = (s) => s.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((v) => v.replace(/\\\|/g, "|").trim());
      const rows = [cells(ln)];
      for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(cells(lines[i]));
      blocks.push({ t: "table", rows });
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^#{1,6}\s/.test(lines[i]) && !TASK.test(lines[i])) para.push(lines[i++]);
    if (i < lines.length && TASK.test(lines[i]) && para.length === 1) tasks(para[0].trim()); // a single line right above a task list is its title
    else blocks.push({ t: "p", text: para.join("\n").trim() });
  }
  return blocks;
}
const rid8 = () => Math.random().toString(36).slice(2, 8);
function noteItem(text) { // a note: bullets and numbers become a real list, a "> " paragraph a quote; **bold**, *italic*, ==highlight== and links are kept
  let lines = text.split("\n");
  const bullets = lines.every((l) => /^\s*[-*+]\s+/.test(l)), numbers = lines.every((l) => /^\s*\d+[.)]\s+/.test(l)), quote = lines.every((l) => /^\s*>/.test(l));
  let html;
  if (quote) {
    lines = lines.map((l) => l.replace(/^\s*>\s?/, ""));
    html = `<blockquote>${lines.map(inlineHtml).join("<br>")}</blockquote>`;
  } else if (bullets || numbers) {
    lines = lines.map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ""));
    const tag = bullets ? "ul" : "ol";
    html = `<${tag}>${lines.map((l) => `<li>${inlineHtml(l)}</li>`).join("")}</${tag}>`;
  } else html = lines.map(inlineHtml).join("<br>");
  return { type: "CARD", content: { textContent: lines.map(plain).join("\n"), ...(/<(b|i|s|a|ul|ol|mark|blockquote)[\s>]/.test(html) ? { html } : {}) } };
}
const GENERIC_CAPTION = /^(image|photo|picture)(\s+from\s+.*)?$/i; // what Milanote writes when a picture has no caption of its own
function paragraphItem(text, raw = false) {
  let m;
  if (raw) return { type: "CARD", content: { textContent: text, html: `<pre>${esc(text)}</pre>` } }; // a fenced code block stays a code block
  if (/^#[0-9a-f]{6}$/i.test(text)) return { type: "SWATCH", content: { color: text.toLowerCase() } }; // a lone hex colour
  if ((m = /^!\[(.*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/s.exec(text))) { // the caption may hold brackets of its own: ![Photo by [name](url)](image-url)
    const caption = plain(m[1]), name = decodeURIComponent(m[2].split("?")[0].split("/").pop() || "image");
    return { type: "IMAGE", name, caption: GENERIC_CAPTION.test(caption) ? "" : caption, ref: m[2] };
  }
  if ((m = /^\[([^\]]*)\]\((https?:[^)\s]+)\)$/.exec(text)) || (m = /^()(https?:\/\/\S+)$/.exec(text))) {
    let host = ""; try { host = new URL(m[2]).hostname.replace(/^www\./, ""); } catch { /* not a valid address: the card keeps it as text */ }
    const title = plain(m[1]);
    return { type: "LINK", content: { url: m[2], ...(title && !title.toLowerCase().startsWith(host) && !/\s-\s*link$/i.test(title) ? { previewTitle: title } : {}) } };
  }
  if (/^Table element string placeholder$/i.test(text)) return { type: "TABLE", content: { header: false, rows: [["", "", ""], ["", "", ""], ["", "", ""]] }, placeholder: true }; // Milanote does not export a table's cells
  return noteItem(text);
}
function planFromBlocks(blocks, fallbackTitle, subBoards) {
  const root = { title: null, items: [] };
  let board = root, column = null;
  const put = (it) => (column ? column.kids : board.items).push(it);
  for (const b of blocks) {
    if (b.t === "h" && b.level === 1) {
      if (root.title === null) { root.title = b.text; continue; }
      if (subBoards) { board = { title: b.text, items: [] }; root.items.push({ type: "BOARD", plan: board }); column = null; }
      else put({ type: "CARD", content: { textContent: b.text, heading: true } });
    } else if (b.t === "h" && b.level === 2 && b.bold) { column = null; board.items.push({ type: "CARD", content: { textContent: b.text, heading: true } }); } // "## **Title**" is a heading note, not a column: it ends the column above and what follows sits on the board
    else if (b.t === "h" && b.level === 2) { column = { type: "COLUMN", content: { title: b.text }, kids: [] }; board.items.push(column); }
    else if (b.t === "h") put({ type: "CARD", content: { textContent: b.text, heading: true } });
    else if (b.t === "tasks") put({ type: "TASK_LIST", content: { title: b.title ?? "", tasks: b.tasks.map((t) => ({ id: rid8(), text: t.text, done: t.done })) } });
    else if (b.t === "table") {
      const w = Math.min(20, Math.max(...b.rows.map((r) => r.length)));
      put({ type: "TABLE", content: { header: true, rows: b.rows.slice(0, 100).map((r) => Array.from({ length: w }, (_, i) => (r[i] ?? "").slice(0, 500))) } });
    }
    else if (b.text) {
      const it = paragraphItem(b.text, b.raw), last = (column ? column.kids : board.items).at(-1);
      // Milanote prints a link card as its link followed by the card's description. Only a link with a real title (not "site - Link") takes the next plain paragraph;
      // after a bare link the next paragraph is a note of its own ("250 pln").
      if (it.type === "CARD" && !it.content.html && !b.raw && last?.type === "LINK" && last.content.previewTitle && !last.content.previewDesc) last.content.previewDesc = it.content.textContent;
      else put(it);
    }
  }
  root.title ??= fallbackTitle;
  return root;
}
function planStats(plan, s = { boards: 0, cards: 0, images: 0 }) {
  s.boards++;
  const count = (it) => { if (it.type === "BOARD") planStats(it.plan, s); else if (it.type === "COLUMN") { s.cards++; it.kids.forEach(count); } else { s.cards++; if (it.type === "IMAGE") s.images++; } };
  plan.items.forEach(count);
  return s;
}

// ---------------------------------------------------------------------------------------------------------------------
// the import dialog
const dlg = $("impdlg"), imp = { plans: [], boards: [], zips: [] }; // plans: Markdown/text; boards: board files; zips: images
const say2 = (m) => ($("impinfo").textContent = m);
const isImage = (name) => /\.(png|jpe?g|gif|webp)$/i.test(name);
const mimeOf = (name) => ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" })[name.split(".").pop().toLowerCase()];
$("impBtn").onclick = () => { dlg.hidden = !dlg.hidden; if (!dlg.hidden) reset(); };
$("impno").onclick = () => (dlg.hidden = true);
function reset() { Object.assign(imp, { plans: [], boards: [], zips: [] }); $("impgo").disabled = true; $("impopt").hidden = true; say2(""); $("impfile").value = ""; }
$("impfile").onchange = (e) => analyse([...e.target.files]);
$("impdrop").ondragover = (e) => { e.preventDefault(); e.stopPropagation(); $("impdrop").classList.add("over"); };
$("impdrop").ondragleave = () => $("impdrop").classList.remove("over");
$("impdrop").ondrop = (e) => { e.preventDefault(); e.stopPropagation(); $("impdrop").classList.remove("over"); analyse([...e.dataTransfer.files]); };

async function analyse(files) {
  reset();
  const notes = [];
  for (const f of files) {
    try {
      const n = f.name.toLowerCase();
      if (f.size > 256 * 1024 * 1024) throw new Error("too large");
      if (n.endsWith(".zip")) {
        const entries = (await readZip(await f.arrayBuffer())).filter((z) => isImage(z.name) && !z.name.startsWith("__MACOSX"));
        imp.zips.push(...entries);
        notes.push(`${f.name}: ${entries.length} image${entries.length === 1 ? "" : "s"}`);
      } else if (n.endsWith(".json")) {
        const j = JSON.parse(await f.text());
        if (j.format !== "boardsync-board" || !Array.isArray(j.elements)) throw new Error("not a boardsync board file");
        if (j.elements.length > MAX_ELEMENTS) throw new Error(`more than ${MAX_ELEMENTS} cards`);
        imp.boards.push(j);
        const t = (k) => j.elements.filter((e) => e.type === k).length;
        notes.push(`${f.name}: board "${j.board?.title ?? "Board"}", ${j.elements.length} cards, ${t("BOARD")} sub-boards, ${Object.keys(j.media ?? {}).length} images`);
      } else if (/\.(md|markdown|txt)$/.test(n)) {
        if (f.size > MAX_TEXT) throw new Error("too large");
        imp.plans.push({ name: f.name, blocks: parseMd(await f.text()) });
      } else throw new Error("unsupported file type (Word and PDF exports cannot be imported)");
    } catch (err) { notes.push(`${f.name}: ${err.message ?? err}`); }
  }
  updatePreview(notes);
}
function updatePreview(notes = []) {
  const sub = $("impsub").checked, lines = [...notes];
  $("impopt").hidden = !imp.plans.length;
  for (const p of imp.plans) {
    const plan = planFromBlocks(p.blocks, p.name.replace(/\.[^.]*$/, ""), sub), s = planStats(plan);
    lines.push(`${p.name}: "${plan.title}", ${s.boards} board${s.boards === 1 ? "" : "s"}, ${s.cards} cards`);
  }
  $("impgo").disabled = !(imp.plans.length || imp.boards.length || imp.zips.length);
  say2(lines.join("\n") + (imp.plans.length ? "\nMilanote's text exports have no layout or colours, so cards are laid out automatically." : ""));
}
$("impsub").onchange = () => updatePreview();

// ---- building the new board -----------------------------------------------------------------------------------------
const SLOT = 270, GAP = 24;
function estimate(it) { // rough heights, only for laying cards out in columns
  if (it.type === "CARD") return 30 + 21 * Math.ceil(String(it.content.textContent).length / 26);
  if (it.type === "TASK_LIST") return 90 + 30 * it.content.tasks.length;
  if (it.type === "LINK") return 130 + (it.content.previewImage ? 150 : 0) + (it.content.previewDesc ? 60 : 0); // title, address and buttons, plus the picture and description when the site gave them
  if (it.type === "TABLE") return 80 + 32 * it.content.rows.length;
  if (it.type === "IMAGE") return 24 + 220 * ((it.h || 3) / (it.w || 4)) + (it.caption ? 30 : 0);
  if (it.type === "COLUMN") return 100 + it.kids.reduce((n, k) => n + estimate(k) + 10, 0);
  return 150;
}
function layout(items) { // shortest-column-first masonry, four columns
  const cols = [0, 0, 0, 0], out = [];
  for (const it of items) {
    const c = cols.indexOf(Math.min(...cols));
    out.push({ it, x: 40 + c * SLOT, y: 40 + cols[c] });
    cols[c] += estimate(it) + GAP;
  }
  return out;
}
function mkEl(type, content, parentId, pos, section = "CANVAS", score = 65536) {
  const el = newElement(type, content, pos);
  el.location = { parentId, section, position: section === "COLUMN" ? { score } : { x: pos.x, y: pos.y, score: 65536 } };
  return el;
}
async function uploadImage(bytes, type) {
  if (bytes.length > MAX_IMAGE) throw new Error("over 5 MB");
  const r = await fetch("/api/media", { method: "POST", headers: { "x-user-id": uid, "content-type": type }, body: bytes });
  if (!r.ok) throw new Error("upload refused (HTTP " + r.status + ")");
  return (await r.json()).id;
}
async function imageSize(bytes, type) { try { const b = await createImageBitmap(new Blob([bytes], { type })); return { w: b.width, h: b.height }; } catch { return { w: 4, h: 3 }; } }
function emit(plan, parentId, pos, out) {
  const board = mkEl("BOARD", { title: plan.title }, parentId, pos);
  out.push(board);
  for (const { it, x, y } of layout(plan.items)) {
    if (it.type === "BOARD") emit(it.plan, board.id, { x, y }, out);
    else if (it.type === "COLUMN") { const c = mkEl("COLUMN", it.content, board.id, { x, y }); out.push(c); it.kids.forEach((k, j) => out.push(mkEl(k.type, k.content, c.id, {}, "COLUMN", 65536 * (j + 1)))); }
    else out.push(mkEl(it.type, it.content, board.id, { x, y }));
  }
  return board;
}
// An image address in the file: a ZIP entry with that file name wins, then a data: address, then the address itself is downloaded by the server.
// Milanote's own picture addresses are public, and "?w=800" only asks for a smaller copy, so the full picture is tried first.
async function fetchRemote(href) {
  const tries = /^https?:\/\/app\.milanote\.com\//.test(href) && href.includes("?") ? [href.split("?")[0], href] : [href];
  for (const u of tries) {
    const r = await fetch("/api/fetch-image?url=" + encodeURIComponent(u), { headers: { "x-user-id": uid } }).catch(() => null);
    if (r?.ok) return (await r.json()).id;
  }
  return null;
}
async function resolveImages(plan, byName, used, warn, say = () => {}) { // turn image references into uploaded images, and give link cards their preview
  const jobs = [];
  const walk = (items) => items.forEach((it) => { if (it.type === "COLUMN") walk(it.kids); else if (it.type === "BOARD") walk(it.plan.items); else if ((it.type === "IMAGE" && !it.content) || it.type === "LINK") jobs.push(it); });
  walk(plan.items);
  const images = jobs.filter((it) => it.type === "IMAGE").length;
  let done = 0, links = 0;
  const handle = async (it) => {
    if (it.type === "LINK") { // a preview (site title, description, picture) when the site allows it; Milanote's text export has none of this
      if (links++ >= 18) return; // the server allows 20 previews a minute
      const r = await fetch("/api/unfurl?url=" + encodeURIComponent(it.content.url), { headers: { "x-user-id": uid } }).catch(() => null);
      if (!r?.ok) return;
      const p = await r.json();
      Object.assign(it.content, { previewTitle: it.content.previewTitle ?? p.title ?? null, previewDesc: it.content.previewDesc ?? p.description ?? null, previewSite: p.site ?? null, previewImage: p.mediaId ?? null }); // what the file says wins over the site's own text
      return;
    }
    const href = String(it.ref), ref = decodeURIComponent(href.split("?")[0]), base = ref.split("/").pop().toLowerCase();
    let bytes, type, id;
    if (/^data:image\/(png|jpeg|gif|webp);base64,/.test(href)) { const [h, d] = href.split(","); type = h.slice(5, h.indexOf(";")); bytes = Uint8Array.from(atob(d), (c) => c.charCodeAt(0)); }
    else if (byName.has(base)) { const z = byName.get(base); bytes = await z.bytes(); type = mimeOf(z.name); used.add(base); }
    else if (/^https?:\/\//i.test(href)) id = await fetchRemote(href);
    say(`Importing pictures ${++done} of ${images}...`);
    const keep = (mediaId, w, h) => Object.assign(it, { w, h, content: { mediaId, name: it.name, ...(it.caption ? { caption: it.caption } : {}) } });
    if (id) { // downloaded by the server: read its size from the stored copy
      try { const b = await createImageBitmap(await mediaBlob(id)); keep(id, b.width, b.height); } catch { keep(id, 4, 3); }
      return;
    }
    if (!bytes) { it.type = "LINK"; it.content = { url: /^https?:/.test(href) ? href : "" }; warn.push(`picture "${it.name}" could not be downloaded or found in the ZIP`); return; }
    try { const mediaId = await uploadImage(bytes, type), { w, h } = await imageSize(bytes, type); keep(mediaId, w, h); }
    catch (err) { it.type = "CARD"; it.content = { textContent: `[image not imported: ${it.name} (${err.message})]` }; warn.push(`image "${it.name}": ${err.message}`); }
  };
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => { while (next < jobs.length) await handle(jobs[next++]); })); // four at a time
}
async function sendAll(list, progress) { // parents come before their children in `list`, and the socket keeps order
  for (let i = 0; i < list.length; i += 50) {
    const create = async (el) => { let r; for (let t = 0; t < 20; t++) { r = await send({ type: "ELEMENT_CREATE", ...el }); if (r.status !== 429) break; await new Promise((ok) => setTimeout(ok, 250)); } return r; }; // 429: the server's flood limit, wait for it to refill
    const rs = await Promise.all(list.slice(i, i + 50).map(create));
    const bad = rs.find((r) => r.status !== 200);
    if (bad) throw new Error("the server refused some cards (status " + bad.status + ")");
    progress(Math.min(i + 50, list.length), list.length);
  }
}
const pickBoardLook = (c = {}) => ({ ...(HEX.test(c.color ?? "") || TINTS.includes(c.color) ? { color: c.color } : {}), ...(ICON_NAMES.includes(c.icon) ? { icon: c.icon } : {}) });
async function fromBoardFile(j, parentPos, out, warn) {
  const board = mkEl("BOARD", { title: j.board?.title || "Imported board", ...pickBoardLook(j.board?.content) }, B, parentPos);
  out.push(board);
  const ids = new Map([["root", board.id]]), media = new Map(), kinds = new Set(Object.keys(KIND));
  const depth = (e, seen = 0) => (e.parent === "root" || seen > 20 ? 0 : 1 + depth(j.elements.find((x) => x.id === e.parent) ?? { parent: "root" }, seen + 1));
  const list = j.elements.filter((e) => e && typeof e.id === "string" && kinds.has(e.type)).sort((a, b) => depth(a) - depth(b));
  if (list.length < j.elements.length) warn.push(`${j.elements.length - list.length} cards of an unknown type were skipped`);
  for (const e of list) ids.set(e.id, newElement(e.type, {}, {}).id); // fresh ids for every card
  for (const [id, m] of Object.entries(j.media ?? {})) {
    if (!SUPPORTED_IMAGES[m?.type] || typeof m.data !== "string") continue;
    try { media.set(id, await uploadImage(Uint8Array.from(atob(m.data), (c) => c.charCodeAt(0)), m.type)); } catch (err) { warn.push(`an image was skipped (${err.message})`); }
  }
  for (const e of list) {
    const parent = ids.get(e.parent);
    if (!parent) continue;
    const c = structuredClone(e.content ?? {});
    if (e.type === "IMAGE") { if (!media.has(c.mediaId)) { warn.push("an image card had no image data"); continue; } c.mediaId = media.get(c.mediaId); }
    if (e.type === "LINE") for (const k of ["from", "to"]) c[k] = ids.get(c[k]) ?? null; // attachments follow the copies
    if (e.type === "COMMENT_THREAD") c.messages = []; // the server stamps authors, so past comments cannot be recreated
    const pos = e.position ?? {}, sect = e.section === "COLUMN" ? "COLUMN" : "CANVAS";
    const el = newElement(e.type, c, { x: pos.x ?? 0, y: pos.y ?? 0 });
    el.id = ids.get(e.id);
    el.location = { parentId: parent, section: sect, position: sect === "COLUMN" ? { score: pos.score ?? 65536 } : { x: pos.x ?? 0, y: pos.y ?? 0, score: 65536 } };
    out.push(el);
  }
  return board;
}

$("impgo").onclick = async () => {
  const go = $("impgo"), warn = [], out = [];
  go.disabled = true;
  try {
    const sub = $("impsub").checked, byName = new Map(), used = new Set(), tiles = [];
    for (const z of imp.zips) byName.set(z.name.split("/").pop().toLowerCase(), z);
    for (const j of imp.boards) { say2(`Importing "${j.board?.title}"...`); tiles.push(await fromBoardFile(j, freeSpot("BOARD"), out, warn)); }
    for (const p of imp.plans) {
      const plan = planFromBlocks(p.blocks, p.name.replace(/\.[^.]*$/, ""), sub);
      say2(`Uploading images for "${plan.title}"...`);
      await resolveImages(plan, byName, used, warn, say2);
      tiles.push(emit(plan, B, freeSpot("BOARD"), out));
    }
    const leftovers = [...byName.entries()].filter(([k]) => !used.has(k));
    if (leftovers.length) { // images in a ZIP that nothing referred to get a board of their own
      const plan = { title: "Imported images", items: [] };
      for (const [, z] of leftovers) {
        const bytes = await z.bytes(), type = mimeOf(z.name);
        try { const id = await uploadImage(bytes, type), { w, h } = await imageSize(bytes, type); plan.items.push({ type: "IMAGE", w, h, content: { mediaId: id, name: z.name.split("/").pop() } }); }
        catch (err) { warn.push(`${z.name.split("/").pop()}: ${err.message}`); }
      }
      if (plan.items.length) tiles.push(emit(plan, B, freeSpot("BOARD"), out));
    }
    if (!out.length) throw new Error("nothing to import");
    if (out.length > MAX_ELEMENTS) throw new Error(`more than ${MAX_ELEMENTS} cards`);
    // the new boards' tiles are laid out side by side on the board being viewed; their contents are created inside them
    let next = freeSpot("BOARD").x;
    const y = freeSpot("BOARD").y;
    tiles.forEach((t) => { t.location.position = { x: next, y, score: 65536 }; next += 150; });
    tiles.forEach((t) => { els[t.id] = t; });
    for (const t of tiles) counts[t.id] = { boards: out.filter((e) => e.elementType === "BOARD" && e.location.parentId === t.id).length, cards: out.filter((e) => e.location.parentId === t.id && e.elementType !== "BOARD" && e.elementType !== "LINE").length };
    tiles.forEach(render);
    await sendAll(out, (n, total) => say2(`Creating cards ${n} of ${total}...`));
    setSel(tiles.map((t) => t.id));
    pushHistory({ kind: "move", moves: tiles.map((t) => ({ id: t.id, from: trashOf(t.location), to: t.location })) });
    say2(`Imported ${out.length} item${out.length === 1 ? "" : "s"} (boards, columns and cards) in ${tiles.length} new board${tiles.length === 1 ? "" : "s"}.${warn.length ? "\nNote: " + warn.slice(0, 6).join("; ") + (warn.length > 6 ? `; and ${warn.length - 6} more` : "") : ""}`);
    toast(`Imported ${plural(tiles.length, "board")} (${out.length} items)`);
    if (!warn.length) dlg.hidden = true; // all went well: nothing left to read. With warnings the dialog stays open so they can be read.
  } catch (err) { say2("Import failed: " + (err.message ?? err)); await resync(); }
  go.disabled = false;
};
})();
