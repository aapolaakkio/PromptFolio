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
