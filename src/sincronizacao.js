// Sincronizacao: le as issues pela API do Jira e grava na mesma tabela usada
// pela importacao de planilhas, reaproveitando as regras de normalizar.js.
//
// Cada "origem" e um projeto do Jira (ou "(consulta)" quando ha um JQL livre
// configurado). Para cada origem guardamos a marca d'agua do maior "Atualizado"
// ja visto: a sincronizacao seguinte pede so o que mudou desde entao.
import { lerConfig } from './config.js';
import {
  paginasDeIssues, escaparJql, listarProjetos, verificarConexao, exigirAutenticacao,
  listarChaves,
} from './jira.js';
import { normalizarLinha, espacoDoProjeto } from './normalizar.js';
import {
  gravarItens, lerSincronizacao, listarSincronizacoes, contarItensDaOrigem,
  registrarSincronizacao, removerAusentes, origemJira, resolverEpicos,
} from './banco.js';

/** Folga aplicada a marca d'agua, para cobrir diferenca de fuso/relogio. */
const FOLGA_MINUTOS = 15;

/** Pausa entre um projeto e o proximo, para nao esbarrar no limite do Jira. */
const PAUSA_ORIGENS_MS = 400;

export const ORIGEM_CONSULTA = '(consulta)';
export const ORIGEM_TUDO = '(todos os projetos)';

// Filtro da consulta de ultimo recurso (quando nem da para listar os projetos).
// Nao pode ser vazio: sites Cloud recusam JQL sem restricao com
// "As consultas JQL ilimitadas não são permitidas aqui" (400). Um recorte por
// data de criacao aberto o suficiente para pegar tudo serve de restricao.
const BASE_TUDO = 'created >= "1970-01-01"';

const pausar = (ms) => (ms > 0 ? new Promise((r) => { setTimeout(r, ms); }) : Promise.resolve());

// ------------------------------------------------------------ JQL

/** Separa a parte de filtro da clausula ORDER BY de um JQL. */
function partirJql(jql) {
  const texto = String(jql ?? '').trim();
  const m = /\border\s+by\b/i.exec(texto);
  if (!m) return { filtro: texto, ordem: '' };
  return { filtro: texto.slice(0, m.index).trim(), ordem: texto.slice(m.index).trim() };
}

/** Instante UTC -> "aaaa-MM-dd HH:mm" no fuso da maquina, como o JQL espera. */
function dataParaJql(instanteUtc, folgaMinutos = FOLGA_MINUTOS) {
  const t = Date.parse(instanteUtc);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t - folgaMinutos * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Monta o JQL final: filtro da origem + recorte incremental + ordenacao estavel. */
export function montarJql(base, desde) {
  const { filtro, ordem } = partirJql(base);
  const partes = [];
  if (filtro) partes.push(`(${filtro})`);
  const corte = desde ? dataParaJql(desde) : null;
  if (corte) partes.push(`updated >= "${corte}"`);
  return `${partes.join(' AND ')} ${ordem || 'ORDER BY updated ASC'}`.trim();
}

/** Uma origem por chave de projeto. */
const origensDosProjetos = (chaves) =>
  chaves.map((p) => ({ origem: p, base: `project = "${escaparJql(p)}"` }));

/** Quais consultas rodar, olhando so a configuracao (sem falar com a API). */
export function definirOrigens(cfg) {
  if (cfg.jql) return [{ origem: ORIGEM_CONSULTA, base: cfg.jql }];
  if (cfg.projetos?.length) return origensDosProjetos(cfg.projetos);
  return [{ origem: ORIGEM_TUDO, base: BASE_TUDO }];
}

/**
 * Como `definirOrigens`, mas quando nao ha projetos nem JQL configurados
 * descobre os projetos visiveis e devolve **uma origem por projeto**, em vez de
 * uma unica consulta com o site inteiro.
 *
 * E o que faz a sincronizacao rodar um projeto de cada vez: cada um tem a sua
 * marca d'agua, o seu registro de erro e a sua propria transacao no banco.
 */
export async function resolverOrigens(cfg) {
  if (cfg.jql || cfg.projetos?.length) return definirOrigens(cfg);

  try {
    const projetos = await listarProjetos(cfg);
    if (projetos.length) return origensDosProjetos(projetos.map((p) => p.chave));
  } catch (e) {
    // sem permissao para listar projetos: sobra a consulta unica
    return [{
      origem: ORIGEM_TUDO,
      base: BASE_TUDO,
      aviso: `não consegui listar os projetos (${e.message}); sincronizando em uma consulta única.`,
    }];
  }
  return [{ origem: ORIGEM_TUDO, base: BASE_TUDO }];
}

// ------------------------------------------------------------ mapeamento

const instante = (valor) => {
  const t = Date.parse(valor ?? '');
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** Converte uma issue crua da API no registro gravado no banco (ou null). */
export function registroDaIssue(issue) {
  const f = issue?.fields ?? {};
  const projeto = f.project ?? {};
  const status = String(f.status?.name ?? '').trim() || 'Sem status';
  // o Jira devolve o pai ja resumido dentro da propria issue (chave, tipo e
  // titulo) — e por ele que o ticket chega ao epico do espaco
  const pai = f.parent ?? null;

  // Quando o item foi concluido, na melhor fonte disponivel:
  //   1. resolutiondate — a data oficial da resolucao;
  //   2. statuscategorychangedate — quando ele entrou na categoria "done", para
  //      os workflows que fecham sem resolucao nenhuma (ex.: "FECHADO" no
  //      Suporte). So vale se ele estiver encerrado agora: em item aberto esse
  //      campo marca a entrada em "em andamento".
  // Se nenhuma existir, normalizarLinha deixa vazio e o dashboard cai no
  // "Atualizado(a)" — o proxy antigo, agora so como ultimo recurso.
  const encerrado = f.status?.statusCategory?.key === 'done';
  const concluidoEm = f.resolutiondate || (encerrado ? f.statuscategorychangedate : null);

  const registro = normalizarLinha({
    tipo_item: f.issuetype?.name,
    chave: issue?.key,
    id_item: issue?.id,
    resumo: f.summary,
    responsavel: f.assignee?.displayName,
    id_responsavel: f.assignee?.accountId ?? f.assignee?.key,
    relator: f.reporter?.displayName,
    id_relator: f.reporter?.accountId ?? f.reporter?.key,
    prioridade: f.priority?.name,
    status,
    // a API traz a categoria macro do status; vale quando o nome nao e conhecido
    categoria_api: f.status?.statusCategory?.key,
    resolucao: f.resolution?.name,
    criado: f.created,
    atualizado: f.updated,
    concluido_em: concluidoEm,
    data_limite: f.duedate,
    projeto: projeto.name,
    origem: projeto.key,
    pai: pai?.key,
    pai_tipo: pai?.fields?.issuetype?.name,
    pai_resumo: pai?.fields?.summary,
  });
  if (!registro) return null;

  registro.espaco = espacoDoProjeto(projeto.key, projeto.name);
  return registro;
}

// ------------------------------------------------------------ execucao

/**
 * Tira da base o que nao existe mais no Jira.
 *
 * Roda em **toda** sincronizacao, nao so na completa. A passada incremental
 * pede apenas `updated >= marca d'agua`, e uma issue excluida nao aparece em
 * resposta nenhuma — sem perguntar quem ainda esta la, "apagada" e
 * indistinguivel de "nao mudou", e o ticket ficava para sempre na base.
 *
 * A pergunta e uma consulta enxuta, so de chaves (ver `listarChaves`).
 *
 * Tres situacoes em que **nada** e removido, porque apagariam dado bom:
 *   * a listagem falhou — sem lista, todo mundo pareceria ausente;
 *   * a listagem bateu no teto — o que ficou de fora nao esta excluido;
 *   * veio vazia com a base cheia — mais provavel ter perdido acesso ao
 *     projeto do que alguem ter apagado todas as issues de uma vez.
 *
 * @returns {Promise<{removidos:number, avisos:string[]}>}
 */
async function removerExcluidas(cfg, alvo) {
  const avisos = [];
  // sem o recorte incremental: aqui interessa quem existe agora, nao quem mudou
  const jql = montarJql(alvo.base, null);

  let listagem;
  try {
    listagem = await listarChaves(cfg, jql);
  } catch (e) {
    return { removidos: 0, avisos: [`não consegui conferir o que foi excluído (${e.message})`] };
  }

  if (listagem.truncado) {
    return {
      removidos: 0,
      avisos: ['a lista de issues do Jira não coube no teto de leitura; '
        + 'nada foi removido para não apagar o que só não foi listado'],
    };
  }

  const naBase = contarItensDaOrigem(alvo.origem);
  if (!listagem.chaves.length && naBase > 0) {
    return {
      removidos: 0,
      avisos: [`o Jira não devolveu nenhuma issue, mas a base tem ${naBase} item(ns) desta origem — `
        + 'nada foi removido; confira o acesso da conta a este projeto'],
    };
  }

  return { removidos: removerAusentes(alvo.origem, listagem.chaves), avisos };
}

/**
 * Sincroniza uma origem (um projeto), pagina a pagina.
 *
 * Cada pagina lida e gravada antes de pedir a proxima. Duas consequencias:
 * o consumo de memoria nao depende do tamanho do projeto, e uma falha no meio
 * do caminho preserva tudo o que ja entrou na base.
 */
async function sincronizarOrigem(cfg, alvo, ctx) {
  const { origem, base } = alvo;
  const anterior = lerSincronizacao(origem);
  const marcaAnterior = anterior?.marca_agua ?? null;
  const desde = ctx.completa ? null : marcaAnterior || null;
  const jql = montarJql(base, desde);
  // com a ordenacao padrao (updated ASC) o que ja foi lido e sempre o mais
  // antigo, entao a marca d'agua parcial e segura. Com um ORDER BY do usuario
  // nao ha essa garantia: ai a marca so avanca se a origem terminar inteira.
  const ordemPropria = Boolean(partirJql(base).ordem);

  const progresso = (extra) =>
    ctx.aoProgredir?.({ origem, indice: ctx.indice, total: ctx.total, ...extra });

  progresso({ fase: 'consultando', jql });

  const conta = { lidas: 0, itens: 0, novos: 0, atualizados: 0, ignorados: 0, paginas: 0 };
  const rotulo = origemJira(origem);
  let marcaAgua = marcaAnterior;
  let truncado = false;

  try {
    for await (const pagina of paginasDeIssues(cfg, jql, { limite: cfg.maxIssues })) {
      conta.paginas++;
      conta.lidas += pagina.issues.length;
      if (pagina.truncado) truncado = true;

      const registros = [];
      for (const issue of pagina.issues) {
        const r = registroDaIssue(issue);
        if (r) registros.push(r);
        const u = instante(issue?.fields?.updated);
        if (u && (!marcaAgua || u > marcaAgua)) marcaAgua = u;
      }

      if (registros.length) {
        const gravado = gravarItens(registros, rotulo);
        conta.itens += registros.length;
        conta.novos += gravado.novos;
        conta.atualizados += gravado.atualizados;
        conta.ignorados += gravado.ignorados;
      }

      progresso({
        fase: 'lendo',
        lidas: conta.lidas,
        gravados: conta.itens,
        paginas: conta.paginas,
        totalJira: pagina.total,
      });

      if (!pagina.ultima) await pausar(ctx.pausaPaginaMs);
    }
  } catch (e) {
    // registra o progresso parcial: a proxima passada retoma daqui em vez de
    // reler o projeto inteiro
    registrarSincronizacao({
      origem,
      jql,
      itens: conta.itens,
      novos: conta.novos,
      atualizados: conta.atualizados,
      removidos: 0,
      marcaAgua: ordemPropria ? marcaAnterior : marcaAgua,
      erro: e.message,
    });
    e.registrado = true;
    e.parcial = { ...conta };
    throw e;
  }

  // toda passada confere o que sumiu do Jira, incremental inclusive
  progresso({ fase: 'conferindo', jql });
  const limpeza = await removerExcluidas(cfg, alvo);
  const removidos = limpeza.removidos;

  registrarSincronizacao({
    origem,
    jql,
    itens: conta.itens,
    novos: conta.novos,
    atualizados: conta.atualizados,
    removidos,
    marcaAgua: ordemPropria && truncado ? marcaAnterior : marcaAgua,
    erro: null,
  });

  const avisos = [...limpeza.avisos];
  if (truncado) {
    avisos.push(
      `limite de ${cfg.maxIssues} issues por passada atingido — o resto vem na próxima sincronização`,
    );
  }

  return { origem, jql, completa: ctx.completa, ok: true, ...conta, removidos, truncado, avisos };
}

/**
 * Sincroniza todas as origens configuradas, **uma de cada vez**.
 *
 * Sem projetos nem JQL configurados, descobre os projetos visiveis e trata cada
 * um como uma origem separada. Uma origem que falha nao interrompe as outras: o
 * erro fica registrado nela e a proxima comeca.
 *
 * @param {{completa?:boolean, aoProgredir?:Function, config?:object,
 *          origens?:Array, pausaMs?:number, pausaPaginaMs?:number}} opcoes
 */
export async function sincronizar(opcoes = {}) {
  const cfg = opcoes.config ?? lerConfig();
  if (!cfg.configurado) {
    throw new Error(
      'Jira não configurado: faltam a URL do site e/ou o token da API. '
      + 'Preencha em Configurar Jira no dashboard ou no arquivo .env (veja docs/CONFIGURACAO-JIRA.md).',
    );
  }

  const inicio = Date.now();
  // antes de qualquer consulta: token vencido faz o Jira responder 200 com
  // lista vazia, e a passada inteira "daria certo" sem trazer nada
  await exigirAutenticacao(cfg);

  const origens = opcoes.origens ?? await resolverOrigens(cfg);
  const total = origens.length;
  const pausa = opcoes.pausaMs ?? cfg.pausaMs ?? PAUSA_ORIGENS_MS;

  opcoes.aoProgredir?.({
    fase: 'inicio',
    total,
    completa: !!opcoes.completa,
    origens: origens.map((o) => o.origem),
  });

  const resultados = [];
  for (let i = 0; i < total; i++) {
    const alvo = origens[i];
    const ctx = {
      completa: !!opcoes.completa,
      aoProgredir: opcoes.aoProgredir,
      indice: i + 1,
      total,
      pausaPaginaMs: opcoes.pausaPaginaMs ?? 0,
    };

    try {
      const r = await sincronizarOrigem(cfg, alvo, ctx);
      if (alvo.aviso) r.avisos.push(alvo.aviso);
      resultados.push(r);
      opcoes.aoProgredir?.({ ...r, fase: 'concluida', indice: ctx.indice, total });
    } catch (e) {
      if (!e.registrado) {
        registrarSincronizacao({ origem: alvo.origem, jql: alvo.base, erro: e.message });
      }
      resultados.push({ origem: alvo.origem, ok: false, erro: e.message, ...(e.parcial ?? {}) });
      opcoes.aoProgredir?.({
        origem: alvo.origem, fase: 'erro', erro: e.message, indice: ctx.indice, total,
      });
    }

    // respira entre um projeto e o proximo: nunca duas origens ao mesmo tempo
    if (i + 1 < total) await pausar(pausa);
  }

  // com tudo gravado, sobe a cadeia de pais e carimba o epico de cada ticket.
  // So aqui da para fazer isso: o pai de uma issue pode ter vindo em outra
  // pagina, em outro projeto, ou ate numa passada anterior.
  let epicosResolvidos = 0;
  try {
    epicosResolvidos = resolverEpicos();
  } catch (e) {
    opcoes.aoProgredir?.({ fase: 'aviso', erro: `não consegui resolver os épicos: ${e.message}` });
  }

  const somar = (campo) => resultados.reduce((s, r) => s + (r[campo] ?? 0), 0);
  return {
    completa: !!opcoes.completa,
    duracaoMs: Date.now() - inicio,
    origens: resultados,
    epicosResolvidos,
    novos: somar('novos'),
    atualizados: somar('atualizados'),
    removidos: somar('removidos'),
    itens: somar('itens'),
    lidas: somar('lidas'),
    truncadas: resultados.filter((r) => r.truncado).length,
    falhas: resultados.filter((r) => !r.ok).length,
    erro: resultados.length && resultados.every((r) => !r.ok) ? resultados[0]?.erro ?? null : null,
  };
}

export { listarSincronizacoes, listarProjetos, verificarConexao, resolverEpicos };
