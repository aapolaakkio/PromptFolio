import type { ChatClient, ChatMessage } from "../../chat/runner.ts";
import { PDF_READ_MODEL, type PdfPage } from "../pdf-read.ts";
import { OP_STATEMENT_RECIPE } from "./op-reference.ts";
import type { RecipeRun } from "./run.ts";
import type { BankRecipe } from "./types.ts";
import { createVerifySession, runVerifyCall, verifyToolDefinition } from "./verify-tool.ts";

/** A recipe is about a kilobyte; this is room for one with comments stripped. */
const MAX_TOKENS = 16000;
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
/**
 * How many earlier attempts each round carries. The prompt used to keep every
 * one, so the round that needed the model's attention most was the round it
 * read the longest transcript to reach -- and the transcript was mostly
 * recipes already known to be wrong. What a round needs is the file, the last
 * thing tried and what that broke; the recipe before it is kept as well, so a
 * candidate already refused is not proposed again.
 *
 * Whole exchanges are dropped, never halves: an assistant's tool call and the
 * result answering it have to travel together or the request is malformed.
 */
const KEEP_ATTEMPTS = 2;

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

/**
 * What the model is told. Deliberately mechanical: how the program executes a
 * recipe, and nothing about how to write one. Which pattern reads which field
 * is the model's judgement, and the verify tool shows it the consequences of
 * that judgement -- rows read, fields landed, balances -- on the real file.
 * Advice about particular layouts belongs in neither: it aged badly, it was
 * written for one bank, and a model that follows it stops looking.
 */
const INSTRUCTIONS = `Saat otteen pankin tiliotteen tekstisisällöstä. Älä poimi tapahtumia. Kuvaa sen sijaan tiedoston rakenne JSON-oliona, jonka ohjelma ajaa koko tiedostolle.

Näin ohjelma ajaa kuvauksen:
- Rivit trimmataan. Jokainen skip-lausekkeeseen osuva rivi poistetaan.
- recordStart-lausekkeeseen osuva rivi aloittaa tapahtuman. Sitä seuraavat rivit seuraavaan recordStartiin asti ovat saman tapahtuman lohko.
- Jokainen continuation-lauseke ajetaan kerran lohkoa vastaan, rivinvaihdoilla liitettynä: lauseke saa ulottua usealle riville, mutta osuu vain KERRAN lohkoa kohti.
- restField saa lohkon ensimmäisen rivin jota mikään lauseke ei ottanut.
- Nimetyt ryhmät ovat kenttiä, luettuna mistä tahansa saman lohkon lausekkeesta: date, amount (tai debit ja credit), label, counterparty, message, externalId. Millään kentällä ei ole omaa paikkaansa. recordStartin oma ryhmä voittaa continuationin.
- Jos ote tulostaa jokaisen rivin jälkeen tilin saldon, nimeä se ryhmällä balance. Tarkistus lukee sen: se on ainoa keino huomata yksittäinen väärin luettu rivi, koska virhe ja sen peilikuva summautuvat pois.
- header-lausekkeet haetaan koko tiedostosta, ryhmästä (?<value>...). Ne eivät saa osua tapahtumariveihin.

Työskentely:
- Kutsu verify_recipe-työkalua ehdotuksellasi. Se ajaa kuvauksen koko tiedostolle ja kertoo mitä tuli ulos: tunnistamattomat rivit, ohitetut tapahtumannäköiset rivit, saldotarkistuksen ja kolme ensimmäistä poimittua tapahtumaa.
- Lue tulos ja päättele itse mikä on pielessä. sampleRows kertoo mihin kenttiin arvot päätyivät: tyhjä maksunsaaja tai väärässä kentässä oleva viesti tarkoittaa väärää kuvausta vaikka saldo täsmäisi.
- Kun tulos on ok: true, työ on valmis. Älä kutsu enää.
- Älä kirjoita kuvausta vastaukseesi tekstinä: anna se verify_recipe-työkalulle.

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
  const opening: readonly ChatMessage[] = [
    { role: "system", content: INSTRUCTIONS },
    { role: "user", content: sampleFor(pages) },
  ];
  const attempts: (readonly ChatMessage[])[] = [];

  for (let round = 0; round < MAX_ROUNDS && session.verified() === null; round += 1) {
    const reply = await client.run({
      model: PDF_READ_MODEL,
      max_tokens: MAX_TOKENS,
      messages: [...opening, ...attempts.slice(-KEEP_ATTEMPTS).flat()],
      tools: [verifyToolDefinition],
    });
    // Words instead of a call: there is nothing to check, and nothing in the
    // text is trusted, so asking again would only repeat the same reply.
    if (reply.toolCalls.length === 0) break;
    const attempt: ChatMessage[] = [
      { role: "assistant", content: reply.text, tool_calls: reply.toolCalls },
    ];
    for (const call of reply.toolCalls) {
      const content = await runVerifyCall(session, call);
      attempt.push({ role: "tool", tool_call_id: call.id, content });
      // A pass ends the job: further calls would spend a round on a question
      // that is already answered.
      if (session.verified() !== null) break;
    }
    attempts.push(attempt);
  }

  const verified = session.verified();
  if (verified !== null) return { recipe: verified.recipe, run: verified.run, verified: true };
  const best = session.best();
  if (best !== null) return { recipe: best.recipe, run: best.run, verified: false };
  throw new Error(session.lastError() ?? NO_ANSWER);
};
