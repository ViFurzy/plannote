# Next features: iPad, web clipper, templates, shapes

Status: PLAN (nothing built). Written 2026-10-24 from research (see "Evidence") and the current code. Rule for all work: every change is designed and tested for
**touch (phone, iPad, Pencil) and desktop (mouse, wheel, keyboard)** at the same time.

## Evidence and its limits
- Read from sources: Milanote help (custom templates, clipper), tldraw geo-shape docs, WebKit Safari 18.2/26 notes (install, push, storage), Karakeep/Linkwarden docs.
- From the research agents' own knowledge, NOT verified: Apple Pencil details (hover, azimuth), three-finger gesture handling, Safari memory limits, Share Target status on iOS 26,
  Apple/Chrome fees, shape-library licences. These need a check on a real iPad before we rely on them.
- Milanote's own feature pages were unreachable, so "what Milanote does" is partly from third parties.

## Cross-device rules (apply to every phase)
1. Pointer Events only. One input helper: `inputKind(e)` = mouse | touch | pen. Never `pointerType !== "mouse"` to mean "finger" (today a Pencil is treated as a finger: `index.html` ~1456).
2. Finger: one finger pans, two pinch, press-and-hold (0.35s) drags a card or starts a marquee. Pencil: precise, so it drags/selects at once and draws when the Draw tool is on; a pen going down cancels any touch gesture in progress.
3. `ctrlKey || metaKey` is "the modifier" (iPad keyboard sends Cmd). Detect capability with `any-pointer` / `any-hover` and per-event `pointerType`, never user-agent (iPadOS reports a Mac).
4. Touch targets >= 44px on coarse pointers, handles drawn ~12px with a 44px hit area; nothing important within 20px of the screen edge.
5. Layout by width (phone <= 640, iPad portrait ~820, iPad landscape/desktop >= 1100), `dvh`, `viewport-fit=cover` + `env(safe-area-inset-*)`, `ResizeObserver` for Split View / Stage Manager.
6. Scrolling panels are listed in the wheel pass-through selector (index.html global wheel handler); no horizontal scroll strips, wrap instead.
7. Test matrix for each feature: 393x852 touch, 834x1194 touch (iPad portrait), 1180x820 touch + keyboard (iPad landscape), 1400x900 mouse. Pen through CDP (`Input.dispatchMouseEvent` with `pointerType: "pen"`).
   Add a WebKit run of the touch smoke tests (playwright-core can drive WebKit once installed). Things emulation cannot prove go on a real-iPad checklist (end of this file).

## Order
A. Foundations + iPad (below)  ->  B. Shapes  ->  C. Templates (can use shapes)  ->  D. Web clipper (token API + bookmarklet + Shortcut)  ->  E. Offline/PWA and the browser extension.
Each phase ends with: unit + e2e green at all four sizes, `GAPS.md` and the real-iPad checklist updated, one commit and one push you approve.

---
## A. Foundations and full iPad support  (M-L)
**A1 Input layer (S).** `inputKind(e)`, pen/finger rules above, `pointercancel` + `lostpointercapture` clean-up everywhere drag state is kept, pen-down cancels touch gestures. `touch-action: none` stays on the canvas.
**A2 Gesture map (M).**
| Gesture | Result | Desktop equivalent |
|---|---|---|
| one finger on empty canvas, drag | pan (+ toss, exists) | Space-drag / wheel |
| two fingers | pinch zoom around the midpoint (exists) | Ctrl+wheel |
| two-finger tap | undo (Procreate convention); Undo/Redo buttons are always visible | Ctrl+Z |
| double-tap empty canvas | new note at that point | double-click (also NEW on desktop; Milanote parity) |
| press-hold empty canvas, then drag | marquee select (Milanote iPad) | drag on empty canvas |
| press-hold card, then drag | move (exists) | drag |
| Pencil on card / canvas | drag / marquee at once | same as mouse |
| three-finger swipe/pinch | NOT used: iPadOS reserves them; offer buttons + Cmd+Z. Optional later: bridge `beforeinput` historyUndo/Redo from a hidden editable (test on a device) | - |
**A3 Pencil drawing (M).** Pressure -> stroke width (store `[x,y,p]`), `getCoalescedEvents()` when present, pen size (4 presets) and eraser (closes GAPS #4), palm rejection via A1, Scribble works in notes (check, no code). Draw-on-image stays a later item.
**A4 Layout for iPad (M).** Today only width <= 640 is "phone". Audit the tool panel, options bar, Boards panel, icon picker, share dialog, popups at 834 and 1180 wide and in Split View; bump targets to 44px with `@media (any-pointer: coarse)`; safe areas; keyboard-aware bars (exists) on the floating/split keyboard.
**A5 Keyboard parity (S, helps desktop too).** Ctrl+Enter = add sibling, Ctrl+Shift+U/O lists, Ctrl+Shift+1/2 headings, Tab/Shift+Tab indent, Ctrl+K link prompt works already; drawing keys D/V/E/1-4.
**A6 iPad performance (S).** `will-change: transform` on `#canvas` only; downscale pictures larger than ~2048px on upload (client canvas) and serve at display size; keep `content-visibility` OUT (it breaks fit/lines, see perf notes).
**A7 Install (S, no offline yet).** `manifest.webmanifest` (name, icons, `display: standalone`), apple touch icons, `navigator.storage.persist()`; Home-Screen apps get their own storage counter.
Acceptance: all gestures in the table work on touch and have a keyboard/mouse equivalent; Pencil draws with pressure; no layout overflow at 393/834/1180/1400; e2e for each.

## B. Shapes  (M)
**Model.** New element type `SHAPE`: `content = { kind, width, height, fill, stroke, strokeWidth, dash, opacity, radius, text, align, rot }`. Colours are palette tokens (existing tints + ink), not hex, so dark mode needs no migration. Server: add `SHAPE` to `TYPES` (server.ts) and the size cap already applies.
**Geometry.** New `shapes.js` (loaded like icons.js): `kind -> { path(w,h,p), outline(w,h), inset }`. The path is REGENERATED at the new size (stroke and corner radii stay constant, no `non-scaling-stroke`). `outline` returns a polygon (curves sampled) used for hit-testing and for connectors.
**First release, ~20 kinds:** rectangle, rounded rectangle, ellipse, diamond, triangle, right triangle, parallelogram, trapezoid, pentagon, hexagon, octagon, star, cross, heart, cloud, speech bubble, right arrow, double arrow, cylinder, check-box. (Left/up arrows by rotation/flip; extras later.) Hand-written parametric paths: no licence issue.
**Interaction.** Tool strip "Shape" opens a popover grid (search, >= 44px cells, English/Polish names like the icon picker); click/tap places it centred in view, drag-from-palette places under the pointer (exists for tools). Resize with the existing grips (min size = fits its label, as tldraw), a shape bar (kind swap, fill, stroke, width, dash, opacity) in the options row. Rotation handle = phase B2.
**Text.** `contenteditable` overlay centred with a per-shape inset; text never lives inside the SVG.
**Arrows.** `edgePoint` (index.html ~847) clips a ray to a rectangle; give it `shape.outline` so arrows meet ellipses, diamonds, stars at their edge.
**Other places to touch:** `KIND/LABEL/HTML/FIELD` tables, `render()`, `preview()` + aria-label, outline view, search text, export (md/txt: text only; PNG renders the path; board file keeps all), import validation (token and kind whitelist), `portable.js` mdText/docHtml, hit area: wide transparent stroke (>= 12px) so unfilled shapes are draggable by the edge and the interior.
Acceptance: all 20 kinds render and resize with constant stroke; arrows attach on the true outline; text fits/wraps; undo, copy/paste, board-file round trip, dark mode, touch resize with 44px handles, Pencil.

## C. Templates  (M)
**Format.** Our board file JSON (already exports/imports with id remap via `fromBoardFile`). Files in `templates/<id>.json` with `{ id, category, title:{en,pl}, description:{en,pl}, board: ... }`; card text as `{en,pl}` pairs resolved at instantiation. A small index built by `scripts/build-templates.mjs`. Served through the existing `send()` (gzip/ETag). No images (placeholder cards), so no licence risk and a few KB each.
**Content (own-made, EN+PL, ~12):** blank, mood board, storyboard, brand strategy, content calendar, project plan, meeting notes, kanban, weekly planner, research notes, trip planning, recipe collection.
**UX.** Creating a board (tool, Boards panel "New board", empty-board hint) offers a picker: "Blank" first, category chips, search. Desktop: modal or bottom-right card like Milanote; touch: bottom sheet with large tiles (Milanote has templates desktop-only; we do both).
**Instantiate.** Import into the current board as a new board tile in ONE transaction (existing multi-card write path), ids remapped (parents, columns, line ends).
**User templates (C2).** Right-click board -> "Convert to template" (flag `content.template`), "Use template" copies it; listed in the picker under "Mine". Sharing = board file or link.
Acceptance: each shipped template instantiates with the expected card count, unique ids, attached lines, Polish/English by UI language; picker works at all four sizes.

## D. Web clipper  (M, then L for extensions)
**D1 Token API (M, everything depends on it).** Table `api_tokens(hash sha256, user, label, scope, created, last_used)`; Settings -> "Clipper" to create/revoke (secret shown once). `POST /api/clip` with `Authorization: Bearer`, bearer-only (no cookie, so no CSRF). Body `{ url?, title?, text?, imageUrl? | image upload, boardId? }`. Creates a LINK card (reuse the unfurler, which already blocks private addresses, pins the checked IP and re-checks redirects), a NOTE for text, an IMAGE (reuse the upload checks: magic bytes, 5 MB). Default destination: an auto "Inbox" board with an Unsorted column; the clipper can pick from the 10 most recent boards. Rate limit per token + IP, body cap, CORS only on this route.
**D2 Popup bookmarklet (S).** Bookmarklet only does `window.open(server + "/clip?u=&t=&sel=")`; that first-party page (session cookie works) shows a preview + board picker and saves. Works in every desktop browser and in Safari on iPad (awkward to install on iOS, so D3 is the primary iPad route).
**D3 iOS/iPadOS Shortcut (S).** A shared Shortcut in the share sheet posting to `/api/clip` with the token; documented in DEPLOY.md. Untested recipe: needs a real device.
**D4 Share Target (S).** `share_target` in the manifest for Android Chrome / installed PWA. iOS does not support it (assume so).
**D5 MV3 extension (L, later).** Chrome/Edge/Firefox: context menu (image / selection / link), toolbar popup with board picker, optional screenshot (`captureVisibleTab`, with a preview). Token pasted once. Self-distributed zip first; stores later.
**D6 Safari extension: deferred.** Needs the Apple Developer Program ($99/yr, unverified) and an app wrapper; D2 + D3 already cover Safari.
Tests (unit): token hashing/scope/revoke, bad/expired token, SSRF blocked, size and rate limits, each content type creates the right card and broadcasts live to the board room.

## E. Offline and extension polish  (L, last)
Service worker caching the shell; IndexedDB snapshot of the open boards + an outbox of pending actions with idempotent ids, replayed on `online` / `visibilitychange` / socket reconnect; conflicts use the existing version check (retry once on the fresh card). Treat local storage as a cache, never the only copy (Safari may evict it; Home-Screen apps are better). Scope decision below.

## Decisions (answered 2026-10-24)
1. No Safari extension and no Apple developer account: the clipper is the popup bookmarklet (D2) plus the iOS/iPadOS Shortcut (D3), later the Chrome/Edge/Firefox extension (D5).
2. Clipper default destination: an automatic "Inbox" board with an Unsorted column; a choice of the 10 most recent boards.
3. Templates may include images, from stock sources. Rule: only pictures whose licence allows redistribution inside a free app (CC0 / public domain, or Pexels/Unsplash/Pixabay licence terms re-read for each image),
   downscaled (<= 800px, ~60 KB), with a `templates/CREDITS.md` listing source, author and licence per picture. Each picture's licence is checked when it is chosen, not assumed.
4. Pencil default (decided by me, the user had no preference): select/move at once, draw when the Draw tool is on; fingers pan, rest-then-drag selects. Revisit after trying it on a real iPad.
5. Shapes: rotation comes after the first release (B2).
6. Offline (phase E): skipped for now. Only the install manifest (A7) is built.

## Progress
- A1/A2/A5 first slice DONE (commit pending push): `inputKind` (a Pencil drags at once like a mouse), `pointercancel` clean-up, pen cancels finger gestures, double-click / double-tap on the empty board makes a note,
  two-finger tap = undo, rest-then-drag on empty board = marquee (6px dead zone), Ctrl+Enter = add a sibling card; e2e at phone and iPad-portrait widths, and Pencil via CDP.
- Next: A3 Pencil pressure + pen size + eraser, A4 iPad layout audit (44px targets, 834/1180 widths), A6 performance, A7 manifest, then B shapes.

## Real-iPad checklist (cannot be proven by emulation)
Three-finger gestures do not interfere; Pencil pressure/tilt; Scribble into a note; hardware keyboard shortcuts (Cmd); floating/split on-screen keyboard; Split View / Slide Over / Stage Manager resizing; Add to Home Screen standalone; a 2,000-card board's memory; Shortcut share-sheet flow; image drag from Photos/Files and paste.
