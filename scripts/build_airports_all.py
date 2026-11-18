"""Full airport list: every airport with scheduled passenger service and an IATA code (OurAirports,
public domain), beyond the curated core in lib/data/airports.json. Polish city names from Wikidata,
English names and ASCII spellings as aliases, time zones from OpenFlights (nearest airport when
missing). Writes lib/data/airports-extra.json (only airports not in the core list).

Inputs in data-src/: ourairports-airports.csv, ourairports-countries.csv, airports.dat (OpenFlights),
wikidata-airport-cities.csv (iata, cityPl, cityEn; see README in this script's docstring header).
"""
import csv, json, math, os, unicodedata

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data-src")

def fold(s):
    s = unicodedata.normalize("NFD", s.lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return s.replace("ø", "o").replace("æ", "ae").replace("ł", "l").replace("ß", "ss").replace("đ", "d").replace("ı", "i")

core = json.load(open(os.path.join(ROOT, "lib/data/airports.json")))
core_codes = {a["iata"] for a in core}
cc_region = {}
for a in core:
    cc_region.setdefault(a["cc"], a["region"])

# regions for countries the core list does not cover
SUB = {
    "MEA": "AE QA OM SA BH KW IQ IR JO LB SY IL PS YE",
    "CAU": "GE AM AZ",
    "CAS": "KZ UZ KG TJ TM AF MN",
    "SAS": "IN LK MV NP BD PK BT",
    "SEA": "TH MY SG ID VN PH KH MM LA BN TL",
    "EAS": "CN JP KR KP TW HK MO",
    "NAF": "MA DZ TN LY EG EH SD",
    "CAR": "MX GT BZ SV HN NI CR PA CU JM HT DO PR BS BB TT AG DM GD KN LC VC AW CW SX BQ VG VI KY TC MS AI GP MQ BL MF",
    "OCE": "AU NZ FJ PG NC PF WS TO VU SB KI TV NR FM MH PW CK NU WF GU MP AS",
    "EUR": "RU BY UA MD RS BA MK XK ME AL SI IS FO GL SJ GI AD MC SM VA LI LU EE LV LT",
}
for reg, ccs in SUB.items():
    for cc in ccs.split():
        cc_region.setdefault(cc, reg)
CONT = {"EU": "EUR", "AF": "AFR", "NA": "NAM", "SA": "SAM", "OC": "OCE", "AS": "EAS"}

countries = {r["code"]: r["name"] for r in csv.DictReader(open(os.path.join(SRC, "ourairports-countries.csv"), encoding="utf-8"))}

# time zones (OpenFlights airports.dat: id,name,city,country,iata,icao,lat,lon,alt,tzoff,dst,tz,...)
tz_of = {}
for row in csv.reader(open(os.path.join(SRC, "airports.dat"), encoding="utf-8")):
    if len(row) > 11 and row[4] not in ("", "\\N") and row[11] not in ("", "\\N"):
        tz_of[row[4]] = row[11]
for a in core:
    tz_of.setdefault(a["iata"], a["tz"])

# Polish city names: several "served city" rows per airport; prefer the one matching the municipality
wd = {}
for r in csv.DictReader(open(os.path.join(SRC, "wikidata-airport-cities.csv"), encoding="utf-8")):
    wd.setdefault(r["iata"], []).append((r.get("cityPl") or "", r.get("cityEn") or ""))
BAD = ("region", "prowincja", "gmina", "hrabstwo", "powiat", "okręg", "dystrykt", "stan ", "metropol", "obszar", "aglomeracja", "county", "municipality")

def polish_city(iata, muni, name=""):
    opts = [(pl, en) for pl, en in wd.get(iata, []) if pl and not any(b in pl.lower() for b in BAD)]
    if not opts:
        return None
    m = fold(muni)
    for pl, en in opts:
        if en and (fold(en) == m or fold(en).startswith(m) or m.startswith(fold(en))):
            return pl
    # a single served place that is not the municipality (e.g. "Mainland" for Kirkwall): keep the municipality,
    # unless the Polish name is just a spelling of it (diacritics, transliteration)
    pl = opts[0][0]
    return pl if len(opts) == 1 and (fold(pl)[:4] == m[:4] or fold(pl) in fold(name)) else None

rows = [r for r in csv.DictReader(open(os.path.join(SRC, "ourairports-airports.csv"), encoding="utf-8"))
        if r["scheduled_service"] == "yes" and r["iata_code"].strip() and r["type"] in ("large_airport", "medium_airport", "small_airport", "seaplane_base")]

def dist(a, b):
    p = math.pi / 180
    h = math.sin((b[0] - a[0]) * p / 2) ** 2 + math.cos(a[0] * p) * math.cos(b[0] * p) * math.sin((b[1] - a[1]) * p / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(h))

out = []
seen = set()
for r in rows:
    iata = r["iata_code"].strip().upper()
    if iata in core_codes or iata in seen or len(iata) != 3:
        continue
    seen.add(iata)
    cc = r["iso_country"]
    muni = (r["municipality"].strip() or r["name"]).split(",")[0].strip()
    city = polish_city(iata, muni, r["name"]) or muni
    region = cc_region.get(cc) or CONT.get(r["continent"], "EUR")
    aliases = sorted({fold(x) for x in (muni, r["name"], city, *[k.strip() for k in r["keywords"].split(",")]) if x and fold(x) != fold(city)})
    out.append({
        "iata": iata, "name": r["name"], "city": city, "cityEn": muni, "country": countries.get(cc, cc), "cc": cc, "region": region,
        "lat": round(float(r["latitude_deg"]), 4), "lon": round(float(r["longitude_deg"]), 4), "tz": tz_of.get(iata),
        "metro": None, "land": "MAIN", "size": {"large_airport": "L", "medium_airport": "M"}.get(r["type"], "S"), "aliases": aliases[:6],
    })

# missing time zones: the nearest airport (same country first) that has one
known = [(a["lat"], a["lon"], a["cc"], a["tz"]) for a in out if a["tz"]] + [(a["lat"], a["lon"], a["cc"], a["tz"]) for a in core]
for a in out:
    if a["tz"]:
        continue
    same = [k for k in known if k[2] == a["cc"]] or known
    a["tz"] = min(same, key=lambda k: dist((a["lat"], a["lon"]), (k[0], k[1])))[3]

out.sort(key=lambda a: a["iata"])
with open(os.path.join(ROOT, "lib/data/airports-extra.json"), "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
print("core", len(core), "extra", len(out), "no-pl-city", sum(1 for a in out if a["city"] == a["cityEn"]))
