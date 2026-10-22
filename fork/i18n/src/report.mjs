// Markdown coverage summary for $GITHUB_STEP_SUMMARY and artifacts.
import fs from "node:fs";
import path from "node:path";

export function renderSummary(outDir) {
  const read = (f, d) => {
    const p = path.join(outDir, f);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : d;
  };
  const s = read("summary.json", {});
  const missing = read("missing.json", []);
  const apply = read("apply.json", null);
  const lines = [
    "## Tradução pt-BR",
    "",
    "| Métrica | Valor |",
    "|---|---|",
    `| Textos únicos na interface | ${s.uniqueKeys ?? "?"} |`,
    `| Traduzidos (únicos) | ${s.uniqueTranslated ?? "?"} (${s.keyCoverage ?? "?"}%) |`,
    `| Pontos de uso traduzidos | ${s.translatedSites ?? "?"} de ${s.sites ?? "?"} (${s.siteCoverage ?? "?"}%) |`,
    `| Revisados / automáticos (pontos) | ${s.reviewedSites ?? "?"} / ${s.machineSites ?? "?"} |`,
    `| Sem tradução (únicos) | ${s.uniqueMissing ?? "?"} |`,
    `| Protegidos (usados como identificador) | ${s.blockedUnique ?? "?"} |`,
  ];
  if (apply) {
    lines.push(`| Edições aplicadas | ${apply.edits} em ${apply.filesChanged.length} arquivos |`);
    lines.push(`| Mensagens de servidor no runtime | ${apply.runtimeEntries} |`);
    lines.push("", "### Regras de ponto fixo", "");
    for (const site of apply.sites) lines.push(`- ${site.applied ? "✅" : "⚠️"} \`${site.id}\` (${site.file}): esperado ${site.expect}, encontrado ${site.found}`);
    if (apply.problems.length) {
      lines.push("", "### Problemas de verificação", "");
      for (const p of apply.problems.slice(0, 30)) lines.push(`- [${p.kind}] ${p.file}: ${p.detail.join("; ")}`);
    }
  }
  if (missing.length) {
    lines.push("", `### Primeiros textos sem tradução (${missing.length})`, "");
    for (const m of missing.slice(0, 40)) lines.push(`- \`${m.key.replace(/`/g, "'").slice(0, 120)}\` — ${m.files[0] ?? ""}`);
  }
  return `${lines.join("\n")}\n`;
}
