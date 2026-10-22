// Core of the pt-BR overlay: scope, identifier guard, candidate extraction,
// dictionary lookup and source rendering. Everything here is read-only; the
// file writes live in apply.mjs.
//
// Principle: only string literals in render-only contexts are rewritten, and a
// literal whose exact value is used as an identifier anywhere in the codebase
// (compared, switched on, used as a key, enum value...) is left in English.
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

// ---------------------------------------------------------------- files

const SKIP_PATH =
  /(\.test\.|\.spec\.|__tests__|\.stories\.|\/evals?\/|\.d\.ts$|node_modules|\/scripts\/|\/__ptbr__\/)/;

export function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(tsx?|mts)$/.test(entry.name) && !SKIP_PATH.test(p)) out.push(p);
  }
  return out;
}

/** Every file that can contain logic referencing a UI string. */
export function listLogicFiles(root) {
  const pkgs = path.join(root, "packages");
  return [
    ...walk(path.join(root, "apps/web")),
    ...(fs.existsSync(pkgs)
      ? fs.readdirSync(pkgs).flatMap((p) => walk(path.join(pkgs, p, "src")))
      : []),
  ];
}

export function parseFile(file, text = fs.readFileSync(file, "utf8")) {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

// ---------------------------------------------------------------- scope

export function loadScope(configDir) {
  const raw = JSON.parse(fs.readFileSync(path.join(configDir, "scope.json"), "utf8"));
  const include = raw.include.map((s) => new RegExp(s));
  const deny = raw.deny.map((s) => new RegExp(s));
  return (rel) => include.some((r) => r.test(rel)) && !deny.some((r) => r.test(rel));
}

export function loadContexts(configDir) {
  const raw = JSON.parse(fs.readFileSync(path.join(configDir, "contexts.json"), "utf8"));
  return {
    attrs: new Set(raw.attributes),
    objKeys: new Set(raw.objectKeys),
    toastObjFns: new Set(raw.toastObjectFunctions),
    toastObjProps: new Set(raw.toastObjectProps),
    excludedCallee: new RegExp(raw.excludedCalleePattern),
    excludedAncestorProps: new Set(raw.excludedAncestorProps),
    zodMethods: new Set(raw.zodMethods),
  };
}

// ---------------------------------------------------------------- helpers

export const hasWords = (s) => /[A-Za-z]{2,}/.test(s);
export const looksIdent = (s) =>
  /^[a-z0-9_.:/#@-]+$/.test(s) || // kebab, snake, paths, single lowercase tokens
  /^[A-Z0-9_]+$/.test(s) || // SCREAMING_CASE
  /^[a-z]+[A-Z][A-Za-z0-9]*$/.test(s) || // camelCase
  /^(https?:|\/|#|mailto:|www\.)/.test(s) ||
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) || // e-mail address
  /\{\{/.test(s) || // AI prompt templates
  /^Inbox Zero$/.test(s) ||
  looksLikeClassList(s);

/** Tailwind/CSS class lists ("mt-0.5 text-sm leading-5") are not UI text. */
function looksLikeClassList(s) {
  const tokens = s.trim().split(/\s+/);
  return (
    tokens.length > 1 &&
    tokens.every((t) => /^[a-z0-9:[\]/._%#()!-]+$/.test(t)) &&
    tokens.some((t) => t.includes("-"))
  );
}

const ENTITIES = {
  "&apos;": "'", "&quot;": '"', "&amp;": "&", "&lt;": "<", "&gt;": ">",
  "&nbsp;": " ", "&#39;": "'", "&rsquo;": "’", "&lsquo;": "‘",
  "&ldquo;": "“", "&rdquo;": "”", "&hellip;": "…",
  "&mdash;": "—", "&ndash;": "–", "&copy;": "©",
  "&middot;": "·", "&bull;": "•", "&rarr;": "→", "&larr;": "←", "&times;": "×",
};
const decodeEntities = (s) => s.replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m] ?? m);

/** JSX whitespace rules: trim each line, drop empty lines, join with a space. */
export function jsxTextKey(raw) {
  const lines = raw.split(/\r?\n/);
  const parts = [];
  lines.forEach((line, i) => {
    let l = line.replace(/\t/g, " ");
    if (i > 0) l = l.replace(/^[ ]+/, "");
    if (i < lines.length - 1) l = l.replace(/[ ]+$/, "");
    if (l.length) parts.push(l);
  });
  return decodeEntities(parts.join(" ")).replace(/[ ]{2,}/g, " ").trim();
}

const strVal = (n) =>
  n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null;

// ---------------------------------------------------------------- identifier guard

const CMP = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
]);
const MATCH_METHODS = new Set([
  "includes", "startsWith", "endsWith", "indexOf", "lastIndexOf", "has", "get",
  "match", "test", "replace", "replaceAll", "split", "localeCompare", "search",
]);

/**
 * Builds value -> [locations] for every string literal used in a logic
 * position anywhere in the codebase (not only in the UI scope).
 */
export function buildLogicIndex(parsed, rootDir) {
  const logic = new Map();
  const add = (v, sf, node, why) => {
    if (!hasWords(v)) return;
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const loc = `${path.relative(rootDir, sf.fileName)}:${line} ${why}`;
    if (!logic.has(v)) logic.set(v, []);
    logic.get(v).push(loc);
  };
  const constsCompared = new Map(); // file -> Set(identifier) compared somewhere

  for (const sf of parsed.values()) {
    const comparedIds = new Set();
    const visit = (n) => {
      if (ts.isBinaryExpression(n) && CMP.has(n.operatorToken.kind)) {
        for (const side of [n.left, n.right]) {
          const v = strVal(side);
          if (v) add(v, sf, side, "cmp");
          else if (ts.isIdentifier(side)) comparedIds.add(side.text);
        }
      } else if (ts.isCaseClause(n)) {
        const v = strVal(n.expression);
        if (v) add(v, sf, n, "case");
      } else if (ts.isLiteralTypeNode(n)) {
        const v = strVal(n.literal);
        if (v) add(v, sf, n, "type");
      } else if (ts.isPropertyAssignment(n) || ts.isPropertySignature(n)) {
        if (ts.isStringLiteral(n.name)) add(n.name.text, sf, n, "key");
        else if (ts.isIdentifier(n.name) && /^[A-Z][a-z]/.test(n.name.text) && ts.isPropertyAssignment(n))
          add(n.name.text, sf, n, "key");
      } else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const m = n.expression.name.text;
        if (MATCH_METHODS.has(m))
          for (const a of n.arguments) {
            const v = strVal(a);
            if (v) add(v, sf, a, `.${m}`);
          }
        if (m === "includes" && ts.isArrayLiteralExpression(n.expression.expression))
          for (const el of n.expression.expression.elements) {
            const v = strVal(el);
            if (v) add(v, sf, el, "[].includes");
          }
        if ((m === "enum" || m === "literal") && /^z$/.test(n.expression.expression.getText(sf)))
          for (const a of n.arguments) {
            const els = ts.isArrayLiteralExpression(a) ? a.elements : [a];
            for (const el of els) {
              const v = strVal(el);
              if (v) add(v, sf, el, `z.${m}`);
            }
          }
      } else if (
        ts.isNewExpression(n) && /^(Set|Map)$/.test(n.expression.getText(sf)) &&
        n.arguments?.[0] && ts.isArrayLiteralExpression(n.arguments[0])
      ) {
        for (const el of n.arguments[0].elements) {
          const v = strVal(el);
          if (v) add(v, sf, el, "Set");
        }
      } else if (ts.isElementAccessExpression(n)) {
        const v = strVal(n.argumentExpression);
        if (v) add(v, sf, n, "[]");
      } else if (ts.isAsExpression(n) && n.type.getText(sf) === "const") {
        // `["a", "b"] as const` tuples feed literal unions.
        const e = n.expression;
        const els = ts.isArrayLiteralExpression(e) ? e.elements : [];
        for (const el of els) {
          const v = strVal(el);
          if (v) add(v, sf, el, "as const");
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    constsCompared.set(sf, comparedIds);
  }

  // One-hop pass: `const X = "Literal"` where X is compared in the same file.
  for (const [sf, ids] of constsCompared) {
    if (!ids.size) continue;
    const visit = (n) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && ids.has(n.name.text)) {
        const v = strVal(n.initializer);
        if (v) add(v, sf, n, "const-compared");
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return logic;
}

// ---------------------------------------------------------------- extraction

/** `a ${x} b ${y.z}` -> { key: "a {0} b {1}", exprs: [...] } */
function templateKey(t, sf) {
  let s = t.head.text;
  const exprs = [];
  t.templateSpans.forEach((sp, i) => {
    s += `{${i}}${sp.literal.text}`;
    exprs.push(sp.expression);
  });
  return { key: s, exprs: exprs.map((e) => e.getText(sf)), pure: exprs.map(isPure) };
}

/** Expressions whose evaluation order does not matter (safe to reorder). */
function isPure(e) {
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e))
    return isPure(e.expression);
  if (ts.isIdentifier(e) || ts.isStringLiteral(e) || ts.isNumericLiteral(e) ||
      ts.isNoSubstitutionTemplateLiteral(e) || e.kind === ts.SyntaxKind.TrueKeyword ||
      e.kind === ts.SyntaxKind.FalseKeyword || e.kind === ts.SyntaxKind.NullKeyword)
    return true;
  if (ts.isPropertyAccessExpression(e)) return isPure(e.expression);
  if (ts.isElementAccessExpression(e))
    return isPure(e.expression) && isPure(e.argumentExpression);
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.EqualsToken || (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment))
      return false;
    return isPure(e.left) && isPure(e.right);
  }
  if (ts.isConditionalExpression(e))
    return isPure(e.condition) && isPure(e.whenTrue) && isPure(e.whenFalse);
  if (ts.isPrefixUnaryExpression(e))
    return e.operator !== ts.SyntaxKind.PlusPlusToken && e.operator !== ts.SyntaxKind.MinusMinusToken && isPure(e.operand);
  return false;
}

function calleeName(call, sf) {
  return call.expression.getText(sf).replace(/\s+/g, "");
}

function isIntrinsicTag(tagName) {
  return /^[a-z]/.test(tagName) && !tagName.includes(".");
}

/** The element a JSX text / attribute belongs to, to know if it only renders. */
function owningTag(node, sf) {
  let p = node.parent;
  while (p) {
    if (ts.isJsxElement(p)) return p.openingElement.tagName.getText(sf);
    if (ts.isJsxSelfClosingElement(p) || ts.isJsxOpeningElement(p)) return p.tagName.getText(sf);
    if (ts.isJsxFragment(p)) return "";
    p = p.parent;
  }
  return null;
}

/**
 * Collects candidate sites from one in-scope file.
 * Each candidate: { ctx, key, start, end, kind, renderOnly, exprs?, pure?, lead?, trail? }
 */
export function extractCandidates(sf, cfg) {
  const isTsx = sf.fileName.endsWith(".tsx");
  const out = [];

  const excludedByAncestor = (node) => {
    let p = node.parent;
    while (p && !ts.isSourceFile(p)) {
      if (ts.isCallExpression(p) && cfg.excludedCallee.test(calleeName(p, sf))) return true;
      if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && cfg.excludedAncestorProps.has(p.name.text))
        return true;
      if (ts.isJsxAttribute(p)) return false; // stop at JSX attribute boundaries
      p = p.parent;
    }
    return false;
  };

  const pushStr = (e, ctx, extra = {}) => {
    if (!e) return;
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression?.(e))
      return pushStr(e.expression, ctx, extra);
    if (ts.isConditionalExpression(e)) {
      pushStr(e.whenTrue, ctx, extra);
      pushStr(e.whenFalse, ctx, extra);
      return;
    }
    if (ts.isBinaryExpression(e) &&
        [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]
          .includes(e.operatorToken.kind)) {
      pushStr(e.right, ctx, extra);
      if (e.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) pushStr(e.left, ctx, extra);
      return;
    }
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
      const v = e.text;
      if (!hasWords(v) || looksIdent(v)) return;
      out.push({ ctx, key: v, start: e.getStart(sf), end: e.end, kind: "str", ...extra });
      return;
    }
    if (ts.isTemplateExpression(e)) {
      const { key, exprs, pure } = templateKey(e, sf);
      const literalPart = key.replace(/\{\d+\}/g, "");
      if (!hasWords(literalPart) || /[{}]/.test(literalPart) || /\{\{/.test(key)) return;
      out.push({ ctx, key, start: e.getStart(sf), end: e.end, kind: "tpl", exprs, pure, ...extra });
    }
  };

  const visit = (n) => {
    if (ts.isJsxText(n)) {
      const raw = n.getText(sf);
      const key = jsxTextKey(raw);
      if (hasWords(key)) {
        const tag = owningTag(n, sf);
        out.push({
          ctx: "jsxText", key, start: n.getStart(sf), end: n.end, kind: "jsxtext",
          lead: raw.match(/^\s*/)[0], trail: raw.match(/\s*$/)[0],
          renderOnly: tag !== null && isIntrinsicTag(tag),
        });
      }
    } else if (ts.isJsxExpression(n) && n.expression && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))) {
      const tag = owningTag(n, sf);
      pushStr(n.expression, "jsxChildExpr", { renderOnly: tag !== null && isIntrinsicTag(tag) });
    } else if (ts.isJsxAttribute(n)) {
      const name = n.name.getText(sf);
      if (cfg.attrs.has(name) && n.initializer) {
        const tag = owningTag(n, sf);
        const renderOnly = tag !== null && isIntrinsicTag(tag);
        if (ts.isStringLiteral(n.initializer)) {
          const v = n.initializer.text;
          if (hasWords(v) && !looksIdent(v))
            out.push({
              ctx: `attr:${name}`, key: v, start: n.initializer.getStart(sf), end: n.initializer.end,
              kind: "jsxattr", renderOnly,
            });
        } else if (ts.isJsxExpression(n.initializer)) {
          pushStr(n.initializer.expression, `attr:${name}`, { renderOnly });
        }
      }
    } else if (ts.isCallExpression(n)) {
      const callee = calleeName(n, sf);
      const arg0 = n.arguments[0];
      if (cfg.toastObjFns.has(callee) && arg0 && ts.isObjectLiteralExpression(arg0)) {
        for (const p of arg0.properties)
          if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && cfg.toastObjProps.has(p.name.text))
            pushStr(p.initializer, `toast:${p.name.text}`);
      } else if (/^toast(\.(success|error|info|warning|loading|message))?$/.test(callee)) {
        pushStr(arg0, "toast()");
        const o = n.arguments[1];
        if (o && ts.isObjectLiteralExpression(o))
          for (const p of o.properties)
            if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "description")
              pushStr(p.initializer, "toast():description");
      } else if (callee === "toast.promise" && n.arguments[1] && ts.isObjectLiteralExpression(n.arguments[1])) {
        for (const p of n.arguments[1].properties)
          if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && ["loading", "success", "error"].includes(p.name.text))
            pushStr(p.initializer, "toast.promise");
      } else if (callee === "getBrandTitle") {
        pushStr(arg0, "metadata:title");
      } else if (isTsx && ts.isPropertyAccessExpression(n.expression) && cfg.zodMethods.has(n.expression.name.text) &&
                 /\bz\b|\.(string|number|array)\(/.test(n.expression.expression.getText(sf))) {
        const m = n.expression.name.text;
        const args = ["email", "url", "nonempty"].includes(m) ? n.arguments : n.arguments.slice(1);
        for (const a of args) {
          if (ts.isStringLiteral(a)) pushStr(a, "zod");
          else if (ts.isObjectLiteralExpression(a))
            for (const p of a.properties)
              if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && ["message", "error"].includes(p.name.text))
                pushStr(p.initializer, "zod");
        }
      }
    } else if (isTsx && ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && cfg.objKeys.has(n.name.text)) {
      // Toast option objects are already handled by the toast contexts above.
      const call = n.parent?.parent;
      const isToastArg = call && ts.isCallExpression(call) && /^toast/.test(calleeName(call, sf));
      if (!isToastArg && !excludedByAncestor(n)) pushStr(n.initializer, `obj:${n.name.text}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

// ---------------------------------------------------------------- dictionaries

export function loadDictionaries(messagesDir, { useMachine = true } = {}) {
  const read = (f, fallback) => {
    const p = path.join(messagesDir, f);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : fallback;
  };
  const reviewed = read("pt-BR.json", {});
  const machineRaw = useMachine ? read("pt-BR.machine.json", {}) : {};
  const machine = {};
  for (const [k, v] of Object.entries(machineRaw)) machine[k] = typeof v === "string" ? v : v?.t;
  const overrides = read("overrides.json", {});
  return { reviewed, machine, overrides };
}

const PLACEHOLDER = /\{(\d+)\}/g;
export const placeholders = (s) => [...s.matchAll(/\{[^{}\s]+\}|<\/?\d+>/g)].map((m) => m[0]).sort();

/**
 * Finds a translation for a candidate. Returns { text, source } or null.
 * Templates are also tried with named placeholders ({count}) because the
 * recovered dictionary sometimes uses the variable name instead of {0}.
 */
export function lookup(dicts, cand, rel) {
  const keys = [cand.key];
  let named = null;
  if (cand.kind === "tpl") {
    const names = cand.exprs.map((e) => {
      const m = e.match(/([A-Za-z_$][\w$]*)\s*$/);
      return m ? m[1] : null;
    });
    if (names.every(Boolean) && new Set(names).size === names.length) {
      named = names;
      keys.push(cand.key.replace(PLACEHOLDER, (_, i) => `{${names[+i]}}`));
    }
  }
  for (const key of keys) {
    const tries = [
      [`${rel}#${cand.ctx}#${key}`, "override"],
      [`${rel}#${key}`, "override"],
      [`${cand.ctx}#${key}`, "override"],
    ];
    for (const [k, src] of tries) if (dicts.overrides[k] !== undefined) return finish(dicts.overrides[k], src, key, named);
    if (dicts.reviewed[key] !== undefined) return finish(dicts.reviewed[key], "reviewed", key, named);
    if (dicts.machine[key] !== undefined) return finish(dicts.machine[key], "machine", key, named);
  }
  return null;
}

function finish(text, source, matchedKey, named) {
  if (typeof text !== "string") return null;
  if (named && !/\{\d+\}/.test(matchedKey)) {
    // Convert {count} back to positional {0}.
    text = text.replace(/\{([A-Za-z_$][\w$]*)\}/g, (m, name) => {
      const i = named.indexOf(name);
      return i >= 0 ? `{${i}}` : m;
    });
  }
  return { text, source };
}

// ---------------------------------------------------------------- rendering

const escTemplate = (s) => s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

/**
 * Renders the replacement source text for a candidate, or returns
 * { error } when the translation cannot be applied safely.
 */
export function render(cand, text) {
  switch (cand.kind) {
    case "jsxtext":
      if (/\{\d+\}/.test(text)) return { error: "placeholder in plain text" };
      return { code: `${cand.lead}{${JSON.stringify(text)}}${cand.trail}` };
    case "jsxattr":
      if (/\{\d+\}/.test(text)) return { error: "placeholder in plain text" };
      return { code: /["\\\n\r{}<>&]/.test(text) ? `{${JSON.stringify(text)}}` : `"${text}"` };
    case "str":
      if (/\{\d+\}/.test(text)) return { error: "placeholder in plain text" };
      return { code: JSON.stringify(text) };
    case "tpl": {
      const want = [...cand.key.matchAll(PLACEHOLDER)].map((m) => +m[1]);
      const got = [...text.matchAll(PLACEHOLDER)].map((m) => +m[1]);
      if ([...want].sort().join() !== [...got].sort().join()) return { error: "placeholder mismatch" };
      const reordered = got.join() !== want.join();
      if (reordered && !cand.pure.every(Boolean)) return { error: "reorders impure expressions" };
      const body = text
        .split(/(\{\d+\})/)
        .map((part) => {
          const m = part.match(/^\{(\d+)\}$/);
          return m ? `\${${cand.exprs[+m[1]]}}` : escTemplate(part);
        })
        .join("");
      return { code: `\`${body}\`` };
    }
    default:
      return { error: `unknown kind ${cand.kind}` };
  }
}

/** Histogram of node kinds, ignoring the literal/JSX-text nodes we rewrite. */
export function structureHistogram(sf) {
  const h = {};
  const ignore = (n) =>
    ts.isStringLiteral(n) || ts.isJsxText(n) || ts.isJsxExpression(n) ||
    ts.isTemplateExpression(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateSpan(n) ||
    n.kind === ts.SyntaxKind.TemplateHead || n.kind === ts.SyntaxKind.TemplateMiddle ||
    n.kind === ts.SyntaxKind.TemplateTail;
  const visit = (n) => {
    if (!ignore(n)) h[n.kind] = (h[n.kind] || 0) + 1;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return h;
}

export function histogramDrift(a, b) {
  return Object.keys({ ...a, ...b })
    .filter((k) => (a[k] || 0) !== (b[k] || 0))
    .map((k) => `${ts.SyntaxKind[k]}:${a[k] || 0}->${b[k] || 0}`);
}

export { ts };
