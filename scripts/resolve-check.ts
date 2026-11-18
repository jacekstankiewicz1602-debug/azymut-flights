// Prints what place names resolve to: npx tsx scripts/resolve-check.ts [text...]
import { resolvePlace } from "../lib/parse";
const qs = process.argv.slice(2).length ? process.argv.slice(2) : ["Kirkenes", "KKN", "Longyearbyen", "Svalbard", "Tromso", "Tromsø", "Vardø", "Norwegia", "do Norwegii", "Islandia", "Azja Płd.", "Peru", "Indie", "Gruzja", "Mongolia", "Fidżi", "Lima", "Oslo", "Bergen"];
for (const q of qs) { const r = resolvePlace(q); console.log(q.padEnd(14), "=>", r ? `${r.label} [${r.codes.length}] ${r.codes.slice(0, 12).join(" ")}` : "null"); }
