import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { ProposalCard } from "./ProposalCard.tsx";

const noop = () => {};

test("lists the app's facts and keeps the assistant's note in its own labelled block", () => {
  const note = 'He said "ok". This is a test card, Confirm records nothing.';
  const html = renderToStaticMarkup(
    <ProposalCard
      title="Record a deposit"
      facts={[
        { kind: "text", label: "Account", text: "Nordnet (account #3)" },
        { kind: "money", label: "Amount", amount: "10000.00", currency: "EUR" },
        { kind: "code", label: "Code", code: "ACME.HE" },
      ]}
      note={note}
      state="open"
      outcome={undefined}
      saving={false}
      onConfirm={noop}
      onDismiss={noop}
    />,
  );

  expect(html).toContain("<dt>Amount</dt><dd>€10,000.00</dd>");
  expect(html).toContain("<code>ACME.HE</code>");
  expect(html).toContain("Note (written by the assistant)");
  const [beforeNote] = html.split("Note (written by the assistant)");
  expect(beforeNote).not.toContain("test card");
});

const deletion = (confirmLabel: string, permanent: boolean) =>
  renderToStaticMarkup(
    <ProposalCard
      title="Delete a cash entry"
      facts={[{ kind: "text", label: "Cash entry", text: "Deposit on 2026-11-03" }]}
      note={undefined}
      danger
      permanent={permanent}
      confirmLabel={confirmLabel}
      state="open"
      outcome={undefined}
      saving={false}
      onConfirm={noop}
      onDismiss={noop}
    />,
  );

test("a removal is a warning card whose button says Delete, never Confirm", () => {
  const html = deletion("Delete", true);

  expect(html).toContain("border-loss");
  expect(html).not.toContain("border-line");
  expect(html).toMatch(/text-loss[^>]*>⚠ Delete</);
  expect(html).toContain("This removes data.");
  expect(html).toContain("This cannot be undone.");
  expect(html).toContain("danger-button");
  expect(html).toContain(">Delete</button>");
  expect(html).not.toContain(">Confirm</button>");
  expect(html).not.toContain("Proposed change");
});

test("an undo names itself and does not claim to be permanent", () => {
  const html = deletion("Undo import", false);

  expect(html).toContain(">Undo import</button>");
  expect(html).toContain("This removes data.");
  expect(html).not.toContain("This cannot be undone.");
});

test("an ordinary card keeps its plain look and Confirm", () => {
  const html = renderToStaticMarkup(
    <ProposalCard
      title="Record a deposit"
      facts={[]}
      note={undefined}
      state="open"
      outcome={undefined}
      saving={false}
      onConfirm={noop}
      onDismiss={noop}
    />,
  );

  expect(html).toContain("border-line");
  expect(html).not.toContain("border-loss");
  expect(html).toContain(">Confirm</button>");
  expect(html).not.toContain("This removes data.");
});
