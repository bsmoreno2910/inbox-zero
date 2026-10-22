// Orchestrates extract and apply over an upstream checkout.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildLogicIndex, extractCandidates, histogramDrift, listLogicFiles, loadContexts,
  loadDictionaries, loadScope, lookup, parseFile, render, structureHistogram, ts,
} from "./core.mjs";

export const FORK_I18N = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = path.join(FORK_I18N, "config");
const MESSAGES = path.join(FORK_I18N, "messages");
const RUNTIME_TMPL = path.join(FORK_I18N, "runtime", "runtime.ts.tmpl");
export const RUNTIME_REL = "apps/web/__ptbr__/runtime.ts";

/** Parses the tree and returns candidates grouped by file, plus the guard. */
export function analyze(srcRoot, { useMachine = true } = {}) {
  const inScope = loadScope(CONFIG);
  const cfg = loadContexts(CONFIG);
  const dicts = loadDictionaries(MESSAGES, { useMachine });
  const files = listLogicFiles(srcRoot);
  const parsed = new Map();
  for (const f of files) parsed.set(f, parseFile(f));
  const logic = buildLogicIndex(parsed, srcRoot);

  const byFile = new Map();
  for (const [file, sf] of parsed) {
    const rel = path.relative(srcRoot, file);
    if (!inScope(rel)) continue;
    const cands = extractCandidates(sf, cfg);
    for (const c of cands) {
      c.blocked = logic.has(c.key) && !c.renderOnly;
      c.blockedBy = c.blocked ? logic.get(c.key).slice(0, 3) : undefined;
      c.translation = c.blocked ? null : lookup(dicts, c, rel);
    }
    if (cands.length) byFile.set(rel, { sf, cands });
  }
  return { parsed, logic, byFile, dicts, fileCount: files.length };
}

/** Builds catalog / missing / blocked reports from an analysis. */
export function buildReports(analysis) {
  const catalog = new Map(); // key -> { contexts:Set, files:Set, sites, translated, source }
  const blocked = new Map();
  let sites = 0, translatedSites = 0, reviewedSites = 0, machineSites = 0;
  for (const [rel, { cands }] of analysis.byFile) {
    for (const c of cands) {
      if (c.blocked) {
        if (!blocked.has(c.key)) blocked.set(c.key, { where: c.blockedBy, files: new Set() });
        blocked.get(c.key).files.add(rel);
        continue;
      }
      sites++;
      if (!catalog.has(c.key)) catalog.set(c.key, { contexts: new Set(), files: new Set(), sites: 0, source: null });
      const e = catalog.get(c.key);
      e.contexts.add(c.ctx); e.files.add(rel); e.sites++;
      if (c.translation) {
        translatedSites++;
        if (c.translation.source === "machine") machineSites++; else reviewedSites++;
        e.source = e.source === "reviewed" ? "reviewed" : c.translation.source;
      }
    }
  }
  const keys = [...catalog.keys()].sort();
  const missing = keys.filter((k) => !catalog.get(k).source).map((k) => ({
    key: k, contexts: [...catalog.get(k).contexts], files: [...catalog.get(k).files].slice(0, 5),
  }));
  const summary = {
    filesScanned: analysis.fileCount,
    filesWithCandidates: analysis.byFile.size,
    sites, translatedSites, reviewedSites, machineSites,
    siteCoverage: sites ? +(100 * translatedSites / sites).toFixed(1) : 0,
    uniqueKeys: keys.length,
    uniqueTranslated: keys.length - missing.length,
    uniqueMissing: missing.length,
    keyCoverage: keys.length ? +(100 * (keys.length - missing.length) / keys.length).toFixed(1) : 0,
    blockedUnique: blocked.size,
  };
  return {
    summary,
    catalog: Object.fromEntries(keys.map((k) => [k, { contexts: [...catalog.get(k).contexts].sort(), files: [...catalog.get(k).files].sort() }])),
    missing,
    blocked: [...blocked.entries()].map(([key, v]) => ({ key, where: v.where, files: [...v.files].slice(0, 5) })),
  };
}

/** Applies translations in place. Returns a result object; never throws on drift. */
export function apply(srcRoot, { dryRun = false, verify = "strict", buildId = "dev", useMachine = true } = {}) {
  const analysis = analyze(srcRoot, { useMachine });
  const problems = [];
  const changed = new Map(); // rel -> new text
  const skipped = { renderError: [], overlap: 0 };
  let edits = 0;

  for (const [rel, { sf, cands }] of analysis.byFile) {
    const planned = [];
    for (const c of cands) {
      if (c.blocked || !c.translation) continue;
      const r = render(c, c.translation.text);
      if (r.error) { skipped.renderError.push({ file: rel, key: c.key, why: r.error }); continue; }
      if (sf.text.slice(c.start, c.end) === r.code) continue;
      planned.push({ start: c.start, end: c.end, code: r.code });
    }
    if (!planned.length) continue;
    planned.sort((a, b) => a.start - b.start || b.end - a.end);
    const kept = [];
    let lastEnd = -1;
    for (const e of planned) {
      if (e.start >= lastEnd) { kept.push(e); lastEnd = e.end; } else skipped.overlap++;
    }
    let text = sf.text;
    for (const e of kept.sort((a, b) => b.start - a.start)) {
      text = text.slice(0, e.start) + e.code + text.slice(e.end);
      edits++;
    }
    if (verify === "strict") {
      const sf2 = parseFile(sf.fileName, text);
      if (sf2.parseDiagnostics.length > sf.parseDiagnostics.length)
        problems.push({ file: rel, kind: "parse", detail: sf2.parseDiagnostics.slice(0, 2).map((d) => ts.flattenDiagnosticMessageText(d.messageText, " ")) });
      const drift = histogramDrift(structureHistogram(sf), structureHistogram(sf2));
      if (drift.length) problems.push({ file: rel, kind: "structure", detail: drift.slice(0, 5) });
    }
    changed.set(rel, text);
  }

  // Site rules (exact-text edits), evaluated per group: all-or-nothing.
  const sites = JSON.parse(fs.readFileSync(path.join(CONFIG, "sites.json"), "utf8")).rules;
  const siteReport = [];
  const groups = new Map();
  for (const rule of sites) {
    const g = rule.group || rule.id;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(rule);
  }
  for (const [, rules] of groups) {
    const results = rules.map((rule) => {
      const abs = path.join(srcRoot, rule.file);
      const current = changed.get(rule.file) ?? (fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null);
      if (current === null) return { rule, ok: false, found: 0 };
      if (rule.type === "replace") {
        const found = current.split(rule.find).length - 1;
        return { rule, ok: found === rule.expect, found };
      }
      if (rule.type === "afterImports") return { rule, ok: true, found: 1 };
      return { rule, ok: false, found: 0 };
    });
    const allOk = results.every((r) => r.ok);
    for (const { rule, ok, found } of results) {
      siteReport.push({ id: rule.id, file: rule.file, expect: rule.expect, found, applied: allOk });
      if (!allOk && rule.required) problems.push({ file: rule.file, kind: "required-site", detail: [`${rule.id}: expected ${rule.expect}, found ${found}`] });
    }
    if (!allOk) continue;
    for (const { rule } of results) {
      const abs = path.join(srcRoot, rule.file);
      let text = changed.get(rule.file) ?? fs.readFileSync(abs, "utf8");
      if (rule.type === "replace") {
        text = text.split(rule.find).join(rule.replace.replaceAll("{{BUILD_ID}}", buildId));
      } else if (rule.type === "afterImports") {
        const sf = parseFile(abs, text);
        const imports = sf.statements.filter((s) => ts.isImportDeclaration(s));
        const at = imports.length ? imports[imports.length - 1].end : 0;
        text = text.slice(0, at) + "\n" + rule.code + text.slice(at);
      }
      const sf2 = parseFile(abs, text);
      if (sf2.parseDiagnostics.length) problems.push({ file: rule.file, kind: "parse-site", detail: [rule.id] });
      changed.set(rule.file, text);
    }
  }

  // Runtime map: dictionary entries that are not already baked in at build time.
  const staticKeys = new Set();
  for (const [, { cands }] of analysis.byFile)
    for (const c of cands) if (!c.blocked && c.translation) staticKeys.add(c.key);
  const runtimeMap = {};
  for (const src of [analysis.dicts.machine, analysis.dicts.reviewed])
    for (const [k, v] of Object.entries(src))
      if (typeof v === "string" && v !== k && !/\{[^{}\s]+\}/.test(k) &&
          // Text baked in at build time is not needed at runtime, except short
          // labels, which can also arrive as data (sidebar names, stored errors).
          (!staticKeys.has(k) || k.length <= 40)) runtimeMap[k] = v;
  const tmpl = fs.readFileSync(RUNTIME_TMPL, "utf8");
  const runtime = tmpl.replace('/*__PTBR_MAP__*/ "{}"', JSON.stringify(JSON.stringify(runtimeMap)));
  changed.set(RUNTIME_REL, runtime);

  // Idempotence: a second pass over the rewritten text must not find new edits.
  let secondPassEdits = 0;
  if (verify === "strict") {
    for (const [rel, text] of changed) {
      if (rel === RUNTIME_REL || !analysis.byFile.has(rel)) continue;
      const sf2 = parseFile(path.join(srcRoot, rel), text);
      const cfg = loadContexts(CONFIG);
      for (const c of extractCandidates(sf2, cfg)) {
        if (analysis.logic.has(c.key) && !c.renderOnly) continue;
        const t = lookup(analysis.dicts, c, rel);
        if (!t) continue;
        const r = render(c, t.text);
        if (!r.error && sf2.text.slice(c.start, c.end) !== r.code) secondPassEdits++;
      }
    }
    if (secondPassEdits) problems.push({ file: "*", kind: "idempotence", detail: [`${secondPassEdits} edits on second pass`] });
  }

  if (!dryRun) {
    for (const [rel, text] of changed) {
      const abs = path.join(srcRoot, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text);
    }
  }
  return {
    edits,
    filesChanged: [...changed.keys()].sort(),
    runtimeEntries: Object.keys(runtimeMap).length,
    secondPassEdits,
    skipped: { overlap: skipped.overlap, renderError: skipped.renderError.length, renderErrorSample: skipped.renderError.slice(0, 20) },
    sites: siteReport,
    problems,
    reports: buildReports(analysis),
  };
}
