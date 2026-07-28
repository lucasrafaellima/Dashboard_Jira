// Agregacoes que alimentam o dashboard.
import { listarItens, listarImportacoes } from './banco.js';
import { ehConcluida, SEM_RESPONSAVEL } from './normalizar.js';

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

/** Serie mensal de itens criados x concluidos (concluido pela data de atualizacao). */
function serieMensal(itens, amplo) {
  const meses = new Map();
  const garantir = (m) => {
    if (!meses.has(m)) meses.set(m, { mes: m, criadas: 0, concluidas: 0 });
    return meses.get(m);
  };
  for (const it of itens) {
    const mc = mesDe(it.criado);
    if (mc) garantir(mc).criadas++;
    if (ehConcluida(it.status, amplo)) {
      const mf = mesDe(it.atualizado) || mc;
      if (mf) garantir(mf).concluidas++;
    }
  }
  return [...meses.values()].sort((a, b) => a.mes.localeCompare(b.mes));
}

/** Tempo em dias entre criacao e conclusao (mediana + media). */
function tempoDeConclusao(itens, amplo) {
  const dias = [];
  for (const it of itens) {
    if (!ehConcluida(it.status, amplo) || !it.criado || !it.atualizado) continue;
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
  const amplo = !!filtros.amplo;
  const todos = listarItens();
  const itens = aplicarFiltros(todos, filtros);

  const concluidas = itens.filter((it) => ehConcluida(it.status, amplo));
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
      amplo,
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
      semResponsavel: itens.filter((it) => it.responsavel === SEM_RESPONSAVEL).length,
      atrasadas: itens.filter(
        (it) => it.data_limite && !ehConcluida(it.status, amplo) && it.data_limite.slice(0, 10) < new Date().toISOString().slice(0, 10),
      ).length,
    },
    porStatus: contarPor(itens, 'status'),
    porEspaco: contarPor(itens, 'espaco'),
    porTipo: contarPor(itens, 'tipo_item'),
    porPrioridade: contarPor(itens, 'prioridade'),
    concluidasPorResponsavel: ordenarResponsaveis(contarPor(concluidas, 'responsavel')),
    criadasPorResponsavel: ordenarResponsaveis(contarPor(itens, 'responsavel')),
    serieMensal: serieMensal(itens, amplo),
    tempoDeConclusao: tempoDeConclusao(itens, amplo),
    periodo: { inicio: datas[0] ?? null, fim: datas[datas.length - 1] ?? null },
    baseTotal: todos.length,
    importacoes,
    geradoEm: new Date().toISOString(),
  };
}

/** Lista detalhada para a tabela do rodape. */
export function listarDetalhe(filtros = {}, limite = 500) {
  const itens = aplicarFiltros(listarItens(), filtros);
  itens.sort((a, b) => String(b.criado ?? '').localeCompare(String(a.criado ?? '')));
  return { total: itens.length, itens: itens.slice(0, limite) };
}
