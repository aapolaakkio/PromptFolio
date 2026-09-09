import type { ChatClient, ChatMessage } from "../../chat/runner.ts";
import { PDF_READ_MODEL, type PdfPage } from "../pdf-read.ts";
import { OP_STATEMENT_RECIPE } from "./op-reference.ts";
import type { RecipeRun } from "./run.ts";
import { MAX_PATTERN_LENGTH, type BankRecipe } from "./types.ts";
import { createVerifySession, runVerifyCall, verifyToolDefinition } from "./verify-tool.ts";

/** A recipe is about a kilobyte; this is room for one with comments stripped. */
const MAX_TOKENS = 4096;
/**
 * How much of the last page goes in the sample. Its END, not its beginning:
 * the closing balance and the maturity date are printed at the bottom, and a
 * long statement's last page opens with the same column captions page one
 * already showed. Sending the head as well would cost tokens to repeat them.
 */
const TAIL_LINES = 15;
/**
 * Tool rounds before the loop gives up, the same cap `runTurn` uses: a model
 * still calling the tool past this is circling, not converging.
 */
const MAX_ROUNDS = 10;

const NO_ANSWER = "Malli ei kuvannut tiedostomuotoa";

export const sampleFor = (pages: readonly PdfPage[]): string => {
  const first = pages[0];
  const last = pages.length > 1 ? pages.at(-1) : undefined;
  const tail = last?.text.split("\n").slice(-TAIL_LINES).join("\n");
  return [
    `--- sivu ${first?.number ?? 1} ---\n${first?.text ?? ""}`,
    tail === undefined ? "" : `--- viimeinen sivu (loppu) ---\n${tail}`,
  ]
    .filter((part) => part !== "")
    .join("\n\n");
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
- Älä kirjoita kuvausta vastaukseesi tekstinä: anna se verify_recipe-työkalulle.
- Yksi lauseke saa olla enintään ${MAX_PATTERN_LENGTH} merkkiä. Jos luettelosi ei mahdu, jaa se useaksi lausekkeeksi -- skip-kenttään mahtuu 40.

Neljä sudenkuoppaa, jotka ovat tuhonneet aiempia kuvauksia äänettömästi -- ei virhettä, ei tunnistamatonta riviä, vain puuttuva arvo:
1. Älä kirjoita continuation-lauseketta joka osuu paljaaseen MUOTOON joka voisi olla myös nimi. Esimerkki: arkistotunnukselle tarkoitettu \`^[0-9A-Z]{16,}$\` nielaisee myös yhdeksi sanaksi painetun maksunsaajan nimen, ja nimi katoaa jäljettömiin. Vaadi jotain mitä arvossa on mutta nimessä ei -- tunnukselle vähintään yksi numero.
2. Kun listaat sivun täytesisältöä skip-kentässä, vaadi jokaisen avainsanan jälkeen välilyönti tai rivin loppu (esim. \`(?=\\s|$)\`). Muuten maksunsaaja, jonka nimi vain ALKAA täytesanalla (esimerkiksi "BIC"), katoaa kokonaan.
3. Kun arvon paikka rivillä vaihtelee, käytä laiskaa hakua (\`.*?\`) etsimässä sitä, älä kiinteää paikkaa. Naiivi valinnainen ryhmä palauttaa äänettömästi tyhjää sen sijaan että epäonnistuisi -- se on helpoin tapa kirjoittaa kuvaus joka näyttää oikealta muttei ole.
4. Jokainen continuation-lauseke osuu vain KERRAN yhtä tapahtumalohkoa kohti. Saman muodon toinen esiintymä lohkossa jää poimimatta.

Työskentely:
- Kutsu verify_recipe-työkalua ehdotuksellasi. Työkalu ajaa kuvauksen koko tiedostolle ja kertoo mitä meni pieleen: tunnistamattomat rivit, ohitetut tapahtumannäköiset rivit, saldotarkistuksen ja kolme ensimmäistä poimittua tapahtumaa.
- Lue tulos, korjaa kuvaus ja kutsu uudelleen. Katso myös sampleRows: jos maksunsaaja on tyhjä tai viesti on päätynyt väärään kenttään, kuvaus on väärä vaikka saldo täsmäisi.
- Kun tulos on ok: true, työ on valmis. Älä kutsu enää.

Esimerkki toisesta pankista:
${JSON.stringify(OP_STATEMENT_RECIPE)}`;

/**
 * One description, arrived at by trying. The model proposes a recipe, the
 * `verify_recipe` tool runs it over the whole statement and hands back what
 * went wrong, and it proposes again. What comes back is whatever the TOOL saw
 * verify -- never the model's closing words, which cost nothing to write and
 * are not evidence that a statement was read correctly.
 *
 * When nothing verifies, the most complete reading is still returned as an
 * unverified draft: the owner's review screen can fix a recipe, but only if
 * there is one.
 */
export const generateRecipe = async (
  text: string,
  pages: readonly PdfPage[],
  client: ChatClient,
): Promise<{ recipe: BankRecipe; run: RecipeRun; verified: boolean }> => {
  const session = createVerifySession(text);
  let messages: readonly ChatMessage[] = [
    { role: "system", content: INSTRUCTIONS },
    { role: "user", content: sampleFor(pages) },
  ];

  for (let round = 0; round < MAX_ROUNDS && session.verified() === null; round += 1) {
    const reply = await client.run({
      model: PDF_READ_MODEL,
      max_tokens: MAX_TOKENS,
      messages,
      tools: [verifyToolDefinition],
    });
    // Words instead of a call: there is nothing to check, and nothing in the
    // text is trusted, so asking again would only repeat the same reply.
    if (reply.toolCalls.length === 0) break;
    messages = [
      ...messages,
      { role: "assistant", content: reply.text, tool_calls: reply.toolCalls },
    ];
    for (const call of reply.toolCalls) {
      const content = await runVerifyCall(session, call);
      messages = [...messages, { role: "tool", tool_call_id: call.id, content }];
      // A pass ends the job: further calls would spend a round on a question
      // that is already answered.
      if (session.verified() !== null) break;
    }
  }

  const verified = session.verified();
  if (verified !== null) return { recipe: verified.recipe, run: verified.run, verified: true };
  const best = session.best();
  if (best !== null) return { recipe: best.recipe, run: best.run, verified: false };
  throw new Error(session.lastError() ?? NO_ANSWER);
};
