// Sincronizacao: le as issues pela API do Jira e grava na mesma tabela usada
// pela importacao de planilhas, reaproveitando as regras de normalizar.js.
//
// Cada "origem" e um projeto do Jira (ou "(consulta)" quando ha um JQL livre
// configurado). Para cada origem guardamos a marca d'agua do maior "Atualizado"
// ja visto: a sincronizacao seguinte pede so o que mudou desde entao.
import { lerConfig } from './config.js';
import { buscarIssues, escaparJql, listarProjetos, verificarConexao } from './jira.js';
import { normalizarLinha, categoriaStatus, apelidoEspaco } from './normalizar.js';
import {
  gravarItens, lerSincronizacao, listarSincronizacoes,
  registrarSincronizacao, removerAusentes, origemJira,
} from './banco.js';

/** Folga aplicada a marca d'agua, para cobrir diferenca de fuso/relogio. */
const FOLGA_MINUTOS = 15;

export const ORIGEM_CONSULTA = '(consulta)';
export const ORIGEM_TUDO = '(todos os projetos)';

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

/** Quais consultas rodar, conforme a configuracao. */
export function definirOrigens(cfg) {
  if (cfg.jql) return [{ origem: ORIGEM_CONSULTA, base: cfg.jql }];
  if (cfg.projetos?.length) {
    return cfg.projetos.map((p) => ({ origem: p, base: `project = "${escaparJql(p)}"` }));
  }
  return [{ origem: ORIGEM_TUDO, base: '' }];
}

// ------------------------------------------------------------ mapeamento

const instante = (valor) => {
  const t = Date.parse(valor ?? '');
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** Rotulo do espaco: apelido da chave, apelido do nome, ou o nome do projeto. */
function espacoDoProjeto(projeto = {}) {
  return apelidoEspaco(projeto.key)
    ?? apelidoEspaco(projeto.name)
    ?? (String(projeto.name ?? '').trim() || String(projeto.key ?? '').trim() || 'Sem espaço');
}

/** Converte uma issue crua da API no registro gravado no banco (ou null). */
export function registroDaIssue(issue) {
  const f = issue?.fields ?? {};
  const projeto = f.project ?? {};
  const status = String(f.status?.name ?? '').trim() || 'Sem status';

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
    resolucao: f.resolution?.name,
    criado: f.created,
    atualizado: f.updated,
    data_limite: f.duedate,
    projeto: projeto.name,
    origem: projeto.key,
  });
  if (!registro) return null;

  // a API traz a categoria macro do status; usamos quando o nome nao e conhecido
  registro.status_categoria = categoriaStatus(status, f.status?.statusCategory?.key);
  registro.espaco = espacoDoProjeto(projeto);
  return registro;
}

// ------------------------------------------------------------ execucao

async function sincronizarOrigem(cfg, { origem, base }, { completa, aoProgredir }) {
  const anterior = lerSincronizacao(origem);
  const desde = completa ? null : anterior?.marca_agua || null;
  const jql = montarJql(base, desde);

  aoProgredir?.({ origem, fase: 'consultando', jql });

  const issues = await buscarIssues(cfg, jql, {
    aoProgredir: (lidas) => aoProgredir?.({ origem, fase: 'lendo', lidas }),
  });

  const registros = [];
  let marcaAgua = anterior?.marca_agua ?? null;
  for (const issue of issues) {
    const r = registroDaIssue(issue);
    if (r) registros.push(r);
    const u = instante(issue?.fields?.updated);
    if (u && (!marcaAgua || u > marcaAgua)) marcaAgua = u;
  }

  const gravado = registros.length
    ? gravarItens(registros, origemJira(origem))
    : { novos: 0, atualizados: 0, ignorados: 0, total: 0 };

  // so a sincronizacao completa sabe o conjunto inteiro, entao so ela pode
  // concluir que uma issue sumiu do Jira
  const removidos = completa ? removerAusentes(origem, registros.map((r) => r.chave)) : 0;

  registrarSincronizacao({
    origem,
    jql,
    itens: registros.length,
    novos: gravado.novos,
    atualizados: gravado.atualizados,
    removidos,
    marcaAgua,
    erro: null,
  });

  return {
    origem, jql, completa, ok: true,
    lidas: issues.length,
    itens: registros.length,
    novos: gravado.novos,
    atualizados: gravado.atualizados,
    ignorados: gravado.ignorados,
    removidos,
  };
}

/**
 * Sincroniza todas as origens configuradas.
 * Uma origem que falha nao interrompe as outras: o erro fica registrado nela.
 * @param {{completa?:boolean, aoProgredir?:Function, config?:object}} opcoes
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
  const resultados = [];
  for (const alvo of definirOrigens(cfg)) {
    try {
      resultados.push(await sincronizarOrigem(cfg, alvo, {
        completa: !!opcoes.completa,
        aoProgredir: opcoes.aoProgredir,
      }));
    } catch (e) {
      registrarSincronizacao({ origem: alvo.origem, jql: alvo.base, erro: e.message });
      resultados.push({ origem: alvo.origem, ok: false, erro: e.message });
      opcoes.aoProgredir?.({ origem: alvo.origem, fase: 'erro', erro: e.message });
    }
  }

  const somar = (campo) => resultados.reduce((s, r) => s + (r[campo] ?? 0), 0);
  return {
    completa: !!opcoes.completa,
    duracaoMs: Date.now() - inicio,
    origens: resultados,
    novos: somar('novos'),
    atualizados: somar('atualizados'),
    removidos: somar('removidos'),
    itens: somar('itens'),
    falhas: resultados.filter((r) => !r.ok).length,
    erro: resultados.every((r) => !r.ok) ? resultados[0]?.erro ?? null : null,
  };
}

export { listarSincronizacoes, listarProjetos, verificarConexao };
