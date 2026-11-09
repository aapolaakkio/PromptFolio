// Category from the text a bank prints. Shallow on purpose: case-insensitive substring, first rule wins, no learning, so history never reclassifies between runs. Unmatched is reported, not hidden.
export type Category =
  | "groceries"
  | "restaurants"
  | "transport"
  | "housing"
  | "health"
  | "leisure"
  | "online-shopping"
  | "clothing"
  | "home"
  | "pets"
  | "children"
  | "travel"
  | "education"
  | "gifts"
  | "subscriptions"
  | "bank-fees"
  | "loans"
  | "insurance"
  | "taxes"
  | "transfers"
  | "salary"
  | "interest"
  | "other";

export const CATEGORY_LABELS = {
  groceries: "Groceries",
  restaurants: "Restaurants and cafes",
  transport: "Transport",
  housing: "Housing",
  health: "Health",
  leisure: "Leisure",
  "online-shopping": "Online shopping",
  clothing: "Clothing",
  home: "Home and renovation",
  pets: "Pets",
  children: "Children",
  travel: "Travel",
  education: "Education",
  gifts: "Gifts and charity",
  subscriptions: "Subscriptions and memberships",
  "bank-fees": "Bank fees",
  loans: "Loans and credit",
  insurance: "Insurance",
  taxes: "Taxes",
  transfers: "Account transfers",
  salary: "Salary and benefits",
  interest: "Interest",
  other: "Other",
} satisfies Record<Category, string>;

type Rule = { readonly category: Category; readonly patterns: readonly string[] };

// Finnish merchants as OP prints them (upper case, location appended, hence substring). Order matters: a restaurant inside a shop is a restaurant.
const SEED: readonly Rule[] = [
  { category: "interest", patterns: ["TALLETUSKORKO", "KORKO", "INTEREST"] },
  {
    category: "salary",
    // "OPINTOTUKI" must beat "OPINTO" (education): it is money in, not a course paid for.
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
  { category: "taxes", patterns: ["VEROHALLINTO", "VEROTILI", "JÄÄNNÖSVERO", "ENNAKKOVERO"] },
  {
    // A repayment is mostly the owner's own money reducing a debt; only the interest is a cost, so not with service fees.
    category: "loans",
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
    category: "bank-fees",
    patterns: ["PALVELUMAKSU", "TILINHOITO", "KORTTIMAKSU KK"],
  },
  {
    category: "insurance",
    patterns: ["VAKUUTUS", "IF VAHINKO", "POHJOLA VAKUUTUS", "LÄHITAPIOLA", "TURVA", "FENNIA"],
  },
  {
    category: "restaurants",
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
    category: "groceries",
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
    category: "transport",
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
    category: "housing",
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
    category: "home",
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
    category: "health",
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
    category: "clothing",
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
    category: "pets",
    patterns: ["ELÄINLÄÄKÄRI", "MUSTI JA MIRRI", "FAUNATAR", "ELÄINKAUPPA", "ZOOPLUS"],
  },
  {
    category: "children",
    patterns: ["PÄIVÄKOTI", "VARHAISKASVATUS", "LASTENTARHA", "KOULURUOKA", "PRISMA LELU", "LELU"],
  },
  {
    category: "travel",
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
    category: "education",
    patterns: ["YLIOPISTO", "AMMATTIKORKEA", "KURSSI", "OPINTO", "KIRJASTO", "UDEMY", "COURSERA"],
  },
  {
    category: "gifts",
    patterns: ["LAHJA", "KUKKA", "INTERFLORA", "PUNAINEN RISTI", "UNICEF", "PELASTAKAA LAPSET"],
  },
  {
    category: "subscriptions",
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
    category: "leisure",
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
    category: "online-shopping",
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
  { category: "transfers", patterns: ["TILISIIRTO", "PANO", "OTTO", "TALLETUSAUTOM", "MOBILEPAY"] },
];

// Seeded into a user's own table once, then live in the database. In code, not a migration, so a new install starts useful.
export const SEED_RULES: readonly { pattern: string; category: Category }[] = SEED.flatMap((rule) =>
  rule.patterns.map((pattern) => ({ pattern, category: rule.category })),
);

/** The fallback shows the raw key for a rule stored before a category was renamed. */
export const labelForCategory = (category: string): string =>
  // SAFETY: `categoriseWith` only returns a `Category`, and `CATEGORY_LABELS` covers them all.
  CATEGORY_LABELS[category as keyof typeof CATEGORY_LABELS] ?? category;
