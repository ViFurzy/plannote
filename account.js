// Plannote accounts: the boards home page (a tile grid, shown when you arrive) and the profile sheet (avatar, name, theme, password, log out, delete).
// Only with logins on (window.ACCOUNT). A classic script after index.html's own, so it reads that page's globals: $, h, escH, uid, B, HOME, goTo, iconSvg.
(() => {
if (!window.ACCOUNT) return;

const COLORS = ["teal", "orange", "sage", "sand", "slate", "rose", "lilac"], EMOJI = ["🌿", "🎨", "📚", "☕", "🚀", "🐙", "🌙", "🎧", "🍋", "🧩", "🦊", "🌊"];
const LOGO = '<svg viewBox="0 0 64 64"><rect x="14" y="14" width="16" height="16" rx="4"/><rect x="34" y="14" width="16" height="16" rx="4" opacity=".6"/><rect x="14" y="34" width="16" height="16" rx="4" opacity=".6"/><rect x="34" y="34" width="16" height="16" rx="4"/></svg>';
const serif = 'ui-serif, Georgia, "Times New Roman", serif';

document.head.append(Object.assign(document.createElement("style"), { textContent: `
  .pn-av { --s: 36px; --c: var(--tile-teal); display: inline-grid; place-items: center; width: var(--s); height: var(--s); border-radius: 50%; background: var(--c); color: #fff; font: 700 calc(var(--s) * .42)/1 system-ui, sans-serif; flex: none; user-select: none; text-shadow: 0 1px 1px rgb(0 0 0 / .18); }
  .pn-av.sand, .pn-av.sage, .pn-av.rose, .pn-av.lilac { color: #2b2b2b; text-shadow: none; }
  #homeBtn, #meBtn { background: none; border: 0; box-shadow: none; } #homeBtn svg { width: 24px; height: 24px; fill: #fff; padding: 5px; box-sizing: content-box; border-radius: 9px; background: #ef6c1a; } #meBtn .pn-av { --s: 30px; }
  #phome, #psheet { position: fixed; inset: 0; user-select: text; -webkit-user-select: text; } #phome:focus { outline: none; }
  #phome { z-index: 40; overflow: auto; background: var(--bg); color: var(--ink); background-image: radial-gradient(var(--dot) 1.2px, transparent 1.2px); background-size: 22px 22px; }
  .ph-top { display: flex; align-items: center; gap: 10px; padding: 12px 20px; position: sticky; top: 0; z-index: 2; background: var(--bg); }
  .ph-top .logo { display: inline-flex; align-items: center; gap: 10px; font: 700 20px ${serif}; }
  .ph-top .mark { width: 34px; height: 34px; border-radius: 9px; background: #ef6c1a; display: grid; place-items: center; } .ph-top .mark svg { width: 24px; height: 24px; fill: #fff; }
  .ph-top .sp { flex: 1; }
  .pn-btn { white-space: nowrap; font: inherit; min-height: 44px; padding: 0 16px; border-radius: 10px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); cursor: pointer; display: inline-flex; align-items: center; gap: 8px; }
  .pn-btn:hover { border-color: var(--accent); color: var(--accent); }
  .pn-btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; } .pn-btn.primary:hover { filter: brightness(1.1); color: #fff; }
  .pn-btn.danger { color: var(--bad); } .pn-btn.danger:hover { border-color: var(--bad); color: var(--bad); }
  .pn-btn:disabled { opacity: .5; cursor: default; }
  .ph-wrap { max-width: 1100px; margin: 0 auto; padding: 8px 20px 80px; }
  .ph-greet { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; padding-top: 12px; }
  .ph-greet h1 { margin: 0; font: 600 34px/1.1 ${serif}; letter-spacing: -.01em; }
  .ph-search { position: relative; width: min(360px, 100%); }
  .ph-search input, .pn-sheet input { font: inherit; font-size: 16px; min-height: 44px; padding: 0 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); color: var(--ink); width: 100%; outline: none; user-select: text; -webkit-user-select: text; }
  .ph-search input { padding-left: 38px; }
  .ph-search::before { content: "⌕"; position: absolute; left: 13px; top: 9px; font-size: 20px; color: var(--muted); pointer-events: none; }
  .ph-search input:focus, .pn-sheet input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .ph-sh { margin: 28px 0 12px; font: 600 20px ${serif}; display: flex; align-items: baseline; gap: 10px; } .ph-sh small { font: 13px system-ui, sans-serif; color: var(--muted); }
  .ph-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 18px; }
  .ph-card { position: relative; border-radius: 16px; background: var(--surface); border: 1px solid var(--line); box-shadow: var(--shadow); transition: transform .18s, box-shadow .18s, border-color .18s; }
  .ph-card:hover { transform: translateY(-3px); box-shadow: var(--shadow-lift); border-color: var(--accent); }
  .ph-card .open { display: block; width: 100%; text-align: left; font: inherit; color: inherit; background: none; border: 0; padding: 0; border-radius: inherit; cursor: pointer; }
  .ph-card .open:focus-visible, .ph-new:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .ph-thumb { position: relative; height: 118px; border-radius: 16px 16px 0 0; overflow: hidden; background: var(--ph-tint); }
  .ph-thumb i { position: absolute; border-radius: 4px; box-shadow: var(--shadow); }
  .ph-thumb .ico { position: absolute; left: 12px; bottom: 10px; width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center; background: var(--ph-tile); color: var(--ph-fg); box-shadow: var(--shadow); }
  .ph-thumb .ico svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
  .ph-meta { display: grid; padding: 12px 14px 14px; } .ph-meta b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-right: 74px; } .ph-meta small { color: var(--muted); }
  .ph-avs { position: absolute; right: 10px; bottom: 12px; display: flex; } .ph-avs .pn-av { --s: 24px; margin-left: -6px; border: 2px solid var(--surface); box-sizing: content-box; }
  .ph-new { display: grid; place-items: center; align-content: center; gap: 8px; min-height: 192px; border: 2px dashed var(--line); border-radius: 16px; background: none; color: var(--muted); font: inherit; cursor: pointer; }
  .ph-new:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); } .ph-new b { font: 300 36px/1 system-ui, sans-serif; }
  .ph-empty { text-align: center; padding: 48px 16px; display: grid; justify-items: center; gap: 14px; } .ph-empty h2 { margin: 0; font: 600 28px ${serif}; } .ph-empty p { margin: 0; color: var(--muted); max-width: 380px; }
  .ph-skel { height: 192px; border-radius: 16px; background: linear-gradient(90deg, var(--surface-2) 0, var(--surface) 50%, var(--surface-2) 100%) 0 0 / 400px 100%; animation: ph-shimmer 1.2s linear infinite; }
  @keyframes ph-shimmer { to { background-position: 400px 0; } }
  #psheet { z-index: 50; background: rgb(22 26 33 / .45); display: grid; place-items: center; padding: 20px; }
  .pn-sheet { width: min(520px, 100%); max-height: calc(100dvh - 40px); overflow: auto; background: var(--bg); color: var(--ink); border-radius: 20px; box-shadow: var(--shadow-lift); padding: 18px; display: grid; gap: 10px; align-content: start; overscroll-behavior: contain; }
  .pn-top { display: flex; align-items: center; gap: 12px; } .pn-top .t { flex: 1; min-width: 0; } .pn-top b { font: 600 20px ${serif}; display: block; overflow: hidden; text-overflow: ellipsis; } .pn-top span.m { color: var(--muted); }
  .pn-x { width: 44px; height: 44px; border-radius: 50%; border: 0; background: var(--surface-2); color: var(--ink); font-size: 22px; cursor: pointer; }
  .pn-sheet details { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; }
  .pn-sheet summary { min-height: 48px; padding: 12px 16px; font-weight: 600; cursor: pointer; list-style: none; display: flex; justify-content: space-between; align-items: center; border-radius: 10px; }
  .pn-sheet summary::-webkit-details-marker { display: none; }
  .pn-sheet summary:hover { background: var(--surface-2); }
  .pn-sheet summary::after { content: "▾"; color: var(--muted); transition: transform .28s cubic-bezier(.2, .8, .2, 1); }
  .pn-sheet details.is-open summary::after { transform: rotate(180deg); }
  .pn-sec { display: grid; gap: 14px; padding: 4px 16px 18px; will-change: height, opacity; }
  .pn-sec label { display: grid; gap: 4px; color: var(--muted); font-size: 13px; }
  .pn-sec input:disabled { background: var(--surface-2); color: var(--muted); }
  .pn-row { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; } .pn-row .grow { flex: 1; min-width: 200px; display: grid; gap: 12px; }
  .pn-sw, .pn-em { display: flex; flex-wrap: wrap; gap: 8px; }
  .pn-sw button { width: 36px; height: 36px; border-radius: 50%; border: 3px solid transparent; box-shadow: inset 0 0 0 2px var(--surface); cursor: pointer; } .pn-sw button.on { border-color: var(--ink); }
  .pn-em button { width: 44px; height: 44px; font-size: 22px; border-radius: 12px; border: 2px solid transparent; background: var(--surface-2); cursor: pointer; } .pn-em button.on { border-color: var(--accent); background: var(--accent-soft); }
  .pn-seg { display: inline-flex; padding: 3px; gap: 2px; background: var(--surface-2); border-radius: 10px; width: max-content; }
  .pn-seg button { min-height: 40px; padding: 0 14px; border: 0; background: none; border-radius: 8px; color: var(--muted); font: inherit; cursor: pointer; } .pn-seg button.on { background: var(--surface); color: var(--ink); font-weight: 600; box-shadow: var(--shadow); }
  .pn-line { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; } .pn-line > div { flex: 1; min-width: 180px; } .pn-line small { display: block; color: var(--muted); }
  .pn-box { display: grid; gap: 12px; padding: 14px; border-radius: 10px; background: var(--surface-2); } .pn-box.del { border: 1px solid var(--bad); }
  .pn-err { color: var(--bad); font-size: 13px; min-height: 1.2em; } .pn-err.ok { color: var(--ok); }
  .pn-save { position: sticky; bottom: 0; display: flex; gap: 10px; align-items: center; padding: 10px 12px; background: #161a21; color: #fff; border-radius: 10px; box-shadow: var(--shadow-lift); } .pn-save span { flex: 1; font-size: 14px; }
  .pn-save .pn-btn:not(.primary) { background: none; color: #fff; border-color: #4b5060; }
  .pn-toast { position: fixed; left: 50%; bottom: 28px; transform: translate(-50%, 20px); opacity: 0; z-index: 60; background: #161a21; color: #fff; padding: 10px 16px; border-radius: 10px; font-size: 14px; transition: all .2s; pointer-events: none; max-width: 90vw; } .pn-toast.show { opacity: 1; transform: translate(-50%, 0); }
  @media (max-width: 640px) { #meBtn { display: none; } } /* the phone's top bar is full: Profile is in the gear menu there */
  @media (max-width: 700px) {
    #psheet { padding: 0; align-items: end; } .pn-sheet { border-radius: 20px 20px 0 0; width: 100%; max-height: 90dvh; }
    .ph-top { padding: 10px 12px; } .ph-top .btn-label { display: none; } .ph-wrap { padding: 4px 12px 80px; } .ph-greet h1 { font-size: 28px; } .ph-grid { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
  }
  @media (prefers-reduced-motion: reduce) { .ph-card, .pn-sheet summary::after, .pn-toast { transition: none; } .ph-skel { animation: none; } }
` }));

// --- small helpers ---
const j = async (path, method = "GET", body) => {
  const r = await fetch(path, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined }).catch(() => null);
  return { ok: !!r?.ok, status: r?.status ?? 0, body: (await r?.json().catch(() => ({}))) ?? {} };
};
const el = (html) => Object.assign(document.createElement("div"), { innerHTML: html }).firstElementChild;
let toastTimer; const toast = (m) => { let t = document.querySelector(".pn-toast"); if (!t) document.body.append((t = h("div", "pn-toast"))); t.textContent = m; t.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2400); };
const hashOf = (s) => { let x = 0; for (const c of s) x = (x * 31 + c.charCodeAt(0)) >>> 0; return x; };
const sealed = (node) => { for (const t of ["pointerdown", "pointerup", "mousedown", "touchstart", "wheel", "dblclick", "contextmenu"]) node.addEventListener(t, (e) => e.stopPropagation()); return node; }; // the board behind must not hear clicks, drags or wheel turns on these layers
const ago = (t) => { const m = (Date.now() - t) / 60000; return m < 1 ? "just now" : m < 60 ? Math.round(m) + " min ago" : m < 1440 ? Math.round(m / 60) + " h ago" : m < 2880 ? "yesterday" : m < 10080 ? Math.round(m / 1440) + " days ago" : new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" }); };

// the picture: a colour plus the first letter, or one emoji
const avatar = (p, px = 36) => {
  const a = p?.avatar ?? { color: "teal", mode: "initial", emoji: EMOJI[0] };
  const n = h("span", "pn-av " + a.color, a.mode === "emoji" ? a.emoji : (p?.display || p?.name || "?").trim()[0]?.toUpperCase() || "?");
  n.style.setProperty("--s", px + "px"); n.style.setProperty("--c", `var(--tile-${a.color})`); n.setAttribute("aria-hidden", "true");
  return n;
};

let me = { name: uid, display: uid, avatar: { color: "teal", mode: "initial", emoji: EMOJI[0] }, devices: 1 };
const homeBtn = Object.assign(h("button", "btn ic"), { id: "homeBtn", title: "Boards home", ariaLabel: "Boards home", innerHTML: LOGO });
const meBtn = Object.assign(h("button", "btn ic"), { id: "meBtn", title: "Profile", ariaLabel: "Profile" });
$("side").prepend(homeBtn); $("gearBtn").after(meBtn);
const profileItem = Object.assign(h("button", "item", "Profile"), { id: "profileItem", title: "Your picture, name, theme and password" }); $("outBtn").before(profileItem); // the way in on a phone
const paintMe = () => { meBtn.replaceChildren(avatar(me, 30)); sheetTop?.(); phHead?.(); };
const loadMe = async () => { const r = await j("/api/users/me/profile"); if (r.ok) me = r.body; paintMe(); };

// =============================== profile sheet ===============================
let sheetTop, draft, opener;
const sheet = sealed(el(`<div id="psheet" hidden><div class="pn-sheet" role="dialog" aria-modal="true" aria-labelledby="pn-title">
  <div class="pn-top"><span id="pn-top-av"></span><div class="t"><b id="pn-title"></b><span class="m"></span></div><button class="pn-x" id="pn-close" aria-label="Close">×</button></div>
  <details open><summary>Profile</summary><div class="pn-sec">
    <div class="pn-row"><span id="pn-big-av"></span><div class="grow">
      <div class="pn-seg" role="group" aria-label="Picture"><button data-mode="initial">Letter</button><button data-mode="emoji">Emoji</button></div>
      <div class="pn-sw" id="pn-sw"></div><div class="pn-em" id="pn-em"></div></div></div>
    <label>Display name<input id="pn-display" maxlength="32" autocomplete="nickname"></label>
    <label>Login name<input id="pn-login" disabled></label><small class="pn-err" style="color:var(--muted)">Friends find you by the login name. It cannot be changed.</small>
    <div class="pn-save" id="pn-save" hidden><span>Unsaved changes</span><button class="pn-btn" id="pn-discard">Discard</button><button class="pn-btn primary" id="pn-do-save">Save</button></div>
  </div></details>
  <details><summary>Appearance</summary><div class="pn-sec"><div class="pn-line"><div><b>Theme</b><small>Changes at once on this device.</small></div>
    <div class="pn-seg" id="pn-theme" role="group" aria-label="Theme"><button data-v="light">Light</button><button data-v="dark">Dark</button><button data-v="system">System</button></div></div></div></details>
  <details><summary>Security</summary><div class="pn-sec">
    <div class="pn-line"><div><b>Password</b><small>At least 8 characters.</small></div><button class="pn-btn" id="pn-pw-open">Change password</button></div>
    <form class="pn-box" id="pn-pw" hidden><label>Current password<input type="password" name="cur" autocomplete="current-password"></label><label>New password<input type="password" name="next" autocomplete="new-password"></label><label>Repeat new password<input type="password" name="rep" autocomplete="new-password"></label>
      <div class="pn-err" role="alert"></div><div class="pn-row"><button class="pn-btn primary">Save password</button><button type="button" class="pn-btn" id="pn-pw-cancel">Cancel</button></div></form>
    <div class="pn-line"><div><b id="pn-devs"></b><small>Other devices stay signed in until you sign them out.</small></div><button class="pn-btn" id="pn-signall">Sign out other devices</button></div>
  </div></details>
  <details><summary>Account</summary><div class="pn-sec">
    <div class="pn-line"><div><b>Log out</b><small>On this device only.</small></div><button class="pn-btn" id="pn-logout">Log out</button></div>
    <div class="pn-line"><div><b>Delete account</b><small>Removes your boards and files. Boards you shared are removed for the others too.</small></div><button class="pn-btn danger" id="pn-del-open">Delete…</button></div>
    <form class="pn-box del" id="pn-del" hidden><div>Type <b class="who"></b> and your password to confirm. This cannot be undone.</div><input name="who" autocomplete="off" autocapitalize="none" aria-label="Your login name"><input type="password" name="pw" autocomplete="current-password" aria-label="Your password">
      <div class="pn-err" role="alert"></div><div class="pn-row"><button class="pn-btn danger" disabled>Delete everything</button><button type="button" class="pn-btn" id="pn-del-cancel">Keep my account</button></div></form>
  </div></details></div></div>`));
document.body.append(sheet);
const S = (s) => sheet.querySelector(s), SA = (s) => [...sheet.querySelectorAll(s)];

const dirty = () => draft.display !== (me.display === me.name ? "" : me.display) || draft.color !== me.avatar.color || draft.mode !== me.avatar.mode || draft.emoji !== me.avatar.emoji;
function drawDraft() {
  const p = { name: me.name, display: draft.display || me.name, avatar: { color: draft.color, mode: draft.mode, emoji: draft.emoji } };
  S("#pn-big-av").replaceChildren(avatar(p, 88));
  SA("[data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === draft.mode));
  SA("#pn-sw button").forEach((b) => b.classList.toggle("on", b.dataset.c === draft.color));
  SA("#pn-em button").forEach((b) => b.classList.toggle("on", b.dataset.e === draft.emoji));
  S("#pn-em").hidden = draft.mode !== "emoji";
  S("#pn-save").hidden = !dirty();
}
sheetTop = () => { S("#pn-top-av").replaceChildren(avatar(me, 52)); S("#pn-title").textContent = me.display; S(".pn-top .m").textContent = "@" + me.name; };
const themeNow = () => { try { return localStorage.getItem("theme") ?? "system"; } catch { return "system"; } };
const drawTheme = () => SA("#pn-theme button").forEach((b) => b.classList.toggle("on", b.dataset.v === themeNow()));
function fillSheet() {
  sheetTop(); draft = { display: me.display === me.name ? "" : me.display, color: me.avatar.color, mode: me.avatar.mode, emoji: me.avatar.emoji };
  S("#pn-display").value = draft.display; S("#pn-display").placeholder = me.name; S("#pn-login").value = me.name; S(".who").textContent = me.name;
  S("#pn-devs").textContent = `Signed in on ${me.devices} device${me.devices === 1 ? "" : "s"}`; S("#pn-signall").disabled = me.devices <= 1;
  S("#pn-sw").replaceChildren(...COLORS.map((c) => Object.assign(h("button"), { type: "button", title: c, ariaLabel: c, style: `background:var(--tile-${c})`, onclick: () => { draft.color = c; drawDraft(); } }))); SA("#pn-sw button").forEach((b, i) => (b.dataset.c = COLORS[i]));
  S("#pn-em").replaceChildren(...EMOJI.map((e) => Object.assign(h("button", "", e), { type: "button", onclick: () => { draft.emoji = e; drawDraft(); } }))); SA("#pn-em button").forEach((b, i) => (b.dataset.e = EMOJI[i]));
  drawDraft(); drawTheme();
}
SA("[data-mode]").forEach((b) => (b.onclick = () => { draft.mode = b.dataset.mode; drawDraft(); }));
S("#pn-display").oninput = (e) => { draft.display = e.target.value; drawDraft(); };
S("#pn-discard").onclick = () => { fillSheet(); S("#pn-display").focus(); };
S("#pn-do-save").onclick = async () => {
  const r = await j("/api/users/me/profile", "PUT", { display: draft.display.trim(), color: draft.color, mode: draft.mode, emoji: draft.emoji });
  if (!r.ok) return toast(r.body.error || "Could not save.");
  me = { ...me, ...r.body }; paintMe(); fillSheet(); S("#pn-close").focus(); toast("Saved. People you share with see the new name and picture."); // the Save button is gone now: keep focus in the sheet
};
SA("#pn-theme button").forEach((b) => (b.onclick = () => {
  const v = b.dataset.v, dark = v === "dark" || (v === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  try { v === "system" ? localStorage.removeItem("theme") : localStorage.setItem("theme", v); } catch { /* lasts until reload */ }
  document.documentElement.dataset.theme = dark ? "dark" : "light"; drawTheme();
}));
// password
const pw = S("#pn-pw");
S("#pn-pw-open").onclick = () => { pw.hidden = !pw.hidden; if (!pw.hidden) pw.cur.focus(); };
S("#pn-pw-cancel").onclick = () => { pw.reset(); pw.hidden = true; pw.querySelector(".pn-err").textContent = ""; };
pw.onsubmit = async (e) => {
  e.preventDefault(); const err = pw.querySelector(".pn-err"); err.classList.remove("ok");
  err.textContent = pw.next.value.length < 8 ? "New password: at least 8 characters." : pw.next.value !== pw.rep.value ? "The two new passwords differ." : "";
  if (err.textContent) return;
  const r = await j("/api/auth/password", "POST", { password: pw.cur.value, next: pw.next.value });
  if (!r.ok) return void (err.textContent = r.body.error || "Could not change the password.");
  pw.reset(); pw.hidden = true; me.devices = 1; fillSheet(); toast("Password changed. Other devices were signed out.");
};
S("#pn-signall").onclick = async () => { const r = await j("/api/auth/logout-all", "POST", {}); if (r.ok) { me.devices = 1; fillSheet(); toast(`Signed out of ${r.body.signedOut} other device${r.body.signedOut === 1 ? "" : "s"}.`); } };
// leaving
S("#pn-logout").onclick = async () => { await j("/api/auth/logout", "POST", {}); location.reload(); };
const del = S("#pn-del"), delGo = del.querySelector(".pn-btn.danger");
S("#pn-del-open").onclick = () => { del.hidden = !del.hidden; if (!del.hidden) del.who.focus(); };
S("#pn-del-cancel").onclick = () => { del.reset(); del.hidden = true; delGo.disabled = true; del.querySelector(".pn-err").textContent = ""; };
del.oninput = () => (delGo.disabled = del.who.value.trim().toLowerCase() !== me.name);
del.onsubmit = async (e) => {
  e.preventDefault(); if (delGo.disabled) return;
  const r = await j("/api/auth/delete", "POST", { password: del.pw.value });
  if (!r.ok) return void (del.querySelector(".pn-err").textContent = r.body.error || "Could not delete the account.");
  location.reload();
};
// animated unfolding: height, padding and fade on the section under each summary (Web Animations API, so it also runs in Safari on iPad)
SA("details").forEach((d) => d.classList.toggle("is-open", d.open));
SA("summary").forEach((s) => s.addEventListener("click", (e) => {
  e.preventDefault();
  const d = s.parentElement, body = s.nextElementSibling, opening = !d.classList.contains("is-open");
  const cur = d._a ? body.offsetHeight : null; // clicked mid-animation: continue from where it is
  d._a?.cancel(); d.classList.toggle("is-open", opening);
  if (opening) d.open = true;
  const natural = body.offsetHeight, cs = getComputedStyle(body), pt = parseFloat(cs.paddingTop), pb = parseFloat(cs.paddingBottom);
  const from = cur ?? (opening ? 0 : natural), to = opening ? natural : 0;
  const at = (x) => ({ height: x + "px", paddingTop: (pt * x) / natural + "px", paddingBottom: (pb * x) / natural + "px", opacity: x / natural });
  body.style.overflow = "hidden";
  const a = (d._a = body.animate([at(from), at(to)], { duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 1 : opening ? 300 : 230, easing: "cubic-bezier(.2, .8, .2, 1)" }));
  a.onfinish = () => { if (!opening) d.open = false; body.style.overflow = ""; d._a = null; };
}));
// open / close, with focus kept inside and returned
function openSheet() { opener = document.activeElement; fillSheet(); sheet.hidden = false; S("#pn-close").focus(); loadMe().then(() => !sheet.hidden && !dirty() && fillSheet()); }
function closeSheet() { sheet.hidden = true; opener?.focus?.(); }
S("#pn-close").onclick = closeSheet;
sheet.addEventListener("pointerdown", (e) => { if (e.target === sheet) closeSheet(); });
sheet.addEventListener("keydown", (e) => {
  e.stopPropagation(); // typing in the sheet is not a board shortcut
  if (e.key === "Escape") return closeSheet();
  if (e.key !== "Tab") return;
  const f = [...sheet.querySelectorAll("button, input, summary")].filter((n) => !n.disabled && n.offsetParent);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
meBtn.onclick = profileItem.onclick = openSheet;

// =============================== boards home ===============================
let phHead, homeData = null, q = "";
const home = sealed(el(`<div id="phome" hidden tabindex="-1"><div class="ph-top"><span class="logo"><span class="mark">${LOGO}</span>Plannote</span><span class="sp"></span>
  <button class="pn-btn" id="ph-canvas" title="The free canvas where your boards sit (Esc)">Canvas</button><button class="pn-btn primary" id="ph-new">＋ <span class="btn-label">New board</span></button><button class="btn ic" id="ph-me" title="Profile" aria-label="Profile" style="background:none;border:0;box-shadow:none"></button></div>
  <div class="ph-wrap"><div class="ph-greet"><h1 id="ph-hi"></h1><div class="ph-search"><input id="ph-q" placeholder="Search your boards" autocomplete="off" aria-label="Search your boards"></div></div><div id="ph-res"></div></div></div>`));
document.body.append(home);
const Hs = (s) => home.querySelector(s);
phHead = () => {
  const hr = new Date().getHours();
  Hs("#ph-hi").textContent = `Good ${hr < 5 || hr >= 18 ? "evening" : hr < 12 ? "morning" : "afternoon"}, ${me.display}`;
  Hs("#ph-me").replaceChildren(avatar(me, 32));
};
Hs("#ph-me").onclick = openSheet;

const thumb = (b) => {
  const c = COLORS.includes(b.color) ? b.color : COLORS[hashOf(b.id) % COLORS.length], t = h("div", "ph-thumb");
  t.style.cssText = `--ph-tint:var(--tint-${c});--ph-tile:var(--tile-${c});--ph-fg:var(--fg-${c})`;
  let x = hashOf(b.id) || 1; const r = () => ((x = (x * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < 5; i++) { const w = 22 + r() * 26, hh = 18 + r() * 24, d = h("i"); d.style.cssText = `left:${r() * (100 - w)}%;top:${r() * (100 - hh)}%;width:${w}%;height:${hh}%;background:${i % 2 ? `var(--tile-${c})` : "var(--surface)"}`; t.append(d); }
  if (b.icon) { try { t.append(Object.assign(h("span", "ico"), { innerHTML: iconSvg(b.icon) })); } catch { /* no icon */ } }
  return t;
};
function card(b, people, theirs) {
  const c = h("article", "ph-card"), open = h("button", "open"), meta = h("span", "ph-meta"), title = h("b", "", b.title || "Untitled board");
  open.type = "button"; open.dataset.id = b.id;
  meta.append(title, h("small", "", `${theirs ? "by " + (people[b.owner]?.display ?? b.owner) + " · " : ""}${b.cards} card${b.cards === 1 ? "" : "s"} · ${ago(b.at)}`));
  open.append(thumb(b), meta);
  const who = (theirs ? [b.owner] : b.members.filter((m) => m !== uid)).slice(0, 3), avs = h("div", "ph-avs");
  avs.append(...who.map((n) => avatar(people[n] ?? { name: n }, 24)));
  c.append(open, avs);
  return c;
}
function paint() {
  const res = Hs("#ph-res");
  if (!homeData) { const g = h("div", "ph-grid"); g.append(...Array.from({ length: 6 }, () => h("div", "ph-skel"))); return void res.replaceChildren(g); }
  const { boards, people } = homeData, byId = new Map(boards.map((b) => [b.id, b])), find = q.trim().toLowerCase(), hit = (b) => (b.title || "Untitled board").toLowerCase().includes(find);
  const mine = boards.filter((b) => b.parent === homeData.home && b.id !== homeData.home).sort((a, c) => c.at - a.at);
  const theirs = boards.filter((b) => b.owner && b.owner !== uid && b.id !== homeData.home && !byId.has(b.parent)).sort((a, c) => c.at - a.at);
  if (!mine.length && !theirs.length) {
    res.replaceChildren(el(`<div class="ph-empty"><h2>Make your first board</h2><p>A board is an open canvas for notes, pictures, lists and links. Start blank or from a template.</p><div><button class="pn-btn primary" data-act="new">＋ Blank board</button> <button class="pn-btn" data-act="tpl">From a template</button></div></div>`));
    return;
  }
  const m = mine.filter(hit), t = theirs.filter(hit), out = [];
  if (find && !m.length && !t.length) { const none = el(`<div class="ph-empty"><h2></h2><p>Try another word. The Boards button in a board also searches inside cards.</p></div>`); none.querySelector("h2").textContent = `No board called “${q.trim()}”`; return void res.replaceChildren(none); }
  const grid = (list, theirsFlag, first) => { const g = h("div", "ph-grid"); if (first) g.append(Object.assign(h("button", "ph-new"), { type: "button", innerHTML: "<b>＋</b>New board", onclick: newBoard })); g.append(...list.map((b) => card(b, people, theirsFlag))); return g; };
  const head = (text, n) => { const s = h("h2", "ph-sh", text + " "); s.append(h("small", "", String(n))); return s; };
  out.push(head("Your boards", mine.length), grid(m, false, !find));
  if (t.length) out.push(head("Shared with me", theirs.length), grid(t, true, false));
  res.replaceChildren(...out);
}
async function refreshHome() { const r = await j("/api/tree"); if (r.ok) homeData = r.body; paint(); }
function openHome() { home.hidden = false; home.focus({ preventScroll: true }); phHead(); paint(); refreshHome(); } // focus inside the page, so board shortcuts behind it hear nothing
function closeHome() { home.hidden = true; }
Hs("#ph-q").oninput = (e) => { q = e.target.value; paint(); };
Hs("#ph-res").onclick = (e) => {
  const o = e.target.closest(".open"), a = e.target.closest("[data-act]");
  if (o) { closeHome(); goTo(o.dataset.id); }
  else if (a?.dataset.act === "new") newBoard();
  else if (a?.dataset.act === "tpl") withCanvas(() => $("tplBtn").click());
};
// run something on the Home canvas once it is open and live (the existing tools create the board and open it for naming)
function withCanvas(run) {
  closeHome();
  if (location.hash.slice(1)) location.hash = "";
  const t0 = Date.now(), t = setInterval(() => { if ((B === HOME && $("st").dataset.state === "live") || Date.now() - t0 > 6000) { clearInterval(t); if (B === HOME) run(); } }, 80);
}
function newBoard() { withCanvas(() => $("brd").click()); }
Hs("#ph-new").onclick = newBoard;
Hs("#ph-canvas").onclick = () => withCanvas(() => {});
homeBtn.onclick = () => (home.hidden ? openHome() : closeHome());
addEventListener("hashchange", () => { if (!home.hidden && location.hash.slice(1)) closeHome(); });
home.addEventListener("keydown", (e) => { if (e.key === "Escape" && sheet.hidden && document.activeElement?.id !== "ph-q") { e.stopPropagation(); withCanvas(() => {}); } else e.stopPropagation(); });
addEventListener("keydown", (e) => { // focus can be on the page itself (a button that went away): Escape still closes the top layer
  if (e.key !== "Escape") return;
  if (!sheet.hidden) closeSheet(); else if (!home.hidden) withCanvas(() => {});
});

window.__account = { openHome, openSheet }; // test hook
loadMe().then(phHead);
if (!location.hash.slice(1)) openHome(); // arriving at the bare address: the boards home first
})();
