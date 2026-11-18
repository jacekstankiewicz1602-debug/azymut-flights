// Prints autocomplete suggestions for a few queries: npx tsx scripts/suggest-check.ts [query...]
import { suggest } from "../lib/suggest";
const qs = process.argv.slice(2).length ? process.argv.slice(2) : ["Kirkenes", "KKN", "Vardø", "vardo", "Tromsø", "Tromso", "Longyearbyen", "LYR", "Svalbard", "Oslo", "Norwegia", "do Norwegii"];
for (const q of qs) console.log(q.padEnd(14), "=>", suggest(q, 4).map((s) => `${s.kind}:${s.label} | ${s.sub}`).join("  ;  "));
