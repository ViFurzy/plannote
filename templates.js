// Board templates, made for this app (own words, no outside content). Each is a function that lays cards out with the helpers h; texts are [English, Polish] pairs
// and are picked by the browser's language. build(t) returns a "subtree" (what copying a board produces), which the app pastes into a new board.
(() => {
  const PL = /^pl/i.test(navigator.language), tx = (v) => (Array.isArray(v) ? (PL ? v[1] : v[0]) : v ?? "");
  const rid = () => Math.random().toString(36).slice(2, 8);
  const maker = () => {
    const list = [];
    const put = (type, content, x, y, extra = {}) => { const id = "t" + list.length; list.push({ id, type, parent: "root", section: "CANVAS", position: { x, y, score: 65536 }, content, ...extra }); return id; };
    const h = {
      note: (text, x, y, o = {}) => put("CARD", { textContent: tx(text), width: o.w ?? 200, ...(o.color && { color: o.color }), ...(o.heading && { heading: true }) }, x, y),
      head: (text, x, y, w = 360) => put("CARD", { textContent: tx(text), heading: true, width: w }, x, y),
      todo: (title, tasks, x, y, o = {}) => put("TASK_LIST", { title: tx(title), tasks: tasks.map((t) => ({ id: rid(), text: tx(t), done: false })), width: o.w ?? 240, ...(o.color && { color: o.color }) }, x, y),
      shape: (kind, text, x, y, w, ht, o = {}) => put("SHAPE", { kind, textContent: tx(text), width: w, height: ht, ...o }, x, y),
      table: (rows, x, y, w = 420) => put("TABLE", { rows: rows.map((r) => r.map(tx)), header: true, width: w }, x, y),
      swatch: (color, x, y) => put("SWATCH", { color }, x, y),
      link: (x, y) => put("LINK", { url: "" }, x, y),
      col: (title, x, y, cards = [], o = {}) => {
        const id = put("COLUMN", { title: tx(title), width: o.w ?? 240, ...(o.color && { color: o.color }) }, x, y);
        cards.forEach((c, i) => list.push({ id: id + "c" + i, type: "CARD", parent: id, section: "COLUMN", position: { score: 65536 * (i + 1) }, content: { textContent: tx(c) } }));
        return id;
      },
      line: (from, to) => put("LINE", { x1: 0, y1: 0, x2: 0, y2: 0, from, to, arrow: "end" }, 0, 0),
    };
    return { h, list };
  };
  const T = (id, icon, title, desc, words, make) => ({ id, icon, title, desc, words, make });
  const TEMPLATES = [
    T("kanban", "layout-grid", ["Kanban board", "Tablica kanban"], ["Three columns to move work from idea to done.", "Trzy kolumny, żeby przesuwać pracę od pomysłu do końca."], "tasks board columns zadania kolumny", (h) => {
      h.col(["To do", "Do zrobienia"], 40, 40, [["Write the first task here", "Wpisz tu pierwsze zadanie"], ["Drag cards between columns", "Przeciągaj karty między kolumnami"]]);
      h.col(["Doing", "W trakcie"], 320, 40, [["Limit this column to a few cards", "Trzymaj tu kilka kart naraz"]]);
      h.col(["Done", "Zrobione"], 600, 40, [["Finished work goes here", "Skończone rzeczy trafiają tutaj"]], { color: "sage" });
    }),
    T("mood", "palette", ["Mood board", "Tablica nastroju"], ["Colours, words and pictures that set a look and feel.", "Kolory, słowa i obrazy, które wyznaczają styl."], "design colours inspiration kolory inspiracje", (h) => {
      h.head(["Mood board", "Tablica nastroju"], 40, 30);
      ["#e5484d", "#f5c400", "#30a46c", "#3e63dd", "#8e4ec6"].forEach((c, i) => h.swatch(c, 40 + i * 130, 100));
      for (let i = 0; i < 3; i++) h.shape("rect", ["Picture", "Obraz"], 40 + i * 250, 270, 220, 150, { fill: "none", dash: "dashed" });
      h.note(["Words that describe it: calm, bold, warm…", "Słowa, które to opisują: spokojny, odważny, ciepły…"], 40, 450, { w: 340, color: "sand" });
      h.note(["Drop pictures onto the dashed frames or anywhere on the board.", "Upuść obrazy na ramki albo w dowolne miejsce tablicy."], 410, 450, { w: 340 });
    }),
    T("storyboard", "movie", ["Storyboard", "Storyboard"], ["Six frames in order, with a line under each for what happens.", "Sześć kadrów po kolei, a pod każdym miejsce na opis."], "film video scenes comic film wideo sceny", (h) => {
      const ids = [];
      for (let i = 0; i < 6; i++) {
        const x = 40 + (i % 3) * 300, y = 40 + Math.floor(i / 3) * 280;
        ids.push(h.shape("rect", [`Frame ${i + 1}`, `Kadr ${i + 1}`], x, y, 240, 150, { fill: "none" }));
        h.note([`What happens in scene ${i + 1}`, `Co dzieje się w scenie ${i + 1}`], x, y + 170, { w: 240 });
      }
      for (let i = 0; i < 5; i++) if (i !== 2) h.line(ids[i], ids[i + 1]);
      h.line(ids[2], ids[3]);
    }),
    T("brand", "target", ["Brand strategy", "Strategia marki"], ["Purpose, audience, voice, values and look in one place.", "Cel, odbiorcy, głos, wartości i wygląd w jednym miejscu."], "marketing identity branding marka", (h) => {
      h.head(["Brand strategy", "Strategia marki"], 40, 30, 500);
      h.col(["Purpose", "Cel"], 40, 100, [["Why do we exist?", "Po co istniejemy?"], ["What changes because of us?", "Co zmienia się dzięki nam?"]]);
      h.col(["Audience", "Odbiorcy"], 310, 100, [["Who are we for?", "Dla kogo to robimy?"], ["What do they need?", "Czego potrzebują?"]]);
      h.col(["Voice", "Głos"], 580, 100, [["Three words for how we sound", "Trzy słowa o tym, jak brzmimy"], ["Words we never use", "Słowa, których nie używamy"]]);
      h.col(["Values", "Wartości"], 850, 100, [["What we will not compromise on", "Na co się nie zgodzimy"]]);
      h.col(["Look", "Wygląd"], 1120, 100, [["Colours, fonts, pictures", "Kolory, czcionki, obrazy"]], { color: "lilac" });
    }),
    T("calendar", "calendar", ["Content calendar", "Kalendarz treści"], ["A week grid for planning posts, plus a bank of ideas.", "Tygodniowa siatka do planowania wpisów i skrzynka pomysłów."], "social posts schedule wpisy harmonogram", (h) => {
      h.head(["Content calendar", "Kalendarz treści"], 40, 30, 460);
      h.table([["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d, i) => [d, ["Pon", "Wt", "Śr", "Czw", "Pt", "Sob", "Nd"][i]]), ...Array.from({ length: 4 }, () => Array(7).fill(""))], 40, 100, 900);
      h.col(["Idea bank", "Skrzynka pomysłów"], 980, 100, [["A topic worth a post", "Temat wart wpisu"]], { color: "sand" });
      h.todo(["This week", "Ten tydzień"], [["Draft", "Szkic"], ["Pictures", "Obrazy"], ["Schedule", "Zaplanuj"]], 40, 420);
    }),
    T("project", "checklist", ["Project plan", "Plan projektu"], ["A goal, three steps in a flow, tasks and risks.", "Cel, trzy kroki w przepływie, zadania i ryzyka."], "planning steps flow roadmap kroki", (h) => {
      const g = h.shape("ellipse", ["Goal", "Cel"], 40, 60, 160, 100, { color: "sage" });
      const a = h.shape("rounded", ["Plan", "Plan"], 270, 70, 150, 80), b = h.shape("rounded", ["Do", "Wykonaj"], 490, 70, 150, 80), c = h.shape("rounded", ["Review", "Przegląd"], 710, 70, 150, 80);
      h.line(g, a); h.line(a, b); h.line(b, c);
      h.todo(["Tasks", "Zadania"], [["First step", "Pierwszy krok"], ["Second step", "Drugi krok"]], 40, 230);
      h.note(["Risks: what could go wrong, and what we do about it.", "Ryzyka: co może pójść źle i co wtedy robimy."], 320, 230, { w: 260, color: "rose" });
      h.note(["Who does what, and by when.", "Kto co robi i do kiedy."], 610, 230, { w: 250, color: "teal" });
    }),
    T("meeting", "notebook", ["Meeting notes", "Notatki ze spotkania"], ["Agenda, notes, decisions and action items.", "Agenda, notatki, decyzje i zadania."], "agenda minutes spotkanie zebranie", (h) => {
      h.head(["Meeting notes", "Notatki ze spotkania"], 40, 30, 420);
      h.note(["Date, people present", "Data, obecni"], 40, 100, { w: 300, color: "slate" });
      h.col(["Agenda", "Agenda"], 40, 190, [["First item", "Pierwszy punkt"], ["Second item", "Drugi punkt"]]);
      h.col(["Notes", "Notatki"], 320, 190, [["What was said", "Co zostało powiedziane"]]);
      h.col(["Decisions", "Decyzje"], 600, 190, [["What we decided", "Co ustaliliśmy"]], { color: "sage" });
      h.todo(["Action items", "Do zrobienia po spotkaniu"], [["Who does what", "Kto co robi"]], 880, 190);
    }),
    T("weekly", "calendar", ["Weekly planner", "Plan tygodnia"], ["A column for each day and a place for the week's goals.", "Kolumna na każdy dzień i miejsce na cele tygodnia."], "week days schedule tydzień dni", (h) => {
      h.todo(["Goals for the week", "Cele tygodnia"], [["Most important thing", "Najważniejsza rzecz"], ["Second thing", "Druga rzecz"]], 40, 30, { w: 300 });
      [["Monday", "Poniedziałek"], ["Tuesday", "Wtorek"], ["Wednesday", "Środa"], ["Thursday", "Czwartek"], ["Friday", "Piątek"], ["Saturday", "Sobota"], ["Sunday", "Niedziela"]].forEach((d, i) => h.col(d, 40 + i * 220, 230, [], { w: 200, color: i > 4 ? "sand" : undefined }));
    }),
    T("research", "notebook", ["Research notes", "Notatki z badań"], ["A question, sources, findings, quotes and what is still open.", "Pytanie, źródła, wnioski, cytaty i to, co zostało otwarte."], "study sources reading źródła nauka", (h) => {
      h.note(["The question I am trying to answer", "Pytanie, na które szukam odpowiedzi"], 40, 40, { w: 500, color: "lilac", heading: true });
      h.col(["Sources", "Źródła"], 40, 140, [], { w: 240 }); h.link(300, 160);
      h.col(["Findings", "Wnioski"], 580, 140, [["What I learned", "Czego się dowiedziałem"]]);
      h.col(["Quotes", "Cytaty"], 860, 140, [["A line worth keeping", "Zdanie warte zachowania"]]);
      h.col(["Still open", "Nadal otwarte"], 1140, 140, [["What I still need to find out", "Co jeszcze muszę ustalić"]], { color: "rose" });
    }),
    T("trip", "plane", ["Trip planning", "Plan podróży"], ["Before you go, day by day, packing and budget.", "Przed wyjazdem, dzień po dniu, pakowanie i budżet."], "travel holiday vacation podróż wakacje urlop", (h) => {
      h.head(["Trip to…", "Wyjazd do…"], 40, 30, 400);
      h.col(["Before we go", "Przed wyjazdem"], 40, 100, [["Tickets", "Bilety"], ["Places to stay", "Noclegi"]], { color: "teal" });
      h.col(["Day 1", "Dzień 1"], 320, 100, [["Morning", "Rano"], ["Evening", "Wieczorem"]]);
      h.col(["Day 2", "Dzień 2"], 600, 100, [["Morning", "Rano"], ["Evening", "Wieczorem"]]);
      h.todo(["Packing", "Pakowanie"], [["Documents", "Dokumenty"], ["Charger", "Ładowarka"]], 880, 100);
      h.table([[["Budget", "Budżet"], ["Cost", "Koszt"]], [["Travel", "Dojazd"], ""], [["Stay", "Nocleg"], ""], [["Food", "Jedzenie"], ""]], 880, 330, 300);
      h.shape("cloud", ["Ideas", "Pomysły"], 40, 420, 200, 120, { color: "sand" });
    }),
    T("recipes", "chef-hat", ["Recipe collection", "Zbiór przepisów"], ["Columns by meal, a recipe card to copy and a shopping list.", "Kolumny według posiłków, karta przepisu do skopiowania i lista zakupów."], "cooking food kitchen gotowanie kuchnia jedzenie", (h) => {
      h.col(["Breakfast", "Śniadania"], 40, 40, [["A recipe name", "Nazwa przepisu"]]);
      h.col(["Lunch", "Obiady"], 320, 40, [["A recipe name", "Nazwa przepisu"]]);
      h.col(["Dinner", "Kolacje"], 600, 40, [["A recipe name", "Nazwa przepisu"]]);
      h.col(["Sweet", "Słodkie"], 880, 40, [["A recipe name", "Nazwa przepisu"]], { color: "rose" });
      h.note(["Recipe card: ingredients, steps, time, how it turned out. Copy this card for each recipe.", "Karta przepisu: składniki, kroki, czas, jak wyszło. Skopiuj tę kartę dla każdego przepisu."], 40, 340, { w: 320, color: "sand" });
      h.todo(["Shopping list", "Lista zakupów"], [["Vegetables", "Warzywa"], ["Bread", "Chleb"]], 400, 340);
    }),
    T("mindmap", "brain", ["Mind map", "Mapa myśli"], ["A central idea with five branches joined by arrows.", "Główna myśl i pięć gałęzi połączonych strzałkami."], "ideas brainstorm thinking pomysły burza mózgów", (h) => {
      const c = h.shape("ellipse", ["Main idea", "Główna myśl"], 400, 260, 200, 120, { color: "lilac" });
      [[60, 60], [400, 20], [740, 60], [60, 460], [740, 460]].forEach(([x, y], i) => h.line(c, h.shape("rounded", [`Branch ${i + 1}`, `Gałąź ${i + 1}`], x, y, 200, 80, { color: ["sage", "teal", "sand", "orange", "rose"][i] })));
    }),
  ];
  const build = (t) => { const { h, list } = maker(); t.make(h); return list; };
  window.TEMPLATES = { list: TEMPLATES, build, tx };
})();
