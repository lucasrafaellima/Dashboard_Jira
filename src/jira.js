// Cliente da API REST do Jira — fetch nativo, sem dependencias.
//
// Autenticacao:
//   * Jira Cloud  -> Basic com "e-mail:token da API"
//   * Jira Server/Data Center -> Bearer com Personal Access Token (deixe o e-mail vazio)
//
// A busca de issues usa /rest/api/3/search/jql (paginacao por nextPageToken, o
// endpoint atual do Cloud) e cai automaticamente para /rest/api/2/search
// (paginacao por startAt) em instalacoes Server/DC ou sites mais antigos.

const CAMPOS_PADRAO = [
  'summary', 'issuetype', 'assignee', 'reporter', 'priority',
  'status', 'resolution', 'created', 'updated', 'duedate', 'project',
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
  return projetos.sort((a, b) => a.chave.localeCompare(b.chave));
}

// ------------------------------------------------------------ busca de issues

async function paginaNova(cfg, jql, campos, token) {
  return requisitar(cfg, '/rest/api/3/search/jql', {
    metodo: 'POST',
    corpo: { jql, fields: campos, maxResults: PAGINA, ...(token ? { nextPageToken: token } : {}) },
  });
}

async function paginaLegada(cfg, jql, campos, inicio) {
  return requisitar(cfg, '/rest/api/2/search', {
    metodo: 'POST',
    corpo: { jql, fields: campos, maxResults: PAGINA, startAt: inicio },
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
 * @param {{campos?:string[], limite?:number}} opcoes
 * @yields {{issues:object[], lidas:number, pagina:number, ultima:boolean, truncado:boolean, total:number|null}}
 */
export async function* paginasDeIssues(cfg, jql, opcoes = {}) {
  const campos = opcoes.campos ?? CAMPOS_PADRAO;
  const limite = opcoes.limite ?? cfg.maxIssues ?? 20000;

  let modo = dialeto.get(cfg.url) ?? null;
  let token = null;
  let inicio = 0;
  let lidas = 0;
  let numero = 0;

  for (;;) {
    let resposta;
    if (modo === 'legado') {
      resposta = await paginaLegada(cfg, jql, campos, inicio);
    } else {
      try {
        resposta = await paginaNova(cfg, jql, campos, token);
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

/** Escapa um literal para uso dentro de aspas em JQL. */
export function escaparJql(valor) {
  return String(valor ?? '').replace(/["\\]/g, '\\$&');
}
