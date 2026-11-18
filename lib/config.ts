// Central configuration. Everything tunable lives here and can be overridden by env.
const num = (k: string, d: number) => (process.env[k] ? Number(process.env[k]) : d);

export const config = {
  keys: {
    serpapi: process.env.SERPAPI_KEY || "",
    duffel: process.env.DUFFEL_TOKEN || "",
    anthropic: process.env.ANTHROPIC_API_KEY || "",
  },
  // AZYMUT_DATABASE_URL first: the Neon integration manages DATABASE_URL on Vercel (the original project ran out of its free quota)
  databaseUrl: process.env.AZYMUT_DATABASE_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL || "",
  appPassword: process.env.APP_PASSWORD || "",
  cronSecret: process.env.CRON_SECRET || "",

  // Per-search limits.
  maxPaidCallsPerSearch: num("MAX_PAID_CALLS_PER_SEARCH", process.env.SERPAPI_KEY ? 30 : 0),
  // Budgets for one whole search (across all resumed steps); override with SEARCH_SOURCE_LIMITS (JSON).
  sourceLimits: {
    google: 450, kiwi: 1400, ryanair: 1600, wizz: 3000, flixbus: 600,
    ...(process.env.SEARCH_SOURCE_LIMITS ? JSON.parse(process.env.SEARCH_SOURCE_LIMITS) : {}),
  } as Record<string, number>,
  stepSeconds: num("STEP_SECONDS", 120),
  stepHardSeconds: num("STEP_HARD_SECONDS", 210), // absolute end of a step's work; DB writes follow
  maxSearchMinutes: num("MAX_SEARCH_MINUTES", 30),
  // laptop worker: one long step per search instead of 120 s slices
  worker: {
    // a fast search ends here with the best trip found and the gap to the proven bound
    fastMinutes: num("WORKER_FAST_MINUTES", 12),
    deepHours: num("WORKER_DEEP_HOURS", 6),
    // no time limit by default: a search runs until its optimum is proven or the user stops it
    // (WORKER_MAX_HOURS > 0 sets a safety limit)
    maxHours: num("WORKER_MAX_HOURS", 0),
    onlineSeconds: 35 * 60, // offline after this long without a heartbeat (the idle worker reports every 30 min)
  },
  googleReserve: 25, // kept for hub round-trips and the baseline
  originAirports: (process.env.ORIGIN_AIRPORTS ?? "POZ BER WAW WMI KTW KRK WRO GDN PRG VIE BUD BTS LEJ DRS VNO RIX CPH BLL HAM").split(/[ ,]+/),
  flexDays: num("FLEX_DAYS", 3),
  originRadiusKm: num("ORIGIN_RADIUS_KM", 900),
  duffelLive: process.env.DUFFEL_LIVE === "1",
  maxFreeCallsPerSearch: num("MAX_FREE_CALLS_PER_SEARCH", 7000),
  maxSearchSeconds: num("MAX_SEARCH_SECONDS", 185),
  resultsK: num("RESULTS_K", 10),
  maxSerpDatesPerLeg: num("MAX_SERP_DATES_PER_LEG", 3),

  // API pricing (USD) for cost logging.
  cost: {
    serpapiPerCall: num("SERPAPI_COST_USD", 0.015),
    duffelPerCall: num("DUFFEL_COST_USD", 0),
    anthropicInPerM: 0.1,
    anthropicOutPerM: 0.5,
  },
  llmModel: process.env.LLM_MODEL || "claude-haiku-5-5",

  // Self-transfer rules (defaults; user can override per search).
  rules: {
    minConnSameH: 3,
    minConnChangeH: 5,
    maxLayoverH: 30,
    maxTripH: 60,
  },

  // Low-cost baggage fees (PLN, one checked 20 kg bag, per leg, typical online price).
  bagFee: { ryanair: 160, wizz: 170, other: 0 } as Record<string, number>,

  // Rough overnight cost near the airport, PLN.
  hotelByRegion: {
    EUR: 220, CAU: 150, MEA: 300, NAF: 150, AFR: 220, SAS: 130, SEA: 110, EAS: 260, CAS: 150,
    OCE: 380, NAM: 420, CAR: 330, SAM: 200,
  } as Record<string, number>,

  // FX to PLN (Duffel can return non-PLN currencies).
  fx: {
    PLN: 1, EUR: 4.25, USD: 3.95, GBP: 5.05, CHF: 4.55, HUF: 0.0108, RON: 0.855, BGN: 2.17, CZK: 0.17,
    NOK: 0.37, SEK: 0.37, DKK: 0.57, ALL: 0.043, MKD: 0.069, RSD: 0.036, GEL: 1.45, AED: 1.08, ILS: 1.07,
    MDL: 0.22, TRY: 0.11, BAM: 2.17, KZT: 0.0078, MAD: 0.40, SAR: 1.05,
  } as Record<string, number>,

  // Low-cost long-haul carriers and their hubs: priced and tried first on the far legs.
  lowcostLongHaul: ["Norse", "Level", "French bee", "Arajet", "Air Europa", "Plus Ultra", "World2fly", "JetSMART", "Sky Airline", "Wingo",
    "AirAsia X", "Scoot", "Cebu", "IndiGo", "Pegasus", "flydubai", "Air Arabia", "Uzbekistan"],
  lowcostHubs: "OSL LGW ORY BCN SDQ BOG KUL SIN MNL SAW DXB SHJ TAS".split(" "),
  // Big hubs on the far side: the inbound ends there and a separate local ticket goes on (always tried).
  splitHubs: {
    SAM: "BOG GRU SCL LIM MDE UIO EZE PTY".split(" "), CAR: "BOG PTY SDQ CUN MEX".split(" "), NAM: "JFK EWR MIA FLL".split(" "),
    // a hub inside the destination region is a destination itself: Asia splits at the Gulf / India / Istanbul too
    SEA: "KUL BKK SIN DMK MNL SGN DXB SHJ AUH DOH IST DEL BOM CMB TAS".split(" "), SAS: "DEL BOM CMB KUL DXB SHJ IST".split(" "),
    EAS: "HKG BKK KUL SIN TPE DXB IST TAS".split(" "),
    MEA: "DXB SHJ AUH IST".split(" "), AFR: "ADD NBO JNB CAI".split(" "), OCE: "SIN KUL BKK".split(" "), CAS: "TAS IST".split(" "),
  } as Record<string, string[]>,

  // Map refresh.
  mapMonths: 6,
  serpExploreDailyBudget: num("SERP_EXPLORE_DAILY_BUDGET", 0),
  mapStaleHours: 26,
  freeApiDelayMs: num("FREE_API_DELAY_MS", 700),
};

export type Config = typeof config;
