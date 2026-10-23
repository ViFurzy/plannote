// Builds icons.js (the board icon library) from Tabler Icons, MIT licence: https://github.com/tabler/tabler-icons
// Usage: npm i @tabler/icons --prefix <some folder> --ignore-scripts, then  node scripts/build-icons.mjs <folder>/node_modules/@tabler/icons
// Each icon gets English words (Tabler's own tags) plus Polish words from DICT below, so both "kitchen" and "kuchnia" find it.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const src = process.argv[2];
if (!src) { console.error("usage: node scripts/build-icons.mjs <path to @tabler/icons>"); process.exit(1); }
const meta = JSON.parse(readFileSync(join(src, "icons.json"), "utf8"));

// words lose their accents and case, so "Łazienka" and "lazienka" are the same (index.html does the same to what is typed)
const norm = (s) => s.toLowerCase().replace(/ł/g, "l").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

// [id, English name, Polish name, extra search words (both languages), icons]
const GROUPS = [
  ["home", "Home & rooms", "Dom i pokoje", "house flat apartment room furniture mieszkanie wnetrza meble sprzatanie cleaning laundry pranie",
    "home home-2 home-heart building-cottage door door-enter armchair armchair-2 bed bath toilet-paper lamp lamp-2 bulb plug key fence window stairs bucket trash wash ironing sofa wash-machine fridge microwave spray"],
  ["food", "Food & drink", "Jedzenie i picie", "kitchen cooking recipe meal restaurant kuchnia gotowanie przepisy restauracja",
    "chef-hat cooker blender tools-kitchen-2 tools-kitchen soup bowl bowl-chopsticks bread baguette burger pizza cake cookie coffee cup glass glass-cocktail glass-full beer bottle apple carrot avocado banana cherry grape lemon pepper mushroom egg cheese meat fish ice-cream ice-cream-2 salad candy lollipop milk grill grill-fork"],
  ["nature", "Garden & nature", "Ogrod i natura", "plants trees outdoors weather rosliny drzewa pogoda dwor",
    "plant plant-2 seedling flower leaf trees tree cactus mountain sun moon cloud droplet droplets umbrella flame campfire shovel butterfly feather snowflake rainbow clover wind cloud-rain sunrise sunset temperature wheat"],
  ["animals", "Animals", "Zwierzeta", "pets pet zwierzaki zwierze",
    "cat dog paw fish horse pig spider dragon deer bat bone fish-bone bug butterfly"],
  ["travel", "Travel & places", "Podroze i miejsca", "holiday vacation trip journey wakacje urlop wycieczka",
    "plane plane-departure plane-arrival luggage map map-pin map-2 compass globe world beach tent camper caravan ship sailboat train bus car bike motorbike scooter backpack ticket e-passport building-airport building-church building-castle building-bridge building-lighthouse tower anchor road route binoculars parachute helicopter rocket"],
  ["work", "Work & projects", "Praca i projekty", "office business job task planning biuro firma zadania planowanie",
    "briefcase building-skyscraper building calendar calendar-event checklist list-check list-details target flag presentation presentation-analytics clipboard clipboard-list file-text folder folders notebook notes pencil writing bookmark users user mail phone message message-circle bell-ringing inbox archive timeline hourglass stopwatch award certificate id-badge signature printer paperclip link pin"],
  ["money", "Money & shopping", "Pieniadze i zakupy", "finance budget store sale finanse budzet sklep",
    "shopping-cart shopping-bag basket gift coin coins cash cash-banknote credit-card wallet receipt receipt-2 tag tags discount building-store building-bank moneybag pig-money calculator currency-dollar currency-euro currency-zloty percentage shirt shoe hanger sunglasses paper-bag diamond crown"],
  ["health", "Health & sport", "Zdrowie i sport", "fitness gym workout medical doctor silownia trening lekarz medycyna",
    "heart heartbeat stethoscope pill pills vaccine first-aid-kit bandage brain dumbbell run stretching bike ball-football ball-basketball ball-tennis ball-volleyball ball-baseball ball-bowling trophy medal medal-2 swimming skateboard golf karate barbell mood-smile dental ear eye lungs walk ski-jumping pool kayak wheelchair thermometer ambulance hospital"],
  ["fun", "Music, movies & hobbies", "Muzyka, filmy i hobby", "entertainment art creative games rozrywka sztuka kreatywne gry",
    "music headphones microphone guitar-pick piano movie camera photo palette brush book books device-gamepad-2 device-gamepad dice puzzle chess device-tv masks-theater theater paint video playlist vinyl disc cards scissors ballpen typography"],
  ["tech", "Tech & devices", "Technologia i urzadzenia", "computer programming it komputer programowanie",
    "device-laptop device-desktop device-mobile device-tablet device-watch cpu code terminal-2 wifi bluetooth battery router server database cloud robot settings tool device-speaker keyboard mouse usb"],
  ["school", "School & learning", "Szkola i nauka", "study education science studia edukacja chemia fizyka matematyka",
    "school book books backpack pencil ruler ruler-2 certificate abacus language atom flask microscope telescope brain bulb notebook calculator math-function abc alphabet-latin planet dna"],
  ["people", "People & family", "Ludzie i rodzina", "kids children friends baby dzieci przyjaciele bobas",
    "users user users-group baby-carriage baby-bottle mood-kid mood-boy heart-handshake friends gift cake balloon confetti man woman"],
  ["party", "Celebrations", "Imprezy i swieta", "birthday wedding christmas party urodziny wesele swieta impreza prezenty",
    "gift cake balloon confetti calendar-event glass-cocktail music star sparkles tent campfire christmas-tree snowman pumpkin-scary"],
  ["diy", "Repairs & tools", "Naprawy i narzedzia", "diy construction garage remont budowa garaz narzedzia",
    "tools hammer hammer-drill axe paint brush ruler-2 building-factory bulldozer crane car car-garage engine gas-station plug bolt ladder tool bucket fence"],
  ["time", "Time & calendar", "Czas i kalendarz", "schedule date reminder harmonogram data przypomnienie",
    "clock alarm hourglass calendar calendar-event calendar-time stopwatch history timeline sunrise sunset"],
  ["symbols", "Symbols", "Symbole", "favourite favorite important ulubione wazne",
    "star heart flag bookmark bolt flame diamond crown infinity sparkles rocket trophy target key lock bell eye pin layout-grid folder bulb circle triangle square hexagon box rosette"],
];

// Polish words for English words that appear in Tabler's tags and icon names. One line per topic; "english words: polish words", separated by |
const DICT = `kitchen: kuchnia kuchenka gotowanie | cook cooking: gotowanie gotowac kucharz | chef: kucharz szef kuchni | food: jedzenie pozywienie | meal: posilek danie | dinner: obiad kolacja | lunch: obiad | breakfast: sniadanie | recipe: przepis przepisy | bake baking: pieczenie ciasto | bread: chleb pieczywo | cake: ciasto tort | cookie: ciastko ciasteczko | coffee: kawa kawiarnia | tea: herbata | drink drinks beverage: napoj napoje picie | beer: piwo | wine: wino | cocktail: koktajl drink | bottle: butelka | glass: szklanka kieliszek | cup mug: kubek filizanka | fruit: owoc owoce | vegetable: warzywo warzywa | apple: jablko | banana: banan | carrot: marchewka | egg: jajko jajka | cheese: ser | meat: mieso | fish: ryba ryby wedkarstwo | pizza: pizza | burger hamburger: burger hamburger | ice cream: lody | candy sweet sweets: cukierek slodycze | soup: zupa | salad: salatka | grill bbq barbecue: grill grillowanie | bowl: miska | blender: blender | fridge: lodowka | microwave: mikrofalowka | oven: piekarnik | stove: kuchenka | restaurant: restauracja | milk: mleko | lemon: cytryna | cherry: wisnia czeresnia | grape: winogrono | mushroom: grzyb grzyby | pepper: papryka pieprz
shop store: sklep | shopping: zakupy | cart: wozek zakupy | bag: torba torebka | basket: koszyk | gift present: prezent prezenty | money: pieniadze kasa | cash: gotowka | coin coins: moneta monety | wallet: portfel | credit: karta kredytowa | bank: bank | budget: budzet | finance financial: finanse | invoice: faktura | receipt bill: paragon rachunek | tax: podatek | discount sale: promocja rabat wyprzedaz | price: cena | tag tags: etykieta | calculator: kalkulator | savings: oszczednosci | pig: swinka swinia | moneybag: worek pieniedzy | percent percentage: procent
home house: dom mieszkanie | room: pokoj | bedroom: sypialnia | bed: lozko | sleep: sen spanie | bath bathroom bathtub: lazienka kapiel wanna | toilet: toaleta wc | shower: prysznic | living: salon | armchair: fotel | sofa couch: sofa kanapa | chair: krzeslo | table: stol | lamp: lampa | light bulb: swiatlo zarowka | door: drzwi | window: okno | key: klucz | lock: zamek klodka | garage: garaz | fence: plot | stairs: schody | bucket: wiadro | trash bin garbage: kosz smieci | clean cleaning: sprzatanie czysty | laundry wash washing: pranie | iron ironing: prasowanie zelazko | furniture: meble | cottage: domek | estate: osiedle nieruchomosci
garden: ogrod ogrodek | plant plants: roslina rosliny | flower flowers: kwiat kwiaty | tree trees: drzewo drzewa | leaf: lisc | grass: trawa | nature: natura przyroda | forest wood: las | mountain mountains: gory gora | hiking: wedrowka | camping camp: kemping biwak | tent: namiot | campfire bonfire: ognisko | fire flame: ogien plomien | sun sunny: slonce | moon: ksiezyc | cloud: chmura | rain rainy: deszcz | snow snowflake: snieg platek sniegu | wind: wiatr | weather: pogoda | umbrella: parasol | water droplet drop: woda kropla | rainbow: teczka teczowy | seedling: sadzonka | cactus: kaktus | shovel: lopata | temperature: temperatura | sunrise: wschod slonca | sunset: zachod slonca | feather: pioro | clover: koniczyna | outdoor outdoors: na zewnatrz
animal animals: zwierze zwierzeta | pet pets: zwierzak zwierzeta domowe | dog: pies | cat: kot | bird: ptak | horse: kon | paw: lapa | bug insect: owad robak | butterfly: motyl | spider: pajak | dragon: smok | deer: jelen | bat: nietoperz | bone: kosc | pig: swinia
travel: podroz podroze | trip journey: wycieczka podroz | vacation holiday: wakacje urlop | plane airplane flight: samolot lot | airport: lotnisko | luggage suitcase baggage: bagaz walizka | map: mapa | location place: lokalizacja miejsce | pin: pinezka | compass: kompas | globe world earth: swiat globus ziemia | beach: plaza | sea ocean: morze ocean | ship: statek | boat: lodz lodka | sail sailboat: zagle zaglowka zeglarstwo | train: pociag | bus: autobus | car: auto samochod | taxi: taksowka | bike bicycle: rower | motorbike motorcycle: motocykl motor | road: droga | route: trasa | ticket: bilet | hotel: hotel | caravan camper: kamper przyczepa | anchor: kotwica | binoculars: lornetka | parachute: spadochron | helicopter: smiglowiec | rocket: rakieta | backpack: plecak | transport: transport
work: praca | job: praca zawod | office: biuro | business: biznes firma | company: firma | project: projekt projekty | task tasks: zadanie zadania | todo checklist: lista zadan | list: lista | plan planning: plan planowanie | goal: cel cele | target: cel | idea: pomysl pomysly | calendar: kalendarz | schedule: harmonogram | meeting: spotkanie | presentation: prezentacja | chart: wykres | graph: wykres | report: raport | analytics: analityka statystyki | file document: plik dokument | folder: folder teczka | note notes: notatka notatki | notebook: notatnik zeszyt | pen pencil: olowek dlugopis | write writing: pisanie | printer: drukarka | paperclip: spinacz | link: link odnosnik | team: zespol | users: uzytkownicy ludzie | user: uzytkownik osoba | mail email: poczta email | message chat: wiadomosc czat | phone call: telefon rozmowa | inbox: skrzynka | archive: archiwum | timeline: os czasu | award: nagroda | certificate: certyfikat | badge: odznaka | signature: podpis | briefcase: teczka aktowka | skyscraper: wiezowiec | bell: dzwonek powiadomienie | clipboard: schowek tablica
draw drawing: rysowanie rysunek | paint: farba malowanie | brush: pedzel | palette: paleta | art: sztuka | design: projekt design | photo picture image: zdjecie zdjecia obraz | camera: aparat kamera fotografia | video: wideo film | movie film cinema: film filmy kino | tv television: telewizja telewizor | music: muzyka | song: piosenka | headphones: sluchawki | microphone: mikrofon | guitar: gitara | piano: pianino | concert: koncert | playlist: playlista | game games gaming: gra gry | gamepad: gry konsola | dice: kostka | puzzle: puzzle lamiglowka | chess: szachy | toy toys: zabawka zabawki | scissors: nozyczki | hobby: hobby | theater theatre masks: teatr maski | disc: plyta | typography: typografia
book books: ksiazka ksiazki | read reading: czytanie | library: biblioteka | school: szkola | study: nauka | learn learning: nauka | student: uczen student | teacher: nauczyciel | education: edukacja | homework: zadanie domowe | exam test: egzamin sprawdzian | science: nauka | chemistry flask: chemia kolba | physics atom: fizyka atom | math mathematics: matematyka | language: jezyk jezyki | microscope: mikroskop | telescope: teleskop | planet: planeta | dna: dna genetyka | ruler: linijka | abacus: liczydlo | alphabet: alfabet | brain: mozg
kid kids child children: dziecko dzieci | baby: niemowle bobas | family: rodzina | friend friends: przyjaciel przyjaciele znajomi | people: ludzie | man: mezczyzna | woman: kobieta | love: milosc | heart: serce | handshake: uscisk dloni | stroller carriage: wozek dzieciecy | bottle baby: butelka dla dziecka
wedding: wesele slub | party: impreza przyjecie | celebration: swietowanie uroczystosc | birthday: urodziny | balloon: balon balony | confetti: konfetti | christmas xmas: swieta boze narodzenie | snowman: balwan | pumpkin halloween: dynia halloween | holiday: swieto | festival: festiwal
sport: sport | fitness: fitness | gym: silownia | workout exercise training: trening cwiczenia | run running jogging: bieganie | swim swimming: plywanie | yoga: joga | stretching: rozciaganie | football soccer: pilka nozna | basketball: koszykowka | tennis: tenis | volleyball: siatkowka | baseball: baseball | bowling: kregle | golf: golf | karate: karate sztuki walki | skateboard: deskorolka | trophy cup: puchar | medal: medal | dumbbell barbell: hantle sztanga | health: zdrowie | medical: medyczny medycyna | doctor: lekarz | hospital: szpital | medicine pill pills: lek leki tabletki | vaccine: szczepionka | stethoscope: stetoskop | tooth dentist: zab dentysta | bandage: bandaz | aid: pomoc | ear: ucho | eye: oko | lungs: pluca | heartbeat: tetno | diet: dieta | mental: psychika | smile happy: usmiech radosc | mood: nastroj
tool tools: narzedzie narzedzia | repair fix: naprawa remont | hammer: mlotek | wrench: klucz francuski | screwdriver: wkretak | axe: siekiera | construction: budowa | build building: budynek budowa | factory: fabryka | bulldozer: koparka buldozer | crane: dzwig | engine: silnik | gas station fuel: stacja paliw | ladder: drabina | bolt: blyskawica sruba | bricks brick: cegly | diy: majsterkowanie | city: miasto | church: kosciol
computer: komputer | laptop: laptop | desktop: komputer stacjonarny | mobile smartphone: telefon smartfon | tablet: tablet | watch: zegarek | code: kod programowanie | programming developer: programowanie | terminal: terminal | server: serwer | database: baza danych | wifi: wifi internet | bluetooth: bluetooth | internet: internet | network router: siec router | security: bezpieczenstwo | robot: robot | settings gear: ustawienia | battery: bateria | plug: wtyczka | electric electricity: elektryka prad | keyboard: klawiatura | mouse: mysz | usb: usb | speaker: glosnik | cpu: procesor | device: urzadzenie
clock time: zegar czas | alarm: budzik | timer stopwatch: minutnik stoper | hourglass: klepsydra | history: historia | date: data | reminder: przypomnienie | daily: codziennie
star: gwiazda gwiazdka | favorite favourite: ulubione | flag: flaga | bookmark: zakladka | diamond jewel gem: diament bizuteria | crown: korona | infinity: nieskonczonosc | sparkles sparkle: iskry blyszczace magia | magic: magia | grid layout: siatka uklad | circle: kolo | triangle: trojkat | square: kwadrat | hexagon: szesciokat | box cube: pudelko kostka | rosette: rozeta | shirt: koszula ubranie | clothes: ubrania | hanger: wieszak | fashion: moda | secret: sekret | question: pytanie | info: informacja | help: pomoc | warning: ostrzezenie | space: kosmos | castle: zamek | treasure: skarb | ghost: duch | sword: miecz | shield: tarcza`;
const PL = new Map();
for (const line of DICT.split("\n")) for (const part of line.split("|")) {
  const [en, pl] = part.split(":").map((s) => s.trim());
  if (en && pl) for (const w of en.split(/\s+/)) PL.set(w, (PL.get(w) ?? "") + " " + pl);
}

const words = (s) => norm(String(s).replace(/-/g, " ")).split(" ").filter(Boolean); // a few Tabler tags are numbers
const inner = (name) => {
  const svg = readFileSync(join(src, "icons", "outline", name + ".svg"), "utf8");
  return svg.replace(/^[\s\S]*?class="[^"]*"\s*>/, "").replace(/<\/svg>\s*$/, "").replace(/<path stroke="none" d="M0 0h24v24H0z" fill="none"\s*\/>/, "").replace(/\s+/g, " ").replace(/ \/>/g, "/>").replace(/> </g, "><").trim();
};

const groups = GROUPS.map(([id, en, pl, kw]) => [id, en, pl, norm(kw + " " + en + " " + pl)]);
const icons = {}, missing = [];
GROUPS.forEach(([, , , , list], g) => {
  for (const name of list.split(/\s+/)) {
    if (icons[name]) continue; // an icon that appears in two groups stays in the first
    if (!meta[name]) { missing.push(name); continue; }
    const own = words(name), en = [...new Set([...own, ...(meta[name].tags ?? []).flatMap(words)])];
    const pl = [...new Set(en.flatMap((w) => words(PL.get(w) ?? "")))];
    icons[name] = [g, inner(name), [...new Set([...own, ...pl, ...en])].slice(0, 40).join(" ")]; // the icon's own name words first: they count most when searching
  }
});
if (missing.length) console.warn("not in Tabler (skipped): " + missing.join(" "));

const licence = readFileSync(join(src, "LICENSE"), "utf8").trim().split("\n").map((l) => " * " + l.trimEnd()).join("\n"); // the MIT licence asks for its notice to travel with the icons
const out = `/*\n${licence}\n */\n// Board icon library. Generated by scripts/build-icons.mjs from Tabler Icons (MIT licence above, https://github.com/tabler/tabler-icons): do not edit by hand.
// groups: [id, English name, Polish name, search words]   icons: name -> [group index, svg inner markup, search words (name first, then Polish, then English tags)]
const ICON_LIB = ${JSON.stringify({ groups, icons })};
`;
writeFileSync(new URL("../icons.js", import.meta.url), out);
console.log(`icons.js: ${Object.keys(icons).length} icons in ${groups.length} groups, ${(out.length / 1024).toFixed(0)} KB`);
