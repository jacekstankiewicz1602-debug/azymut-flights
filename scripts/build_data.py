"""Builds static reference data: curated airport list, land dot grid, fallback route topology.

Usage: python3 -I scripts/build_data.py data-src
"""
import csv
import json
import math
import os
import struct
import sys

SRC = sys.argv[1]
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ~300 largest airports, hubs and low-cost bases. Second field: Polish city name.
AIRPORTS = """
POZ Poznań|WAW Warszawa|WMI Warszawa-Modlin|KRK Kraków|GDN Gdańsk|WRO Wrocław|KTW Katowice|LUZ Lublin|RZE Rzeszów|SZZ Szczecin|BZG Bydgoszcz|LCJ Łódź|IEG Zielona Góra|SZY Olsztyn|RDO Radom
BER Berlin|FRA Frankfurt|MUC Monachium|HAM Hamburg|DUS Düsseldorf|CGN Kolonia|STR Stuttgart|HHN Frankfurt-Hahn|NRN Weeze|DTM Dortmund|LEJ Lipsk|DRS Drezno|BLL Billund|KEF Reykjavik|HAJ Hanower|BRE Brema|NUE Norymberga|FMM Memmingen
LHR Londyn|LGW Londyn|STN Londyn|LTN Londyn|SEN Londyn|LCY Londyn|MAN Manchester|BHX Birmingham|EDI Edynburg|GLA Glasgow|BRS Bristol|LPL Liverpool|NCL Newcastle|DUB Dublin|SNN Shannon|ORK Cork|BFS Belfast
CDG Paryż|ORY Paryż|BVA Paryż-Beauvais|NCE Nicea|MRS Marsylia|LYS Lyon|TLS Tuluza|BOD Bordeaux|NTE Nantes
AMS Amsterdam|EIN Eindhoven|BRU Bruksela|CRL Bruksela-Charleroi|LUX Luksemburg
MAD Madryt|BCN Barcelona|AGP Malaga|ALC Alicante|PMI Palma de Mallorca|VLC Walencja|SVQ Sewilla|IBZ Ibiza|TFS Teneryfa|LPA Gran Canaria|ACE Lanzarote|FUE Fuerteventura|GRO Girona|REU Reus|BIO Bilbao
LIS Lizbona|OPO Porto|FAO Faro
FCO Rzym|CIA Rzym|MXP Mediolan|LIN Mediolan|BGY Mediolan-Bergamo|VCE Wenecja|TSF Wenecja-Treviso|BLQ Bolonia|NAP Neapol|CTA Katania|PMO Palermo|BRI Bari|PSA Piza|CAG Cagliari
ZRH Zurych|GVA Genewa|BSL Bazylea|VIE Wiedeń
CPH Kopenhaga|ARN Sztokholm|NYO Sztokholm-Skavsta|GOT Göteborg|OSL Oslo|TRF Oslo-Torp|BGO Bergen|HEL Helsinki|RIX Ryga|VNO Wilno|KUN Kowno|TLL Tallin
PRG Praga|BUD Budapeszt|BTS Bratysława
OTP Bukareszt|CLJ Kluż-Napoka|SOF Sofia|VAR Warna|BEG Belgrad|ZAG Zagrzeb|SPU Split|DBV Dubrownik|TIA Tirana|SKP Skopje|PRN Prisztina|TGD Podgorica
ATH Ateny|SKG Saloniki|HER Heraklion|RHO Rodos|CFU Korfu|LCA Larnaka|PFO Pafos|MLA Malta
IST Stambuł|SAW Stambuł-Sabiha|AYT Antalya|ESB Ankara|ADB Izmir
TBS Tbilisi|KUT Kutaisi|GYD Baku|EVN Erywań|KIV Kiszyniów
DXB Dubaj|DWC Dubaj-Al Maktoum|AUH Abu Zabi|SHJ Szardża|DOH Doha|BAH Bahrajn|KWI Kuwejt|MCT Maskat|RUH Rijad|JED Dżudda|AMM Amman|TLV Tel Awiw|BEY Bejrut
CAI Kair|HRG Hurghada|SSH Szarm el-Szejk|RAK Marrakesz|CMN Casablanca|AGA Agadir|TUN Tunis|ALG Algier
ADD Addis Abeba|NBO Nairobi|JNB Johannesburg|CPT Kapsztad|DAR Dar es Salaam|ZNZ Zanzibar|LOS Lagos|ACC Akra|DSS Dakar|MRU Mauritius|SEZ Seszele|JRO Kilimandżaro
DEL Delhi|BOM Bombaj|BLR Bengaluru|MAA Ćennaj|CCU Kalkuta|CMB Kolombo|MLE Male|KTM Katmandu|DAC Dhaka|GOX Goa|COK Koczin
BKK Bangkok|DMK Bangkok-Don Mueang|HKT Phuket|CNX Chiang Mai|KUL Kuala Lumpur|SIN Singapur|CGK Dżakarta|DPS Bali|SGN Ho Chi Minh|HAN Hanoi|DAD Da Nang|MNL Manila|CEB Cebu|PNH Phnom Penh|KTI Phnom Penh|REP Siem Reap|SAI Siem Reap|RGN Rangun|BKI Kota Kinabalu|LGK Langkawi|USM Koh Samui|KBV Krabi|VTE Wientian|PEN Penang
HKG Hongkong|MFM Makau|TPE Tajpej|PEK Pekin|PKX Pekin-Daxing|PVG Szanghaj|SHA Szanghaj-Hongqiao|CAN Kanton|SZX Shenzhen|CTU Chengdu|ICN Seul|GMP Seul-Gimpo|NRT Tokio|HND Tokio|KIX Osaka|FUK Fukuoka
ALA Ałmaty|TAS Taszkent|NQZ Astana
SYD Sydney|MEL Melbourne|BNE Brisbane|PER Perth|AKL Auckland
JFK Nowy Jork|EWR Nowy Jork-Newark|LGA Nowy Jork|BOS Boston|IAD Waszyngton|DCA Waszyngton|ORD Chicago|ATL Atlanta|MIA Miami|FLL Fort Lauderdale|MCO Orlando|LAX Los Angeles|SFO San Francisco|SEA Seattle|LAS Las Vegas|DFW Dallas|IAH Houston|DEN Denver|PHL Filadelfia|YYZ Toronto|YUL Montreal|YVR Vancouver|MEX Meksyk|CUN Cancún
PUJ Punta Cana|SDQ Santo Domingo|HAV Hawana|MBJ Montego Bay|PTY Panama|SJO San José|SJU San Juan|AUA Aruba
BOG Bogota|MDE Medellín|CTG Cartagena|LIM Lima|CUZ Cusco|AQP Arequipa|UIO Quito|GYE Guayaquil|SCL Santiago|EZE Buenos Aires|AEP Buenos Aires|GRU São Paulo|CGH São Paulo|VCP Campinas|GIG Rio de Janeiro|SSA Salvador|REC Recife|FOR Fortaleza|MVD Montevideo|ASU Asunción|VVI Santa Cruz|LPB La Paz|CCS Caracas
PIU Piura|TRU Trujillo|CIX Chiclayo|IQT Iquitos|JUL Juliaca|PCL Pucallpa|TPP Tarapoto|AYP Ayacucho|PEM Puerto Maldonado|TCQ Tacna|TBP Tumbes|CJA Cajamarca
CLO Cali|BAQ Barranquilla|SMR Santa Marta|PEI Pereira|BGA Bucaramanga|ADZ San Andrés|CUC Cúcuta|CUE Cuenca|GPS Galápagos
ANF Antofagasta|CJC Calama|PMC Puerto Montt|PUQ Punta Arenas|IQQ Iquique|ARI Arica|CCP Concepción|LSC La Serena|CBB Cochabamba
BSB Brasília|FLN Florianópolis|POA Porto Alegre|CWB Kurytyba|CNF Belo Horizonte|MAO Manaus|BEL Belém|NAT Natal|MCZ Maceió|FEN Fernando de Noronha
COR Córdoba|MDZ Mendoza|BRC Bariloche|IGR Iguazú|SLA Salta|USH Ushuaia|NQN Neuquén
GDL Guadalajara|MTY Monterrey|TIJ Tijuana|SJD Los Cabos|PVR Puerto Vallarta|MID Mérida|OAX Oaxaca|BJX León
SAL San Salvador|GUA Gwatemala|SAP San Pedro Sula|MGA Managua|LIR Liberia|BZE Belize|NAS Nassau|BGI Barbados|POS Port of Spain|CUR Curaçao|SXM Sint Maarten|KIN Kingston|STI Santiago (DO)|LRM La Romana
MCO Orlando|BWI Baltimore|YYZ Toronto
SUB Surabaja|LOP Lombok|PQC Phu Quoc|CXR Nha Trang|CRK Clark|JHB Johor Bahru|DPS Bali
"""

# Airports sharing a city: ground transfer between them is cheap and short.
METROS = {
    "LON": "LHR LGW STN LTN SEN LCY", "PAR": "CDG ORY BVA", "MIL": "MXP LIN BGY", "ROM": "FCO CIA",
    "WAW": "WAW WMI", "STO": "ARN NYO", "OSL": "OSL TRF", "VCE": "VCE TSF", "BRU": "BRU CRL",
    "FRA": "FRA HHN", "BCN": "BCN GRO REU", "IST": "IST SAW", "DXB": "DXB DWC SHJ", "NYC": "JFK EWR LGA",
    "WAS": "IAD DCA", "MIA": "MIA FLL", "BUE": "EZE AEP", "SAO": "GRU CGH VCP", "TYO": "NRT HND",
    "SEL": "ICN GMP", "BKK": "BKK DMK", "BJS": "PEK PKX", "SHA": "PVG SHA", "HKG": "HKG MFM SZX",
    "PNH": "PNH KTI", "REP": "REP SAI", "DUS": "DUS NRN DTM CGN",
}

# Islands / separate landmasses: no regional ground transfer to the mainland.
LANDMASS = {
    "GB": "LHR LGW STN LTN SEN LCY MAN BHX EDI GLA BRS LPL NCL",
    "IE": "DUB SNN ORK BFS",
    "ISLAND": "PMI IBZ TFS LPA ACE FUE CTA PMO CAG HER RHO CFU LCA PFO MLA",
}

REGION_BY_COUNTRY = {}
def _reg(region, names):
    for n in names.split("|"):
        REGION_BY_COUNTRY[n] = region
_reg("EUR", "Poland|Germany|United Kingdom|Ireland|France|Netherlands|Belgium|Luxembourg|Spain|Portugal|Italy|Switzerland|Austria|Denmark|Sweden|Norway|Finland|Latvia|Lithuania|Estonia|Czech Republic|Hungary|Slovakia|Romania|Bulgaria|Serbia|Croatia|Albania|Macedonia|North Macedonia|Kosovo|Montenegro|Greece|Cyprus|Malta|Turkey|Moldova")
_reg("CAU", "Georgia|Azerbaijan|Armenia")
_reg("MEA", "United Arab Emirates|Qatar|Bahrain|Kuwait|Oman|Saudi Arabia|Jordan|Israel|Lebanon")
_reg("NAF", "Egypt|Morocco|Tunisia|Algeria")
_reg("AFR", "Ethiopia|Kenya|South Africa|Tanzania|Nigeria|Ghana|Senegal|Mauritius|Seychelles")
_reg("SAS", "India|Sri Lanka|Maldives|Nepal|Bangladesh")
_reg("SEA", "Thailand|Malaysia|Singapore|Indonesia|Vietnam|Philippines|Cambodia|Burma|Myanmar|Laos")
_reg("EAS", "Hong Kong|Macau|Taiwan|China|South Korea|Japan")
_reg("CAS", "Kazakhstan|Uzbekistan")
_reg("OCE", "Australia|New Zealand")
_reg("NAM", "United States|Canada|Mexico")
_reg("CAR", "Dominican Republic|Cuba|Jamaica|Panama|Costa Rica|Puerto Rico|Aruba|El Salvador|Guatemala|Honduras|Nicaragua|Belize|Bahamas|Barbados|Trinidad and Tobago|Curacao|Netherlands Antilles|Sint Maarten")
_reg("SAM", "Colombia|Peru|Ecuador|Chile|Argentina|Brazil|Uruguay|Paraguay|Bolivia|Venezuela")

COUNTRY_CODE = {
    "Poland": "PL", "Germany": "DE", "United Kingdom": "GB", "Ireland": "IE", "France": "FR", "Netherlands": "NL",
    "Belgium": "BE", "Luxembourg": "LU", "Spain": "ES", "Portugal": "PT", "Italy": "IT", "Switzerland": "CH",
    "Austria": "AT", "Denmark": "DK", "Sweden": "SE", "Norway": "NO", "Finland": "FI", "Latvia": "LV",
    "Lithuania": "LT", "Estonia": "EE", "Czech Republic": "CZ", "Hungary": "HU", "Slovakia": "SK", "Romania": "RO",
    "Bulgaria": "BG", "Serbia": "RS", "Croatia": "HR", "Albania": "AL", "Macedonia": "MK", "North Macedonia": "MK",
    "Kosovo": "XK", "Montenegro": "ME", "Greece": "GR", "Cyprus": "CY", "Malta": "MT", "Turkey": "TR",
    "Moldova": "MD", "Georgia": "GE", "Azerbaijan": "AZ", "Armenia": "AM", "United Arab Emirates": "AE",
    "Qatar": "QA", "Bahrain": "BH", "Kuwait": "KW", "Oman": "OM", "Saudi Arabia": "SA", "Jordan": "JO",
    "Israel": "IL", "Lebanon": "LB", "Egypt": "EG", "Morocco": "MA", "Tunisia": "TN", "Algeria": "DZ",
    "Ethiopia": "ET", "Kenya": "KE", "South Africa": "ZA", "Tanzania": "TZ", "Nigeria": "NG", "Ghana": "GH",
    "Senegal": "SN", "Mauritius": "MU", "Seychelles": "SC", "India": "IN", "Sri Lanka": "LK", "Maldives": "MV",
    "Nepal": "NP", "Bangladesh": "BD", "Thailand": "TH", "Malaysia": "MY", "Singapore": "SG", "Indonesia": "ID",
    "Vietnam": "VN", "Philippines": "PH", "Cambodia": "KH", "Burma": "MM", "Myanmar": "MM", "Laos": "LA",
    "Hong Kong": "HK", "Macau": "MO", "Taiwan": "TW", "China": "CN", "South Korea": "KR", "Japan": "JP",
    "Kazakhstan": "KZ", "Uzbekistan": "UZ", "Australia": "AU", "New Zealand": "NZ", "United States": "US",
    "Canada": "CA", "Mexico": "MX", "Dominican Republic": "DO", "Cuba": "CU", "Jamaica": "JM", "Panama": "PA",
    "Costa Rica": "CR", "Puerto Rico": "PR", "Aruba": "AW", "Colombia": "CO", "Peru": "PE", "Ecuador": "EC",
    "Chile": "CL", "Argentina": "AR", "Brazil": "BR", "Uruguay": "UY", "Paraguay": "PY", "Bolivia": "BO",
    "Venezuela": "VE", "El Salvador": "SV", "Guatemala": "GT", "Honduras": "HN", "Nicaragua": "NI", "Belize": "BZ",
    "Bahamas": "BS", "Barbados": "BB", "Trinidad and Tobago": "TT", "Curacao": "CW", "Netherlands Antilles": "CW", "Sint Maarten": "SX",
}

# Fixes for airports missing or outdated in OpenFlights.
OVERRIDES = {
    "BER": ("Berlin Brandenburg Airport", "Berlin", "Germany", 52.3667, 13.5033, "Europe/Berlin"),
    "PKX": ("Beijing Daxing International Airport", "Beijing", "China", 39.5098, 116.4105, "Asia/Shanghai"),
    "KTI": ("Techo International Airport", "Phnom Penh", "Cambodia", 11.3500, 104.9200, "Asia/Phnom_Penh"),
    "SAI": ("Siem Reap-Angkor International Airport", "Siem Reap", "Cambodia", 13.3700, 104.2200, "Asia/Phnom_Penh"),
    "NQZ": ("Astana International Airport", "Astana", "Kazakhstan", 51.0222, 71.4669, "Asia/Almaty"),
    "GOX": ("Manohar International Airport", "Goa", "India", 15.7300, 73.8600, "Asia/Kolkata"),
    "DSS": ("Blaise Diagne International Airport", "Dakar", "Senegal", 14.6700, -17.0733, "Africa/Dakar"),
    "PRN": ("Pristina International Airport", "Pristina", "Kosovo", 42.5728, 21.0358, "Europe/Belgrade"),
}


def load_airports():
    rows = {}
    with open(os.path.join(SRC, "airports.dat"), encoding="utf-8") as f:
        for r in csv.reader(f):
            if len(r) < 12 or r[4] in ("\\N", ""):
                continue
            rows[r[4]] = (r[1], r[2], r[3], float(r[6]), float(r[7]), r[11])
    rows.update(OVERRIDES)
    metro_of = {c: m for m, codes in METROS.items() for c in codes.split()}
    land_of = {c: g for g, codes in LANDMASS.items() for c in codes.split()}
    out = []
    seen = set()
    for line in AIRPORTS.strip().splitlines():
        for item in line.split("|"):
            iata, city_pl = item.split(" ", 1)
            if iata in seen:
                continue
            seen.add(iata)
            if iata not in rows:
                print(f"skip missing airport {iata}")
                continue
            name, city, country, lat, lon, tz = rows[iata]
            # the OpenFlights row has no time zone ("\\N") for a few big airports
            tz = {"IST": "Europe/Istanbul", "DOH": "Asia/Qatar"}.get(iata, tz) if "/" not in tz else tz
            if country == "Burma":
                country = "Myanmar"
            out.append({
                "iata": iata, "name": name, "city": city_pl, "cityEn": city, "country": country,
                "cc": COUNTRY_CODE[country], "region": REGION_BY_COUNTRY[country],
                "lat": round(lat, 4), "lon": round(lon, 4), "tz": tz,
                "metro": metro_of.get(iata), "land": land_of.get(iata, "MAIN"),
            })
    return out


def land_grid():
    """Equal-area grid of points over land, rasterised with a scanline fill."""
    topo = json.load(open(os.path.join(SRC, "land-50m.json")))
    sx, sy = topo["transform"]["scale"]
    tx, ty = topo["transform"]["translate"]
    arcs = []
    for arc in topo["arcs"]:
        x = y = 0
        pts = []
        for dx, dy in arc:
            x += dx
            y += dy
            pts.append((x * sx + tx, y * sy + ty))
        arcs.append(pts)

    def ring(idx):
        pts = []
        for i in idx:
            a = arcs[i] if i >= 0 else arcs[~i][::-1]
            pts.extend(a if not pts else a[1:])
        return pts

    rings = []
    for g in topo["objects"]["land"]["geometries"]:
        polys = g["arcs"] if g["type"] == "MultiPolygon" else [g["arcs"]]
        for poly in polys:
            for r in poly:
                rings.append(ring(r))

    step = 0.75
    rows = {}
    nrows = int(180 / step)
    for r in rings:
        for (x1, y1), (x2, y2) in zip(r, r[1:] + r[:1]):
            if y1 == y2:
                continue
            lo, hi = min(y1, y2), max(y1, y2)
            for k in range(math.ceil((lo + 90) / step - 0.5), math.floor((hi + 90) / step - 0.5) + 1):
                lat = -90 + (k + 0.5) * step
                if lo <= lat < hi:
                    rows.setdefault(k, []).append(x1 + (lat - y1) * (x2 - x1) / (y2 - y1))
    pts = []
    for k in range(nrows):
        lat = -90 + (k + 0.5) * step
        if lat < -60:
            continue
        xs = sorted(rows.get(k, []))
        n = max(1, int(round(360 * math.cos(math.radians(lat)) / step)))
        dlon = 360 / n
        off = (k % 2) * dlon / 2
        for a, b in zip(xs[0::2], xs[1::2]):
            j0 = math.ceil((a + 180 - off) / dlon)
            j1 = math.floor((b + 180 - off) / dlon)
            for j in range(j0, j1 + 1):
                pts.append((lat, -180 + off + j * dlon))
    return pts


def routes(codes):
    pairs = set()
    with open(os.path.join(SRC, "routes.dat"), encoding="utf-8") as f:
        for r in csv.reader(f):
            if len(r) > 4 and r[2] in codes and r[4] in codes and r[2] != r[4]:
                pairs.add((r[2], r[4]))
    return sorted(pairs)


def main():
    airports = load_airports()
    codes = {a["iata"] for a in airports}
    with open(os.path.join(ROOT, "lib/data/airports.json"), "w") as f:
        json.dump(airports, f, ensure_ascii=False, separators=(",", ":"))
    pairs = routes(codes)
    with open(os.path.join(ROOT, "lib/data/known-routes.json"), "w") as f:
        json.dump(["%s%s" % p for p in pairs], f, separators=(",", ":"))
    pts = land_grid()
    with open(os.path.join(ROOT, "public/land.bin"), "wb") as f:
        for lat, lon in pts:
            f.write(struct.pack("<hh", int(round(lat * 100)), int(round(lon * 100))))
    print(f"airports={len(airports)} routes={len(pairs)} land_points={len(pts)}")


main()
