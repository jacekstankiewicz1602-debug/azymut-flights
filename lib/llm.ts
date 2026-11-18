// Claude is used only to turn a Polish query into parameters and to write a short summary.
// It never searches for routes.
import Anthropic from "@anthropic-ai/sdk";
import { AP } from "./airports";
import { config } from "./config";
import type { SearchParams } from "./types";

let client: Anthropic | null = null;
const llm = () => (client ??= new Anthropic({ apiKey: config.keys.anthropic }));

const usd = (u: { input_tokens: number; output_tokens: number }) =>
  (u.input_tokens * config.cost.anthropicInPerM + u.output_tokens * config.cost.anthropicOutPerM) / 1e6;

export type LlmQuery = {
  origin: string; destination: string; date_from: string | null; date_to: string | null;
  one_way: boolean | null; stay_min_days: number | null; stay_max_days: number | null;
  max_connections: number | null; baggage: "cabin" | "checked" | null; allow_overnight: boolean | null;
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["origin", "destination", "date_from", "date_to", "one_way", "stay_min_days", "stay_max_days", "max_connections", "baggage", "allow_overnight"],
  properties: {
    origin: { type: "string", description: "Origin city, country or IATA code, Polish nominative (e.g. 'Poznań')" },
    destination: { type: "string", description: "Destination city / country / region in Polish nominative, or region key SEA, SAM, CAR, SAS, EAS, MEA, AFR, OCE, NAM, EUR when the user means 'anywhere in' a region" },
    date_from: { type: ["string", "null"], description: "Earliest outbound date YYYY-MM-DD" },
    date_to: { type: ["string", "null"], description: "Latest outbound date YYYY-MM-DD" },
    one_way: { type: ["boolean", "null"] },
    stay_min_days: { type: ["integer", "null"] },
    stay_max_days: { type: ["integer", "null"] },
    max_connections: { type: ["integer", "null"], description: "Max connections per direction" },
    baggage: { type: ["string", "null"], enum: ["cabin", "checked", null] },
    allow_overnight: { type: ["boolean", "null"] },
  },
};

export async function llmParse(q: string, today: string): Promise<{ data: LlmQuery; usd: number } | null> {
  if (!config.keys.anthropic) return null;
  const res = await llm().messages.create({
    model: config.llmModel,
    max_tokens: 2000,
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    system: `Extract flight search parameters from a Polish query. Today is ${today}. A month without a year means its next occurrence. "2–3 tygodnie" means a stay of 14–21 days. Use null for anything not stated.`,
    messages: [{ role: "user", content: q }],
  } as unknown as Anthropic.MessageCreateParamsNonStreaming);
  if (res.stop_reason === "refusal") return null;
  const text = res.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
  if (!text) return null;
  return { data: JSON.parse(text) as LlmQuery, usd: usd(res.usage) };
}

type TripLite = { price: number; nodes: string[]; flags: string[]; outDate: string; retDate: string | null; estimated: boolean };

export async function summarize(
  p: SearchParams, trips: TripLite[], baseline: { price: number } | null, proven: boolean,
): Promise<{ text: string; usd: number }> {
  const fallback = () => {
    if (!trips.length) return "Nie znaleziono trasy spełniającej warunki w tym oknie dat.";
    const t = trips[0];
    const route = t.nodes.map((c) => AP[c]?.city ?? c).filter((c, i, a) => c !== a[i - 1]).join(" – ");
    const save = baseline ? ` To ${Math.round(baseline.price - t.price)} zł mniej niż najtańsza zwykła oferta Google (${Math.round(baseline.price)} zł).` : "";
    const est = t.estimated ? " Część odcinków ma cenę szacunkową, bo brakuje klucza do weryfikacji na żywo." : "";
    return `Najtańsza trasa: ${route}, ${t.price} zł, wylot ${t.outDate}${t.retDate ? `, powrót ${t.retDate}` : ""}.${save}${proven ? " Wynik optymalny względem dostępnych danych." : ""}${est}`;
  };
  if (!config.keys.anthropic || !trips.length) return { text: fallback(), usd: 0 };
  const res = await llm().messages.create({
    model: config.llmModel,
    max_tokens: 1500,
    output_config: { effort: "low" },
    system: "Piszesz po polsku, rzeczowo, 2–3 zdania, bez emoji i bez wykrzykników. Opisz najtańszą trasę, oszczędność i najważniejsze ryzyko. Nie wymyślaj danych spoza JSON.",
    messages: [{ role: "user", content: JSON.stringify({ query: p.query, top: trips, baseline, optimal: proven }) }],
  } as unknown as Anthropic.MessageCreateParamsNonStreaming);
  const text = res.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text?.trim();
  return { text: text || fallback(), usd: usd(res.usage) };
}
