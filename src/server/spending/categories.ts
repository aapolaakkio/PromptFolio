/**
 * What a payment was for, from the text a bank prints on it.
 *
 * The assistant may not do arithmetic in prose, so "how much did I spend on food"
 * has to be computed in code -- which means the server decides what counts as food.
 *
 * Shallow on purpose: a case-insensitive substring match, first rule wins. No
 * learning, nothing that could reclassify a year of history between two runs.
 * Anything unmatched is reported rather than hidden.
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
  | "lainat"
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
  lainat: "Lainat ja luotot",
  vakuutukset: "Vakuutukset",
  verot: "Verot",
  siirrot: "Tilisiirrot",
  palkka: "Palkka ja etuudet",
  korko: "Korot",
  muu: "Muu",
} satisfies Record<Category, string>;

type Rule = { readonly category: Category; readonly patterns: readonly string[] };

/**
 * Finnish merchants as OP prints them -- upper case, often with a location
 * appended, hence substring matching. Order matters where a name could match
 * twice: a restaurant inside a shop is a restaurant.
 */
const SEED: readonly Rule[] = [
  { category: "korko", patterns: ["TALLETUSKORKO", "KORKO", "INTEREST"] },
  {
    category: "palkka",
    // "OPINTOTUKI" is longer than the "OPINTO" that would otherwise claim it
    // for education, and it is money in rather than a course paid for.
    patterns: [
      "PALKKA",
      "ETUUS",
      "KELA",
      "ELÄKE",
      "OP-BONUS",
      "PALKKIO",
      "TYÖTTÖMYYSKASSA",
      "OPINTOTUKI",
      "ASUMISTUKI",
    ],
  },
  { category: "verot", patterns: ["VEROHALLINTO", "VEROTILI", "JÄÄNNÖSVERO", "ENNAKKOVERO"] },
  {
    // A repayment is not a bank charge: most of it is the owner's own money
    // reducing a debt, and only its interest is a cost. Its own line rather
    // than mixed in with service fees.
    category: "lainat",
    patterns: [
      "LAINANHOITO",
      "LUOTON MAKSU",
      "LUOTON",
      "LUOTTO",
      "LAINA",
      "OPINTOLAINA",
      "LYHENNYS",
      "OSAMAKSU",
      "RAHOITUS",
      "PERINTÄ",
    ],
  },
  {
    category: "pankki",
    patterns: ["PALVELUMAKSU", "TILINHOITO", "KORTTIMAKSU KK"],
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
 * The built-in rules, one row per pattern. They seed a user's own table once and
 * then live in the database. Kept in code rather than a migration so a new
 * install begins with something useful.
 */
export const SEED_RULES: readonly { pattern: string; category: Category }[] = SEED.flatMap((rule) =>
  rule.patterns.map((pattern) => ({ pattern, category: rule.category })),
);

/**
 * The Finnish name for a category key. The fallback covers a rule stored before a
 * category was renamed, showing the raw key rather than nothing.
 */
export const labelForCategory = (category: string): string =>
  // SAFETY: `categoriseWith` only ever returns a `Category`, which is exactly
  // the set of keys `CATEGORY_LABELS` is declared over.
  CATEGORY_LABELS[category as keyof typeof CATEGORY_LABELS] ?? category;
