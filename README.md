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
- **Burndown da semana** — de segunda a sexta (detalhes [abaixo](#burndown-da-semana)).
- **Extras**: evolução mensal (criadas × concluídas), tickets por épico, tempo médio/mediano até concluir, itens sem responsável, itens com data limite vencida, e a tabela detalhada.
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

Mostra quantas atividades cada pessoa **concluiu** em cada semana da janela (de **segunda a
sexta**) e compara a última semana com a anterior. Sem filtro de datas a janela são as **8
últimas semanas**; com filtro, ela vira o **próprio intervalo** (veja abaixo). Ao lado, o
gráfico **Concluídas por semana** traz o total da equipe; clicar numa barra recorta o
período naquela semana, do mesmo jeito que clicar num mês na evolução mensal.

Quatro coisas mudam a leitura do número e por isso ficam ditas na tela:

- **A semana é útil, mas o fim de semana não some.** O rótulo e a contagem de dias vão de
  segunda a sexta — é o que a operação chama de semana, e o mesmo intervalo do burndown ao
  lado. O que alguém concluiu no sábado ou no domingo continua contando **na semana que
  acabou**: são poucas conclusões (3,9% da base), mas todas com data de conclusão própria, e
  descartá-las zeraria o número de quem fechou chamado de plantão. Por isso clicar numa
  barra de *Concluídas por semana* recorta o período até domingo, e não até sexta — senão o
  cartão diria um número e a tabela lá embaixo, outro.
- **Semana pela metade é comparada pela metade.** Comparar uma terça-feira com uma semana
  inteira acusaria queda toda segunda. Enquanto a última semana não fecha — porque ainda
  está correndo ou porque o filtro de datas cortou no meio dela — a comparação é contra o
  **mesmo trecho** da semana anterior (do começo dela até o mesmo dia útil), e é o que
  a coluna *Mesmo trecho anterior* traz. Chegando no sábado a semana já conta como fechada:
  os cinco dias úteis passaram. A faixa de indicadores guarda no `title` quanto a semana
  anterior fechou, para quem quiser o número cheio.
- **Conta a data de conclusão**, não a de criação: uma atividade aberta há um mês e fechada
  ontem é produtividade de ontem.
- **A variação vem com o absoluto junto** (`▲ +100% (+1)`). Sozinho, o percentual mente de
  tamanho: sair de 1 para 2 conclusões também é "+100%". Sem base de comparação a pílula
  diz *novo* em vez de inventar um número.

Clicar num colaborador filtra o painel inteiro por ele — inclusive os indicadores do cartão
e o gráfico **Concluídas por semana** ao lado, que passam a mostrar o ritmo só daquela
pessoa. O **ranking continua trazendo todo mundo** (as outras linhas apenas desbotam),
porque é por ele que se troca a seleção: filtrado, sobraria uma linha só e não haveria como
escolher outro nome. O título dos dois cartões diz de quem é o número em vigor.

O filtro de **período** vale aqui: a janela passa a ser o intervalo escolhido, das semanas
que ele toca, e os números contam só as conclusões dentro dele. Espaço, épico, tipo e
prioridade valem normalmente. Três consequências:

- **As pontas podem entrar pela metade.** Um intervalo que começa numa quarta conta só de
  quarta em diante naquela semana. Essas semanas saem mais claras no gráfico ao lado, do
  mesmo jeito que a semana em curso.
- **Sem semana anterior inteira não há comparação.** Se o intervalo cabe numa semana só, ou
  se a penúltima semana entra cortada pela borda, a variação e a média aparecem como `—`
  em vez de um percentual inventado contra um número incompleto.
- **Intervalos longos são truncados em 26 semanas** (as últimas do período): mais que isso
  vira uma parede de barras ilegível. A nota embaixo do cartão avisa quando corta.

Sem filtro de período e com a base parada (sem sincronização há semanas), a janela recua até
a última semana com entregas em vez de mostrar oito semanas zeradas — a nota embaixo do
cartão também avisa quando isso acontece.

### Burndown da semana

Quanto trabalho ainda estava **em aberto no fim de cada dia**, de segunda a sexta, contra a
reta que zeraria a fila na sexta-feira.

- **A reta parte da fila do fim da segunda** e desce até zero na sexta. As duas linhas nascem
  no mesmo ponto, e daí em diante a distância entre elas é a leitura inteira do cartão.
  Partir do escopo cheio da semana (com o que entrou depois já embutido) foi testado e mente:
  num balcão de chamados a maior parte do que se fecha na semana também nasce nela, então a
  reta começaria muito acima da linha real e o time apareceria adiantado de segunda a quinta
  mesmo terminando a sexta com a fila do mesmo tamanho.
- **O que entra depois empurra a linha para cima** — é assim que se vê a fila crescendo mais
  rápido do que se entrega. Por isso *Novas na semana* é um dos números do cartão: sem ele,
  uma linha que não cai parece falta de entrega quando pode ser excesso de chegada.
- **A linha real é o fim do dia.** Uma atividade aberta e fechada na terça some do ponto de
  terça em diante. Dia que ainda não chegou não vira ponto — a linha para em hoje, em vez de
  despencar até zero e fingir semana concluída numa terça.
- **Ponto acima da reta sai vermelho**: é sobra acumulada, o sinal de que a semana não zera
  no ritmo atual. O indicador “contra o ritmo ideal” diz de quantas atividades é a diferença.
- **A semana é a mesma do cartão de produtividade** — sem filtro de datas, a semana corrente;
  com filtro, a última do intervalo. Clicar numa barra de *Concluídas por semana* traz o
  burndown para aquela semana.
- **Período e status não filtram este gráfico.** O período, porque o burndown precisa das
  atividades abertas antes do recorte; o status, porque o gráfico é feito de aberto contra
  concluído e recortar por status responderia sozinho a pergunta. Espaço, épico, responsável,
  tipo e prioridade valem normalmente.

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
src/metricas.js        agregações do dashboard — JS puro, roda também no navegador
src/metricas-banco.js  liga as métricas ao SQLite (é o que o server.js usa)
tools/sincronizar.js   sincronização pela linha de comando
tools/importar.js      importação em lote pela pasta data/
tools/publicar-firestore.js  publica a base como snapshot no Firestore
public/                index.html, styles.css, app.js (gráficos SVG)
public/fonte.js        decide no boot: backend Node ou Firestore
public/portao.js       login com Google ou Outlook (só no modo público)
firestore.rules        quem pode ler o snapshot — a barreira de acesso de verdade
.github/workflows/     sincronização por cron e publicação no GitHub Pages
data/                  as planilhas que você foi adicionando
db/jira.db             banco gerado
.env                   suas credenciais (fora do Git)
docs/                  guias de configuração
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
| `GET /api/saude` | só existe no servidor local; é como o front descobre que há backend |
| `GET /compartilhado/metricas.js` | módulos puros que o navegador também executa |

## Os dois modos

O mesmo front roda de duas formas. Quem decide é `public/fonte.js`, no boot: ele
chama `GET api/saude` e, se responder, usa o backend; se não, cai no Firestore.
A escolha é por sondagem justamente para não existir um sinalizador que possa ser
publicado errado.

| | **servidor** (`npm start`) | **público** (GitHub Pages) |
|---|---|---|
| Dados | SQLite local, agregados no Node | snapshot do Firestore, agregado no navegador |
| Login | nenhum (escuta em `127.0.0.1`) | conta Google ou Outlook + lista de permitidos |
| Sincronizar / Configurar Jira / Planilha | sim | escondidos |
| Exportar | `.xlsx` | `.csv` |
| PDF, filtros, gráficos | sim | sim |

As métricas são as **mesmas nos dois casos**: `src/metricas.js` não conhece banco
nem rede, só recebe `{ itens, importacoes, sincronizacoes }`. No servidor quem
monta isso é `src/metricas-banco.js`; no navegador, o snapshot baixado.

### Publicar no GitHub Pages

Uma vez, no console do Firebase (projeto `dashboard-81c66`):

1. **Authentication → Sign-in method** → habilitar **Google** e, para o botão
   *Entrar com Outlook*, também **Microsoft** (tem
   [passo a passo abaixo](#habilitar-o-login-com-outlook-microsoft)).
2. **Authentication → Settings → Authorized domains** → adicionar
   `lucasrafaellima.github.io`. Sem isso o login falha com `auth/unauthorized-domain`.
3. **Firestore Database → Create database** → produção, região `southamerica-east1`.
4. **Rules** → colar o `firestore.rules` deste repositório → *Publish*.
5. Liberar quem vai usar: criar um documento em `permitidos/<e-mail em minúsculas>`
   (o conteúdo não importa, pode ser vazio).
6. **Project settings → Service accounts → Generate new private key** → guardar o
   JSON no secret `FIREBASE_SERVICE_ACCOUNT` e **apagar o arquivo baixado**.

No GitHub, em *Settings*:

- **Pages → Source: GitHub Actions** ([link direto](https://github.com/lucasrafaellima/Dashboard_Jira/settings/pages)).
  Não é detalhe: veja [o link abre o README](#o-link-do-pages-abre-o-readme-em-vez-do-sistema).
- **Secrets and variables → Actions**: `JIRA_URL`, `JIRA_EMAIL`, `JIRA_TOKEN`,
  `JIRA_PROJETOS` e `FIREBASE_SERVICE_ACCOUNT`. Vale gerar um token do Jira
  separado para o CI, para poder revogá-lo sem derrubar o uso local.
- Rodar o workflow **Sincronizar Jira e publicar snapshot** na mão uma vez: o site
  só serve para alguma coisa depois que existe um snapshot.

#### Habilitar o login com Outlook (Microsoft)

A tela já traz os dois botões, mas o **Entrar com Outlook** só funciona depois de
registrar um aplicativo na Microsoft — o Firebase não tem um provedor Microsoft
pronto como tem o do Google. Enquanto não estiver ligado, quem clicar recebe a
mensagem *"o login com Outlook ainda não foi habilitado no Firebase"*.

No [portal do Azure](https://portal.azure.com) → **Microsoft Entra ID → App
registrations → New registration**:

1. Nome: `Dashboard Jira` (só aparece na tela de consentimento).
2. *Supported account types*: **Accounts in any organizational directory and
   personal Microsoft accounts** — é o que o código pede com `tenant: 'common'`.
   Para fechar o login só na empresa, escolha *single tenant* aqui **e** troque o
   `'common'` pelo ID do tenant em `public/portao.js`.
3. *Redirect URI* → plataforma **Web** → exatamente:
   `https://dashboard-81c66.firebaseapp.com/__/auth/handler`
   (é o que o Firebase mostra ao habilitar o provedor; errar aqui dá
   `AADSTS50011` na hora do login).
4. Registrar e copiar o **Application (client) ID**.
5. **Certificates & secrets → New client secret** → copiar o **Value** (não o
   *Secret ID*; o valor só aparece uma vez).

No console do Firebase → **Authentication → Sign-in method → Microsoft**:
habilitar, colar o *Application ID* e o *secret*, salvar.

⚠️ **O segredo do cliente expira** (a Microsoft dá no máximo 24 meses). No dia em
que expirar, o login com Outlook para de funcionar e o do Google continua — se um
dia só o Outlook falhar, é o primeiro lugar a olhar. Vale anotar a data de
validade em algum lugar visível.

Por fim, **republique o `firestore.rules`** (Firestore Database → Rules → colar →
*Publish*): a versão nova aceita o e-mail vindo da Microsoft. Sem isso, o login
com Outlook conclui e o painel responde *"conta não liberada"* — a Microsoft não
envia a claim `email_verified` e o Firebase grava `false` mesmo com o endereço
confirmado ([firebase-functions#1592](https://github.com/firebase/firebase-functions/issues/1592)),
então a regra antiga rejeita todo mundo que entra por lá.

A lista de permitidos não muda: continua sendo `permitidos/<e-mail em
minúsculas>`. Quem tem o mesmo endereço nos dois provedores usa o botão que
quiser — mas só o **primeiro** que usar: o Firebase guarda uma conta por e-mail e
recusa a segunda com *"já entrou aqui por outro provedor"*.

#### O link do Pages abre o README em vez do sistema

Sintoma: `https://lucasrafaellima.github.io/Dashboard_Jira/` mostra o README
formatado, e o workflow **Publicar no GitHub Pages** está verde.

Causa: a origem do Pages está em **Deploy from a branch**. Aí existem *dois*
publicadores disputando o mesmo endereço — o workflow deste repositório e o
Jekyll que o GitHub roda sozinho a cada push na branch. Os dois escrevem no
ambiente `github-pages` e **o último ganha**; o Jekyll termina depois e marca o
nosso deploy como `inactive`. Como o repositório não tem `index.html` na raiz, o
que o Jekyll publica é o README.

Correção, uma vez só:

1. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. **Actions → Publicar no GitHub Pages → Run workflow**.

O workflow confere isso antes de publicar: com a origem errada ele tenta trocar
sozinho (quase sempre não pode — trocar exige `administration:write`, que o
`GITHUB_TOKEN` não tem) e então **falha de propósito**, com o passo a passo no
log. Um X vermelho aqui vale mais que um verde publicando um site que ninguém vê.

#### A chave da service account

Baixe em **Project settings → Service accounts → Generate new private key**
([link direto](https://console.firebase.google.com/project/dashboard-81c66/settings/serviceaccounts/adminsdk)).
Vem um `.json` com nome tipo `dashboard-81c66-firebase-adminsdk-a1b2c-3d4e5f.json`.

Essa chave **ignora o `firestore.rules`** — quem a tem lê e escreve tudo. Ela não
tem senha e o Firebase não mostra o conteúdo de novo; perdeu, gera outra e revoga
a antiga no mesmo lugar. Guarde **fora do repositório** (ex.: `%USERPROFILE%\.firebase\`),
para não depender do `.gitignore` estar certo.

Para o GitHub Actions, o que vai no secret `FIREBASE_SERVICE_ACCOUNT` é o
**conteúdo** do arquivo (abra e copie tudo, incluindo as chaves `{ }`), não o caminho.

Publicar da sua máquina, sem esperar o cron:

```powershell
# PowerShell (Windows)
npm run sync
$env:FIREBASE_CHAVE = "$env:USERPROFILE\.firebase\chave.json"
npm run publicar
```

```bash
# bash / Git Bash / Linux / macOS
npm run sync
FIREBASE_CHAVE=~/.firebase/chave.json npm run publicar
```

### Testar o modo público localmente

`npm start` sempre entra em modo servidor, porque `api/saude` responde. Para ver a
tela de login e o caminho do Firestore sem publicar nada, sirva a pasta `public/`
por qualquer estático (aí não há `api/saude` e a sondagem cai no modo público) —
lembrando de copiar `src/metricas.js` e `src/normalizar.js` para `compartilhado/`,
que é o que o workflow do Pages faz.

## Segurança

No modo servidor, o processo guarda o token do Jira, então por padrão escuta **só
em `127.0.0.1`**. Para abrir na rede local: `HOST=0.0.0.0 npm start` — ciente de
que qualquer pessoa da rede poderá disparar sincronizações. O token nunca é
enviado ao navegador.

No modo público vale entender o que protege o quê. **Um site no GitHub Pages é
sempre alcançável por qualquer um**, inclusive em repositório privado. A tela de
login é conveniência; a barreira de verdade é o `firestore.rules` — nenhum dado é
buscado antes do login e, para quem não está em `permitidos/`, a leitura volta
`permission-denied`. Por isso o artefato publicado **não contém dado nenhum**: o
site sobe vazio e busca o snapshot depois de autenticar.

A `apiKey` do Firebase em `public/firebase-config.js` pode ficar no repositório —
ela identifica o projeto, não autoriza nada. Já a **chave da service account**
ignora as regras do Firestore: essa vive só no GitHub Secrets, nunca no Git.

## Limitações

A sincronização traz os mesmos campos do export de planilha (tipo, responsável,
status, datas, prioridade, projeto). **Story points**, **worklogs** e histórico de
transições não são lidos — então não há horas apontadas nem cycle time real. O
"tempo até concluir" usa `Criado` → `Atualizado`, que é uma aproximação do lead time.
