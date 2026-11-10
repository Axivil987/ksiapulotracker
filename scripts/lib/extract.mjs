import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { CATEGORIES, VERDICTS, guessCategory } from "./categories.mjs";

const MODEL = process.env.KSIAPULO_MODEL || "claude-opus-5-5";

const Place = z.object({
  name: z.string().describe("Nazwa lokalu dokładnie tak, jak w rozdziale lub jak ją wymawia autor"),
  city: z.string().nullable().describe("Miasto/miejscowość w mianowniku, np. 'Warszawa'"),
  district: z.string().nullable().describe("Dzielnica lub osiedle, jeśli padło"),
  street: z.string().nullable().describe("Ulica (z numerem jeśli padł), jeśli padła"),
  category: z.enum(CATEGORIES),
  dishes: z.array(z.string()).describe("Co zamówił, krótko"),
  price_pln: z.number().nullable().describe("Łączna lub główna cena w zł, jeśli padła"),
  verdict: z.enum(VERDICTS).describe("muala = przyznał MUALA; plus/srednio/minus = jego ogólna ocena"),
  note: z.string().describe("Jedno zdanie po polsku, własnymi słowami, jak ocenił jedzenie (max 140 znaków)"),
  start_seconds: z.number().int().nullable().describe("Sekunda filmu, od której zaczyna się ten lokal"),
});

const Extraction = z.object({
  is_food_review: z.boolean().describe("false dla vlogów, Q&A, testów produktów sklepowych itp."),
  places: z.array(Place).describe("Tylko stacjonarne lokale/budki, które da się odwiedzić"),
});

const SYSTEM = `Analizujesz odcinki polskiego youtubera Książulo, który recenzuje lokale gastronomiczne.
Z tytułu, opisu (rozdziały to zwykle nazwy lokali) i automatycznej transkrypcji wypisz każdy odwiedzony lokal.
Zasady:
- Miasto ustalaj z transkrypcji ("jesteśmy w...", nazwy ulic, dzielnic). Gdy nie da się ustalić — null, nie zgaduj.
- Transkrypcja jest automatyczna i przekręca nazwy; preferuj zapis z rozdziałów opisu.
- Pomijaj produkty ze sklepów, dostawy bez lokalu, jarmarki bez stałego adresu i lokale tylko wspomniane.
- verdict "muala" tylko gdy wprost przyznaje MUALA / naklejkę.
- Kategorie: ${CATEGORIES.join(", ")}. "obiad" = kuchnia polska/domowa/bar mleczny.`;

const client = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? new Anthropic() : null;

export const hasClaude = () => client !== null;

/** Zwraca { is_food_review, places[] } albo null przy braku klucza API. */
export async function extractWithClaude({ title, description, transcript }) {
  if (!client) return null;
  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: betaZodOutputFormat(Extraction) },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `TYTUŁ: ${title}\n\nOPIS:\n${description}\n\nTRANSKRYPCJA:\n${transcript ?? "(brak)"}`,
      },
    ],
  });
  if (response.stop_reason === "refusal" || !response.parsed_output) {
    throw new Error(`Brak wyniku (${response.stop_reason})`);
  }
  return response.parsed_output;
}

/**
 * Bez Claude: lokale = rozdziały z opisu, kategoria ze słów kluczowych.
 * Miasta nie znamy, więc taki odcinek trafia do kolejki "do zmapowania".
 */
export function extractHeuristic({ title, chapters }) {
  const skip = /intro|wstęp|zakończ|outro|podsumow|bonus|ranking|^start$/i;
  const places = chapters
    .filter((c) => !skip.test(c.title))
    .map((c) => ({
      name: c.title,
      city: null,
      district: null,
      street: null,
      category: guessCategory(`${c.title} ${title}`),
      dishes: [],
      price_pln: null,
      verdict: /muala/i.test(c.title) ? "muala" : "nieznany",
      note: "",
      start_seconds: c.start,
    }));
  return { is_food_review: true, places };
}
