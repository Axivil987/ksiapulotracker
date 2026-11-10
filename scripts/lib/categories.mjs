// Wspólna lista kategorii — te same klucze używa frontend (assets/app.js).
export const CATEGORIES = [
  "kebab",
  "pizza",
  "burger",
  "zapiekanka",
  "obiad",
  "azjatyckie",
  "sushi",
  "hotdog",
  "fastfood",
  "slodkie",
  "inne",
];

export const VERDICTS = ["muala", "plus", "srednio", "minus", "nieznany"];

// Proste słowa kluczowe — używane gdy nie ma klucza do Claude API.
const KEYWORDS = [
  ["kebab", /kebab|kebsik|d[öo]ner|falafel|gyros|shawarm|lahmacun|szaszłyk/i],
  ["pizza", /pizz/i],
  ["burger", /burger|smash/i],
  ["zapiekanka", /zapiek/i],
  ["sushi", /sushi|ramen/i],
  ["azjatyckie", /chi[nń]czyk|chi[nń]sk|wietnam|tajsk|thai|pho\b|kurczak słodko|azjat|bao|kore[aj]|indyjsk|curry|wok/i],
  ["hotdog", /hot ?dog/i],
  ["slodkie", /lod(y|ów)|pącz|gofr|deser|cukier|ciast|naleśnik|churros|tort/i],
  ["obiad", /schabow|obiad|pierog|bar mleczny|mielon|rosół|żurek|zupa|kotlet|gołąb|placki|bigos|stołówk|karczm|golonk/i],
  ["fastfood", /frytk|kfc|mcdonald|kurczak|nugget|stacja|orlen|żabk|kanapk|tortill|wrap|kurczaki/i],
];

export function guessCategory(text) {
  for (const [cat, re] of KEYWORDS) if (re.test(text)) return cat;
  return "inne";
}
