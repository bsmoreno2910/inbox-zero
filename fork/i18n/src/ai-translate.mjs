// Optional machine translation of missing strings through an OpenAI-compatible
// endpoint. Only English UI strings from the public upstream source are sent.
// Configure with env PTBR_LLM_BASE_URL, PTBR_LLM_API_KEY, PTBR_LLM_MODEL.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { lintMessages } from "./lint.mjs";
import { placeholders } from "./core.mjs";

const GLOSSARY = `Traduza textos de interface do app "Inbox Zero" do inglês para o português do Brasil.
Regras: tratamento "você"; mesma capitalização do original (sentence case); não traduza nomes de produtos
(Inbox Zero, Outlook, Gmail, Google, Microsoft, Slack, Teams, Telegram); "e-mail" com hífen;
Inbox=Caixa de entrada; Rules=Regras; Assistant=Assistente; Chat=Conversa; Channels=Canais; Archive=Arquivar;
Draft=Rascunho; Sent=Enviados; Sender=Remetente; Unsubscribe=Cancelar inscrição; Bulk Unsubscribe=Cancelamento em massa;
Bulk Archive=Arquivamento em massa; Analytics=Análises; Settings=Configurações; History=Histórico; Digest=Resumo.
Preserve exatamente os marcadores {0}, {1}, {count}, <0>…</0> (podem mudar de posição). Não adicione URLs, HTML ou código.
Responda somente com um objeto JSON {"<texto original>": "<tradução>"}.`;

export async function aiTranslate({ missingFile, max, messagesDir }) {
  const base = process.env.PTBR_LLM_BASE_URL;
  const key = process.env.PTBR_LLM_API_KEY;
  const model = process.env.PTBR_LLM_MODEL;
  if (!base || !key || !model) {
    console.log("ai: PTBR_LLM_BASE_URL / PTBR_LLM_API_KEY / PTBR_LLM_MODEL not set, skipping");
    return 0;
  }
  const missing = JSON.parse(fs.readFileSync(missingFile, "utf8")).slice(0, max);
  const machinePath = path.join(messagesDir, "pt-BR.machine.json");
  const machine = fs.existsSync(machinePath) ? JSON.parse(fs.readFileSync(machinePath, "utf8")) : {};
  let added = 0;
  for (let i = 0; i < missing.length; i += 60) {
    const batch = missing.slice(i, i + 60);
    const res = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: GLOSSARY },
          { role: "user", content: JSON.stringify(batch.map((m) => ({ text: m.key, where: m.contexts.join(",") }))) },
        ],
      }),
    });
    if (!res.ok) {
      console.warn(`ai: batch ${i / 60 + 1} failed with HTTP ${res.status}`);
      continue;
    }
    const body = await res.json();
    let parsed;
    try {
      parsed = JSON.parse(body.choices?.[0]?.message?.content ?? "{}");
    } catch {
      console.warn(`ai: batch ${i / 60 + 1} returned invalid JSON`);
      continue;
    }
    for (const { key: en } of batch) {
      const pt = parsed[en];
      if (typeof pt !== "string" || !pt.trim() || pt === en) continue;
      if (placeholders(en).join() !== placeholders(pt).join()) continue;
      machine[en] = {
        t: pt,
        src: crypto.createHash("sha1").update(en).digest("hex").slice(0, 8),
        model,
        date: new Date().toISOString().slice(0, 10),
      };
      added++;
    }
  }
  const sorted = Object.fromEntries(Object.keys(machine).sort().map((k) => [k, machine[k]]));
  fs.writeFileSync(machinePath, `${JSON.stringify(sorted, null, 2)}\n`);
  const { errors } = lintMessages(messagesDir);
  if (errors.length) console.warn(`ai: lint reports ${errors.length} errors after merge`);
  return added;
}
