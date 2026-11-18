// Sample booking links of every kind, as JSON lines (for the link check): npx tsx scripts/link-urls.ts
import { flixUrl, googleUrl, ryanairUrl, wizzUrl } from "../lib/booking";
const out = [
  { kind: "ryanair", expect: ["Poznań", "Londyn|London|Stansted"], url: ryanairUrl("POZ", "STN", "2026-12-10", 1) },
  { kind: "wizz", expect: ["Gdańsk|Gdansk", "Tromsø|Tromso"], url: wizzUrl("GDN", "TOS", "2027-03-02", 1) },
  { kind: "google-ow", expect: ["Gdańsk|Gdansk|GDN", "Kirkenes|KKN"], url: googleUrl([{ date: "2027-04-04", from: "GDN", to: "KKN" }], false, 1) },
  { kind: "google-rt", expect: ["Gdańsk|Gdansk|GDN", "Kirkenes|KKN"], url: googleUrl([{ date: "2027-04-04", from: "GDN", to: "KKN" }, { date: "2027-04-19", from: "KKN", to: "GDN" }], true, 2) },
  { kind: "flixbus", expect: ["Poznań|Poznan", "Warszawa|Warsaw"], url: flixUrl("POZ", "WMI", "2027-02-15", 1) },
];
for (const o of out) console.log(JSON.stringify(o));
