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
| Pela tela | **Sincronização completa** (dentro de *Configurar Jira*) | relê todas as issues, campo por campo |
| Terminal | `npm run sync` | igual ao botão ⟳ |
| Terminal | `npm run sync:completa` | igual à sincronização completa |
| Automático | `JIRA_INTERVALO_MIN=30` | sincroniza sozinho a cada 30 min com o servidor ligado |

A primeira sincronização traz o histórico inteiro e pode demorar alguns minutos.
As seguintes são rápidas: o dashboard guarda a data da última issue atualizada e
pede ao Jira apenas `updated >= (essa data - 15 min)`.

No rodapé do dashboard, a tabela **Origens sincronizadas do Jira** mostra quando
cada projeto foi atualizado pela última vez e se houve erro.

### Issues excluídas saem em qualquer sincronização

**Toda** passada — a incremental inclusive — confere o que ainda existe no Jira
e apaga da base o que não existe mais. Não é preciso rodar a completa para
isso.

A conferência é necessária porque a passada incremental pede só
`updated >= marca d'água`: uma issue **excluída não aparece em resposta
nenhuma**, e sem perguntar quem ainda está lá não há como distinguir "não
mudou" de "não existe mais" — era assim que tickets apagados ficavam encalhados
no dashboard.

A pergunta é barata: uma consulta que traz só as chaves, sem resumo nem
comentários. Um projeto de 1.165 issues cabe numa requisição de ~110 KB, em
menos de meio segundo.

Em três situações **nada** é removido, porque apagariam dado bom — e o motivo
aparece como aviso na origem:

- a listagem falhou (sem lista, todo mundo pareceria ausente);
- a listagem bateu no teto de leitura (o que ficou de fora não está excluído);
- veio vazia com a base cheia — mais provável ter perdido acesso ao projeto do
  que alguém ter apagado todas as issues de uma vez.

> Com um `JIRA_JQL` personalizado, "não existe mais" quer dizer **não casa mais
> com a consulta**. Uma issue que saiu do filtro sai da base também: ali a base
> é o espelho da consulta, não do projeto inteiro.

---

## Os gráficos são filtros

Clicar em qualquer parte de um gráfico filtra o dashboard inteiro — uma fatia da
pizza, uma barra, o rótulo ao lado dela. Clicar de novo desfaz.

| Gráfico | O que filtra |
|---|---|
| Status das Atividades | status |
| Atividades concluídas por responsável | responsável |
| Tickets criados por espaços | espaço |
| Tickets por épico | épico |
| Por tipo de item | tipo |
| Por prioridade | prioridade |
| Evolução mensal | recorta o período no mês clicado |

Os filtros se acumulam entre si e com os segmentadores e as datas do topo.
**Limpar filtros** zera tudo. Tipo, status e prioridade não têm segmentador
próprio: o gráfico é a única forma de filtrá-los.

O que está selecionado fica com contorno; o resto desbota, **mas continua na
tela e clicável** — é assim que se troca de seleção sem precisar desfazer
primeiro. Por isso cada gráfico ignora o próprio filtro e obedece a todos os
outros: marcar um espaço muda o gráfico de status, mas o gráfico de status
segue mostrando todos os status.

O gráfico mensal segue a mesma regra e ignora o recorte de datas: mostra sempre
a linha do tempo inteira, para dar de pular de um mês para outro num clique.

Ao aproximar o cursor, a categoria inteira acende — a mesma área que responde
ao clique, então dá para ver o que vai ser filtrado antes de clicar. O que está
desbotado acende parcialmente, lembrando que continua clicável.

Ao filtrar, as barras crescem da base e as fatias surgem, em cascata. Se a
resposta demorar mais de 140 ms, o painel esmaece de leve enquanto os dados
novos não chegam; abaixo disso não há nada, para um clique rápido não piscar.
Quem usa `prefers-reduced-motion` no sistema não vê animação nenhuma, e no PDF
elas também não entram.

> As marcas respondem ao teclado: `Tab` para navegar, `Enter` ou espaço para
> filtrar.

---

## Como o período conta criadas e concluídas

O recorte de datas no topo do dashboard delimita um **período de análise**, e
dentro dele cada número responde a uma pergunta diferente:

| Indicador | O que conta |
|---|---|
| **Atividades criadas** | nasceram dentro do período |
| **Atividades concluídas** | foram concluídas dentro do período — **não importa quando nasceram** |
| **Taxa de conclusão** | das que **nasceram** no período, quantas foram **também concluídas dentro dele** |

Uma atividade aberta em julho e fechada em agosto conta como *criada de julho* e
*concluída de agosto*. O mérito do fechamento é do mês que fechou. A tabela de
atividades mostra a união das duas populações, então o total dela bate com os
cartões de cima.

### A taxa e o cartão "concluídas" respondem coisas diferentes

Os dois números **não batem de propósito**, e é fácil estranhar:

- **Atividades concluídas** olha o *fluxo* do período: quem fechou nesses dias,
  tenha nascido quando tiver.
- **Taxa de conclusão** olha o *ciclo fechado*: dos tickets que nasceram no
  período, quantos também foram concluídos dentro dele — entraram e saíram sem
  atravessar a virada do mês. O que ficou para o mês seguinte **não conta**, e
  por isso a taxa **nunca passa de 100%**.

No Suporte em agosto/2026, por exemplo: 39 criadas, **44 concluídas** no mês
(mais do que entrou, porque limpou fila antiga), e taxa de **74,36%** — das 39
que nasceram em agosto, 29 fecharam ainda em agosto. O Panorama mostra os dois
números lado a lado, em *Concluídas no período* e *Criadas e concluídas dentro
do período*.

> Um ticket aberto em 30 de julho e fechado em 2 de agosto não entra na taxa de
> julho (não fechou no mês) nem na de agosto (não nasceu no mês). Ele aparece
> normalmente nas *Atividades concluídas* de agosto e na tabela — só não conta
> como ciclo fechado em mês nenhum.

> Sem nenhuma data preenchida, as duas populações são a base inteira e os dois
> números coincidem.

### De onde sai a data de conclusão

Na melhor fonte disponível, nesta ordem:

1. **`resolutiondate`** — a data oficial em que o Jira registrou a resolução;
2. **`statuscategorychangedate`** — quando o item entrou na categoria *concluído*,
   para os workflows que fecham sem preencher resolução (o Suporte fecha assim,
   em *FECHADO*, sem resolução nenhuma);
3. **`Atualizado(a)`** — último recurso, para linhas de planilha antiga sem
   nenhuma das duas.

O "Atualizado(a)" sozinho **não serve**: basta alguém comentar num chamado
fechado no mês passado para a data pular para o mês atual e levar a conclusão
junto. A coluna **Concluído em**, na tabela e no `.xlsx`, mostra a data que o
dashboard está usando.

> A data de conclusão chega numa `npm run sync:completa`. A sincronização normal
> só relê o que mudou, e os itens antigos ficariam sem ela.

---

## Épicos: os pais dos tickets

Cada espaço organiza os tickets abaixo de **épicos** (por exemplo *"Julho de
2026"*), e entre o ticket e o épico ainda pode haver uma história ou uma tarefa.
O Jira só informa o **pai imediato** de cada issue, então o dashboard sobe a
cadeia inteira (subtarefa → história → épico) e carimba em cada item o épico do
topo. Um épico é o épico dele mesmo: filtrar por um traz ele e tudo que está
pendurado nele.

Isso aparece em três lugares:

- no segmentador **Épicos**, ao lado de Espaços e Responsável — a lista
  acompanha os outros filtros, então marcar um espaço deixa só os épicos dele;
- no gráfico **Tickets por épico** e na coluna **Épico** da tabela de
  atividades (que também vai para o `.xlsx` e para o PDF);
- na contagem **Épicos com tickets**, no Panorama.

O rótulo junta chave e título (`WIK-193 · Julho de 2026`) porque o mesmo título
se repete em espaços diferentes. Tickets soltos, sem épico acima, ficam em
**(sem épico)**.

> Depois de atualizar o sistema, rode **uma** `npm run sync:completa`. A
> sincronização normal só relê o que mudou, e os itens antigos ficariam sem a
> hierarquia preenchida.

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
| **O Jira atendeu a requisição como visitante anônimo** | O token venceu ou foi revogado. Gere outro e salve — veja o quadro abaixo. |
| Etiqueta segue **"Jira não configurado"** | O `.env` não foi salvo na pasta certa. A URL, o e-mail e o token são relidos do `.env` sem reiniciar; `PORT` e `HOST`, não. |

### Token vencido não dá erro 401 — dá lista vazia

O Jira Cloud **não** recusa quem chega com token inválido: atende como visitante
anônimo e responde `200` com resultado vazio. Só a rota de identidade
(`/rest/api/3/myself`) devolve 401.

Na prática, um token vencido apareceria assim: "Listar projetos" não mostra
nenhum projeto e a sincronização termina "com sucesso" sem trazer issue nenhuma.
Por isso o dashboard confere a identidade antes de aceitar um resultado vazio —
tanto ao listar projetos quanto no início de cada sincronização — e mostra a
mensagem *"O Jira atendeu a requisição como visitante anônimo"* em vez de fingir
que está tudo certo.

Gere um token novo em
[id.atlassian.com → Segurança → tokens de API](https://id.atlassian.com/manage-profile/security/api-tokens),
troque o `JIRA_TOKEN` no `.env` e clique em **⟳ Sincronizar Jira**. Não precisa
reiniciar o servidor: o `.env` é relido sozinho quando muda.

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

## Teste de API para commitar o projeto v2
