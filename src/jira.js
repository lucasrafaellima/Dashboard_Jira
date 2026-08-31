// Cliente da API REST do Jira — fetch nativo, sem dependencias.
//
// Autenticacao:
//   * Jira Cloud  -> Basic com "e-mail:token da API"
//   * Jira Server/Data Center -> Bearer com Personal Access Token (deixe o e-mail vazio)
//
// A busca de issues usa /rest/api/3/search/jql (paginacao por nextPageToken, o
// endpoint atual do Cloud) e cai automaticamente para /rest/api/2/search
// (paginacao por startAt) em instalacoes Server/DC ou sites mais antigos.

// `parent` traz a issue pai ja resumida (chave, tipo e titulo) — e o que liga
// cada ticket ao epico do espaco a que ele pertence.
export const CAMPOS_PADRAO = [
  'summary', 'issuetype', 'assignee', 'reporter', 'priority',
  'status', 'resolution', 'resolutiondate', 'created', 'updated', 'duedate',
  'project', 'parent',
  // quando o item entrou na categoria atual. Serve de data de conclusao nos
  // workflows que fecham sem preencher resolucao (o Suporte faz isso).
  'statuscategorychangedate',
];

const PAGINA = 100;
const TENTATIVAS = 3;

// por site: qual dialeto de busca funciona ('jql' novo, 'legado' antigo)
const dialeto = new Map();

export class ErroJira extends Error {
  constructor(mensagem, status) {
    super(mensagem);
    this.name = 'ErroJira';
    this.status = status;
  }
}

function autorizacao(cfg) {
  if (!cfg.token) {
    throw new ErroJira('Token da API do Jira não configurado. Veja docs/CONFIGURACAO-JIRA.md.', 0);
  }
  if (cfg.email) {
    return `Basic ${Buffer.from(`${cfg.email}:${cfg.token}`).toString('base64')}`;
  }
  return `Bearer ${cfg.token}`;
}

function explicar(status, corpo, caminho) {
  const detalhe = [
    ...(Array.isArray(corpo?.errorMessages) ? corpo.errorMessages : []),
    ...(corpo?.errors ? Object.values(corpo.errors) : []),
  ].join(' ');

  if (status === 401) {
    return 'Credenciais recusadas (401). Confira o e-mail da conta Atlassian e gere um novo token '
      + 'em https://id.atlassian.com/manage-profile/security/api-tokens.';
  }
  if (status === 403) {
    return `Acesso negado (403). ${detalhe || 'A conta não tem permissão para ler esses dados no Jira.'}`;
  }
  if (status === 404) {
    return `Recurso não encontrado (404) em ${caminho}. Confira se a URL do site do Jira está correta.`;
  }
  if (status === 429) {
    return 'O Jira limitou a taxa de requisições (429). Tente de novo em alguns minutos.';
  }
  return `Jira respondeu ${status}${detalhe ? `: ${detalhe}` : ''}.`;
}

async function esperar(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

/** Uma requisicao a API, com repeticao em 429 e 5xx. */
async function requisitar(cfg, caminho, { metodo = 'GET', corpo } = {}) {
  if (!cfg.url) throw new ErroJira('URL do Jira não configurada. Veja docs/CONFIGURACAO-JIRA.md.', 0);
  const alvo = `${cfg.url}${caminho}`;

  let ultimoErro = null;
  for (let tentativa = 1; tentativa <= TENTATIVAS; tentativa++) {
    let resposta;
    try {
      resposta = await fetch(alvo, {
        method: metodo,
        headers: {
          Authorization: autorizacao(cfg),
          Accept: 'application/json',
          ...(corpo ? { 'Content-Type': 'application/json' } : {}),
        },
        body: corpo ? JSON.stringify(corpo) : undefined,
        signal: AbortSignal.timeout(60000),
      });
    } catch (e) {
      ultimoErro = new ErroJira(`Não consegui falar com ${cfg.url}: ${e.message}`, 0);
      if (tentativa < TENTATIVAS) { await esperar(1000 * tentativa); continue; }
      throw ultimoErro;
    }

    const texto = await resposta.text();
    let dados = null;
    try { dados = texto ? JSON.parse(texto) : null; } catch { /* resposta nao-JSON */ }

    if (resposta.ok) return dados;

    if ((resposta.status === 429 || resposta.status >= 500) && tentativa < TENTATIVAS) {
      const espera = Number(resposta.headers.get('retry-after')) * 1000 || 2000 * tentativa;
      await esperar(Math.min(espera, 30000));
      continue;
    }

    throw new ErroJira(explicar(resposta.status, dados, caminho), resposta.status);
  }
  throw ultimoErro;
}

/** Dados da conta autenticada — serve como teste de conexao. */
export async function verificarConexao(cfg) {
  try {
    const eu = await requisitar(cfg, '/rest/api/3/myself');
    return { ok: true, conta: eu?.displayName || eu?.name || '(sem nome)', email: eu?.emailAddress || cfg.email, api: 3 };
  } catch (e) {
    if (e.status !== 404) throw e;
    const eu = await requisitar(cfg, '/rest/api/2/myself');
    return { ok: true, conta: eu?.displayName || eu?.name || '(sem nome)', email: eu?.emailAddress || cfg.email, api: 2 };
  }
}

/**
 * Confere que o Jira reconheceu as credenciais.
 *
 * Precisa existir porque o Jira Cloud **nao** responde 401 nas consultas: quem
 * chega com token invalido ou vencido e atendido como visitante anonimo e
 * recebe 200 com lista vazia. Sem essa checagem, um token expirado aparece no
 * dashboard como "nenhum projeto visivel" e "nenhuma issue nova" — o sistema
 * parece funcionando enquanto deixa de trazer dados.
 */
export async function exigirAutenticacao(cfg) {
  try {
    return await verificarConexao(cfg);
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      throw new ErroJira(
        'O Jira atendeu a requisição como visitante anônimo — o token da API não vale mais para esta conta. '
        + 'Gere outro em https://id.atlassian.com/manage-profile/security/api-tokens e salve em "Configurar Jira" '
        + `(ou no arquivo .env). Resposta do Jira: ${e.message}`,
        e.status,
      );
    }
    throw e;
  }
}

/** Projetos visiveis para a conta configurada. */
export async function listarProjetos(cfg) {
  const projetos = [];
  try {
    let inicio = 0;
    for (;;) {
      const p = await requisitar(cfg, `/rest/api/3/project/search?startAt=${inicio}&maxResults=50&orderBy=key`);
      for (const v of p?.values ?? []) projetos.push({ chave: v.key, nome: v.name });
      if (p?.isLast !== false) break;
      inicio += p.values.length;
      if (!p.values.length || projetos.length >= 500) break;
    }
  } catch (e) {
    if (e.status !== 404) throw e;
    const lista = await requisitar(cfg, '/rest/api/2/project');
    for (const v of lista ?? []) projetos.push({ chave: v.key, nome: v.name });
  }
  // lista vazia e ambigua: ou a conta perdeu acesso a tudo, ou o token morreu e
  // o Jira respondeu como se fosse um visitante. Sai daqui com a resposta certa.
  if (!projetos.length) await exigirAutenticacao(cfg);
  return projetos.sort((a, b) => a.chave.localeCompare(b.chave));
}

// ------------------------------------------------------------ busca de issues

async function paginaNova(cfg, jql, campos, token, tamanho) {
  return requisitar(cfg, '/rest/api/3/search/jql', {
    metodo: 'POST',
    corpo: { jql, fields: campos, maxResults: tamanho, ...(token ? { nextPageToken: token } : {}) },
  });
}

async function paginaLegada(cfg, jql, campos, inicio, tamanho) {
  return requisitar(cfg, '/rest/api/2/search', {
    metodo: 'POST',
    corpo: { jql, fields: campos, maxResults: tamanho, startAt: inicio },
  });
}

/**
 * Percorre uma consulta JQL pagina a pagina, sem acumular nada.
 *
 * Quem consome grava cada pagina antes de pedir a proxima: o pico de memoria
 * nao cresce com o tamanho do projeto e o que ja foi lido nao se perde se a
 * pagina seguinte falhar.
 *
 * @param {object} cfg configuracao (url, email, token, maxIssues)
 * @param {string} jql consulta
 * @param {{campos?:string[], limite?:number, pagina?:number}} opcoes
 * @yields {{issues:object[], lidas:number, pagina:number, ultima:boolean, truncado:boolean, total:number|null}}
 */
export async function* paginasDeIssues(cfg, jql, opcoes = {}) {
  const campos = opcoes.campos ?? CAMPOS_PADRAO;
  const limite = opcoes.limite ?? cfg.maxIssues ?? 20000;
  const tamanho = opcoes.pagina ?? PAGINA;

  let modo = dialeto.get(cfg.url) ?? null;
  let token = null;
  let inicio = 0;
  let lidas = 0;
  let numero = 0;

  for (;;) {
    let resposta;
    if (modo === 'legado') {
      resposta = await paginaLegada(cfg, jql, campos, inicio, tamanho);
    } else {
      try {
        resposta = await paginaNova(cfg, jql, campos, token, tamanho);
        modo = 'jql';
      } catch (e) {
        // sites Server/DC (e Cloud antigo) nao tem /search/jql
        if ((e.status === 404 || e.status === 410) && modo === null) {
          modo = 'legado';
          dialeto.set(cfg.url, modo);
          continue;
        }
        throw e;
      }
    }
    dialeto.set(cfg.url, modo);

    const total = Number(resposta?.total ?? 0) || null;
    let lote = resposta?.issues ?? [];
    const excedeu = lidas + lote.length > limite;
    if (excedeu) lote = lote.slice(0, Math.max(limite - lidas, 0));

    const acabou = modo === 'legado'
      ? (!lote.length || inicio + lote.length >= (total ?? 0))
      : (resposta?.isLast === true || !resposta?.nextPageToken || !lote.length);

    lidas += lote.length;
    numero++;
    // "truncado" = paramos pelo limite, nao porque o Jira acabou de responder
    const truncado = excedeu || (lidas >= limite && !acabou);
    const ultima = truncado || acabou;

    yield { issues: lote, lidas, pagina: numero, ultima, truncado, total };
    if (ultima) return;

    if (modo === 'legado') inicio += lote.length;
    else token = resposta?.nextPageToken ?? null;
  }
}

/**
 * Todas as issues de uma consulta, de uma vez.
 * Conveniencia para chamadas pequenas — a sincronizacao usa `paginasDeIssues`.
 * @returns {Promise<object[]>} issues cruas da API
 */
export async function buscarIssues(cfg, jql, opcoes = {}) {
  const issues = [];
  for await (const pagina of paginasDeIssues(cfg, jql, opcoes)) {
    issues.push(...pagina.issues);
    opcoes.aoProgredir?.(issues.length);
  }
  return issues;
}

/** Página da listagem de chaves. O Jira aceita bem mais quando não há campos. */
const PAGINA_CHAVES = 5000;

/** Teto da listagem de chaves — generoso porque cada chave custa quase nada. */
const LIMITE_CHAVES = 200000;

/**
 * Todas as chaves que a consulta devolve **hoje**, sem trazer os dados.
 *
 * É o que permite descobrir o que foi excluído no Jira: a sincronização
 * incremental só pede o que mudou, e uma issue apagada simplesmente não vem em
 * resposta nenhuma — não há como distinguir "não mudou" de "não existe mais"
 * sem perguntar quem ainda está lá.
 *
 * Sai barato porque pede só `key`: sem resumo, descrição nem comentários, um
 * projeto de 1.165 issues cabe numa única requisição de ~110 KB.
 *
 * Tem de ser `["key"]` mesmo, não `["id"]` nem `[]`: com `["id"]` o Jira
 * devolve só o id e **omite a chave**, e com `[]` ele ignora o pedido e manda
 * todos os campos (1 MB a cada 100 issues).
 *
 * @returns {Promise<{chaves: string[], truncado: boolean}>} `truncado` avisa
 *   que o teto foi atingido e a lista está incompleta — quem chama **não pode**
 *   apagar nada nesse caso, apagaria o que apenas não foi listado.
 */
export async function listarChaves(cfg, jql, opcoes = {}) {
  const chaves = [];
  let truncado = false;
  for await (const pagina of paginasDeIssues(cfg, jql, {
    campos: ['key'],
    pagina: opcoes.pagina ?? PAGINA_CHAVES,
    limite: opcoes.limite ?? LIMITE_CHAVES,
  })) {
    for (const issue of pagina.issues) {
      if (issue?.key) chaves.push(String(issue.key).toUpperCase());
    }
    if (pagina.truncado) truncado = true;
    opcoes.aoProgredir?.(chaves.length);
  }
  return { chaves, truncado };
}

/** Escapa um literal para uso dentro de aspas em JQL. */
export function escaparJql(valor) {
  return String(valor ?? '').replace(/["\\]/g, '\\$&');
}

// ------------------------------------------------------------ sprint

// O Sprint nao e um campo fixo da API: e um custom field do plugin agil, e o
// numero dele muda de site para site. O tipo (`schema.custom`) e o mesmo em
// todo lugar, entao a busca e por ele; o id abaixo e so o palpite do Cloud
// novo, usado quando a listagem de campos nao pode ser lida.
const TIPO_CAMPO_SPRINT = 'com.atlassian.greenhopper.jira.plugin.system.customfieldtypes:gh-sprint';
const CAMPO_SPRINT_PADRAO = 'customfield_10020';

// por site: o id ja descoberto, para nao repetir a listagem de campos
const campoSprintPorSite = new Map();

/**
 * Id do custom field "Sprint" neste site do Jira.
 *
 * Devolve `null` quando o site nao tem o campo — instalacao sem o modulo agil.
 * Nesse caso ninguem tem sprint, e a sincronizacao simplesmente nao pede o
 * campo em vez de estourar a consulta inteira com "campo desconhecido".
 */
export async function descobrirCampoSprint(cfg) {
  if (campoSprintPorSite.has(cfg.url)) return campoSprintPorSite.get(cfg.url);

  let achado = null;
  try {
    const campos = await requisitar(cfg, '/rest/api/3/field');
    const lista = Array.isArray(campos) ? campos : [];
    achado = lista.find((c) => c?.schema?.custom === TIPO_CAMPO_SPRINT)
      ?? lista.find((c) => c?.custom && String(c?.name ?? '').toLowerCase() === 'sprint')
      ?? null;
    achado = achado?.id ?? null;
  } catch {
    // sem permissao para listar campos: o palpite ainda costuma acertar, e um
    // campo inexistente so faz a issue chegar sem sprint
    achado = CAMPO_SPRINT_PADRAO;
  }
  campoSprintPorSite.set(cfg.url, achado);
  return achado;
}

// ------------------------------------------------------------ quadros ageis

/**
 * Quadros ageis visiveis, cada um com o projeto a que pertence.
 *
 * `projeto` vem `null` em quadro montado sobre um filtro solto (que pode juntar
 * varios projetos); quem chama trata esse caso, porque a associacao
 * projeto -> quadro deixa de valer ali.
 */
export async function listarQuadros(cfg) {
  const quadros = [];
  let inicio = 0;
  for (;;) {
    const p = await requisitar(cfg, `/rest/agile/1.0/board?startAt=${inicio}&maxResults=50`);
    const lote = p?.values ?? [];
    for (const v of lote) {
      quadros.push({ id: v.id, nome: v.name ?? `quadro ${v.id}`, projeto: v.location?.projectKey ?? null });
    }
    if (!lote.length || p?.isLast !== false || quadros.length >= 500) break;
    inicio += lote.length;
  }
  return quadros;
}

/**
 * Sprints de um quadro, da mais antiga para a mais nova.
 *
 * Lista vazia quer dizer "este quadro nao trabalha com sprint": um quadro
 * Kanban responde **400** a esta rota, e e exatamente por ai que os dois tipos
 * de quadro se separam sem depender do campo `type` — em projetos gerenciados
 * pela equipe todos se declaram `simple`, Scrum e Kanban igualmente.
 */
export async function listarSprintsDoQuadro(cfg, id) {
  const sprints = [];
  let inicio = 0;
  for (;;) {
    let p;
    try {
      p = await requisitar(cfg, `/rest/agile/1.0/board/${id}/sprint?startAt=${inicio}&maxResults=50`);
    } catch (e) {
      // 400 = quadro sem sprint (Kanban); 404 = quadro sumiu no meio da passada
      if (e.status === 400 || e.status === 404) return [];
      throw e;
    }
    const lote = p?.values ?? [];
    for (const s of lote) sprints.push({ id: s.id, nome: s.name ?? '', estado: s.state ?? '' });
    if (!lote.length || p?.isLast !== false || sprints.length >= 500) break;
    inicio += lote.length;
  }
  return sprints;
}

/**
 * Chaves das issues no backlog de um quadro.
 *
 * `chaves: null` significa **nao sei**, nao "backlog vazio": alguns quadros
 * respondem erro nesta rota (um quadro gerenciado pela equipe sem backlog
 * habilitado devolve 500). Quem chama nao pode confundir os dois — marcar tudo
 * como fora do backlog e o certo ali, mas o motivo tem de aparecer no aviso.
 */
export async function listarBacklogDoQuadro(cfg, id) {
  const chaves = [];
  let inicio = 0;
  for (;;) {
    let p;
    try {
      p = await requisitar(cfg, `/rest/agile/1.0/board/${id}/backlog?startAt=${inicio}&maxResults=100&fields=key`);
    } catch (e) {
      return { chaves: null, erro: e.message };
    }
    const lote = p?.issues ?? [];
    for (const i of lote) if (i?.key) chaves.push(String(i.key).toUpperCase());
    inicio += lote.length;
    if (!lote.length || inicio >= (Number(p?.total) || 0) || chaves.length >= 50000) break;
  }
  return { chaves, erro: null };
}
