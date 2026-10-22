import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildLogicIndex, extractCandidates, jsxTextKey, loadContexts, looksIdent, lookup, parseFile, render,
} from "../src/core.mjs";

const CONFIG = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "config");
const cfg = loadContexts(CONFIG);

function sfFrom(code, name = "x.tsx") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ptbr-test-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, code);
  return parseFile(file);
}

const dicts = (reviewed, machine = {}, overrides = {}) => ({ reviewed, machine, overrides });

test("JSX text keys follow JSX whitespace rules", () => {
  assert.equal(jsxTextKey("\n    Hello\n    world  \n  "), "Hello world");
  assert.equal(jsxTextKey("I&apos;ve fixed them"), "I've fixed them");
});

test("identifier-looking strings and CSS class lists are skipped", () => {
  for (const s of ["inbox", "CATEGORY_PERSONAL", "camelCase", "/settings", "a@b.com", "{{name}}", "mt-0.5 text-sm leading-5"])
    assert.equal(looksIdent(s), true, s);
  for (const s of ["Try again", "Settings", "Follow-up reminders"]) assert.equal(looksIdent(s), false, s);
});

test("extracts JSX text, allowlisted attributes and toast text", () => {
  const sf = sfFrom(`
    export function A() {
      toastError({ title: "Failed to save", description: "Try again" });
      return <div title="Hello there" className="mt-2 text-sm"><p>Try again</p><Input name="emailAddress" placeholder="Your email" /></div>;
    }`);
  const keys = extractCandidates(sf, cfg).map((c) => `${c.ctx}|${c.key}`).sort();
  assert.deepEqual(keys, [
    "attr:placeholder|Your email",
    "attr:title|Hello there",
    "jsxText|Try again",
    "toast:description|Try again",
    "toast:title|Failed to save",
  ]);
});

test("objects passed to server actions or form defaults are not translated", () => {
  const sf = sfFrom(`
    const opts = [{ label: "Daily", value: "daily" }];
    createRuleAction({ description: "Stored in DB" });
    useForm({ defaultValues: { title: "Default title" } });`);
  const keys = extractCandidates(sf, cfg).map((c) => c.key);
  assert.deepEqual(keys, ["Daily"]);
});

test("the identifier guard blocks literals compared elsewhere", () => {
  const ui = sfFrom(`export const B = () => <Tab label="Remind me" />;`, "ui.tsx");
  const logicFile = sfFrom(`if (label === "Remind me") doSomething();`, "logic.ts");
  const parsed = new Map([[ui.fileName, ui], [logicFile.fileName, logicFile]]);
  const logic = buildLogicIndex(parsed, "/");
  assert.ok(logic.has("Remind me"));
  const [cand] = extractCandidates(ui, cfg);
  assert.equal(cand.renderOnly, false); // <Tab> is a component, so it stays blocked
});

test("text inside intrinsic elements is render-only even if the value is an identifier elsewhere", () => {
  const sf = sfFrom(`export const C = () => <span>Archive</span>;`);
  const [cand] = extractCandidates(sf, cfg);
  assert.equal(cand.renderOnly, true);
});

test("templates keep their expressions and only reorder pure ones", () => {
  const sf = sfFrom("export const D = () => toast(`Moved ${count} of ${total} emails`);");
  const [cand] = extractCandidates(sf, cfg);
  assert.equal(cand.key, "Moved {0} of {1} emails");
  assert.equal(render(cand, "{1} no total, {0} movidos").code, "`${total} no total, ${count} movidos`");
  const impure = sfFrom("export const E = () => toast(`Moved ${next()} of ${total} emails`);");
  const [c2] = extractCandidates(impure, cfg);
  assert.match(render(c2, "{1} no total, {0} movidos").error, /impure/);
  assert.match(render(c2, "Movidos {0} de {1}").code, /`Movidos \$\{next\(\)\} de \$\{total\}`/);
});

test("named placeholders from the recovered dictionary map back to positions", () => {
  const sf = sfFrom("export const F = () => toast(`+ ${count} more senders not shown`);");
  const [cand] = extractCandidates(sf, cfg);
  const hit = lookup(dicts({ "+ {count} more senders not shown": "+ {count} outros remetentes" }), cand, "f.tsx");
  assert.equal(hit.text, "+ {0} outros remetentes");
});

test("rendering escapes quotes, backslashes and template markers", () => {
  const sf = sfFrom(`export const G = () => <p title='Say "hi"'>Hi</p>;`);
  const [attr, text] = extractCandidates(sf, cfg);
  assert.equal(render(attr, 'Diga "oi"').code, '{"Diga \\"oi\\""}');
  assert.equal(render(text, "Olá").code, '{"Olá"}');
  assert.match(render(text, "Olá {0}").error, /placeholder/);
});

test("overrides win over the reviewed dictionary", () => {
  const sf = sfFrom(`export const H = () => <button>Archive</button>;`);
  const [cand] = extractCandidates(sf, cfg);
  const d = dicts({ Archive: "Arquivar" }, {}, { "jsxText#Archive": "Arquivo" });
  assert.equal(lookup(d, cand, "h.tsx").text, "Arquivo");
});
