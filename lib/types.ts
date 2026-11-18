export type FlightOption = {
  from: string; to: string;
  dep: number; arr: number;           // UTC ms
  depLocal: string; arrLocal: string; // local wall clock "YYYY-MM-DDTHH:mm"
  price: number;                      // PLN, includes baggage fee when requested
  carrier: string; flightNo: string;
  source: "ryanair" | "wizz" | "google" | "kiwi" | "duffel" | "estimate" | "ground" | "flixbus" | "local" | "aviasales";
  link: string;
  estimated?: boolean;    // no live price available, lower-bound estimate only
  arrEstimated?: boolean; // arrival time derived from distance
  stops?: number;
  via?: { iata: string; min: number }[]; // Google: transfer airports and layover minutes of a leg with stops (split into flights by expandVias)
  bag?: number;           // checked-bag fee already in price (Google options in a search with a checked bag)
  note?: string;          // e.g. "bilet powrotny MAD-LIM" or "w cenie biletu Kiwi"
  market?: { cc: string; currency: string; label: string; local: number }; // bought on a foreign market ("kolumbijski", COP)
  rtAsOw?: boolean;       // a return ticket used one way (the return half is forfeited)
};

export type SearchParams = {
  query: string;
  origin: string[];          // airports the trip starts from (and returns to)
  dest: string[];            // acceptable destination airports
  destLabel: string;
  originLabel: string;
  dateFrom: string;          // outbound departure window
  dateTo: string;
  oneWay: boolean;
  stayMin: number;           // days
  stayMax: number;
  maxLegs: number;           // flights per direction
  baggage: "cabin" | "checked";
  allowOvernight: boolean;
  maxTripH: number;
  minConnSameH: number;
  minConnChangeH: number;
  flexMode?: "days" | "month" | "exact"; // ±3 days around the range, or the whole month(s)
  stopoverDays?: number;     // longest connection allowed, in days (0-7): a stopover in the city
  countHotel?: boolean;      // add the hotel estimate for nights at connections to the price
  mode?: "route" | "anywhere"; // anywhere: cheapest far destinations within a budget
  budget?: number;           // PLN, anywhere mode
  departs?: string[];        // origin is a country: all its airports are departure options
  home?: string;             // home city (airport code) the access by bus starts from
  access?: boolean;          // count the bus from home to the departure airport (default on)
  strict?: boolean;          // fly only from the airports of the city or country typed in (no airports nearby, no BER/PRG/BUD for Polska)
  abroad?: boolean;          // add foreign airports within ORIGIN_RADIUS_KM of home (default off: a country as the origin departs from its own airports only)
  maxAccessH?: number;       // longest ground access home -> departure airport (and back), by the real bus/train schedule; 0 = no limit (default 4)
  ground?: string[];         // internal: airports reached by bus from home (set by withDeparture)
  tripType?: "rt" | "ow" | "oj"; // form: round trip / one way / open-jaw (overrides the parser)
  destRet?: string[];        // open-jaw: the return starts from these airports (default: dest)
  destRetLabel?: string;
  pax?: number;              // passengers (prices are per person x pax)
  dateMode?: "exact" | "days" | "month" | "any6"; // form: exact dates / ±3 days / whole month / any time in 6 months
  depth?: "fast" | "deep";   // deep: runs for hours on the laptop worker, no step limits
  extended?: number;        // a quick search that ran out of time with a gap goes on in the background (extra minutes)
  researchMin?: number;      // deep with a time cap: "research ~1 h" (minutes); none = until proven or stopped
};

/** One technique's contribution to a trip's price (shown as "rynek CO: −420 zł"). */
export type Saving = { technique: "market" | "rt-as-ow" | "split" | "lowcost-hub" | "radar" | "memory" | "separate" | "hub-rt" | "strategist" | "through"; label: string; pln: number };
