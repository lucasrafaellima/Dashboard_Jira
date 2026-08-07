# Dashboard Jira

Dashboard web para análise das atividades do Jira. Os dados vêm **direto da API do
Jira** — nada de exportar planilha. A importação de Excel continua disponível como
alternativa, para dados históricos que não estão mais no Jira.

- Layout e indicadores reproduzem o **DashBoard_Jira** de referência.
- **Node puro, zero dependências** — nada de `npm install`.

## Como rodar

```bash
cd "Desktop/projetos coagro/Dashboard_Jira"
npm start
```

Abre em <http://localhost:3000> (mude com `PORT=3210 npm start`).

## Conectar no Jira

**Passo a passo completo, com onde colocar URL / e-mail / token:
[`docs/CONFIGURACAO-JIRA.md`](docs/CONFIGURACAO-JIRA.md).**

Versão curta:

1. Gere um token em <https://id.atlassian.com/manage-profile/security/api-tokens>.
2. Copie `.env.example` para `.env` e preencha:

   ```dotenv
   JIRA_URL=https://suaempresa.atlassian.net
   JIRA_EMAIL=voce@empresa.com
   JIRA_TOKEN=o_token_gerado
   JIRA_PROJETOS=CRM,HUB,AR
   JIRA_INTERVALO_MIN=30
   ```

   Ou preencha os mesmos campos no botão **Configurar Jira** do dashboard —
   nesse caso ficam em `config/jira.json`. Os dois arquivos estão no `.gitignore`.
3. `npm start` e clique em **⟳ Sincronizar Jira**.

```bash
npm run jira:testar      # testa a conexão e lista as chaves dos projetos visíveis
npm run sync             # sincroniza só o que mudou desde a última vez
npm run sync:completa    # relê tudo e remove da base issues apagadas no Jira
```

Com `JIRA_INTERVALO_MIN` maior que zero, o servidor sincroniza sozinho nesse intervalo.

### Como funciona a sincronização

**Um projeto de cada vez.** Deixar `JIRA_PROJETOS` (ou o campo *Projetos* da tela) em
branco significa *todos os projetos visíveis*: o dashboard lista os projetos na API e
sincroniza cada um como uma origem separada, em sequência, com uma pausa curta entre
eles. Nada de uma consulta gigante com o site inteiro — assim um projeto grande ou com
erro de permissão não derruba a passada dos outros.

Dentro de cada projeto a leitura é **página a página** (100 issues) e cada página é
gravada antes de a próxima ser pedida. O consumo de memória não cresce com o tamanho do
projeto, e se a conexão cair no meio, o que já entrou fica na base — a passada seguinte
retoma de onde parou em vez de reler tudo.

A primeira passada traz o histórico inteiro. Depois, o dashboard guarda por projeto a
data da issue mais recente que viu e pede ao Jira apenas `updated >= (essa data - 15 min)` —
por isso as sincronizações seguintes levam segundos.

Cada projeto vira uma linha na tabela **Origens sincronizadas do Jira**, no rodapé,
com a data da última passada, o resultado e um botão para remover a origem inteira.
Durante a passada, a tela mostra o andamento (`Projeto 4/11 — CRM: 1.200 issues lidas`)
e atualiza os gráficos conforme cada projeto termina.

Ajustes finos (só via `.env` ou `config/jira.json`):

| Chave | `.env` | Padrão | Para que serve |
|---|---|---|---|
| `maxIssues` | `JIRA_MAX_ISSUES` | 20000 | teto de issues **por projeto em cada passada**; o resto vem na próxima |
| `pausaMs` | `JIRA_PAUSA_MS` | 400 | pausa entre um projeto e o seguinte, para não esbarrar no limite do Jira |

Quando um projeto bate o `maxIssues`, a passada avisa e a **remoção de issues ausentes
não roda** para aquele projeto — ela só age quando a leitura foi completa, senão apagaria
issues que apenas não foram lidas.

Jira Server / Data Center também funciona: gere um *Personal Access Token*, deixe
`JIRA_EMAIL` vazio e o cliente autentica com `Bearer` e cai no endpoint de busca antigo.

## Como adicionar planilhas (alternativa)

**Pelo navegador**: botão **“Planilha”** → arraste um ou vários
`.xlsx` / `.csv`. O arquivo é lido, importado e guardado em `data/`.

As duas fontes gravam na mesma tabela e são deduplicadas pela chave da issue: quando a
mesma issue vem da API e de uma planilha, vence a versão com `Atualizado(a)` mais recente.

**Pela linha de comando**: jogue os arquivos em `data/` e rode

```bash
npm run import                     # importa tudo que está em data/
node tools/importar.js arq.xlsx    # importa arquivos específicos
node tools/importar.js --reset     # zera a base antes de importar
node tools/importar.js --forcar    # reimporta mesmo se o conteúdo já foi visto
node tools/importar.js --aba Sheet1  # força uma aba específica
```

### O que acontece ao importar

| Situação | Comportamento |
|---|---|
| Item novo (`Chave da item` inédita) | inserido |
| Item já existente, planilha **mais nova ou igual** | atualizado |
| Item já existente, planilha **mais antiga** | ignorado (não sobrescreve dado novo) |
| Arquivo com conteúdo idêntico a um já importado | recusado, com aviso |

A comparação de "mais novo" usa a coluna **`Atualizado(a)`**. Então pode reenviar
exports que se sobrepõem à vontade — o total não infla.

Cada importação fica registrada na tabela **Planilhas importadas** no rodapé, com
botão para **remover** o lote (apaga os itens que vieram daquele arquivo).

## Formato aceito

Colunas esperadas (o cabeçalho é reconhecido sem depender de acento, maiúscula ou ordem):

`Tipo de item` · `Chave da item` · `ID da item` · `Resumo` · `Responsável` ·
`ID do responsável` · `Relator` · `ID do relator` · `Prioridade` · `Status` ·
`Resolução` · `Criado` · `Atualizado(a)` · `Data limite` · `Projeto` · `Origem`

Só `Chave da item` e `Status` são obrigatórias. O leitor:

- escolhe **automaticamente a aba certa** de um `.xlsx` com várias abas (ignora abas de
  tabela dinâmica, dashboard e abas ocultas com dados parciais — escolhe a que tem os
  cabeçalhos da base e mais linhas);
- entende data em **serial do Excel** (`46230,60`), `dd/mm/aaaa hh:mm`, ISO e
  `26 de jun. de 2026, 10:28`;
- aceita `.csv` com `;` ou `,`, BOM e aspas escapadas.

## Padronização dos dados

Cada projeto do Jira tem o seu próprio workflow, então o mesmo conceito chega escrito de
vários jeitos. Sem unificar, os cálculos saem errados: `FECHADO`, `Feito` e `Concluído`
são a mesma coisa, mas contariam como três status diferentes.

Toda linha — venha da API ou de planilha — passa pelas regras de `src/normalizar.js`:

### Status

| Vira | Categoria | Nomes aceitos |
|---|---|---|
| `Concluído` | Concluído | `Feito`, `FECHADO`, `Fechado`, `Resolvido`, `Pronto`, `Done`, `Closed`, `Resolved`, `Complete` |
| `A fazer` | A fazer | `A Fazer`, `Tarefas pendentes`, `Backlog`, `To Do`, `Aberto`, `Open`, `Novo`, `Pendente` |
| `Em andamento` | Em andamento | `Fazendo`, `In Progress`, `Em desenvolvimento`, `Em execução` |
| `Em análise` | Em andamento | `Em análise (QA)`, `Em revisão`, `In Review`, `Code Review`, `Em homologação`, `Em teste` |
| `Aguardando` | Em andamento | `Aguardando pelo suporte`, `Esperando ação externa`, `PAUSADO`, `Estacionamento`, `On Hold`, `Bloqueado` |
| `Escalado` | Em andamento | `ESCALADO`, `Escalated` |
| `Cancelado` | Cancelado | `Cancelada`, `Cancelled`, `Descartado`, `Rejeitado`, `Duplicado` |

Status desconhecido **não é descartado**: mantém o próprio nome e herda a categoria que a
API do Jira informou (`new` / `indeterminate` / `done`), então um workflow novo aparece no
dashboard já classificado no funil certo.

O nome original fica guardado na coluna `status_origem` e aparece na seção
**Padronização de status** do dashboard — dá para conferir item a item o que foi unificado.

### Prioridade, tipo e resolução

| Vira | Nomes aceitos |
|---|---|
| `Altíssima` · `Alta` · `Média` · `Baixa` · `Baixíssima` | `Highest`, `Critical`, `Blocker`, `High`, `Major`, `Medium`, `Normal`, `Low`, `Minor`, `Lowest`, `Trivial` |
| `Solicitação de Serviço`, `Incidente ou Interrupções`, `Subtarefa`, `Tarefa`, `História`, `Bug`, `Epic` | equivalentes em inglês (`Service Request`, `Incident`, `Sub-task`, `Task`, `Story`…) |
| `Concluído`, `Não será feito`, `Duplicado`, `Sem solução` | `Itens concluídos`, `Won't Do`, `Não vai ser feito`, `Duplicate`, `Cannot Reproduce` |

### Espaços

| Origem do dado | Vira |
|---|---|
| `Workflow`, `Overflow`, `Davi`, `WIK`, `status-davi-25-07.csv` | `Workflow(Kestra)` |
| `CRM Loja/Campo`, `CRM` | `CRM Loja` |
| `Hub`, `Hub Configurador` | `HUB`, `HUB Configurador` |

O rótulo canônico do espaço fica na coluna `espaco` e é o que alimenta os gráficos —
por isso planilhas antigas (onde `Origem` era o nome do arquivo `.csv`) somam junto com
as novas sem bagunçar os totais.

### Mexeu nas regras? Repadronize a base

As regras valem na hora da gravação. Depois de editar `src/normalizar.js`, rode:

```bash
npm run padronizar            # mostra o que mudaria, sem gravar
npm run padronizar:aplicar    # grava as correções nos itens já existentes
```

Ele recalcula status, categoria, prioridade, tipo e resolução a partir do `status_origem`,
sem precisar de uma sincronização completa.

## O que o dashboard mostra

- **Segmentações** por Espaço e por Responsável (clique para filtrar, clique de novo para soltar), mais período por data de criação.
- **Status das Atividades** — barras verticais.
- **Atividades concluídas por responsável** — pizza.
- **Tickets criados por espaços** — barras horizontais.
- **KPIs**: atividades criadas, concluídas e taxa de conclusão.
- **Produtividade semanal por colaborador** — ranking das conclusões da semana com o
  comparativo das semanas anteriores (detalhes [abaixo](#produtividade-semanal-por-colaborador)).
- **Extras**: evolução mensal (criadas × concluídas), por tipo, por prioridade, tempo médio/mediano até concluir, itens sem responsável, itens com data limite vencida, e a tabela detalhada.
- Botão **PDF** usa a impressão do navegador, mas o que sai é um relatório, não uma foto da tela:
  - **A4 paisagem**, com capa (período coberto, filtros aplicados, data de geração e site do Jira
    de origem) e rodapé repetido em todas as páginas;
  - a ordem muda para leitura: KPIs → status e panorama → espaços e responsáveis → evolução
    mensal → produtividade semanal → demais gráficos → padronização de status;
  - as listas de **Espaços** e **Responsável** saem inteiras, em duas colunas — na tela elas rolam,
    no papel rolagem viraria corte;
  - ficam de fora os controles, a tabela de atividades (essa vai no Excel) e as tabelas
    operacionais de sincronização e importação.
  - Se os cartões azuis saírem sem cor, ligue **“Gráficos de plano de fundo”** nas opções de
    impressão do navegador — o CSS já pede `print-color-adjust: exact`, mas alguns navegadores
    respeitam apenas a caixa de seleção.
- Botão **⤓ Excel**, no título da tabela **Atividades**, baixa um `.xlsx` com as mesmas
  colunas da tela. Ele respeita os filtros ativos (espaços, responsáveis, período,
  cancelados): com filtro, só vem o que está filtrado. A tela mostra no máximo 500 linhas,
  mas a planilha leva **todas** as atividades do filtro. Datas saem como data de verdade
  (ordenável no Excel), com a primeira linha congelada e autofiltro ligado.

### Produtividade semanal por colaborador

Mostra quantas atividades cada pessoa **concluiu** em cada uma das **8 últimas semanas**
(de segunda a domingo) e compara a semana atual com a anterior. Ao lado, o gráfico
**Concluídas por semana** traz o total da equipe; clicar numa barra recorta o período
naquela semana, do mesmo jeito que clicar num mês na evolução mensal.

Três coisas mudam a leitura do número e por isso ficam ditas na tela:

- **A semana em curso é parcial.** Comparar uma terça-feira com uma semana inteira acusaria
  queda toda segunda. Enquanto a semana não fecha, a comparação é contra o **mesmo trecho**
  da semana passada (do começo dela até o mesmo dia da semana) — é o que a coluna
  *Mesmo trecho anterior* traz. A faixa de indicadores guarda no `title` quanto a semana
  anterior fechou, para quem quiser o número cheio.
- **Conta a data de conclusão**, não a de criação: uma atividade aberta há um mês e fechada
  ontem é produtividade de ontem.
- **A variação vem com o absoluto junto** (`▲ +100% (+1)`). Sozinho, o percentual mente de
  tamanho: sair de 1 para 2 conclusões também é "+100%". Sem base de comparação a pílula
  diz *novo* em vez de inventar um número.

O cartão ignora dois filtros de propósito: o de **responsáveis**, porque eles são o eixo do
ranking (marcar um deixaria uma linha só), e o de **período**, porque as semanas já são o
recorte. Espaço, épico, tipo e prioridade continuam valendo. Clicar num colaborador filtra
o resto do painel por ele.

Se a base estiver parada (sem sincronização há semanas), a janela recua até a última semana
com entregas em vez de mostrar oito semanas zeradas — a nota embaixo do cartão avisa quando
isso acontece.

### O que conta como concluída

Toda atividade cuja **categoria** é `Concluído`, não importa o nome que o projeto de
origem dá ao status. Como `FECHADO`, `Feito` e `Concluído` viram o mesmo rótulo, a taxa
de conclusão passou a refletir a base inteira em vez de um workflow só.

**Cancelados ficam de fora** por padrão: foram encerrados, não entregues. Isso vale
também para itens fechados com resolução `Won't Do` / `Não vai ser feito` / `Duplicado` —
eles são reclassificados como `Cancelado` mesmo que o workflow os marque como fechados.
O interruptor **“contar cancelados como concluídas”**, no topo, inclui os dois grupos.

Com isso o funil fecha exato: `A fazer + Em andamento + Concluído + Cancelado = total`.

## Estrutura

```
server.js              servidor HTTP + API (node:http)
src/config.js          lê .env e config/jira.json (credenciais do Jira)
src/jira.js            cliente REST do Jira: auth, paginação, erros
src/sincronizacao.js   issue da API -> registro do banco; incremental e completa
src/xlsx.js            leitor .xlsx: zip na mão + inflate + XML das abas
src/xlsx-escrita.js    escritor .xlsx: XML da pasta de trabalho + zip com deflate
src/normalizar.js      mapeamento de colunas, datas, status, espaços, pessoas
src/ingestao.js        escolhe a aba, converte as linhas e grava
src/banco.js           node:sqlite — tabelas itens, importacoes e sincronizacoes
src/metricas.js        agregações do dashboard
tools/sincronizar.js   sincronização pela linha de comando
tools/importar.js      importação em lote pela pasta data/
public/                index.html, styles.css, app.js (gráficos SVG)
data/                  as planilhas que você foi adicionando
db/jira.db             banco gerado
.env                   suas credenciais (fora do Git)
docs/                  guia de configuração do Jira
```

### API

| Rota | Uso |
|---|---|
| `GET /api/dashboard?espacos=A\|B&responsaveis=X&de=&ate=&amplo=1` | payload completo |
| `GET /api/itens?...&limite=500` | tabela detalhada |
| `GET /api/exportar?...` | mesma tabela em `.xlsx`, com os mesmos filtros (sem limite por padrão) |
| `GET /api/jira/config` | configuração atual (token mascarado) + estado das sincronizações |
| `POST /api/jira/config` | salva a configuração em `config/jira.json` |
| `POST /api/jira/testar` | testa credenciais (aceita URL/e-mail/token no corpo) |
| `GET /api/jira/projetos` | projetos visíveis para a conta |
| `POST /api/jira/sincronizar[?completa=1]` | dispara a sincronização e responde `202` na hora (some `?esperar=1` para bloquear até o fim) |
| `GET /api/jira/sincronizar/estado` | progresso da passada: origem atual, `indice/total`, issues lidas, resultado |
| `DELETE /api/jira/sincronizacoes/:origem` | remove uma origem e seus itens |
| `GET /api/importacoes` | histórico de planilhas |
| `POST /api/upload?nome=arq.xlsx` | corpo = binário do arquivo |
| `DELETE /api/importacoes/:id` | remove um lote |
| `POST /api/limpar` | zera a base |

## Segurança

O servidor guarda o token do Jira, então por padrão escuta **só em `127.0.0.1`**.
Para abrir na rede local: `HOST=0.0.0.0 npm start` — ciente de que qualquer pessoa
da rede poderá disparar sincronizações. O token nunca é enviado ao navegador.

## Limitações

A sincronização traz os mesmos campos do export de planilha (tipo, responsável,
status, datas, prioridade, projeto). **Story points**, **worklogs** e histórico de
transições não são lidos — então não há horas apontadas nem cycle time real. O
"tempo até concluir" usa `Criado` → `Atualizado`, que é uma aproximação do lead time.
