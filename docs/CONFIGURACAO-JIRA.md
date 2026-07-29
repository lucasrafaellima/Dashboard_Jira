# Conectar o dashboard à API do Jira

Este guia explica **onde colocar a URL, o e-mail e o token da API** para o dashboard
puxar as issues sozinho, sem precisar exportar planilha nenhuma.

Tempo estimado: 5 minutos.

---

## Resumo em 4 passos

| # | O que fazer | Onde |
|---|---|---|
| 1 | Gerar o token da API | site da Atlassian |
| 2 | Guardar URL + e-mail + token | arquivo `.env` **ou** tela "Configurar Jira" |
| 3 | Escolher os projetos | mesma configuração do passo 2 |
| 4 | Sincronizar | botão **⟳ Sincronizar Jira** ou `npm run sync` |

---

## Passo 1 — Gerar o token da API

O Jira **não** aceita a sua senha normal em integrações. É preciso um *token de API*.

1. Abra <https://id.atlassian.com/manage-profile/security/api-tokens>
   (ou: foto do seu perfil no Jira → **Gerenciar conta** → aba **Segurança** →
   **Criar e gerenciar tokens de API**).
2. Clique em **Criar token de API**.
3. Dê um nome que você reconheça depois, por exemplo `dashboard-jira`.
4. Escolha a validade e confirme.
5. **Copie o token agora.** A Atlassian mostra o valor uma única vez; se você
   fechar a janela, terá que criar outro.

Anote também estes dois dados:

- **URL do site**: o endereço que aparece no navegador quando você usa o Jira,
  só até `.net`. Exemplo: `https://rbdantas.atlassian.net`.
- **E-mail**: o e-mail com que você entra na Atlassian.

> **Jira Server / Data Center** (instalado na empresa, sem `.atlassian.net`):
> em vez do token de API, gere um **Personal Access Token** no seu perfil e
> **deixe o campo de e-mail vazio** — o dashboard detecta isso e autentica com
> `Bearer` em vez de `Basic`.

---

## Passo 2 — Guardar as credenciais

Escolha **uma** das duas formas. Elas fazem a mesma coisa.

### Opção A — arquivo `.env` (recomendada)

Na pasta do projeto existe o modelo `.env.example`. Copie para `.env` e preencha.

No PowerShell, dentro da pasta `Dashboard_Jira`:

```powershell
Copy-Item .env.example .env
notepad .env
```

Preencha assim (sem aspas, sem espaço em volta do `=`):

```dotenv
JIRA_URL=https://rbdantas.atlassian.net
JIRA_EMAIL=voce@empresa.com
JIRA_TOKEN=ATATT3xFfGF0...o_token_que_voce_copiou
JIRA_PROJETOS=CRM,HUB,AR
JIRA_INTERVALO_MIN=30
```

Salve o arquivo e reinicie o servidor (`npm start`). Pronto.

O `.env` fica na **raiz do projeto**, do lado de `package.json`:

```
Dashboard_Jira/
├── .env            <-- aqui
├── .env.example
├── package.json
├── server.js
├── docs/
├── public/
└── src/
```

### Opção B — pela tela do dashboard

1. Rode `npm start` e abra <http://localhost:3000>.
2. Clique em **Configurar Jira** (canto superior direito).
3. Preencha URL, e-mail e token.
4. Clique em **Testar conexão** — deve aparecer *"Conectado como Fulano"*.
5. Clique em **Salvar e sincronizar**.

O que você digitar aí é gravado em `config/jira.json`, também fora do Git.

> Se o mesmo dado estiver nos dois lugares, o `.env` vence. A tela avisa quando
> um campo está travado pelo `.env` e por isso não pode ser editado ali.

---

## Passo 3 — Escolher os projetos

O dashboard precisa saber **quais projetos** trazer.

Para descobrir as chaves disponíveis, rode:

```powershell
npm run jira:testar
```

A saída lista as chaves e os nomes, por exemplo:

```
Projetos visíveis (6):
  AR           APP Receituário
  CRM          CRM Loja/Campo
  GCW          Coagro Work
  HC           HUB Configurador
  HUB          HUB
  WIK          Workflow(Kestra)
```

Coloque as chaves desejadas em `JIRA_PROJETOS` (ou no campo **Projetos** da tela),
separadas por vírgula:

```dotenv
JIRA_PROJETOS=CRM,HUB,AR,GCW,HC,WIK
```

- **Deixar vazio** = traz tudo que a conta enxerga.
- Precisa de um recorte mais fino? Use `JIRA_JQL`, que substitui a lista de projetos:

```dotenv
JIRA_JQL=project in (CRM, HUB) AND created >= "2025-01-01"
```

---

## Passo 4 — Sincronizar

| Como | Comando / botão | O que faz |
|---|---|---|
| Pela tela | **⟳ Sincronizar Jira** | busca só o que mudou desde a última vez |
| Pela tela | **Sincronização completa** (dentro de *Configurar Jira*) | relê tudo e apaga da base as issues que sumiram do Jira |
| Terminal | `npm run sync` | igual ao botão ⟳ |
| Terminal | `npm run sync:completa` | igual à sincronização completa |
| Automático | `JIRA_INTERVALO_MIN=30` | sincroniza sozinho a cada 30 min com o servidor ligado |

A primeira sincronização traz o histórico inteiro e pode demorar alguns minutos.
As seguintes são rápidas: o dashboard guarda a data da última issue atualizada e
pede ao Jira apenas `updated >= (essa data - 15 min)`.

No rodapé do dashboard, a tabela **Origens sincronizadas do Jira** mostra quando
cada projeto foi atualizado pela última vez e se houve erro.

---

## Como saber que deu certo

Ao subir o servidor, o terminal mostra:

```
Dashboard Jira em http://localhost:3000  (1284 itens na base)
[jira] conectado a https://rbdantas.atlassian.net — projetos: CRM, HUB, AR
```

E no topo do dashboard aparece uma etiqueta verde com o site e a data da última
sincronização. Se estiver cinza (*"Jira não configurado"*) ou vermelha, algo
falhou — veja a seção seguinte.

---

## Problemas comuns

| Mensagem | Causa e solução |
|---|---|
| **Credenciais recusadas (401)** | Token errado, expirado, ou e-mail diferente do da conta Atlassian. Gere outro token e confira o e-mail. Em Jira Server, o campo e-mail precisa ficar **vazio**. |
| **Acesso negado (403)** | A conta não tem permissão de leitura nesse projeto. Peça acesso ao administrador do Jira. Também acontece após várias tentativas de login erradas: entre pelo navegador e resolva o CAPTCHA. |
| **Recurso não encontrado (404)** | URL errada. Deve ser só `https://empresa.atlassian.net`, sem `/jira`, sem `/browse/...` e sem barra no final. |
| **O JQL informado não é válido** | Erro de sintaxe no `JIRA_JQL`. Teste a consulta antes no próprio Jira, em *Filtros → Pesquisa avançada*. |
| **O Jira limitou a taxa (429)** | Muitas requisições. O dashboard já repete sozinho; se persistir, aumente o `JIRA_INTERVALO_MIN`. |
| **Não consegui falar com o site** | Sem internet, VPN desligada, ou proxy da empresa bloqueando. |
| Etiqueta segue **"Jira não configurado"** | O `.env` não foi salvo na pasta certa, ou o servidor não foi reiniciado depois de criá-lo. |

Para diagnosticar pelo terminal, com mensagens mais detalhadas:

```powershell
npm run jira:testar
```

---

## Segurança

- `.env` e `config/jira.json` estão no `.gitignore` — **não** vão para o Git.
- O token nunca é devolvido para o navegador: a tela só mostra os 4 últimos
  caracteres.
- Por padrão o servidor escuta apenas em `127.0.0.1` (só esta máquina), porque
  ele guarda o token. Para liberar na rede local, rode com `HOST=0.0.0.0` —
  mas aí qualquer pessoa da rede poderá disparar sincronizações pelo dashboard.
- Se o token vazar, revogue na mesma página onde foi criado.
- Quem sincroniza é a *sua* conta: o dashboard enxerga exatamente os projetos e
  issues que você enxerga no Jira.

---

## O que mudou em relação às planilhas

A importação de `.xlsx`/`.csv` **continua funcionando** (botão **Planilha**), útil
para dados históricos que não estão mais no Jira. As duas fontes gravam na mesma
tabela e são deduplicadas pela chave da issue (`CRM-142`).

Quando a mesma issue vem das duas fontes, **vence a mais recente** pelo campo
*Atualizado*, e a issue passa a pertencer à origem da API. Na prática: depois da
primeira sincronização, você pode parar de exportar planilha.
