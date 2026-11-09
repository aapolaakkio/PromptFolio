/** V8 has no backtracking limit and the time budget is checked only between exec calls, so a pattern like ^(a+)+$ could pin a request. Refuses a quantified group whose body is one unbounded repetition or has overlapping alternatives. Heuristic; a hanging pattern never verifies, so it is never stored. */

type Group = { readonly body: string; readonly quantifier: string };

const OPEN_QUANTIFIER = /^(?:[*+]|\{\d+,\}|\{\d+,\d{3,}\})/u;

const ANY_QUANTIFIER = /^(?:[*+?]|\{\d+(?:,\d*)?\})\??/u;

const EMPTY_QUANTIFIER = /^(?:[*?]|\{0(?:,\d*)?\})/u;

const GROUP_PREFIX = /^\?(?::|=|!|<[=!]|<[A-Za-z][A-Za-z0-9]*>)/u;

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

const overlappingAlternatives = (body: string): boolean => {
  const branches = alternatives(body);
  if (branches.length < 2) return false;
  return branches.some(
    (branch, index) =>
      branch === "" || branches.some((other, at) => at !== index && other.startsWith(branch)),
  );
};

type Element = {
  readonly groupBody: string | null;
  readonly quantifier: string;
  readonly zeroWidth: boolean;
};

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

const endOfClass = (branch: string, from: number): number => {
  for (let at = from + 1; at < branch.length; at += 1) {
    if (branch[at] === "\\") at += 1;
    else if (branch[at] === "]") return at + 1;
  }
  return branch.length;
};

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

const reducesToOneRepeat = (branch: string, depth: number): boolean => {
  if (depth > 10) return false;
  const elements = elementsOf(branch);
  const required = elements.filter((element) => !canMatchEmpty(element));
  if (required.length === 0) return elements.some(isUnbounded);
  if (required.length > 1) return false;
  const only = required[0]!;
  if (isUnbounded(only)) return true;
  return (
    only.groupBody !== null && only.quantifier === "" && isAmbiguousBody(only.groupBody, depth)
  );
};

function isAmbiguousBody(body: string, depth = 0): boolean {
  const inner = body.replace(GROUP_PREFIX, "");
  if (overlappingAlternatives(inner)) return true;
  return alternatives(inner).some((branch) => reducesToOneRepeat(branch, depth + 1));
}

export const mayBacktrackForever = (source: string): boolean =>
  groupsOf(source).some((group) => group.quantifier !== "" && isAmbiguousBody(group.body));

const MAX_WILDCARD_REPEATS = 1;

export const hasManyWildcards = (source: string): boolean => {
  const folded = source
    .replace(/\[(?:\\w\\W|\\W\\w|\\d\\D|\\D\\d|\\s\\S|\\S\\s)\]|\[\^\]/g, "W")
    .replace(/\(\?:(?:\.\|\\n|\\n\|\.)\)/g, "W")
    .replace(/\\[^sS]/g, "x")
    .replace(/\[\^[^\]]*\]/g, "N")
    .replace(/\[[^\]]*\]/g, "x");
  return (folded.match(/[.WN](?:[*+]|\{\d+,\})/g) ?? []).length > MAX_WILDCARD_REPEATS;
};
