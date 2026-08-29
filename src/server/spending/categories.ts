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
  | "vaatteet"
  | "koti"
  | "lemmikit"
  | "lapset"
  | "matkailu"
  | "koulutus"
  | "lahjat"
  | "tilaukset"
  | "pankki"
  | "vakuutukset"
  | "verot"
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
  vaatteet: "Vaatteet",
  koti: "Koti ja remontti",
  lemmikit: "Lemmikit",
  lapset: "Lapset",
  matkailu: "Matkailu",
  koulutus: "Koulutus",
  lahjat: "Lahjat ja hyväntekeväisyys",
  tilaukset: "Tilaukset ja jäsenmaksut",
  pankki: "Pankkikulut",
  vakuutukset: "Vakuutukset",
  verot: "Verot",
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
const SEED: readonly Rule[] = [
  { category: "korko", patterns: ["TALLETUSKORKO", "KORKO", "INTEREST"] },
  {
    category: "palkka",
    patterns: ["PALKKA", "ETUUS", "KELA", "ELÄKE", "OP-BONUS", "PALKKIO", "TYÖTTÖMYYSKASSA"],
  },
  { category: "verot", patterns: ["VEROHALLINTO", "VEROTILI", "JÄÄNNÖSVERO", "ENNAKKOVERO"] },
  {
    category: "pankki",
    patterns: ["PALVELUMAKSU", "TILINHOITO", "KORTTIMAKSU KK", "LAINANHOITO", "LUOTON MAKSU"],
  },
  {
    category: "vakuutukset",
    patterns: ["VAKUUTUS", "IF VAHINKO", "POHJOLA VAKUUTUS", "LÄHITAPIOLA", "TURVA", "FENNIA"],
  },
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
      "KOTIPIZZA",
      "TACO",
      "SUSHI",
      "KEBAB",
      "BAARI",
      "PUB ",
      "PANIMO",
      "ESPRESSO",
      "ROBERTS",
      "FAZER",
      "SODEXO",
      "AMICA",
      "UNICAFE",
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
      "SIWA",
      "VALINTATALO",
      "MINIMANI",
      "TOKMANNI",
      "LEIPOMO",
      "KAUPPAHALLI",
      "REKO",
      "FOODIE",
      "S-RYHMÄ",
      "K-RAUTA RUOKA",
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
      "EASYPARK",
      "AIMO PARK",
      "KATSASTUS",
      "AUTOKORJAAMO",
      "RENGAS",
      "VIRTA ",
      "K-LATAUS",
      "RECHARGE",
      "NORDIC RIDE",
      "FÖLI",
      "NYSSE",
    ],
  },
  {
    category: "asuminen",
    patterns: [
      "VUOKRA",
      "ISÄNNÖINTI",
      "TALOYHTIÖ",
      "ASUNTO OY",
      "SÄHKÖ",
      "FORTUM",
      "HELEN",
      "VESI",
      "ELISA",
      "TELIA",
      "DNA ",
      "MOI MOBIILI",
      "TELIA FINLAND",
      "KAUKOLÄMPÖ",
      "JÄTEHUOLTO",
      "VASTIKE",
    ],
  },
  {
    category: "koti",
    patterns: [
      "K-RAUTA",
      "RAUTIA",
      "BAUHAUS",
      "STARK",
      "PUUILO",
      "BILTEMA",
      "MOTONET",
      "IKEA",
      "JYSK",
      "ASKO",
      "SOTKA",
      "CLAS OHLSON",
      "REMONTTI",
      "LVI",
      "SÄHKÖASENNUS",
    ],
  },
  {
    category: "terveys",
    patterns: [
      "APTEEKKI",
      "TERVEYS",
      "HAMMAS",
      "LÄÄKÄRI",
      "MEHILÄINEN",
      "TERVEYSTALO",
      "PIHLAJA",
      "AAVA",
      "OPTIKKO",
      "SPECSAVERS",
      "SILMÄASEMA",
      "FYSIOTERAPIA",
      "HYVINVOINTIALUE",
    ],
  },
  {
    category: "vaatteet",
    patterns: [
      "H&M",
      "ZARA",
      "LINDEX",
      "KAPPAHL",
      "SEPPÄLÄ",
      "STOCKMANN",
      "DRESSMANN",
      "JACK & JONES",
      "VERO MODA",
      "INTERSPORT",
      "STADIUM",
      "XXL",
      "SPORTIA",
      "KENKÄ",
      "HALONEN",
    ],
  },
  {
    category: "lemmikit",
    patterns: ["ELÄINLÄÄKÄRI", "MUSTI JA MIRRI", "FAUNATAR", "ELÄINKAUPPA", "ZOOPLUS"],
  },
  {
    category: "lapset",
    patterns: ["PÄIVÄKOTI", "VARHAISKASVATUS", "LASTENTARHA", "KOULURUOKA", "PRISMA LELU", "LELU"],
  },
  {
    category: "matkailu",
    patterns: [
      "HOTEL",
      "HOTELLI",
      "AIRBNB",
      "BOOKING.COM",
      "SCANDIC",
      "SOKOS HOTEL",
      "RADISSON",
      "VIKING LINE",
      "TALLINK",
      "SILJA",
      "NORWEGIAN",
      "RYANAIR",
      "LUFTHANSA",
      "EXPEDIA",
      "MATKATOIMISTO",
    ],
  },
  {
    category: "koulutus",
    patterns: ["YLIOPISTO", "AMMATTIKORKEA", "KURSSI", "OPINTO", "KIRJASTO", "UDEMY", "COURSERA"],
  },
  {
    category: "lahjat",
    patterns: ["LAHJA", "KUKKA", "INTERFLORA", "PUNAINEN RISTI", "UNICEF", "PELASTAKAA LAPSET"],
  },
  {
    category: "tilaukset",
    patterns: [
      "SPOTIFY",
      "NETFLIX",
      "HBO",
      "DISNEY",
      "VIAPLAY",
      "RUUTU",
      "C MORE",
      "YLE",
      "HELSINGIN SANOMAT",
      "HS DIGI",
      "ILTALEHTI",
      "AAMULEHTI",
      "APPLE.COM",
      "GOOGLE",
      "MICROSOFT",
      "ADOBE",
      "JÄSENMAKSU",
      "LIITTO",
    ],
  },
  {
    category: "vapaa-aika",
    patterns: [
      "STEAM",
      "PLAYSTATION",
      "NINTENDO",
      "KIRJAKAUPPA",
      "AKATEEMINEN",
      "SUOMALAINEN KIRJAKAUPPA",
      "ELOKUVA",
      "FINNKINO",
      "KUNTOSALI",
      "GYM",
      "LIIKUNTA",
      "UIMAHALLI",
      "GOLF",
      "TEATTERI",
      "KONSERTTI",
      "TIKETTI",
      "LIPPU.FI",
      "VEIKKAUS",
      "MUSEO",
    ],
  },
  {
    category: "verkkokauppa",
    patterns: [
      "VERKKOKAUPPA",
      "AMAZON",
      "ZALANDO",
      "POWER",
      "GIGANTTI",
      "CDON",
      "EBAY",
      "PAYPAL",
      "ALIEXPRESS",
      "TEMU",
      "WISH",
      "KLARNA",
      "ETSY",
    ],
  },
  { category: "siirrot", patterns: ["TILISIIRTO", "PANO", "OTTO", "TALLETUSAUTOM", "MOBILEPAY"] },
];

/**
 * The built-in rules, flattened to one row per pattern.
 *
 * These seed a user's own table the first time their spending is read; from
 * then on the rules live in the database, where the owner and the assistant can
 * extend them (see spending/rules.ts). Kept in code as the starting point
 * rather than as a migration so a new install begins with something useful.
 */
export const SEED_RULES: readonly { pattern: string; category: Category }[] = SEED.flatMap((rule) =>
  rule.patterns.map((pattern) => ({ pattern, category: rule.category })),
);
