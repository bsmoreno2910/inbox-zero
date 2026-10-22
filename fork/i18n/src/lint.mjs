// Validates the message files. Errors fail CI; warnings are reported only.
// The recovered pt-BR.json is human-reviewed legacy text, so its findings are
// warnings; machine translations and overrides must be clean.
import fs from "node:fs";
import path from "node:path";
import { placeholders } from "./core.mjs";

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

function checkPair(key, value) {
  const issues = [];
  if (typeof value !== "string") return ["value is not a string"];
  if (placeholders(key).join() !== placeholders(value).join())
    issues.push(`placeholders differ: ${placeholders(key).join(" ")} vs ${placeholders(value).join(" ")}`);
  if (/\{\{/.test(value) && !/\{\{/.test(key)) issues.push("introduces {{");
  if (/https?:\/\//.test(value) && !/https?:\/\//.test(key)) issues.push("introduces a URL");
  if (/<[a-z][^>]*>/i.test(value) && !/<[a-z][^>]*>/i.test(key)) issues.push("introduces markup");
  if (CONTROL.test(value)) issues.push("control character");
  if (value.length > key.length * 3 + 20) issues.push("translation much longer than source");
  if (!value.trim()) issues.push("empty translation");
  return issues;
}

export function lintMessages(dir) {
  const errors = [];
  const warnings = [];
  const load = (f) => {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {
      errors.push(`${f}: invalid JSON (${e.message})`);
      return null;
    }
  };
  const reviewed = load("pt-BR.json") || {};
  const machine = load("pt-BR.machine.json") || {};
  const overrides = load("overrides.json") || {};

  for (const [k, v] of Object.entries(reviewed))
    for (const i of checkPair(k, v)) warnings.push(`pt-BR.json ${JSON.stringify(k)}: ${i}`);
  for (const [k, v] of Object.entries(machine)) {
    const t = typeof v === "string" ? v : v?.t;
    for (const i of checkPair(k, t)) errors.push(`pt-BR.machine.json ${JSON.stringify(k)}: ${i}`);
    if (reviewed[k] !== undefined) warnings.push(`pt-BR.machine.json ${JSON.stringify(k)}: shadowed by a reviewed entry`);
  }
  for (const [k, v] of Object.entries(overrides)) {
    const key = k.split("#").pop();
    for (const i of checkPair(key, v)) errors.push(`overrides.json ${JSON.stringify(k)}: ${i}`);
  }
  return { errors, warnings };
}
