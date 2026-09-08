import type { ChatClient } from "../../chat/runner.ts";
import { PDF_READ_MODEL, type PdfPage } from "../pdf-read.ts";
import { OP_STATEMENT_RECIPE } from "./op-reference.ts";
import { runRecipe, type RecipeRun } from "./run.ts";
import { parseRecipe, type BankRecipe } from "./types.ts";
import { verifyRun } from "./verify.ts";

/** A recipe is about a kilobyte; this is room for one with comments stripped. */
const MAX_TOKENS = 4096;
/** How much of the last page the closing balance could be hiding in. */
const TAIL_LINES = 15;

const NO_ANSWER = "Malli ei kuvannut tiedostomuotoa";

export const sampleFor = (pages: readonly PdfPage[]): string => {
  const first = pages[0];
  const last = pages.length > 1 ? pages.at(-1) : undefined;
  const tail = last?.text.split("\n").slice(0, TAIL_LINES).join("\n");
  return [
    `--- sivu ${first?.number ?? 1} ---\n${first?.text ?? ""}`,
    tail === undefined ? "" : `--- viimeinen sivu (alku) ---\n${tail}`,
  ]
    .filter((part) => part !== "")
    .join("\n\n");
};

/**
 * The JSON object out of a reply that may be fenced and may be preceded by
 * pages of reasoning with braces of its own. A fenced block wins; otherwise the
 * last balanced object does, since a model that reconsiders writes its answer
 * last. Strings are tracked so a brace inside a payee's name cannot close the
 * object early.
 */
const jsonObject = (reply: string): string | null => {
  const fenced = [...reply.matchAll(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/g)].at(-1);
  if (fenced?.[1] !== undefined) return fenced[1];
  let depth = 0;
  let start = -1;
  let last: string | null = null;
  let inString = false;
  let escaped = false;
  for (let at = 0; at < reply.length; at += 1) {
    const char = reply[at];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") {
      if (depth === 0) start = at;
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0) last = reply.slice(start, at + 1);
    }
  }
  return last;
};

const INSTRUCTIONS = `Saat otteen pankin tiliotteen tekstisisällöstä. Älä poimi tapahtumia. Kuvaa sen sijaan tiedoston rakenne JSON-oliona, jonka ohjelma ajaa koko tiedostolle.

Kentät:
- skip: säännölliset lausekkeet riveille jotka eivät ole tapahtumia (otsikot, sivunumerot, tilinumerot, saldorivit). Jokaisen rivin on osuttava johonkin: skip, recordStart, continuation tai restField.
- recordStart: tapahtuman aloittava rivi. Nimetyt ryhmät ovat kenttiä: date (pakollinen), amount (tai debit ja credit), label, externalId.
- continuation: lausekkeet tapahtuman seuraaville riveille. Ajetaan riveihin jotka on liitetty rivinvaihdoilla, joten lauseke saa ulottua usealle riville.
- restField: mihin kenttään ensimmäinen muuten tunnistamaton rivi menee.
- header: koko tiedostosta haettavat lausekkeet. Arvo on ryhmä (?<value>...).
- dateFormat: d.m.yyyy, dd.mm.yyyy, yyyy-mm-dd tai d.m.
- money: miten luvut on painettu (desimaalierotin, tuhaterotin, miinuksen paikka).

Säännöt:
- Älä keksi kenttiä joita ei ole listattu.
- Vastaa pelkällä JSON-oliolla, ilman selityksiä.

Neljä sudenkuoppaa, jotka ovat tuhonneet aiempia kuvauksia äänettömästi -- ei virhettä, ei tunnistamatonta riviä, vain puuttuva arvo:
1. Älä kirjoita continuation-lauseketta joka osuu paljaaseen MUOTOON joka voisi olla myös nimi. Esimerkki: arkistotunnukselle tarkoitettu \`^[0-9A-Z]{16,}$\` nielaisee myös yhdeksi sanaksi painetun maksunsaajan nimen, ja nimi katoaa jäljettömiin. Vaadi jotain mitä arvossa on mutta nimessä ei -- tunnukselle vähintään yksi numero.
2. Kun listaat sivun täytesisältöä skip-kentässä, vaadi jokaisen avainsanan jälkeen välilyönti tai rivin loppu (esim. \`(?=\\s|$)\`). Muuten maksunsaaja, jonka nimi vain ALKAA täytesanalla (esimerkiksi "BIC"), katoaa kokonaan.
3. Kun arvon paikka rivillä vaihtelee, käytä laiskaa hakua (\`.*?\`) etsimässä sitä, älä kiinteää paikkaa. Naiivi valinnainen ryhmä palauttaa äänettömästi tyhjää sen sijaan että epäonnistuisi -- se on helpoin tapa kirjoittaa kuvaus joka näyttää oikealta muttei ole.
4. Jokainen continuation-lauseke osuu vain KERRAN yhtä tapahtumalohkoa kohti. Saman muodon toinen esiintymä lohkossa jää poimimatta.

Esimerkki toisesta pankista:
${JSON.stringify(OP_STATEMENT_RECIPE)}`;

const ask = async (
  client: ChatClient,
  messages: { role: "system" | "user"; content: string }[],
) => {
  const reply = await client.run({
    model: PDF_READ_MODEL,
    max_tokens: MAX_TOKENS,
    messages,
    tools: [],
  });
  const object = jsonObject(reply.text);
  if (object === null) throw new Error(NO_ANSWER);
  let raw: unknown;
  try {
    raw = JSON.parse(object);
  } catch {
    throw new Error(NO_ANSWER);
  }
  return parseRecipe(raw);
};

/**
 * One description, checked; and if it does not hold up, one more with the
 * complaint attached. Never a third: a model that has missed twice is guessing,
 * and the owner's review screen is a better use of the next minute.
 */
export const generateRecipe = async (
  text: string,
  pages: readonly PdfPage[],
  client: ChatClient,
): Promise<{ recipe: BankRecipe; run: RecipeRun; verified: boolean }> => {
  const sample = sampleFor(pages);
  const first = await ask(client, [
    { role: "system", content: INSTRUCTIONS },
    { role: "user", content: sample },
  ]);
  const firstRun = runRecipe(text, first);
  const firstVerdict = verifyRun(firstRun);
  if (firstVerdict.ok) return { recipe: first, run: firstRun, verified: true };

  const second = await ask(client, [
    { role: "system", content: INSTRUCTIONS },
    { role: "user", content: sample },
    {
      role: "user",
      content: `Edellinen kuvauksesi:\n${JSON.stringify(first)}\n\n${firstVerdict.report}\n\nKorjaa kuvaus. Vastaa pelkällä JSON-oliolla.`,
    },
  ]);
  const secondRun = runRecipe(text, second);
  if (verifyRun(secondRun).ok) return { recipe: second, run: secondRun, verified: true };

  return { recipe: first, run: firstRun, verified: false };
};
