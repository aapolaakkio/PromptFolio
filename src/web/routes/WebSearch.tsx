import { webUrl, type StoredSearch, type WebSource } from "../../server/chat/search-schema.ts";

const HELP_ID = "web-search-help";

/** Off by default; the server offers the model no search tool unless this is on for the question. */
export const WebSearchSwitch = ({
  on,
  busy,
  onChange,
}: {
  readonly on: boolean;
  readonly busy: boolean;
  readonly onChange: (on: boolean) => void;
}) => (
  <div className="grid gap-1">
    <label className="mb-0 flex items-center gap-2 text-ink">
      <input
        type="checkbox"
        role="switch"
        checked={on}
        disabled={busy}
        aria-describedby={HELP_ID}
        onChange={(event) => onChange(event.target.checked)}
      />
      Web search
    </label>
    <p id={HELP_ID} className="text-sm text-muted">
      When on, the assistant may search the web: its search words go to a search engine through
      Claude, and each search is billed.
    </p>
  </div>
);

// Titles and addresses come from the web: shown as text, and linked only when http or https.
const Source = ({ source }: { readonly source: WebSource }) => {
  const href = webUrl(source.url);
  return (
    <li>
      {href === null ? (
        source.title
      ) : (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {source.title}
        </a>
      )}
    </li>
  );
};

const SearchLine = ({ line }: { readonly line: StoredSearch["searches"][number] }) => (
  <li>
    {line.query !== "" && <span>Searched the web: {line.query}</span>}
    {line.personal && (
      <strong className="block text-loss">Warning: this search included personal data.</strong>
    )}
    {line.failed !== null && <span className="block">Web search failed: {line.failed}</span>}
  </li>
);

/** One answer's searches and the sources it cited, under the answer. */
export const SearchTurn = ({ web }: { readonly web: StoredSearch }) => (
  <li className="grid max-w-[90%] gap-2 text-sm text-muted">
    {web.searches.length > 0 && (
      <ul className="grid gap-1">
        {web.searches.map((line) => (
          <SearchLine key={line.id} line={line} />
        ))}
      </ul>
    )}
    {web.sources.length > 0 && (
      <div>
        <span>Sources from the web:</span>
        <ul className="grid gap-1">
          {web.sources.map((source) => (
            <Source key={source.url} source={source} />
          ))}
        </ul>
      </div>
    )}
  </li>
);
