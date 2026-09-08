/**
 * Shapes of model-written regexes that are refused before they are ever run.
 *
 * A catastrophic pattern cannot be bounded from inside the worker: V8 has no
 * backtracking limit, and the run loop's time budget is only checked between
 * `exec` calls, never inside one. `^(a+)+$` is seven characters, well under
 * `MAX_PATTERN_LENGTH`, and takes minutes on a 37-character line.
 *
 * What is achievable in-process is refusing the classic shapes: a quantified
 * group whose body is itself quantified (`(a+)+`, `(a*)*`, `(a+)*`) and one
 * whose alternatives overlap (`(a|aa)+`). This is a heuristic and not a
 * decision procedure -- a pattern it accepts can still backtrack badly, and
 * the caller must keep its time budget.
 */

type Group = { readonly body: string; readonly quantifier: string };

/** An unbounded repetition of the group in front of it: `*`, `+`, `{2,}`. */
const OPEN_QUANTIFIER = /^(?:[*+]|\{\d+,\}|\{\d+,\d{3,}\})/u;

/** `?:`, `?=`, `?!`, `?<=`, `?<!`, `?<name>` -- none of them part of the body. */
const GROUP_PREFIX = /^\?(?::|=|!|<[=!]|<[A-Za-z][A-Za-z0-9]*>)/u;

/** One escape, one character class, a dot, or one ordinary character. */
const ATOM = String.raw`(?:\\.|\[(?:\\.|[^\]])*\]|\.|[^\\[\](){}|*+?^$])`;
/** A body that is one atom under a repetition, e.g. `a+`, `[0-9]*`, `\d{2,}`. */
const SIMPLE_REPEAT = new RegExp(`^${ATOM}(?:[*+]|\\{\\d+,\\d*\\})$`, "u");

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

const isAmbiguousBody = (body: string): boolean => {
  const inner = body.replace(GROUP_PREFIX, "");
  return SIMPLE_REPEAT.test(inner) || overlappingAlternatives(inner);
};

/**
 * True for a pattern carrying a quantified group whose body can match the same
 * text in more than one way -- the form behind catastrophic backtracking.
 * Heuristic: it clears the classic forms, not every possible one.
 */
export const mayBacktrackForever = (source: string): boolean =>
  groupsOf(source).some((group) => group.quantifier !== "" && isAmbiguousBody(group.body));
