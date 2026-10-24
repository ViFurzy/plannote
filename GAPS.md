# boardsync vs Milanote: gap list

Sources: Milanote help centre (keyboard shortcuts, images, links), checked against the code. Status as of 2026-10-22.
Only features Milanote's help pages mention are listed.

## Parity check 2026-10-24 (research + code + tests, 64/64 e2e)
Evidence quality: the official Milanote shortcut page (help.milanote.com/getting-started/shortcuts) was read directly. Milanote's own features/pricing pages
returned 404 to every fetch, so plan limits, templates, presentation mode, presence, version history and AI come from third-party pages or are UNVERIFIED.

**Milanote shortcuts we do NOT have** (checked in the code): double-click the canvas = new note; Ctrl+Enter = add a sibling note/board/column; Z = zoom tool;
`@` mentions; Ctrl+Shift+U / Shift+O lists, Ctrl+Shift+1/2 headings, Ctrl+> code, Ctrl+" quote (we have the toolbar and `#` `.` `1.` `>` typing instead);
Tab / Shift+Tab indent; `[ ]` checkbox (decided against); table Alt+Arrow add row/column and `=` formulas; drawing keys (Shift+D, D/V/E, 1-4) and the eraser;
iPad: double-tap canvas = note, long-press-drag multi-select, three-finger undo/redo/copy/cut/paste, double-tap an image to draw on it.
**Milanote shortcuts we have:** Space-drag pan, arrows (+Shift) nudge, Alt-drag copy, Ctrl+Shift+Up/Down order, Ctrl+C/X/V/D/A/Z, Esc, Delete, Ctrl+F, Ctrl+[ ] U, Ctrl+Shift+D,
B/I/U/strike/highlight/link/centre, Markdown typing, `/` search.

**Not in boardsync at all (Milanote has, or users ask for):** web clipper (browser extension), embeds (YouTube, Vimeo, SoundCloud, Google Maps, CodePen... in link cards),
file cards (PDF, documents; the server only accepts pictures), @mentions, templates, offline use and an installable app (Milanote's mobile apps lack offline too),
live cursors/presence (unverified for Milanote), snapping/alignment guides (disputed for Milanote), tags, public API, SSO/OIDC. Version history: neither has it, users of Milanote complain.
**Where boardsync is ahead or equal:** self-hosted and free (Milanote free plan: ~100 notes/images/links, 10 uploads, third-party figures), import of our own board file and of Milanote Markdown
(Milanote itself has no re-import in anything found), icon library with English/Polish search and name-based suggestions, outline view, cross-board search in a panel, no card cap.
**Export:** PDF (opens the print dialog: Save as PDF), PNG, Word (an HTML page saved as .doc, not .docx), Markdown, text, images ZIP (only when the board has pictures), board file: all tested.
Milanote's documented limits we share: columns cannot nest, document-style cards are text only; its mobile apps lack offline and table editing.

## Done (verified: `npm test` and `npm run e2e`, 45/45)
Note, to-do, heading, colour swatch, table, link, image, line, draw, comment, column, nested board. Live sync, undo/redo, trash,
sharing/ACL, copy/cut/paste/duplicate, lock position, bring to front/back, search, zoom/pan/fit, presentation mode,
board background, export/import (incl. Milanote Markdown), rich text (bold/italic/underline/strike/lists/heading).
Planned items now built: link-card own picture (button or paste), colour cards from a picture, image caption/crop/pins.
Built from this list: arrow nudge, Alt-drag copy, Ctrl+Shift+Up/Down order, Markdown-as-you-type (`#` `.` `-` `1.` `>`), highlight / quote / code / link / centre,
Ctrl+Shift+D theme (+ Theme button), Ctrl+[ / Ctrl+] / Ctrl+U board navigation, link-card Hide/Show picture, description and address (right-click),
image Rotate (toolbar and menu; crop and pins turn with it), colour strip (colour bar), Download Original (menu). Zoom: one wheel notch / button / Ctrl+plus = 15%.
Import: pictures are downloaded, captions, lists, links with their description, bold `##` headings as notes (see below).

Also built: Markdown import of ==highlight==, > quote and fenced code; "Unsorted" column for several pictures at once; link card to a board of this app = shortcut;
text colour and size (A-, A+, Colour); pen colour row for drawing and recolouring selected drawings.
UI: solid top bar (navigation, search, Boards, Outline, board actions); left options panel (text, picture, colours, pen); Boards panel (tree, recent, search across all boards, Ctrl+F); Outline (editable list of a board).

## Missing, ranked
| # | Gap | Milanote behaviour | Size |
|---|-----|--------------------|------|
| 1 | Embeds | YouTube, Vimeo, SoundCloud, Google Maps, CodePen... as a playable card | L |
| 2 | Freehand draw on images | Draw tool on a picture (boardsync has numbered pins instead) | L |
| 3 | Import from Milanote's own board data | Exact copy: colours, positions, arrows (Markdown cannot carry them) | L |
| 4 | ~~Pen thickness, eraser~~ done (4 sizes, whole-stroke eraser) | Drawing toolbar | S |
| 5 | Image library (Pexels), web clipper | | L (outside the app) |

Decided against for now: `[ ]` checkbox shortcut, @mentions, reactions, iPad gestures, ZIP-by-email export.

## Import from a Milanote Markdown export: what the file cannot carry
Column colours, card positions and sizes, lines/arrows, table cells ("Table element string placeholder"), and whether a `## Name` was a column or a
plain note (only a bold `## **Name**` is told apart). For an exact copy, import Milanote's own board data instead of Markdown (not built).
