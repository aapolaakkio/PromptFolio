/**
 * Shapes of model-written regexes that are refused before they are ever run.
 *
 * A catastrophic pattern cannot be bounded from inside the worker: V8 has no
 * backtracking limit, and the run loop's time budget is only checked between
 * `exec` calls, never inside one. `^(a+)+$` is seven characters, well under
 * `MAX_PATTERN_LENGTH`, and takes minutes on a 37-character line.
 *
 * What is achievable in-process is refusing the classic shapes: a quantified
 * group whose body -- at any depth, through as many inner groups as the model
 * cares to write -- reduces to a single unbounded repetition (`(a+)+`,
 * `(?:(a+))+`, `((a)+)+`, `([a-z]+\s?)+`), and one whose alternatives overlap
 * (`(a|aa)+`). A body with two things that must both match is left alone:
 * `(?:.*\n)*` and `(?:\s+[A-Z][A-Z.-]*)*` are real reference patterns and each
 * iteration has only one way to end.
 *
 * This stays a heuristic, and the honest statement of what it buys is small.
 * A single regex execution is unbounded in V8, so a pattern that passes this
 * shape check can still pin a request until Cloudflare's CPU limit ends it;
 * the run loop's budget only notices between calls. The real fix is a
 * linear-time engine (RE2 and its relatives), not a longer list of shapes.
 * The practical cost today is one failed import: the pattern comes from the
 * model describing the owner's own document, a pattern that hangs never
 * verifies, so it is never stored, and the next import regenerates it.
 */

type Group = { readonly body: string; readonly quantifier: string };

/** An unbounded repetition of the group in front of it: `*`, `+`, `{2,}`. */
const OPEN_QUANTIFIER = /^(?:[*+]|\{\d+,\}|\{\d+,\d{3,}\})/u;

/** Any repetition at all, lazy or greedy: `*`, `+?`, `{1,3}`, `?`. */
const ANY_QUANTIFIER = /^(?:[*+?]|\{\d+(?:,\d*)?\})\??/u;

/** A repetition that may match nothing: `?`, `*`, `{0}`, `{0,3}`. */
const EMPTY_QUANTIFIER = /^(?:[*?]|\{0(?:,\d*)?\})/u;

/** `?:`, `?=`, `?!`, `?<=`, `?<!`, `?<name>` -- none of them part of the body. */
const GROUP_PREFIX = /^\?(?::|=|!|<[=!]|<[A-Za-z][A-Za-z0-9]*>)/u;

/** Every group in the pattern, with whatever quantifier follows it. */
const groupsOf = (source: string): Group[] => {
  const found: Group[] = [];
  const stack: number[] = [];
  let inClass = false;
  for (let at = 0; at < source.length; at += 1) {
    const char = source[at];
    if (char === "\\") {
      at += 1;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      continue;
    }
    if (char === "[") inClass = true;
    else if (char === "(") stack.push(at);
    else if (char === ")") {
      const open = stack.pop();
      if (open === undefined) continue;
      const rest = source.slice(at + 1);
      found.push({
        body: source.slice(open + 1, at),
        quantifier: OPEN_QUANTIFIER.exec(rest)?.[0] ?? "",
      });
    }
  }
  return found;
};

/** The body's top-level alternatives: `a|aa` splits, `(a|b)c` does not. */
const alternatives = (body: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let inClass = false;
  let from = 0;
  for (let at = 0; at < body.length; at += 1) {
    const char = body[at];
    if (char === "\\") {
      at += 1;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      continue;
    }
    if (char === "[") inClass = true;
    else if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "|" && depth === 0) {
      parts.push(body.slice(from, at));
      from = at + 1;
    }
  }
  parts.push(body.slice(from));
  return parts;
};

/**
 * Alternatives that can match the same text, so the outer repetition has more
 * than one way to reach the same position: an empty branch, or one branch a
 * prefix of another (`a|aa`).
 */
const overlappingAlternatives = (body: string): boolean => {
  const branches = alternatives(body);
  if (branches.length < 2) return false;
  return branches.some(
    (branch, index) =>
      branch === "" || branches.some((other, at) => at !== index && other.startsWith(branch)),
  );
};

/** One piece of a branch: an atom or a group, plus the repetition after it. */
type Element = {
  /** The group's own body, or `null` when the element is a plain atom. */
  readonly groupBody: string | null;
  readonly quantifier: string;
  /** An anchor or a lookaround: consumes nothing, so it cannot carry a branch. */
  readonly zeroWidth: boolean;
};

/** The index just past the group opened at `from`, or the end of the source. */
const endOfGroup = (branch: string, from: number): number => {
  let depth = 0;
  let inClass = false;
  for (let at = from; at < branch.length; at += 1) {
    const char = branch[at];
    if (char === "\\") {
      at += 1;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      continue;
    }
    if (char === "[") inClass = true;
    else if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return at + 1;
    }
  }
  return branch.length;
};

/** The index just past the character class opened at `from`. */
const endOfClass = (branch: string, from: number): number => {
  for (let at = from + 1; at < branch.length; at += 1) {
    if (branch[at] === "\\") at += 1;
    else if (branch[at] === "]") return at + 1;
  }
  return branch.length;
};

/** A branch split into its elements. Alternation is handled before this. */
const elementsOf = (branch: string): Element[] => {
  const found: Element[] = [];
  let at = 0;
  while (at < branch.length) {
    const char = branch[at];
    let groupBody: string | null = null;
    let zeroWidth = false;
    let next: number;
    if (char === "(") {
      next = endOfGroup(branch, at);
      const inner = branch.slice(at + 1, next - 1);
      const prefix = GROUP_PREFIX.exec(inner)?.[0] ?? "";
      zeroWidth = prefix.startsWith("?=") || prefix.startsWith("?!") || prefix.startsWith("?<");
      groupBody = inner.slice(prefix.length);
    } else if (char === "[") {
      next = endOfClass(branch, at);
    } else if (char === "\\") {
      next = at + 2;
    } else {
      next = at + 1;
      zeroWidth = char === "^" || char === "$";
    }
    const quantifier = ANY_QUANTIFIER.exec(branch.slice(next))?.[0] ?? "";
    found.push({ groupBody, quantifier, zeroWidth });
    at = next + quantifier.length;
  }
  return found;
};

const canMatchEmpty = (element: Element): boolean =>
  element.zeroWidth || EMPTY_QUANTIFIER.test(element.quantifier);

const isUnbounded = (element: Element): boolean => OPEN_QUANTIFIER.test(element.quantifier);

/**
 * True when the branch is, once the parts that may match nothing are set
 * aside, a single unbounded repetition -- `a+`, `[a-z]+\s?`, `(a+)`, `(a)+`.
 * That is the body shape that lets an enclosing repetition split the same text
 * in exponentially many ways. Two things that must both match (`.*\n`,
 * `\s+[A-Z][A-Z.-]*`) pin every iteration's end, and are left alone.
 */
const reducesToOneRepeat = (branch: string, depth: number): boolean => {
  if (depth > 10) return false;
  const elements = elementsOf(branch);
  const required = elements.filter((element) => !canMatchEmpty(element));
  if (required.length === 0) return elements.some(isUnbounded);
  if (required.length > 1) return false;
  const only = required[0]!;
  if (isUnbounded(only)) return true;
  // A lone group that is not itself repeated adds nothing: look inside it.
  return (
    only.groupBody !== null && only.quantifier === "" && isAmbiguousBody(only.groupBody, depth)
  );
};

function isAmbiguousBody(body: string, depth = 0): boolean {
  const inner = body.replace(GROUP_PREFIX, "");
  if (overlappingAlternatives(inner)) return true;
  return alternatives(inner).some((branch) => reducesToOneRepeat(branch, depth + 1));
}

/**
 * True for a pattern carrying a quantified group whose body can match the same
 * text in more than one way -- the form behind catastrophic backtracking.
 * Heuristic: it clears the classic forms, not every possible one.
 */
export const mayBacktrackForever = (source: string): boolean =>
  groupsOf(source).some((group) => group.quantifier !== "" && isAmbiguousBody(group.body));

/** Most unbounded wildcard repetitions (`.*`, `[\\s\\S]+`, `[^x]*?`) a page pattern may carry. */
const MAX_WILDCARD_REPEATS = 1;

/**
 * True for a pattern with two or more unbounded wildcard repetitions: the
 * shape whose run time grows with the product of their reach over a large page.
 * Classes and escapes are folded away first so `[a.+]` and `\\.*` do not count.
 */
export const hasManyWildcards = (source: string): boolean => {
  const folded = source
    .replace(/\\[^sS]/g, "x")
    .replace(/\[\\s\\S\]/g, "W")
    .replace(/\[\^[^\]]*\]/g, "N")
    .replace(/\[[^\]]*\]/g, "x");
  return (folded.match(/[.WN][*+]/g) ?? []).length > MAX_WILDCARD_REPEATS;
};
