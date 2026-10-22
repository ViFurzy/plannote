# boardsync vs Milanote: gap list

Sources: Milanote help centre (keyboard shortcuts, images, links), checked against the code. Status as of 2026-10-22.
Only features Milanote's help pages mention are listed.

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
| 4 | Pen thickness, eraser | Drawing toolbar | S |
| 5 | Image library (Pexels), web clipper | | L (outside the app) |

Decided against for now: `[ ]` checkbox shortcut, @mentions, reactions, iPad gestures, ZIP-by-email export.

## Import from a Milanote Markdown export: what the file cannot carry
Column colours, card positions and sizes, lines/arrows, table cells ("Table element string placeholder"), and whether a `## Name` was a column or a
plain note (only a bold `## **Name**` is told apart). For an exact copy, import Milanote's own board data instead of Markdown (not built).
