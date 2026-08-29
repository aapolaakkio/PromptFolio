/**
 * What a payment was for, decided from the text a bank prints on it.
 *
 * This exists because the assistant is forbidden from doing arithmetic in prose
 * (see chat/runner.ts's system prompt). "How much did I spend on food" cannot be
 * the model adding up K-Market and Lidl in its head -- that is exactly the shape
 * of answer that comes out confidently wrong. So the total has to be computed
 * here, in code, which means the server has to decide what counts as food.
 *
 * The rules are deliberately shallow: a case-insensitive substring match against
 * the note, first rule wins. No fuzzy matching, no learning, nothing that could
 * silently reclassify a year of history between two runs. Anything unmatched
 * lands in `muu` and is always reported rather than hidden, so a total is never
 * quietly missing the half of spending nobody wrote a rule for.
 */
export type Category =
  | "ruoka"
  | "ravintolat"
  | "liikenne"
  | "asuminen"
  | "terveys"
  | "vapaa-aika"
  | "verkkokauppa"
  | "siirrot"
  | "palkka"
  | "korko"
  | "muu";

export const CATEGORY_LABELS = {
  ruoka: "Ruokakauppa",
  ravintolat: "Ravintolat ja kahvilat",
  liikenne: "Liikenne",
  asuminen: "Asuminen",
  terveys: "Terveys",
  "vapaa-aika": "Vapaa-aika",
  verkkokauppa: "Verkkokauppa",
  siirrot: "Tilisiirrot",
  palkka: "Palkka ja etuudet",
  korko: "Korot",
  muu: "Muu",
} satisfies Record<Category, string>;

type Rule = { readonly category: Category; readonly patterns: readonly string[] };

/**
 * Finnish merchants and payment labels, in the form OP prints them (upper case,
 * often with a location or a store number appended -- hence substring matching
 * rather than equality).
 *
 * Order matters where a name could match two rules. `RAVINTOLA` before the
 * grocery chains, since "K-MARKET RAVINTOLA" is a restaurant inside a shop.
 */
const RULES: readonly Rule[] = [
  { category: "korko", patterns: ["TALLETUSKORKO", "KORKO"] },
  { category: "palkka", patterns: ["PALKKA", "ETUUS", "KELA", "ELÄKE", "OP-BONUS"] },
  {
    category: "ravintolat",
    patterns: [
      "RAVINTOLA",
      "PIZZ",
      "BURGER",
      "MCDONALD",
      "HESBURGER",
      "SUBWAY",
      "KAHVILA",
      "CAFE",
      "COFFEE",
      "WOLT",
      "FOODORA",
      "STARBUCKS",
    ],
  },
  {
    category: "ruoka",
    patterns: [
      "K-MARKET",
      "K-SUPERMARKET",
      "K-CITYMARKET",
      "S-MARKET",
      "PRISMA",
      "ALEPA",
      "LIDL",
      "SALE ",
      "HERKKU",
      "RUOHONJUURI",
      "M CHAN",
      "SESTO",
    ],
  },
  {
    category: "liikenne",
    patterns: [
      "HSL",
      "VR ",
      "MATKAHUOLTO",
      "NESTE",
      "ABC",
      "ST1",
      "SHELL",
      "TEBOIL",
      "TAKSI",
      "TAXI",
      "UBER",
      "BOLT",
      "FINNAIR",
      "PARKING",
      "PYSÄKÖINTI",
    ],
  },
  {
    category: "asuminen",
    patterns: [
      "VUOKRA",
      "ISÄNNÖINTI",
      "TALOYHTIÖ",
      "SÄHKÖ",
      "FORTUM",
      "HELEN",
      "VESI",
      "ELISA",
      "TELIA",
      "DNA ",
      "VAKUUTUS",
      "IF VAHINKO",
      "POHJOLA VAKUUTUS",
    ],
  },
  {
    category: "terveys",
    patterns: ["APTEEKKI", "TERVEYS", "HAMMAS", "LÄÄKÄRI", "MEHILÄINEN", "TERVEYSTALO", "PIHLAJA"],
  },
  {
    category: "vapaa-aika",
    patterns: [
      "SPOTIFY",
      "NETFLIX",
      "HBO",
      "DISNEY",
      "STEAM",
      "KIRJAKAUPPA",
      "AKATEEMINEN",
      "ELOKUVA",
      "FINNKINO",
      "KUNTOSALI",
      "GYM",
      "LIIKUNTA",
    ],
  },
  {
    category: "verkkokauppa",
    patterns: ["VERKKOKAUPPA", "AMAZON", "ZALANDO", "POWER", "GIGANTTI", "CDON", "EBAY", "PAYPAL"],
  },
  { category: "siirrot", patterns: ["TILISIIRTO", "PANO", "OTTO", "TALLETUSAUTOM"] },
];

/**
 * The category a note falls into.
 *
 * Matching is on upper-cased text so a bank that changes its capitalisation does
 * not silently reclassify history.
 */
export const categorise = (note: string): Category => {
  const text = note.toUpperCase();
  for (const rule of RULES) {
    if (rule.patterns.some((pattern) => text.includes(pattern))) return rule.category;
  }
  return "muu";
};
