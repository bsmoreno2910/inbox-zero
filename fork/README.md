# Inbox Zero em português (fork bsmoreno2910/inbox-zero)

Este fork roda o [Inbox Zero](https://github.com/elie222/inbox-zero) oficial com a interface em
português do Brasil. O código oficial **nunca é editado no git**: a tradução é aplicada
automaticamente na hora de gerar a imagem, a cada atualização do projeto oficial.

## Como funciona

1. O workflow `ptbr` (GitHub Actions) roda 3 vezes por dia e também quando este branch muda.
2. Ele escolhe o commit mais recente do projeto oficial que **já tem imagem oficial publicada**
   e **passou no build com checagem de tipos** deles.
3. Baixa esse código, aplica a tradução (`fork/i18n`) e verifica:
   - cada arquivo alterado continua válido e com a mesma estrutura;
   - rodar a tradução duas vezes não muda nada;
   - só arquivos `.ts`/`.tsx` mudaram;
   - o TypeScript não ganhou erros novos.
4. Gera a imagem com o `docker/Dockerfile.prod` oficial, sem alterações.
5. Sobe a imagem com banco e Redis de teste e confere que a tela de login está em português.
6. Publica `ghcr.io/bsmoreno2910/inbox-zero-ptbr` com as tags:

| Tag | Significado |
|---|---|
| `:<up7>-<ov7>` | imagem imutável (commit oficial + commit da tradução) — use para voltar atrás |
| `:<up7>` | tradução mais recente para aquele commit oficial |
| `:latest` | imagem mais recente que passou nos testes |
| `:stable` | o que está em produção (só o job de deploy mexe nela) |

O deploy no Easypanel é **opcional e desligado por padrão** (veja abaixo).

## O que é traduzido (e o que não é)

Traduzido: textos da tela, botões, dicas, avisos (toasts), mensagens de erro vindas do servidor,
nomes do menu lateral, títulos de página.

**Nunca traduzido** (porque são dados ou identificadores e quebrariam o sistema):
- nomes de regras e categorias gravados no banco e no Outlook (as suas já estão em português);
- textos enviados para a IA (prompts);
- qualquer texto que o código compara ou usa como chave — a ferramenta detecta isso sozinha
  e mantém em inglês (`blocked.json` no relatório).

## Onde ficam as traduções

| Arquivo | Conteúdo |
|---|---|
| `fork/i18n/messages/pt-BR.json` | dicionário revisado (recuperado da versão antiga em português) |
| `fork/i18n/messages/pt-BR.machine.json` | traduções automáticas de textos novos |
| `fork/i18n/messages/overrides.json` | correções pontuais por arquivo/contexto |

A chave é sempre o **texto exato em inglês**. Textos com variáveis usam `{0}`, `{1}`…
(ex.: `"Archiving {0} of {1} senders..."` → `"Arquivando {0} de {1} remetentes..."`).

Para corrigir uma tradução: edite o valor em `pt-BR.json` (ou crie a entrada nele, que tem
prioridade sobre a automática) e faça commit no branch `ptbr`. O pipeline gera uma imagem nova.

Para corrigir só um lugar específico, use `overrides.json` com uma destas chaves:
`"apps/web/components/SideNav.tsx#jsxText#Archive"`, `"apps/web/components/SideNav.tsx#Archive"`
ou `"attr:aria-label#Archive"`.

Cada execução mostra no resumo do Actions a cobertura e a lista de textos novos sem tradução.

## Rodar localmente

```bash
cd fork/i18n && npm ci
git -C ~/Projetos/inbox-zero pull upstream main
node src/cli.mjs extract --src ~/Projetos/inbox-zero --out /tmp/ptbr-out     # cobertura
node src/cli.mjs apply --src <cópia do código oficial> --verify strict           # aplica
npm test && node src/cli.mjs lint
```

Nunca rode `apply` no clone que você usa para acompanhar o oficial: use uma cópia.

## Easypanel

O serviço `inbox-zero-web` usa **Fonte → Imagem Docker** `ghcr.io/bsmoreno2910/inbox-zero-ptbr:stable`
(desde 22/10/2026). O domínio continua na porta 80: a variável `PORT=80` do ambiente vale para a
imagem. Nenhuma outra variável precisou mudar.

## Configuração no GitHub (uma vez)

- **Settings → Environments → `production`**:
  - segredo `PTBR_CRON_SECRET` com o mesmo valor de `CRON_SECRET` do Easypanel. Sem ele o
    workflow `ptbr-cron` não renova as assinaturas do Outlook e os e-mails novos deixam de chegar
    em ~3 dias;
  - segredo `PTBR_EASYPANEL_DEPLOY_WEBHOOK` com a URL de "Gatilho de Implantação" do serviço
    `inbox-zero-web` no Easypanel (opcional: sem ele, depois de mover `:stable` é só clicar em
    Implantar no Easypanel).
- **Settings → Variables**:
  - `PTBR_APP_URL` = `https://tools-inbox-zero-web.vtc.srv.br`
  - `PTBR_DEPLOY` = `nightly` para publicar sozinho às 03:17 (horário de Brasília); vazio = desligado
  - `PTBR_ALLOW_MIGRATIONS` = `true` só se aceitar que o deploy noturno aplique migrações de banco
- Opcional, tradução automática de textos novos: segredos `PTBR_LLM_BASE_URL`, `PTBR_LLM_API_KEY`
  e variável `PTBR_LLM_MODEL` (qualquer API compatível com OpenAI).
- O pacote `inbox-zero-ptbr` no GHCR já é público, então o Easypanel baixa sem senha.

## Publicar uma versão manualmente

Actions → `ptbr` → **Run workflow**, marcando `deploy`. Quando houver migrações de banco novas,
o deploy automático para e pede isso: faça antes um backup do `inbox-zero-db` no Easypanel.

## Voltar atrás

- **Para uma imagem anterior**: Actions → `ptbr` → Run workflow com `retag_stable_to` =
  `<up7>-<ov7>` da versão boa. Se houve migração de banco no meio, restaure também o backup.
- **Emergência, sem tradução**: no Easypanel, troque a imagem para
  `ghcr.io/elie222/inbox-zero:<up7>` (mesmo código e mesmas migrações, em inglês).

## Branches

- `ptbr` (padrão): só contém `fork/**` e `.github/workflows/ptbr*.yml`. Não tem o código oficial.
- `main`: cópia antiga do oficial, sem uso. Os workflows herdados do oficial são desativados
  automaticamente a cada execução.

## Contribuir com o projeto oficial

A ideia é propor suporte a idiomas no projeto oficial e enviar este dicionário. Antes de abrir
qualquer PR: o projeto exige assinar o `CLA.md` (cessão ampla de direitos, regida pela lei de
Israel). Como a conta é corporativa (vtclog.com.br), confirme com a empresa antes.

## Licença

AGPL-3.0, com os termos adicionais do projeto oficial (proíbe vender o software). Uso interno é
permitido. Este repositório público cumpre a exigência de disponibilizar o código modificado.
