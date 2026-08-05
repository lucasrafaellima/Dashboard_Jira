// Agregacoes que alimentam o dashboard.
import { listarItens, listarImportacoes, listarSincronizacoes } from './banco.js';
import {
  ehConcluida, SEM_RESPONSAVEL, ORDEM_PRIORIDADE, CATEGORIAS, SEM_EPICO, rotuloEpico,
  dataDeConclusao,
} from './normalizar.js';

/** Chave usada nos filtros de epico: a chave da issue, ou "(sem épico)". */
const epicoDe = (it) => it.epico || SEM_EPICO;

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

/**
 * Serie mensal de criadas x concluidas.
 *
 * Cada item entra no mes do proprio fato: a criacao no mes em que nasceu, a
 * conclusao no mes em que foi concluida. Uma atividade aberta em julho e
 * fechada em agosto soma uma criada em julho e uma concluida em agosto — o
 * merito do fechamento e do mes que fechou.
 */
function serieMensal(criadas, concluidas) {
  const meses = new Map();
  const garantir = (m) => {
    if (!meses.has(m)) meses.set(m, { mes: m, criadas: 0, concluidas: 0 });
    return meses.get(m);
  };
  for (const it of criadas) {
    const m = mesDe(it.criado);
    if (m) garantir(m).criadas++;
  }
  for (const it of concluidas) {
    const m = mesDe(dataDeConclusao(it));
    if (m) garantir(m).concluidas++;
  }
  return [...meses.values()].sort((a, b) => a.mes.localeCompare(b.mes));
}

/** Tempo em dias entre criacao e conclusao (mediana + media). */
function tempoDeConclusao(concluidas) {
  const dias = [];
  for (const it of concluidas) {
    const fim = dataDeConclusao(it);
    if (!it.criado || !fim) continue;
    const d = (Date.parse(fim) - Date.parse(it.criado)) / 86400000;
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

/**
 * Contagem por epico. O valor filtravel e a chave da issue do epico; o rotulo
 * mostrado junta chave e titulo ("WIK-193 · Julho de 2026"), porque o mesmo
 * titulo se repete em espacos diferentes.
 */
function contarPorEpico(itens) {
  const mapa = new Map();
  for (const it of itens) {
    const valor = epicoDe(it);
    if (!mapa.has(valor)) {
      mapa.set(valor, {
        valor,
        rotulo: it.epico ? rotuloEpico(it.epico, it.epico_resumo) : SEM_EPICO,
        total: 0,
      });
    }
    mapa.get(valor).total++;
  }
  // "(sem épico)" sempre por ultimo: e resto, nao um epico de verdade
  return [...mapa.values()].sort((a, b) => {
    if (a.valor === SEM_EPICO) return 1;
    if (b.valor === SEM_EPICO) return -1;
    return b.total - a.total || a.rotulo.localeCompare(b.rotulo, 'pt-BR');
  });
}

/** Filtros que nao dependem de data: valem igual para todo o painel. */
function aplicarRecortes(itens, f) {
  return itens.filter((it) => {
    if (f.espacos?.length && !f.espacos.includes(it.espaco)) return false;
    if (f.epicos?.length && !f.epicos.includes(epicoDe(it))) return false;
    if (f.responsaveis?.length && !f.responsaveis.includes(it.responsavel)) return false;
    if (f.tipos?.length && !f.tipos.includes(it.tipo_item)) return false;
    if (f.status?.length && !f.status.includes(it.status)) return false;
    if (f.prioridades?.length && !f.prioridades.includes(it.prioridade)) return false;
    return true;
  });
}

/** A data cai dentro do recorte? Sem "de" nem "até", tudo cai. */
function noPeriodo(iso, f) {
  if (!f.de && !f.ate) return true;
  if (!iso) return false;
  const dia = iso.slice(0, 10);
  if (f.de && dia < f.de) return false;
  if (f.ate && dia > f.ate) return false;
  return true;
}

/**
 * Divide o recorte em duas populacoes, porque elas respondem perguntas
 * diferentes e nao sao o mesmo conjunto:
 *
 *   - **criadas**: nasceram dentro do periodo;
 *   - **concluidas**: foram concluidas dentro do periodo, tenham nascido
 *     quando tiverem;
 *   - **criadasEConcluidas**: as duas coisas dentro do periodo — entraram e
 *     sairam sem atravessar a virada do mes. E a base da taxa de conclusao.
 *
 * Uma atividade aberta em julho e fechada em agosto conta como concluida de
 * agosto. Antes ela sumia do relatorio de agosto inteira, junto com o trabalho
 * de fecha-la — era o mes de criacao que mandava em tudo.
 *
 * O **universo** e a uniao de criadas e concluidas: e o que a tabela e os
 * graficos de composicao mostram, para que a lista embaixo case com os numeros
 * de cima. Sem recorte de data tudo isso coincide, e nada muda.
 */
function separarPorPeriodo(base, f, incluirCancelados) {
  const criadas = [];
  const concluidas = [];
  const criadasEConcluidas = [];
  const universo = [];
  for (const it of base) {
    const nasceuAqui = noPeriodo(it.criado, f);
    const fechouAqui = ehConcluida(it.status, incluirCancelados)
      && noPeriodo(dataDeConclusao(it), f);
    if (nasceuAqui) criadas.push(it);
    if (fechouAqui) concluidas.push(it);
    if (nasceuAqui && fechouAqui) criadasEConcluidas.push(it);
    if (nasceuAqui || fechouAqui) universo.push(it);
  }
  return { criadas, concluidas, criadasEConcluidas, universo };
}

/**
 * Contagem de uma dimensao **ignorando o filtro dela mesma**.
 *
 * É o que faz os gráficos servirem de filtro. Se o gráfico de status já viesse
 * filtrado por status, clicar em "Concluído" deixaria uma barra só na tela e
 * não haveria como trocar a seleção — só desfazê-la. Ignorando o próprio
 * filtro, as outras categorias continuam ali (apagadas) e clicáveis, e os
 * números delas mostram o que se ganharia ao trocar.
 *
 * Os demais filtros continuam valendo: marcar um espaço realmente muda o
 * gráfico de status.
 *
 * @param {object[]} todos base inteira
 * @param {object} filtros filtros da requisicao
 * @param {string} dim nome do filtro a ignorar ("status", "espacos"...)
 * @param {(conjuntos: {criadas:object[], concluidas:object[], universo:object[]}) => any} contar
 */
function porDimensao(todos, filtros, incluirCancelados, dim, contar) {
  const base = aplicarRecortes(todos, { ...filtros, [dim]: [] });
  return contar(separarPorPeriodo(base, filtros, incluirCancelados));
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
  const base = aplicarRecortes(todos, filtros);
  const {
    criadas, concluidas, criadasEConcluidas, universo: itens,
  } = separarPorPeriodo(base, filtros, incluirCancelados);

  const total = criadas.length;
  const datas = itens.map((it) => it.criado).filter(Boolean).sort();
  const importacoes = listarImportacoes(20);

  // cada gráfico é também um filtro, então cada um ignora o próprio recorte
  const semDim = (dim, contar) => porDimensao(todos, filtros, incluirCancelados, dim, contar);
  // a evolução mensal ignora o período: é por ela que se pula de um mês para
  // outro, e com um único mês na tela não haveria para onde ir
  const semData = separarPorPeriodo(
    aplicarRecortes(todos, filtros), { ...filtros, de: null, ate: null }, incluirCancelados,
  );

  return {
    filtrosAplicados: {
      espacos: filtros.espacos ?? [],
      epicos: filtros.epicos ?? [],
      responsaveis: filtros.responsaveis ?? [],
      tipos: filtros.tipos ?? [],
      status: filtros.status ?? [],
      prioridades: filtros.prioridades ?? [],
      de: filtros.de ?? null,
      ate: filtros.ate ?? null,
      incluirCancelados,
    },
    opcoes: {
      espacos: contarPor(todos, 'espaco').map((x) => x.rotulo),
      // o filtro de epicos acompanha os demais filtros: com um espaco marcado,
      // so aparecem os epicos daquele espaco
      epicos: semDim('epicos', (c) => contarPorEpico(c.universo))
        .map(({ valor, rotulo }) => ({ valor, rotulo })),
      responsaveis: ordenarResponsaveis(contarPor(todos, 'responsavel')).map((x) => x.rotulo),
      tipos: contarPor(todos, 'tipo_item').map((x) => x.rotulo),
      status: contarPor(todos, 'status').map((x) => x.rotulo),
    },
    indicadores: {
      criadas: total,
      concluidas: concluidas.length,
      // Quantas das criadas no periodo foram **tambem concluidas dentro dele**:
      // entraram e sairam sem atravessar a virada do mes. Mede resolucao no
      // proprio ciclo, entao o que ficou para o mes seguinte fica de fora de
      // proposito, e a taxa nunca passa de 100%.
      //
      // Nao confundir com o cartao "Atividades concluídas" ao lado, que conta
      // quem fechou dentro do periodo, tenha nascido quando tiver. Sao duas
      // perguntas diferentes e os dois numeros nao batem de proposito.
      criadasEConcluidas: criadasEConcluidas.length,
      taxaConclusao: total ? +((criadasEConcluidas.length / total) * 100).toFixed(2) : 0,
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
    porStatus: semDim('status', (c) => contarPor(c.universo, 'status')),
    porCategoria: contarNaOrdem(itens, 'status_categoria', CATEGORIAS),
    // o cartao diz "Tickets criados por espaços": so as criadas no periodo
    porEspaco: semDim('espacos', (c) => contarPor(c.criadas, 'espaco')),
    porEpico: semDim('epicos', (c) => contarPorEpico(c.universo)),
    porTipo: semDim('tipos', (c) => contarPor(c.universo, 'tipo_item')),
    porPrioridade: semDim('prioridades', (c) => contarNaOrdem(c.universo, 'prioridade', ORDEM_PRIORIDADE)),
    concluidasPorResponsavel: semDim(
      'responsaveis', (c) => ordenarResponsaveis(contarPor(c.concluidas, 'responsavel')),
    ),
    criadasPorResponsavel: semDim(
      'responsaveis', (c) => ordenarResponsaveis(contarPor(c.criadas, 'responsavel')),
    ),
    serieMensal: serieMensal(semData.criadas, semData.concluidas),
    tempoDeConclusao: tempoDeConclusao(concluidas),
    padronizacao: padronizacaoAplicada(itens),
    periodo: { inicio: datas[0] ?? null, fim: datas[datas.length - 1] ?? null },
    baseTotal: todos.length,
    importacoes,
    sincronizacoes: listarSincronizacoes(),
    geradoEm: new Date().toISOString(),
  };
}

/** Lista detalhada para a tabela do rodape (e para a exportacao em .xlsx). */
export function listarDetalhe(filtros = {}, limite = 500) {
  const base = aplicarRecortes(listarItens(), filtros);
  // mesmo universo dos indicadores: criadas no periodo + concluidas no periodo.
  // Assim a atividade de julho que fechou em agosto aparece aqui no recorte de
  // agosto, e o total da tabela bate com os cartoes de cima.
  const { universo } = separarPorPeriodo(base, filtros, !!filtros.incluirCancelados);
  universo.sort((a, b) => String(b.criado ?? '').localeCompare(String(a.criado ?? '')));
  return {
    total: universo.length,
    // `epico_rotulo` e `concluido` ja saem prontos para a tela e para a planilha
    itens: universo.slice(0, limite).map((it) => ({
      ...it,
      epico_rotulo: it.epico ? rotuloEpico(it.epico, it.epico_resumo) : SEM_EPICO,
      concluido: ehConcluida(it.status, !!filtros.incluirCancelados)
        ? dataDeConclusao(it)
        : null,
    })),
  };
}
