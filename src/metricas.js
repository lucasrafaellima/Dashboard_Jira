// Agregacoes que alimentam o dashboard.
import { listarItens, listarImportacoes, listarSincronizacoes } from './banco.js';
import { ehConcluida, SEM_RESPONSAVEL, ORDEM_PRIORIDADE, CATEGORIAS } from './normalizar.js';

function contarPor(itens, chave) {
  const mapa = new Map();
  for (const it of itens) {
    const k = it[chave] || '(vazio)';
    mapa.set(k, (mapa.get(k) || 0) + 1);
  }
  return [...mapa].map(([rotulo, total]) => ({ rotulo, total })).sort((a, b) => b.total - a.total);
}

function mesDe(iso) {
  return iso ? iso.slice(0, 7) : null;
}

/** Conta seguindo uma ordem fixa de rotulos; o que sobra vai para o fim, por total. */
function contarNaOrdem(itens, chave, ordem) {
  const contagem = contarPor(itens, chave);
  const posicao = new Map(ordem.map((r, i) => [r, i]));
  return contagem.sort((a, b) => {
    const pa = posicao.get(a.rotulo) ?? Infinity;
    const pb = posicao.get(b.rotulo) ?? Infinity;
    return pa - pb || b.total - a.total;
  });
}

/**
 * Auditoria da padronizacao: quais nomes originais do Jira foram unificados em
 * cada rotulo. E o que permite conferir que "FECHADO" virou "Concluído".
 */
function padronizacaoAplicada(itens) {
  const grupos = new Map();
  for (const it of itens) {
    const alvo = it.status || 'Sem status';
    if (!grupos.has(alvo)) {
      grupos.set(alvo, { status: alvo, categoria: it.status_categoria, total: 0, origens: new Map() });
    }
    const g = grupos.get(alvo);
    g.total++;
    const bruto = it.status_origem || alvo;
    g.origens.set(bruto, (g.origens.get(bruto) || 0) + 1);
  }
  return [...grupos.values()]
    .map((g) => ({
      status: g.status,
      categoria: g.categoria,
      total: g.total,
      origens: [...g.origens]
        .map(([rotulo, total]) => ({ rotulo, total }))
        .sort((a, b) => b.total - a.total),
      unificou: g.origens.size > 1,
    }))
    .sort((a, b) => b.total - a.total);
}

/** Serie mensal de itens criados x concluidos (concluido pela data de atualizacao). */
function serieMensal(itens, incluirCancelados) {
  const meses = new Map();
  const garantir = (m) => {
    if (!meses.has(m)) meses.set(m, { mes: m, criadas: 0, concluidas: 0 });
    return meses.get(m);
  };
  for (const it of itens) {
    const mc = mesDe(it.criado);
    if (mc) garantir(mc).criadas++;
    if (ehConcluida(it.status, incluirCancelados)) {
      const mf = mesDe(it.atualizado) || mc;
      if (mf) garantir(mf).concluidas++;
    }
  }
  return [...meses.values()].sort((a, b) => a.mes.localeCompare(b.mes));
}

/** Tempo em dias entre criacao e conclusao (mediana + media). */
function tempoDeConclusao(itens, incluirCancelados) {
  const dias = [];
  for (const it of itens) {
    if (!ehConcluida(it.status, incluirCancelados) || !it.criado || !it.atualizado) continue;
    const d = (Date.parse(it.atualizado) - Date.parse(it.criado)) / 86400000;
    if (Number.isFinite(d) && d >= 0) dias.push(d);
  }
  if (!dias.length) return { amostra: 0, mediaDias: 0, medianaDias: 0 };
  dias.sort((a, b) => a - b);
  const meio = Math.floor(dias.length / 2);
  const mediana = dias.length % 2 ? dias[meio] : (dias[meio - 1] + dias[meio]) / 2;
  return {
    amostra: dias.length,
    mediaDias: +(dias.reduce((s, v) => s + v, 0) / dias.length).toFixed(1),
    medianaDias: +mediana.toFixed(1),
  };
}

function aplicarFiltros(itens, f) {
  return itens.filter((it) => {
    if (f.espacos?.length && !f.espacos.includes(it.espaco)) return false;
    if (f.responsaveis?.length && !f.responsaveis.includes(it.responsavel)) return false;
    if (f.tipos?.length && !f.tipos.includes(it.tipo_item)) return false;
    if (f.status?.length && !f.status.includes(it.status)) return false;
    if (f.de && (!it.criado || it.criado.slice(0, 10) < f.de)) return false;
    if (f.ate && (!it.criado || it.criado.slice(0, 10) > f.ate)) return false;
    return true;
  });
}

function ordenarResponsaveis(lista) {
  // "(vazio)" sempre no fim, como no dashboard de referencia
  return lista.sort((a, b) => {
    if (a.rotulo === SEM_RESPONSAVEL) return 1;
    if (b.rotulo === SEM_RESPONSAVEL) return -1;
    return b.total - a.total || a.rotulo.localeCompare(b.rotulo, 'pt-BR');
  });
}

/** Monta o payload completo do dashboard. */
export function montarDashboard(filtros = {}) {
  const incluirCancelados = !!filtros.incluirCancelados;
  const todos = listarItens();
  const itens = aplicarFiltros(todos, filtros);

  const concluidas = itens.filter((it) => ehConcluida(it.status, incluirCancelados));
  const total = itens.length;

  const datas = itens.map((it) => it.criado).filter(Boolean).sort();
  const importacoes = listarImportacoes(20);

  return {
    filtrosAplicados: {
      espacos: filtros.espacos ?? [],
      responsaveis: filtros.responsaveis ?? [],
      tipos: filtros.tipos ?? [],
      status: filtros.status ?? [],
      de: filtros.de ?? null,
      ate: filtros.ate ?? null,
      incluirCancelados,
    },
    opcoes: {
      espacos: contarPor(todos, 'espaco').map((x) => x.rotulo),
      responsaveis: ordenarResponsaveis(contarPor(todos, 'responsavel')).map((x) => x.rotulo),
      tipos: contarPor(todos, 'tipo_item').map((x) => x.rotulo),
      status: contarPor(todos, 'status').map((x) => x.rotulo),
    },
    indicadores: {
      criadas: total,
      concluidas: concluidas.length,
      taxaConclusao: total ? +((concluidas.length / total) * 100).toFixed(2) : 0,
      emAndamento: itens.filter((it) => it.status_categoria === 'Em andamento').length,
      aFazer: itens.filter((it) => it.status_categoria === 'A fazer').length,
      canceladas: itens.filter((it) => it.status_categoria === 'Cancelado').length,
      semResponsavel: itens.filter((it) => it.responsavel === SEM_RESPONSAVEL).length,
      atrasadas: itens.filter(
        (it) => it.data_limite && !ehConcluida(it.status, incluirCancelados)
          && it.status_categoria !== 'Cancelado'
          && it.data_limite.slice(0, 10) < new Date().toISOString().slice(0, 10),
      ).length,
    },
    porStatus: contarPor(itens, 'status'),
    porCategoria: contarNaOrdem(itens, 'status_categoria', CATEGORIAS),
    porEspaco: contarPor(itens, 'espaco'),
    porTipo: contarPor(itens, 'tipo_item'),
    porPrioridade: contarNaOrdem(itens, 'prioridade', ORDEM_PRIORIDADE),
    concluidasPorResponsavel: ordenarResponsaveis(contarPor(concluidas, 'responsavel')),
    criadasPorResponsavel: ordenarResponsaveis(contarPor(itens, 'responsavel')),
    serieMensal: serieMensal(itens, incluirCancelados),
    tempoDeConclusao: tempoDeConclusao(itens, incluirCancelados),
    padronizacao: padronizacaoAplicada(itens),
    periodo: { inicio: datas[0] ?? null, fim: datas[datas.length - 1] ?? null },
    baseTotal: todos.length,
    importacoes,
    sincronizacoes: listarSincronizacoes(),
    geradoEm: new Date().toISOString(),
  };
}

/** Lista detalhada para a tabela do rodape. */
export function listarDetalhe(filtros = {}, limite = 500) {
  const itens = aplicarFiltros(listarItens(), filtros);
  itens.sort((a, b) => String(b.criado ?? '').localeCompare(String(a.criado ?? '')));
  return { total: itens.length, itens: itens.slice(0, limite) };
}
