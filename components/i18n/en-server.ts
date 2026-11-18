// English for text the server sends (engine phases, notes, trip flags): exact strings and patterns.
// Keys are byte for byte what lib/ produces (diacritics, en dashes "–", „quotes”).
export const EN_SERVER: Record<string, string> = {
  // live.ts: status line of a live search
  "start": "starting",
  "worker: start": "worker: starting",
  "w kolejce na workerze": "queued on the worker",
  "czekam na worker na laptopie (npm run worker)": "waiting for the worker on the laptop (npm run worker)",
  "zatrzymano – pokazuję najlepszy znaleziony wynik": "stopped – showing the best result found",
  "ceny z nocnego przeliczenia – szukam aktualnych": "prices from the overnight run – looking for current ones",
  "zatrzymuję – zapisuję najlepszy wynik": "stopping – saving the best result",
  "lista gotowa": "list ready",
  "optimum udowodnione": "optimum proven",
  "zatrzymano na limicie": "stopped at the limit",
  "wznawiam po przerwie": "resuming after a break",
  // live.ts: push notifications
  "Wyszukiwanie zakończone – sprawdzone wszystko.": "Search finished – everything checked.",
  "Wyszukiwanie zakończone na limicie czasu.": "Search finished at the time limit.",
  "Wyszukiwanie zakończone, brak tras.": "Search finished, no routes.",
  // live.ts: notes
  "Kolejne rundy nie poprawiały już ani ceny, ani dolnej granicy: część wariantów nie daje się sprawdzić (źródło nie odpowiada), więc optimum nie jest udowodnione.":
    "Further rounds no longer improved the price or the lower bound: some variants cannot be checked (the source is not responding), so the optimum is not proven.",
  "Wyczerpany budżet zapytań do darmowych źródeł (ochrona przed blokadą): optimum nie jest udowodnione.":
    "Query budget for the free sources used up (protection against blocking): the optimum is not proven.",

  // engine.ts / anywhere.ts: phase messages
  "Aktualizuję mapę cen wokół punktów startu i celu": "Updating the price map around the origin and destination",
  "Pobieram gotowe kombinacje Kiwi (punkt odniesienia dla odcinania)": "Fetching ready-made Kiwi combinations (reference point for pruning)",
  "Sprawdzam Google na daty najlepszych tras": "Checking Google for the dates of the best routes",
  "Cena Google Flights: te same lotniska wylotu, daty i typ podróży": "Google Flights price: same departure airports, dates and trip type",
  "Wyceniam odcinki długodystansowe na całe okno dat (Kiwi)": "Pricing long-haul legs over the whole date window (Kiwi)",
  "Branch and bound: sprawdzam trasy od najtańszej dolnej granicy": "Branch and bound: checking routes from the cheapest lower bound up",
  "Strateg: sprawdzam nietypowe huby i loty pozycjonujące": "Strategist: checking unusual hubs and positioning flights",
  "Bilety powrotne w hubach: siatka dat Google dla najlepszych par": "Return tickets at hubs: Google date grid for the best pairs",
  "Rozbicie po drugiej stronie: dolot do dużego hubu i osobny lokalny bilet": "Split at the far end: a flight to a big hub and a separate local ticket",
  "Branch and bound: bilety w jedną stronę i powrotne w hubach, od najniższej dolnej granicy": "Branch and bound: one-way tickets and returns at hubs, from the lowest lower bound up",
  "Sprawdzam bilety powrotne w hubach przesiadkowych": "Checking return tickets at connecting hubs",
  "Bilety łączone vs osobne: każdy fragment trasy jako jedna rezerwacja": "Combined vs separate tickets: each part of the route as one booking",
  "Najtańsze kierunki: Kiwi po kontynentach i krajach, z wszystkich lotnisk wylotu": "Cheapest destinations: Kiwi by continent and country, from all departure airports",
  "Sprawdzam trasy z osobnych biletów tam, gdzie mapa obiecuje mniej": "Checking separate-ticket routes where the map promises less",

  // engine.ts / anywhere.ts / baseline.ts: result notes
  "Mapa cen jest starsza niż 3 dni.": "The price map is older than 3 days.",
  "Przeszukiwanie mapy osiągnęło limit bezpieczeństwa pamięci, więc nie ma dowodu optymalności.": "The map search hit the memory safety limit, so there is no proof of optimality.",
  "Najtaniej wychodzi zwykła oferta Google: osobne bilety nie dały tu niższej ceny.": "The plain Google offer is cheapest: separate tickets did not give a lower price here.",
  "Nic w budżecie: spróbuj wyższej kwoty albo szerszego okna dat.": "Nothing within budget: try a higher amount or a wider date window.",
  "Google Flights nie odpowiedział; cena bazowa z Kiwi (najtańsza gotowa kombinacja).": "Google Flights did not respond; baseline price from Kiwi (cheapest ready-made combination).",
  "Google Flights nie odpowiedział; cena bazowa z Kiwi (najtańsza gotowa kombinacja tam i z powrotem).": "Google Flights did not respond; baseline price from Kiwi (cheapest ready-made round-trip combination).",
  "Brak ceny bazowej: Google Flights nie zwrócił oferty mimo ponowień i zapytań per lotnisko, Kiwi też nie. Wynik nie jest porównany z Google.":
    "No baseline price: Google Flights returned no offer despite retries and per-airport queries, and neither did Kiwi. The result is not compared with Google.",
  "Szybka cena Google jeszcze niegotowa – pełne porównanie trwa.": "Quick Google price not ready yet – the full comparison is running.",
  // llm.ts: summary fallback
  "Nie znaleziono trasy spełniającej warunki w tym oknie dat.": "No route meeting the conditions was found in this date window.",
  // errors shown to the user
  "brak lotnisk docelowych (nie rozpoznano celu)": "no destination airports (destination not recognised)",
  "brak celu": "no destination",
  "nie rozpoznano miejsca": "place not recognised",
  // verify.ts: reasons
  "nie da się spiąć przesiadek w tych dniach": "the connections cannot be linked on these days",

  // leg notes
  "przesiadka w tej samej rezerwacji (godziny lotów między przesiadkami szacunkowe)": "connection within the same booking (flight times between connections estimated)",
  "w cenie rezerwacji Kiwi": "included in the Kiwi booking price",
  "jeden bilet z przesiadką (Google): przesiadka chroniona": "one ticket with a connection (Google): protected connection",
  "cena orientacyjna z kalendarza Aviasales": "indicative price from the Aviasales calendar",
  "cena z kalendarza Aviasales (Rosja: kup na miejscu lub przez pośrednika)": "price from the Aviasales calendar (Russia: buy locally or through an agent)",
  "lot z kalendarza Aviasales (osobny bilet; Rosja: kup przez Aviasales lub pośrednika)": "flight from the Aviasales calendar (separate ticket; Russia: buy via Aviasales or an agent)",
  "bilet powrotny (Google, ślad z Kayaka)": "return ticket (Google, lead from Kayak)",
  "bilet powrotny (Google, ślad z Kayaka): przesiadki chronione": "return ticket (Google, lead from Kayak): protected connections",
  "lot powrotny w cenie biletu: potwierdź godzinę przy rezerwacji": "return flight included in the ticket price: confirm the time when booking",
  "dojazd szacunkowy (brak kursu na żywo)": "estimated ground transfer (no live schedule)",
  "powrót w tej samej rezerwacji: lot tej linii wg rozkładu Google, potwierdź godzinę przy rezerwacji": "return in the same booking: this airline's flight per the Google schedule, confirm the time when booking",
  "dojazd do domu: najtańszy kurs w dniu powrotu (godzina wg przylotu)": "ride home: cheapest departure on the return day (time based on arrival)",
  "zwykła oferta Google, cena za oba kierunki": "plain Google offer, price for both directions",
  "zwykła oferta Google": "plain Google offer",
  "powrót w tej samej rezerwacji Google: godziny w ofercie": "return in the same Google booking: times in the offer",
  "z dojazdem miasto–lotnisko (szac.)": "including city–airport transfer (est.)",
  "czas i koszt szacunkowy (kursy codziennie 5–23)": "estimated time and cost (runs daily 5–23)",
  // carriers
  "autobus / pociąg": "bus / train",
  "transfer lokalny": "local transfer",
  "Transfer lokalny": "Local transfer",

  // trip flags (verify.ts riskFlags, engine.ts, techniques.ts, nightly lists)
  "osobne bilety": "separate tickets",
  "zmiana lotniska": "airport change",
  "autobus": "bus",
  "nocleg": "overnight stay",
  "krótka przesiadka": "short connection",
  "bilet powrotny w hubie": "return ticket at a hub",
  "cena szacunkowa": "estimated price",
  "godz. przylotu szacowana": "arrival time estimated",
  "data poza zakresem (±3 dni)": "date outside the range (±3 days)",
  "tylko mały bagaż": "small cabin bag only",
  "kombinacja Kiwi": "Kiwi combination",
  "lot krajowy w Rosji z kalendarza Aviasales (osobny bilet)": "domestic flight in Russia from the Aviasales calendar (separate ticket)",
  "cena bazowa (Kiwi, jedna rezerwacja)": "baseline price (Kiwi, one booking)",
  "zapamiętana trasa – cena sprawdzona teraz": "remembered route – price checked now",
  "najtaniej wychodzi zwykła oferta": "the plain offer is cheapest",
  "jeden bilet": "one ticket",
  "bilet powrotny w jedną stronę (powrót przepada)": "return ticket used one-way (return leg forfeited)",
  "cena z nocnego sprawdzenia": "price from the overnight check",
  "ceny z nocnego przeliczenia – sprawdzam aktualne": "prices from the overnight run – checking current ones",
  "przesiadka": "connection",
  "samodzielna przesiadka": "self-transfer",
  "dojazd autobusem": "bus transfer",
  // saving labels
  "trasa z pamięci wcześniejszych wyszukiwań": "route remembered from earlier searches",
  "osobne bilety zamiast jednej oferty Google": "separate tickets instead of one Google offer",
  // anywhere-cheap zones, place labels from parse.ts
  "Europa": "Europe",
  "Blisko poza Europą": "Near, outside Europe",
  "Reszta świata": "Rest of the world",
  "Ameryka Płd. i Australia": "South America and Australia",
  "gdziekolwiek": "anywhere",
  "Gdziekolwiek": "Anywhere",
  "gdziekolwiek tanio": "anywhere cheap",
  "poza Europą": "outside Europe",
  "Azja": "Asia",
};

// a price as the server prints it: "1234", "12 345" (pl-PL groups with a no-break space)
const N = "(\\d[\\d\\u00a0\\u202f ]*)";
const re = (src: string, flags = "") => new RegExp(src, flags);
const plural = (n: string, one: string, many: string) => (n.trim() === "1" ? one : many);

const MARKET: Record<string, string> = {
  polskim: "Polish", hiszpańskim: "Spanish", portugalskim: "Portuguese", peruwiańskim: "Peruvian", kolumbijskim: "Colombian",
  brazylijskim: "Brazilian", meksykańskim: "Mexican", amerykańskim: "US", tureckim: "Turkish", indyjskim: "Indian",
};
const VISA: Record<string, string> = {
  "wiza": "visa", "wiza na lotnisku": "visa on arrival", "sprawdź ruch bezwizowy": "check visa-free entry", "karta turysty": "tourist card",
};

/** [pattern, replacement] applied in order to server text with numbers, places or dates in it. */
export const SERVER_PATTERNS: [RegExp, string | ((...m: string[]) => string)][] = [
  // ---- live.ts status line
  [/^runda (\d+): (\d+)\/(\d+) tygodni z dowodem$/, "round $1: $2/$3 weeks proven"],
  [/^runda (\d+): dalej w głąb$/, "round $1: going deeper"],
  [/^krok (\d+): dalsze przeszukiwanie$/, "step $1: searching further"],
  [/^szybkie (\d+) min nie wystarczyło – szukam dalej w tle \(do (\d+) min\)$/, "the quick $1 min was not enough – searching on in the background (up to $2 min)"],
  // ---- live.ts push notifications
  [re(`^Wstępny wynik po (\\d+) min(?: – może być do ${N} zł taniej)?\\. Szukam dalej w tle \\(do godziny\\), dam znać\\.$`),
    (_, min, gap) => `Preliminary result after ${min} min${gap ? ` – could be up to ${gap} zł cheaper` : ""}. Searching on in the background (up to an hour), I'll let you know.`],
  [/: gdziekolwiek tanio$/, ": anywhere cheap"],

  // ---- engine.ts / anywhere.ts phase messages
  [/^Każde miasto regionu osobno: (\d+) kierunków$/, "Each city in the region separately: $1 destinations"],
  [/^Szybki przegląd: najtańsze loty do każdego kraju \((\d+) krajów\)$/, "Quick scan: cheapest flights to each country ($1 countries)"],
  [/^Szybki przegląd: (\d+)\/(\d+) krajów$/, "Quick scan: $1/$2 countries"],
  [/^Kierunek (\d+)\/(\d+): (.+)$/, "Destination $1/$2: $3"],
  [re(`^Mapa: (\\d+) kierunków z dolną granicą poniżej ${N} zł, dopytuję brakujące$`), "Map: $1 destinations with a lower bound under $2 zł, querying the missing ones"],

  // ---- result notes
  [re(`^Limit (\\d+) min na wyszukiwanie: optimum nie jest udowodnione, luka ≤ (${N.slice(1, -1)}|\\?) zł\\.$`),
    "Search limit of $1 min: the optimum is not proven, gap ≤ $2 zł."],
  [re(`^Przeszukiwanie mapy przekroczyło limit pamięci nawet przy podwojonym limicie \\(bez limitu przesiadek tras do sprawdzenia jest za dużo\\): część wariantów odpadła bez sprawdzenia, więc optimum nie jest udowodnione(?: \\(sprawdzona część: nic tańszego niż ${N} zł\\))?\\.$`),
    (_, lb) => `The map search exceeded the memory limit even with the limit doubled (without a connection limit there are too many routes to check): some variants were dropped unchecked, so the optimum is not proven${lb ? ` (checked part: nothing cheaper than ${lb} zł)` : ""}.`],
  [/^Nocna lista „Gdziekolwiek tanio”: (\d+) tras na start \(ceny sprawdzone dziś w nocy, potwierdź przed rezerwacją\)\.$/,
    "Overnight “Anywhere cheap” list: $1 routes to start with (prices checked last night, confirm before booking)."],
  [/^Pamięć tras: (\d+) odcinków z wcześniejszych podobnych wyszukiwań sprawdzonych na żywo jako punkt startu\.$/,
    "Route memory: $1 legs from earlier similar searches, checked live as a starting point."],
  [/^Strateg: (\d+) hipotez \((\d+) z trasą na mapie, (\d+) potwierdzonych na żywo\)\.$/,
    "Strategist: $1 hypotheses ($2 with a route on the map, $3 confirmed live)."],
  [/^Dowód obejmuje bilety w jedną stronę, kombinacje Kiwi i bilety powrotne Europa ↔ hub \((\d+) par z pełną siatką dat, (\d+) terminów sprawdzonych; dla pozostałych par założenie: bilet powrotny nie jest tańszy niż najtańszy bilet w jedną stronę na tej trasie\)\.$/,
    "The proof covers one-way tickets, Kiwi combinations and Europe ↔ hub return tickets ($1 pairs with a full date grid, $2 dates checked; for the other pairs the assumption is that a return ticket is not cheaper than the cheapest one-way ticket on that route)."],
  [re(`^(Koniec pamięci workera|Wyczerpany limit zapytań): optimum nie jest udowodnione \\(najniższa niesprawdzona dolna granica: ${N} zł\\)\\.$`),
    (_, why, lb) => `${why.startsWith("Koniec") ? "The worker ran out of memory" : "Query limit used up"}: the optimum is not proven (lowest unchecked lower bound: ${lb} zł).`],
  [/^(\d+) wariantów nie dało się sprawdzić \(źródło nie odpowiedziało\), więc nie ma dowodu optymalności\.$/,
    "$1 variants could not be checked (the source did not respond), so there is no proof of optimality."],
  [re(`^Uwaga: najlepsza trasa \\(${N} zł\\) wyszła drożej niż Google \\(${N} zł\\)\\.$`), "Note: the best route ($1 zł) came out more expensive than Google ($2 zł)."],
  [re(`^Tryb „gdziekolwiek tanio”: (\\d+) kierunków (na całym świecie|poza Europą) w budżecie ${N} zł \\((.+?) – (.+?)\\); jeden, najtańszy wynik na miasto\\.$`),
    (_, n, where, budget, d0, d1) => `“Anywhere cheap” mode: ${n} destinations ${where === "poza Europą" ? "outside Europe" : "worldwide"} within a ${budget} zł budget (${d0} – ${d1}); one cheapest result per city.`],

  // ---- llm.ts summary fallback (head, then the optional sentences)
  [re(`^Najtańsza trasa: (.+?), ${N} zł, wylot (\\d{4}-\\d{2}-\\d{2})(?:, powrót (\\d{4}-\\d{2}-\\d{2}))?\\.`),
    (_, route, price, out, ret) => `Cheapest route: ${route}, ${price} zł, departing ${out}${ret ? `, returning ${ret}` : ""}.`],
  [re(` To ${N} zł mniej niż najtańsza zwykła oferta Google \\(${N} zł\\)\\.`), " That is $1 zł less than the cheapest plain Google offer ($2 zł)."],
  [/ Wynik optymalny względem dostępnych danych\./, " Optimal result with respect to the available data."],
  [/ Część odcinków ma cenę szacunkową, bo brakuje klucza do weryfikacji na żywo\./, " Some legs have an estimated price because the key for live verification is missing."],

  // ---- parse.ts problems (joined with " · " in the calendar error)
  [/LLM niedostępny \((.*?)\), użyto parsera regułowego/, "LLM unavailable ($1), used the rule-based parser"],
  [/Nie rozpoznano miejsca startu: "([^"]*)"/, "Origin not recognised: \"$1\""],
  [/Nie rozpoznano miasta startowego: "([^"]*)"/, "Home city not recognised: \"$1\""],
  [/Nie rozpoznano miejsca powrotu: "([^"]*)"/, "Return place not recognised: \"$1\""],
  [/Nie rozpoznano celu: "([^"]*)"/, "Destination not recognised: \"$1\""],

  // ---- verify.ts reasons
  [/^nie udało się sprawdzić (\w+)-(\w+)$/, "could not check $1-$2"],
  [/^brak lotów (\w+)-(\w+) w sprawdzonych dniach$/, "no flights $1-$2 on the checked days"],
  [/^brak lotów (\w+)-(\w+)$/, "no flights $1-$2"],
  [/^brak autobusu (\w+)-(\w+)$/, "no bus $1-$2"],

  // ---- leg notes
  [/^cena za całą rezerwację Kiwi \((\d+) odc\.\)$/, "price for the whole Kiwi booking ($1 legs)"],
  [/^zmiana lotniska (\w+) → (\w+) \(szacunkowo\)$/, "airport change $1 → $2 (estimate)"],
  [/^bilet powrotny (\w+)–(\w+)–(\w+) użyty w jedną stronę: nie leć powrotnym \(linia anuluje tylko ten odcinek\)$/,
    "return ticket $1–$2–$3 used one-way: don't fly the return leg (the airline cancels only that leg)"],
  [/^bilet powrotny (\w+)–(\w+) \(cena za oba kierunki\)$/, "return ticket $1–$2 (price for both directions)"],
  [/^bilet powrotny (\w+)–(\w+): lot powrotny wg rozkładu, potwierdź przy rezerwacji$/, "return ticket $1–$2: return flight per schedule, confirm when booking"],
  [/^jeden bilet (\w+)–(\w+) zamiast osobnych$/, "one ticket $1–$2 instead of separate ones"],
  [/^kup na rynku (\S+) w ([A-Z]{3}) \(([^)]*)\)(?:, rezerwacja (\S+))?$/,
    (_, m, cur, local, route) => `buy on the ${MARKET[m] ?? m} market in ${cur} (${local})${route ? `, booking ${route}` : ""}`],
  [/^przez (.+) \(rezerwacja Kiwi\)$/, "via $1 (Kiwi booking)"],
  [/^(\d+) przes\.$/, (_, n) => `${n} ${plural(n, "stop", "stops")}`],

  // ---- trip flags
  [/^osobny bilet do (.+) i lot z kalendarza Aviasales \(samodzielna przesiadka\)$/, "separate ticket to $1 and a flight from the Aviasales calendar (self-transfer)"],
  [/^osobny bilet do (.+) \(samodzielna przesiadka\)$/, (_, c) => `separate ticket to ${c === "hubu" ? "the hub" : c} (self-transfer)`],
  [/^open-jaw: przylot (\w+), powrót z (\w+)$/, "open-jaw: arrive at $1, return from $2"],
  [/^tania linia długodystansowa: (.+)$/, "low-cost long-haul airline: $1"],
  [/^(\d+) dni w (.+)$/, (_, n, c) => `${n} ${plural(n, "day", "days")} in ${c}`],
  [/^wiza\/tranzyt: ([A-Z]{2}) (.+)$/, (_, cc, v) => `visa/transit: ${cc} ${VISA[v] ?? v}`],
  [/^zakup na rynku (\S+)$/, (_, m) => `bought on the ${MARKET[m] ?? m} market`],
  [re(`^dojazd z Poznania ~${N} zł \\(szac\\.\\)$`), "ride from Poznań ~$1 zł (est.)"],

  // ---- saving labels ("rynek CO: −420 zł")
  [/^rynek ([A-Z]{2}) \(([A-Z]{3})\) (\S+)$/, "$1 market ($2) $3"],
  [/^rynek ([A-Z]{2})\b/, "$1 market"],
  [/^bilet powrotny jako w jedną stronę (\S+)$/, "return ticket as one-way $1"],
  [/^rozbicie w (\w+) \((.+)\)$/, "split at $1 ($2)"],
  [/^bilet powrotny (\w+)–(\w+) zamiast dwóch w jedną stronę$/, "return ticket $1–$2 instead of two one-ways"],
  [/^jeden bilet zamiast osobnych: (.+)$/, "one ticket instead of separate ones: $1"],
  [re(`^okazja z Radaru (\\w+)–(\\w+) \\(norma ${N} zł\\)$`), "Radar deal $1–$2 (usual price $3 zł)"],
  [/^strateg: /, "strategist: "],
  // strategist hypotheses (also after the "strategist: " prefix above)
  [/^((?:strategist: )?)nietypowy hub (\w+) \((.+)\)$/, "$1unusual hub $2 ($3)"],
  [/^((?:strategist: )?)lot pozycjonujący do (.+) \((\w+)\), stamtąd tani długi lot$/, "$1positioning flight to $2 ($3), then a cheap long-haul flight"],
  [/^((?:strategist: )?)tanie linie z dwóch kontynentów: (\w+) → (\w+)$/, "$1low-cost airlines of two continents: $2 → $3"],
  [/^((?:strategist: )?)przylot do (.+) \((\w+)\) i dalej lądem$/, "$1arrive in $2 ($3) and continue overland"],

  // ---- radar
  [re(` \\(w ogłoszeniu ${N} zł(, w obie strony)?\\)$`), (_, p, rt) => ` (advertised at ${p} zł${rt ? ", return" : ""})`],
  [/ \/ norma z podobnych tras$/, " / usual price from similar routes"],

  // ---- fragments of labels built from pieces (last: only what the patterns above left in Polish)
  [/(?<!\p{L})samodzielna przesiadka(?!\p{L})/gu, "self-transfer"],
  [/(?<!\p{L})osobne bilety(?!\p{L})/gu, "separate tickets"],
  [/(?<!\p{L})osobny bilet(?!\p{L})/gu, "separate ticket"],
  [/(?<!\p{L})bilety powrotne(?!\p{L})/gu, "return tickets"],
  [/(?<!\p{L})bilet powrotny(?!\p{L})/gu, "return ticket"],
  [/(?<!\p{L})w jedną stronę(?!\p{L})/gu, "one-way"],
  [/(?<!\p{L})dojazd autobusem(?!\p{L})/gu, "bus transfer"],
  [/(?<!\p{L})przesiadki chronione(?!\p{L})/gu, "protected connections"],
  [/(?<!\p{L})przesiadka chroniona(?!\p{L})/gu, "protected connection"],
  [/(?<!\p{L})krótka przesiadka(?!\p{L})/gu, "short connection"],
  [/(?<!\p{L})przesiadka(?!\p{L})/gu, "connection"],
  [/(?<!\p{L})przesiadki(?!\p{L})/gu, "connections"],
  [/(?<!\p{L})nocleg(?!\p{L})/gu, "overnight stay"],
  [/(?<!\p{L})zmiana lotniska(?!\p{L})/gu, "airport change"],
  [/(?<!\p{L})cena szacunkowa(?!\p{L})/gu, "estimated price"],
  [/(?<!\p{L})kombinacja Kiwi(?!\p{L})/gu, "Kiwi combination"],
  [/(?<!\p{L})dolna granica(?!\p{L})/gu, "lower bound"],
  [/(?<!\p{L})optimum nie jest udowodnione(?!\p{L})/gu, "the optimum is not proven"],
  [/(?<!\p{L})optimum udowodnione(?!\p{L})/gu, "optimum proven"],
  [/(?<!\p{L})luka(?!\p{L})/gu, "gap"],
  [/(?<!\p{L})szac\./gu, "est."],
];
