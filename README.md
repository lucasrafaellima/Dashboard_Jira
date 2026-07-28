# Dashboard Jira

Dashboard web para análise das atividades do Jira a partir das planilhas exportadas.
Você vai **adicionando arquivos Excel** e a base cresce sozinha, sem duplicar nada.

- Layout e indicadores reproduzem o **DashBoard_Jira** de referência.
- Formato de dados baseado no **base_unificada_copia.xlsx** (16 colunas do export do Jira + `Origem`).
- **Node puro, zero dependências** — nada de `npm install`.

## Como rodar

```bash
cd "Desktop/projetos coagro/Dashboard_Jira"
npm start
```

Abre em <http://localhost:3000> (mude com `PORT=3210 npm start`).

## Como adicionar planilhas

**Pelo navegador** (recomendado): botão **“+ Adicionar planilha”** → arraste um ou vários
`.xlsx` / `.csv`. O arquivo é lido, importado e guardado em `data/`.

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

### Normalizações aplicadas

| Origem do dado | Vira |
|---|---|
| `Subtask` / `Subtarefa` | `Subtarefa` |
| célula vazia / `Sem responsável` | `(vazio)` |
| `Overflow`, `Davi`, `status-davi-25-07.csv` | `Overflow(Kestra)` |
| `CRM Loja/Campo` | `CRM Loja` |
| `Hub`, `Hub Configurador` | `HUB`, `HUB Configurador` |

O rótulo canônico do espaço fica na coluna `espaco` e é o que alimenta os gráficos —
por isso planilhas antigas (onde `Origem` era o nome do arquivo `.csv`) somam junto com
as novas sem bagunçar os totais. Para ajustar os apelidos, edite `src/normalizar.js`.

## O que o dashboard mostra

- **Segmentações** por Espaço e por Responsável (clique para filtrar, clique de novo para soltar), mais período por data de criação.
- **Status das Atividades** — barras verticais.
- **Atividades concluídas por responsável** — pizza.
- **Tickets criados por espaços** — barras horizontais.
- **KPIs**: atividades criadas, concluídas e taxa de conclusão.
- **Extras**: evolução mensal (criadas × concluídas), por tipo, por prioridade, tempo médio/mediano até concluir, itens sem responsável, itens com data limite vencida, e a tabela detalhada.
- Botão **PDF** usa a impressão do navegador (gráficos e cartões saem, tabelas e controles não).

### “Concluído” conta como concluída?

Por padrão **não** — só o status `Feito` conta, que é o critério do DashBoard_Jira de
referência (288 criadas · 188 concluídas · 65,28%).

A base tem dois workflows diferentes: `Feito` (188) e `Concluído` (33). Marcando
**“incluir Concluído”** no topo, os KPIs passam a considerar os dois (221 · 76,74%).

## Estrutura

```
server.js            servidor HTTP + API (node:http)
src/xlsx.js          leitor .xlsx: zip na mão + inflate + XML das abas
src/normalizar.js    mapeamento de colunas, datas, status, espaços, pessoas
src/ingestao.js      escolhe a aba, converte as linhas e grava
src/banco.js         node:sqlite — tabelas `itens` e `importacoes`
src/metricas.js      agregações do dashboard
tools/importar.js    importação em lote pela pasta data/
public/              index.html, styles.css, app.js (gráficos SVG)
data/                as planilhas que você foi adicionando
db/jira.db           banco gerado
```

### API

| Rota | Uso |
|---|---|
| `GET /api/dashboard?espacos=A\|B&responsaveis=X&de=&ate=&amplo=1` | payload completo |
| `GET /api/itens?...&limite=500` | tabela detalhada |
| `GET /api/importacoes` | histórico |
| `POST /api/upload?nome=arq.xlsx` | corpo = binário do arquivo |
| `DELETE /api/importacoes/:id` | remove um lote |
| `POST /api/limpar` | zera a base |

## Limitações

O export por planilha do Jira não traz **story points**, **worklogs** nem marca de
início da atividade — então não há métrica de horas apontadas nem cycle time real.
O "tempo até concluir" usa `Criado` → `Atualizado(a)`, que é uma aproximação do lead time.
