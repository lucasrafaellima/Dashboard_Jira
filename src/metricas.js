// Agregacoes que alimentam o dashboard.
// Este modulo e puro de proposito: nao conhece banco, disco nem rede. Os dados
// chegam prontos pela `fonte`, um objeto { itens, importacoes, sincronizacoes }.
// No servidor quem monta a fonte e `fonte-node.js` (le do SQLite); no navegador
// e o snapshot baixado do Firestore. Assim o mesmo motor roda nos dois lados.
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

// ------------------------------------------------------------ produtividade semanal

const DIA_MS = 86400000;

/** Quantas semanas o comparativo mostra, contando a atual. */
const SEMANAS_COMPARADAS = 8;

const soDia = (iso) => String(iso).slice(0, 10);
const somarDias = (dia, n) => new Date(Date.parse(`${dia}T00:00:00Z`) + n * DIA_MS)
  .toISOString().slice(0, 10);

/**
 * Segunda-feira da semana de um dia, como "aaaa-mm-dd".
 * Semana de segunda a domingo — e o que a operacao entende por "essa semana",
 * e nao a semana do domingo que o `getDay()` do JS usa.
 */
function inicioDaSemana(dia) {
  const d = new Date(`${soDia(dia)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** Variacao percentual contra uma base; `null` quando a base e zero. */
function variacaoPct(atual, base) {
  return base ? +(((atual - base) / base) * 100).toFixed(1) : null;
}

const somar = (lista) => lista.reduce((s, v) => s + v, 0);
const media1 = (lista) => (lista.length ? +(somar(lista) / lista.length).toFixed(1) : 0);

/** Uma linha por conclusao: o dia em que fechou e de quem foi. */
function eventosDeConclusao(itens) {
  const eventos = [];
  for (const it of itens) {
    const fim = dataDeConclusao(it);
    if (fim) eventos.push({ dia: soDia(fim), quem: it.responsavel || SEM_RESPONSAVEL });
  }
  return eventos;
}

/**
 * Espalha as conclusoes por uma janela de semanas ja definida.
 *
 * A janela vem de fora porque o cartao a percorre duas vezes, com populacoes
 * diferentes (o ranking inteiro e o recorte do responsavel selecionado), e as
 * duas precisam cair exatamente nas mesmas semanas — senao a faisca da tabela e
 * as barras ao lado falariam de periodos diferentes.
 *
 * @returns {{ pessoas: Map<string, object>, totais: number[] }}
 */
function distribuirPorSemana(eventos, { inicios, posicao, ultima, limiteAnterior }) {
  const pessoas = new Map();
  const totais = inicios.map(() => 0);
  for (const e of eventos) {
    const i = posicao.get(inicioDaSemana(e.dia));
    if (i == null) continue;
    if (!pessoas.has(e.quem)) {
      pessoas.set(e.quem, { rotulo: e.quem, serie: inicios.map(() => 0), ateAqui: 0 });
    }
    const p = pessoas.get(e.quem);
    p.serie[i]++;
    totais[i]++;
    if (i === ultima - 1 && e.dia < limiteAnterior) p.ateAqui++;
  }
  return { pessoas, totais };
}

/**
 * Produtividade semanal por colaborador — quantas atividades cada um concluiu
 * em cada uma das ultimas semanas, com o comparativo contra a semana anterior.
 *
 * Tres decisoes que mudam o numero e por isso ficam explicitas:
 *
 *   - **a semana em curso e parcial**. Comparar uma terca-feira com uma semana
 *     inteira acusaria queda de 60% toda segunda. Quando a ultima semana ainda
 *     esta correndo, a comparacao e contra o **mesmo trecho** da semana passada
 *     (do inicio ate o mesmo dia da semana) — e isso que `comparavel` guarda.
 *     `anterior` continua trazendo a semana passada fechada, para quem quiser o
 *     numero cheio.
 *   - **conclusao e o que conta**. Produtividade aqui e entrega, entao o item
 *     entra na semana em que foi concluido (ver `dataDeConclusao`), nao na
 *     semana em que nasceu.
 *   - **o ranking e o total falam de populacoes diferentes**, de proposito. O
 *     ranking vem de `concluidas`, que ignora o filtro de responsaveis: e por
 *     ele que se troca a selecao, e filtrado deixaria uma linha so na tela. Ja
 *     os totais por semana e o resumo vem de `concluidasDoFiltro`, que respeita
 *     a selecao — clicar num colaborador refaz o grafico ao lado com o ritmo
 *     dele. A janela de semanas sai do conjunto inteiro nos dois casos, para
 *     que a selecao mude os numeros e nunca o periodo debaixo deles.
 *
 * @param {object[]} concluidas concluidas ignorando o filtro de responsaveis
 * @param {object[]} [concluidasDoFiltro] concluidas respeitando esse filtro
 * @param {number} [semanas] tamanho da janela, contando a semana atual
 */
function produtividadeSemanal(concluidas, concluidasDoFiltro = concluidas, semanas = SEMANAS_COMPARADAS) {
  const hoje = new Date().toISOString().slice(0, 10);
  const eventos = eventosDeConclusao(concluidas);

  // A janela normalmente termina na semana de hoje. Numa base parada (sem
  // sincronizacao ha um mes) ou num recorte historico, isso deixaria o cartao
  // inteiro zerado: nesse caso ela desliza para a ultima semana com entrega,
  // que ao menos tem o que comparar. `emCurso` diz qual dos dois aconteceu.
  const maisRecente = eventos.reduce((m, e) => (e.dia > m ? e.dia : m), '');
  const semanaDeHoje = inicioDaSemana(hoje);
  let ancora = semanaDeHoje;
  if (maisRecente) {
    const semanaDoDado = inicioDaSemana(maisRecente);
    const primeira = somarDias(semanaDeHoje, -7 * (semanas - 1));
    if (semanaDoDado > ancora || semanaDoDado < primeira) ancora = semanaDoDado;
  }
  const emCurso = ancora === semanaDeHoje;

  const inicios = Array.from({ length: semanas }, (_, i) => somarDias(ancora, -7 * (semanas - 1 - i)));
  const posicao = new Map(inicios.map((s, i) => [s, i]));
  const ultima = semanas - 1;

  // dias ja corridos da semana atual (1 = segunda-feira); a semana fechada vale 7
  const decorridos = emCurso
    ? Math.round((Date.parse(`${hoje}T00:00:00Z`) - Date.parse(`${ancora}T00:00:00Z`)) / DIA_MS) + 1
    : 7;
  // limite (exclusivo) do trecho equivalente na semana anterior
  const limiteAnterior = ultima > 0 ? somarDias(inicios[ultima - 1], decorridos) : null;

  const janela = { inicios, posicao, ultima, limiteAnterior };
  const { pessoas } = distribuirPorSemana(eventos, janela);
  // mesma janela, so que com o recorte de responsaveis valendo
  const recorte = distribuirPorSemana(
    concluidasDoFiltro === concluidas ? eventos : eventosDeConclusao(concluidasDoFiltro),
    janela,
  );
  const totais = recorte.totais;

  const colaboradores = [...pessoas.values()].map((r) => {
    const atual = r.serie[ultima];
    const anterior = ultima > 0 ? r.serie[ultima - 1] : 0;
    const comparavel = emCurso ? r.ateAqui : anterior;
    const anteriores = r.serie.slice(0, ultima);
    return {
      rotulo: r.rotulo,
      serie: r.serie,
      atual,
      anterior,
      comparavel,
      delta: atual - comparavel,
      variacao: variacaoPct(atual, comparavel),
      media: media1(anteriores),
      melhor: Math.max(...r.serie),
      total: somar(r.serie),
    };
  });

  // quem entregou nesta semana vem primeiro; "(vazio)" nao e pessoa e fica no fim
  colaboradores.sort((a, b) => {
    if (a.rotulo === SEM_RESPONSAVEL) return 1;
    if (b.rotulo === SEM_RESPONSAVEL) return -1;
    return b.atual - a.atual || b.total - a.total || a.rotulo.localeCompare(b.rotulo, 'pt-BR');
  });

  // o resumo acompanha o grafico ao lado: os dois falam do recorte selecionado,
  // e nao do ranking inteiro que fica na tabela
  const noRecorte = [...recorte.pessoas.values()];
  const atual = totais[ultima];
  const anterior = ultima > 0 ? totais[ultima - 1] : 0;
  const comparavel = emCurso ? somar(noRecorte.map((p) => p.ateAqui)) : anterior;
  const ativos = noRecorte.filter((p) => p.serie[ultima] > 0).length;

  return {
    semanas: inicios.map((inicio, i) => ({
      inicio,
      fim: somarDias(inicio, 6),
      total: totais[i],
      // a ultima barra pode estar pela metade: o grafico marca isso
      parcial: i === ultima && emCurso && decorridos < 7,
    })),
    colaboradores,
    resumo: {
      atual,
      anterior,
      comparavel,
      delta: atual - comparavel,
      variacao: variacaoPct(atual, comparavel),
      // media das semanas fechadas anteriores — a referencia de ritmo
      media: media1(totais.slice(0, ultima)),
      ativos,
      porColaborador: ativos ? +(atual / ativos).toFixed(1) : 0,
      emCurso,
      decorridos,
      inicio: inicios[ultima],
      fim: somarDias(inicios[ultima], 6),
    },
  };
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

/**
 * Monta o payload completo do dashboard.
 * @param fonte  { itens, importacoes, sincronizacoes } — ver `metricas-banco.js`
 * @param filtros recortes da tela (periodo, responsaveis, status, epicos…)
 */
export function montarDashboard(fonte, filtros = {}) {
  const incluirCancelados = !!filtros.incluirCancelados;
  const todos = fonte.itens;
  const base = aplicarRecortes(todos, filtros);
  const {
    criadas, concluidas, criadasEConcluidas, universo: itens,
  } = separarPorPeriodo(base, filtros, incluirCancelados);

  const total = criadas.length;
  const datas = itens.map((it) => it.criado).filter(Boolean).sort();
  const importacoes = fonte.importacoes;

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
    // O filtro de **datas** nao vale aqui, nos dois conjuntos: as semanas ja sao
    // o recorte, e com um mes filtrado sobrariam 4 semanas — sem historico para
    // comparar. Ja o de **responsaveis** vale so no segundo: o ranking (1o) traz
    // todo mundo, porque e por ele que se troca a selecao; os totais por semana
    // e o resumo (2o) seguem quem estiver selecionado. Espaco, epico, tipo e
    // prioridade continuam valendo nos dois.
    produtividadeSemanal: produtividadeSemanal(
      separarPorPeriodo(
        aplicarRecortes(todos, { ...filtros, responsaveis: [] }),
        { ...filtros, de: null, ate: null },
        incluirCancelados,
      ).concluidas,
      semData.concluidas,
    ),
    tempoDeConclusao: tempoDeConclusao(concluidas),
    padronizacao: padronizacaoAplicada(itens),
    periodo: { inicio: datas[0] ?? null, fim: datas[datas.length - 1] ?? null },
    baseTotal: todos.length,
    importacoes,
    sincronizacoes: fonte.sincronizacoes,
    geradoEm: new Date().toISOString(),
  };
}

/** Lista detalhada para a tabela do rodape (e para a exportacao em .xlsx). */
export function listarDetalhe(fonte, filtros = {}, limite = 500) {
  const base = aplicarRecortes(fonte.itens, filtros);
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
