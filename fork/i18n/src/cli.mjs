#!/usr/bin/env node
// pt-BR overlay CLI. See fork/README.md.
//   extract --src <dir> --out <dir> [--update-catalog]
//   apply   --src <dir> [--verify strict|off] [--build-id <id>] [--dry-run] [--out <dir>]
//   lint
//   report  --out <dir> [--summary <file.md>]
//   ai      --missing <file> [--max N]
import fs from "node:fs";
import path from "node:path";
import { lintMessages } from "./lint.mjs";
import { aiTranslate } from "./ai-translate.mjs";
import { analyze, apply, buildReports, FORK_I18N } from "./pipeline.mjs";
import { renderSummary } from "./report.mjs";

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[k] = true;
      else { out[k] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
};

const useMachine = process.env.PTBR_USE_MACHINE !== "false";
const [cmd, ...rest] = process.argv.slice(2);
const opt = args(rest);

try {
  switch (cmd) {
    case "extract": {
      if (!opt.src || !opt.out) throw new Error("usage: extract --src <dir> --out <dir>");
      const reports = buildReports(analyze(path.resolve(opt.src), { useMachine }));
      const out = path.resolve(opt.out);
      writeJson(path.join(out, "summary.json"), reports.summary);
      writeJson(path.join(out, "catalog.json"), reports.catalog);
      writeJson(path.join(out, "missing.json"), reports.missing);
      writeJson(path.join(out, "blocked.json"), reports.blocked);
      if (opt["update-catalog"]) {
        writeJson(path.join(FORK_I18N, "catalog", "strings.json"), reports.catalog);
      }
      console.log(JSON.stringify(reports.summary, null, 2));
      break;
    }
    case "apply": {
      if (!opt.src) throw new Error("usage: apply --src <dir>");
      const result = apply(path.resolve(opt.src), {
        dryRun: !!opt["dry-run"],
        verify: opt.verify === "off" ? "off" : "strict",
        buildId: typeof opt["build-id"] === "string" ? opt["build-id"] : "dev",
        useMachine,
      });
      const { reports, ...rest } = result;
      if (opt.out) {
        const out = path.resolve(opt.out);
        writeJson(path.join(out, "apply.json"), rest);
        writeJson(path.join(out, "summary.json"), reports.summary);
        writeJson(path.join(out, "missing.json"), reports.missing);
        writeJson(path.join(out, "blocked.json"), reports.blocked);
      }
      console.log(JSON.stringify({
        edits: rest.edits, filesChanged: rest.filesChanged.length, runtimeEntries: rest.runtimeEntries,
        secondPassEdits: rest.secondPassEdits, skipped: rest.skipped.renderError, overlap: rest.skipped.overlap,
        sites: rest.sites.map((s) => `${s.id}:${s.applied ? "ok" : `SKIPPED(found ${s.found})`}`),
        coverage: reports.summary, problems: rest.problems.length,
      }, null, 2));
      if (rest.problems.length) {
        console.error("Verification problems:");
        for (const p of rest.problems.slice(0, 50)) console.error(`- [${p.kind}] ${p.file}: ${p.detail.join("; ")}`);
        process.exitCode = 1;
      }
      break;
    }
    case "lint": {
      const { errors, warnings } = lintMessages(path.join(FORK_I18N, "messages"));
      for (const w of warnings.slice(0, 40)) console.warn(`warn: ${w}`);
      if (warnings.length > 40) console.warn(`... ${warnings.length - 40} more warnings`);
      for (const e of errors) console.error(`error: ${e}`);
      console.log(`lint: ${errors.length} errors, ${warnings.length} warnings`);
      if (errors.length) process.exitCode = 1;
      break;
    }
    case "report": {
      if (!opt.out) throw new Error("usage: report --out <dir> [--summary <file>]");
      const out = path.resolve(opt.out);
      const md = renderSummary(out);
      if (typeof opt.summary === "string") fs.appendFileSync(opt.summary, md);
      fs.writeFileSync(path.join(out, "summary.md"), md);
      console.log(md);
      break;
    }
    case "ai": {
      if (!opt.missing) throw new Error("usage: ai --missing <file> [--max N]");
      const n = await aiTranslate({
        missingFile: path.resolve(opt.missing),
        max: opt.max ? Number(opt.max) : 400,
        messagesDir: path.join(FORK_I18N, "messages"),
      });
      console.log(`ai: ${n} new machine translations`);
      break;
    }
    default:
      console.error("commands: extract | apply | lint | report | ai");
      process.exitCode = 2;
  }
} catch (err) {
  console.error(err.stack || String(err));
  process.exitCode = 1;
}
