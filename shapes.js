// Shape geometry. Every shape is a list of rings (points [x, y] inside 0..w, 0..h); a ring flagged `open` is a line (a tick, a rim), the others are closed.
// ring 0 is always the outline: it is drawn, hit-tested and used by arrows to meet the shape at its edge. Curves are sampled into short segments
// (ponytail: polygons, not béziers - one source of truth for drawing and hit-testing; raise N if facets show at huge sizes).
(() => {
  const N = 48, TAU = Math.PI * 2;
  const arc = (cx, cy, rx, ry, a0, a1, n = N) => Array.from({ length: n + 1 }, (_, i) => [cx + rx * Math.cos(a0 + ((a1 - a0) * i) / n), cy + ry * Math.sin(a0 + ((a1 - a0) * i) / n)]);
  const fit = (pts, w, h) => { // stretch points to fill exactly 0..w, 0..h
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]), x0 = Math.min(...xs), y0 = Math.min(...ys), kx = w / (Math.max(...xs) - x0 || 1), ky = h / (Math.max(...ys) - y0 || 1);
    return pts.map(([x, y]) => [(x - x0) * kx, (y - y0) * ky]);
  };
  const regular = (n, w, h, a0 = -Math.PI / 2) => fit(Array.from({ length: n }, (_, i) => [Math.cos(a0 + (TAU * i) / n), Math.sin(a0 + (TAU * i) / n)]), w, h);
  const rrect = (w, h, r = Math.min(14, w / 2, h / 2)) => [...arc(w - r, r, r, r, -Math.PI / 2, 0, 8), ...arc(w - r, h - r, r, r, 0, Math.PI / 2, 8), ...arc(r, h - r, r, r, Math.PI / 2, Math.PI, 8), ...arc(r, r, r, r, Math.PI, Math.PI * 1.5, 8)];
  const open = (pts) => Object.assign(pts, { open: true });
  const GEOM = {
    rect: (w, h) => [[[0, 0], [w, 0], [w, h], [0, h]]],
    rounded: (w, h) => [rrect(w, h)],
    ellipse: (w, h) => [arc(w / 2, h / 2, w / 2, h / 2, 0, TAU, 64).slice(0, -1)],
    diamond: (w, h) => [[[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]],
    triangle: (w, h) => [[[w / 2, 0], [w, h], [0, h]]],
    rtriangle: (w, h) => [[[0, 0], [w, h], [0, h]]],
    parallelogram: (w, h) => { const s = w * 0.22; return [[[s, 0], [w, 0], [w - s, h], [0, h]]]; },
    trapezoid: (w, h) => [[[w * 0.2, 0], [w * 0.8, 0], [w, h], [0, h]]],
    pentagon: (w, h) => [regular(5, w, h)],
    hexagon: (w, h) => [regular(6, w, h, 0)],
    octagon: (w, h) => [regular(8, w, h, Math.PI / 8)],
    star: (w, h) => [fit(Array.from({ length: 10 }, (_, i) => { const r = i % 2 ? 0.382 : 1, a = -Math.PI / 2 + (Math.PI * i) / 5; return [r * Math.cos(a), r * Math.sin(a)]; }), w, h)],
    cross: (w, h) => { const a = w / 3, b = h / 3; return [[[a, 0], [2 * a, 0], [2 * a, b], [w, b], [w, 2 * b], [2 * a, 2 * b], [2 * a, h], [a, h], [a, 2 * b], [0, 2 * b], [0, b], [a, b]]]; },
    heart: (w, h) => [fit(Array.from({ length: 72 }, (_, i) => { const t = (TAU * i) / 72; return [16 * Math.sin(t) ** 3, -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t))]; }), w, h)],
    cloud: (w, h) => [fit(Array.from({ length: 96 }, (_, i) => { const t = (TAU * i) / 96, r = 0.78 + 0.22 * Math.abs(Math.sin(2.5 * t)); return [r * Math.cos(t), r * Math.sin(t)]; }), w, h)],
    bubble: (w, h) => {
      const bh = h * 0.78, r = Math.min(14, w / 2, bh / 2);
      return [[...arc(w - r, r, r, r, -Math.PI / 2, 0, 8), ...arc(w - r, bh - r, r, r, 0, Math.PI / 2, 8), [w * 0.45, bh], [w * 0.2, h], [w * 0.25, bh], ...arc(r, bh - r, r, r, Math.PI / 2, Math.PI, 8), ...arc(r, r, r, r, Math.PI, Math.PI * 1.5, 8)]];
    },
    arrow: (w, h) => { const hl = Math.min(w * 0.4, h * 0.8); return [[[0, h * 0.3], [w - hl, h * 0.3], [w - hl, 0], [w, h / 2], [w - hl, h], [w - hl, h * 0.7], [0, h * 0.7]]]; },
    darrow: (w, h) => { const hl = Math.min(w * 0.3, h * 0.8); return [[[0, h / 2], [hl, 0], [hl, h * 0.3], [w - hl, h * 0.3], [w - hl, 0], [w, h / 2], [w - hl, h], [w - hl, h * 0.7], [hl, h * 0.7], [hl, h]]]; },
    cylinder: (w, h) => {
      const ry = Math.min(h * 0.16, w / 4);
      return [[...arc(w / 2, ry, w / 2, ry, Math.PI, TAU, 24), ...arc(w / 2, h - ry, w / 2, ry, 0, Math.PI, 24)], open(arc(w / 2, ry, w / 2, ry, 0, Math.PI, 24))];
    },
    check: (w, h) => [rrect(w, h, Math.min(8, w / 4, h / 4)), open([[w * 0.25, h * 0.52], [w * 0.43, h * 0.7], [w * 0.76, h * 0.32]])],
  };
  // [id, English, Polish, search words]
  const KINDS = [
    ["rect", "Rectangle", "Prostokąt", "square box kwadrat"], ["rounded", "Rounded rectangle", "Zaokrąglony prostokąt", "box card pudełko"], ["ellipse", "Ellipse", "Elipsa", "circle oval koło okrąg"],
    ["diamond", "Diamond", "Romb", "decision rhombus decyzja"], ["triangle", "Triangle", "Trójkąt", "warning"], ["rtriangle", "Right triangle", "Trójkąt prostokątny", "wedge"],
    ["parallelogram", "Parallelogram", "Równoległobok", "input data"], ["trapezoid", "Trapezoid", "Trapez", ""], ["pentagon", "Pentagon", "Pięciokąt", ""],
    ["hexagon", "Hexagon", "Sześciokąt", "honeycomb"], ["octagon", "Octagon", "Ośmiokąt", "stop sign"], ["star", "Star", "Gwiazda", "favourite favorite ulubione"],
    ["cross", "Cross", "Krzyż", "plus add dodaj"], ["heart", "Heart", "Serce", "love like miłość"], ["cloud", "Cloud", "Chmura", "weather thought myśl"],
    ["bubble", "Speech bubble", "Dymek", "comment talk chat komentarz"], ["arrow", "Arrow", "Strzałka", "right direction"], ["darrow", "Double arrow", "Podwójna strzałka", "both ways"],
    ["cylinder", "Cylinder", "Walec", "database storage baza danych"], ["check", "Check box", "Pole wyboru", "tick done zrobione"],
  ];
  const poly = (kind, w, h, inset = 0) => { // rings for a w x h shape whose stroke is `inset * 2` wide: the outline sits fully inside the box
    const rings = (Object.hasOwn(GEOM, kind) ? GEOM[kind] : GEOM.rect)(Math.max(1, w - inset * 2), Math.max(1, h - inset * 2)); // kind comes from other clients: own keys only
    return rings.map((r) => Object.assign(r.map(([x, y]) => [+(x + inset).toFixed(1), +(y + inset).toFixed(1)]), r.open ? { open: true } : {}));
  };
  const pathD = (rings) => rings.map((r) => "M" + r.map((p) => p.join(" ")).join("L") + (r.open ? "" : "Z")).join("");
  window.SHAPES = { KINDS, has: (k) => Object.hasOwn(GEOM, k), poly, pathD };
})();
