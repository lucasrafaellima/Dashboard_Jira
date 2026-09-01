// Agregacoes que alimentam o dashboard.
// Este modulo e puro de proposito: nao conhece banco, disco nem rede. Os dados
// chegam prontos pela `fonte`, um objeto { itens, importacoes, sincronizacoes }.
// No servidor quem monta a fonte e `fonte-node.js` (le do SQLite); no navegador
// e o snapshot baixado do Firestore. Assim o mesmo motor roda nos dois lados.
import {
  ehConcluida, SEM_RESPONSAVEL, ORDEM_PRIORIDADE, CATEGORIAS, SEM_EPICO, rotuloEpico,
  dataDeConclusao, ehDeSprint, ehEpico,
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

/**
 * A semana do painel e a semana **util**: segunda a sexta. Vale para o cartao de
 * produtividade, para o grafico de concluidas por semana e para o burndown — os
 * tres falam do mesmo intervalo, e trocar aqui troca nos tres.
 *
 * Isso mede o **rotulo e a janela de comparacao**, nao a filtragem: o que fecha
 * no sabado ou no domingo continua entrando na semana que acabou (ver
 * `inicioDaSemana`). Sao 3,9% das conclusoes da base, todas com data de
 * conclusao propria — descarta-las apagaria entrega de gente que trabalhou.
 */
const DIAS_UTEIS = 5;

/**
 * Teto de semanas quando a janela sai do filtro de datas.
 *
 * Um recorte de dois anos viraria 100 barras de 7px com o rotulo de cada uma
 * por cima da outra — ilegivel. Passando disso o cartao mantem as ultimas
 * semanas do intervalo e avisa na nota que recortou.
 */
const MAX_SEMANAS_FILTRADAS = 26;

const soDia = (iso) => String(iso).slice(0, 10);
const somarDias = (dia, n) => new Date(Date.parse(`${dia}T00:00:00Z`) + n * DIA_MS)
  .toISOString().slice(0, 10);

/**
 * Segunda-feira da semana de um dia, como "aaaa-mm-dd" — e nao a semana do
 * domingo que o `getDay()` do JS usa.
 *
 * Sabado e domingo caem na segunda **da propria semana**, e e de proposito: a
 * semana que a tela mostra e util (segunda a sexta, ver `DIAS_UTEIS`), mas o que
 * alguem concluiu no fim de semana pertence a semana que estava acabando, e nao
 * a lugar nenhum.
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

/** Quantos dias separam dois dias "aaaa-mm-dd" (b - a). */
const distanciaEmDias = (a, b) => Math.round(
  (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DIA_MS,
);

/**
 * Decide **de quando ate quando** o cartao fala.
 *
 * Sao dois modos, e o filtro de datas da tela escolhe qual vale:
 *
 *   - **sem filtro de datas**: a janela e um rabo fixo de N semanas terminando
 *     na semana de hoje. Numa base parada (sem sincronizacao ha um mes) isso
 *     deixaria o cartao inteiro zerado, entao ela desliza para a ultima semana
 *     com entrega — ao menos essa tem o que comparar.
 *   - **com filtro de datas**: a janela vira o proprio intervalo, das semanas
 *     que ele toca. E o que se espera ao recortar um periodo: o cartao passa a
 *     falar dele, e nao das ultimas oito semanas independente do recorte.
 *
 * `primeiroDia`/`ultimoDia` sao as bordas reais do que esta sendo contado (o
 * intervalo pode comecar numa quarta e terminar numa quinta): e por eles que se
 * sabe quais semanas das pontas estao pela metade.
 */
function janelaDeSemanas(eventos, { de: dePleno, ate: atePleno, semanas }) {
  const hoje = new Date().toISOString().slice(0, 10);
  const semanaDeHoje = inicioDaSemana(hoje);
  // o filtro chega como "aaaa-mm-dd", mas uma data cheia nao pode virar
  // comparacao de string com o dia solto de `ultimoDia`
  const de = dePleno ? soDia(dePleno) : null;
  const ate = atePleno ? soDia(atePleno) : null;

  if (de || ate) {
    // amanha nao tem conclusao: o "ate" no futuro para em hoje. Ja um intervalo
    // inteiro no futuro (raro, mas o campo aceita) vira a semana do "de"
    let ultimoDia = ate && ate < hoje ? ate : hoje;
    if (de && de > ultimoDia) ultimoDia = de;

    const fim = inicioDaSemana(ultimoDia);
    let primeira = de ? inicioDaSemana(de) : somarDias(fim, -7 * (semanas - 1));
    let quantas = distanciaEmDias(primeira, fim) / 7 + 1;
    const truncada = quantas > MAX_SEMANAS_FILTRADAS;
    if (truncada) {
      quantas = MAX_SEMANAS_FILTRADAS;
      primeira = somarDias(fim, -7 * (quantas - 1));
    }

    return {
      inicios: Array.from({ length: quantas }, (_, i) => somarDias(primeira, 7 * i)),
      // com a janela truncada a primeira borda e a da semana, nao a do filtro
      primeiroDia: de && de > primeira ? de : primeira,
      ultimoDia,
      emCurso: fim === semanaDeHoje,
      filtrada: true,
      truncada,
    };
  }

  const maisRecente = eventos.reduce((m, e) => (e.dia > m ? e.dia : m), '');
  let ancora = semanaDeHoje;
  if (maisRecente) {
    const semanaDoDado = inicioDaSemana(maisRecente);
    const primeira = somarDias(semanaDeHoje, -7 * (semanas - 1));
    if (semanaDoDado > ancora || semanaDoDado < primeira) ancora = semanaDoDado;
  }
  const emCurso = ancora === semanaDeHoje;
  const inicios = Array.from({ length: semanas }, (_, i) => somarDias(ancora, -7 * (semanas - 1 - i)));

  return {
    inicios,
    primeiroDia: inicios[0],
    // A janela que recuou termina na semana fechada; a de hoje termina hoje.
    // Fechada e ate domingo, e nao ate sexta: a semana que a tela mostra e util,
    // mas o que fechou no fim de semana conta nela (ver `inicioDaSemana`).
    ultimoDia: emCurso ? hoje : somarDias(ancora, 6),
    emCurso,
    filtrada: false,
    truncada: false,
  };
}

/**
 * Produtividade semanal por colaborador — quantas atividades cada um concluiu
 * em cada uma das semanas da janela, com o comparativo contra a anterior.
 *
 * Quatro decisoes que mudam o numero e por isso ficam explicitas:
 *
 *   - **a janela segue o filtro de datas**. Recortou um periodo, o cartao passa
 *     a falar so dele (ver `janelaDeSemanas`). Sem recorte, o rabo padrao de
 *     oito semanas.
 *   - **a semana e util: segunda a sexta** (ver `DIAS_UTEIS`). E o que a
 *     operacao chama de semana, e o mesmo intervalo do burndown ao lado. O que
 *     alguem concluiu no sabado ou no domingo continua contando na semana que
 *     acabou — o fim de semana muda o rotulo e a conta de dias, nao a
 *     populacao. Sao poucas conclusoes, mas sao reais, e sumir com elas
 *     zeraria o numero de quem plantao fechou.
 *   - **semana pela metade e comparada pela metade**. Comparar uma terca-feira
 *     com uma semana inteira acusaria queda de 60% toda segunda. Quando a
 *     ultima semana da janela nao esta fechada — porque ainda esta correndo ou
 *     porque o filtro cortou no meio dela — a comparacao e contra o **mesmo
 *     trecho** da semana anterior (do inicio ate o mesmo dia util), e e isso que
 *     `comparavel` guarda. `anterior` continua trazendo a semana anterior
 *     cheia, para quem quiser o numero fechado.
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
 * @param {object} [opcoes] `{ de, ate }` do filtro de datas e tamanho da janela
 */
function produtividadeSemanal(concluidas, concluidasDoFiltro = concluidas, opcoes = {}) {
  const { de = null, ate = null, semanas = SEMANAS_COMPARADAS } = opcoes;
  const eventos = eventosDeConclusao(concluidas);

  const {
    inicios, primeiroDia, ultimoDia, emCurso, filtrada, truncada,
  } = janelaDeSemanas(eventos, { de, ate, semanas });
  const posicao = new Map(inicios.map((s, i) => [s, i]));
  const ultima = inicios.length - 1;

  // Dias uteis ja cobertos da ultima semana (1 = so a segunda-feira); 5 = semana
  // cheia. O fim de semana nao estica a conta: chegando no sabado a semana util
  // ja fechou, e comparar uma sexta com uma "semana de seis dias" nao existe.
  const decorridos = Math.min(
    DIAS_UTEIS, Math.max(1, distanciaEmDias(inicios[ultima], ultimoDia) + 1),
  );
  const parcial = decorridos < DIAS_UTEIS;
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
    const comparavel = parcial ? r.ateAqui : anterior;
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
  const comparavel = parcial ? somar(noRecorte.map((p) => p.ateAqui)) : anterior;
  const ativos = noRecorte.filter((p) => p.serie[ultima] > 0).length;

  return {
    semanas: inicios.map((inicio, i) => {
      const fim = somarDias(inicio, DIAS_UTEIS - 1);
      return {
        inicio,
        fim,
        total: totais[i],
        // barra pela metade: ou a semana ainda corre, ou o filtro cortou ela no
        // meio. O grafico pinta essas mais claras para nao lerem como queda
        parcial: inicio < primeiroDia || fim > ultimoDia,
      };
    }),
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
      parcial,
      decorridos,
      inicio: inicios[ultima],
      fim: somarDias(inicios[ultima], DIAS_UTEIS - 1),
      // Sem base de comparacao em dois casos, e nos dois a tela mostra "—" em
      // vez de inventar "+100%" contra o zero: o intervalo cabe numa semana so,
      // ou a semana anterior entra cortada pela borda do intervalo — comparar
      // uma semana com tres dias da anterior acusaria alta de qualquer jeito.
      semComparacao: ultima === 0 || inicios[ultima - 1] < primeiroDia,
      filtrada,
      truncada,
      primeiroDia,
      ultimoDia,
    },
  };
}

// ------------------------------------------------------------ burndown semanal

/**
 * Burndown da semana — quanto trabalho ainda estava aberto no fim de cada dia,
 * de segunda a sexta, contra a reta que zeraria a fila na sexta.
 *
 * As decisoes que mudam o desenho, explicitas porque burndown e um grafico que
 * cada time monta de um jeito:
 *
 *   - **a reta parte de onde a semana comecou de fato**: a fila no fim da
 *     segunda. As duas linhas nascem juntas, e a partir dai a distancia entre
 *     elas e a leitura inteira do cartao.
 *
 *     A alternativa — partir do escopo cheio da semana, com o que entrou depois
 *     ja embutido — foi testada e mente: num balcao de chamados a maior parte do
 *     que se fecha na semana tambem nasce nela, entao a reta comecaria muito
 *     acima da linha real e o time apareceria adiantado de segunda a quinta,
 *     ainda que terminasse a sexta com a fila do mesmo tamanho.
 *   - **o que entra depois empurra a linha real para cima**, e e assim que se
 *     ve a fila crescendo mais rapido do que se entrega. Por isso `novas` e um
 *     numero do cartao: sem ele, uma linha que nao cai parece falta de entrega
 *     quando pode ser excesso de chegada.
 *   - **a linha real e o fim do dia**: um item aberto e fechado na terca some do
 *     ponto de terca em diante. Dia que ainda nao chegou vem com `restante:
 *     null` — a tela para a linha em hoje em vez de despencar para zero.
 *   - **o escopo e o trabalho tocado na semana**: o que estava aberto na segunda
 *     mais o que nasceu ate sexta. Item que ja tinha fechado antes da segunda
 *     fica de fora, e item que so nasce depois da sexta tambem.
 *   - **so entra trabalho de sprint** (ver `ehDeSprint`): o que esta parado no
 *     backlog nao foi prometido para semana nenhuma, e contar isso aqui inflaria
 *     a linha real com uma fila que ninguem se comprometeu a queimar. Em projeto
 *     Kanban o criterio vira "esta no quadro"; projeto sem quadro agil nao entra.
 *   - **a semana e a mesma do cartao de produtividade** (ver `janelaDeSemanas`):
 *     sem filtro de datas, a semana corrente; com filtro, a ultima do intervalo.
 *
 * @param {object[]} base itens ja recortados pelos filtros (menos o de status)
 * @param {object} opcoes `{ inicio }` a segunda-feira da semana, "aaaa-mm-dd"
 */
function burndownSemanal(base, { inicio, incluirCancelados }) {
  const hoje = new Date().toISOString().slice(0, 10);
  const dias = Array.from({ length: DIAS_UTEIS }, (_, i) => somarDias(inicio, i));
  const sexta = dias[DIAS_UTEIS - 1];

  // Base sem carimbo de quadro nenhum e base que ainda nao foi sincronizada
  // depois desses campos existirem. Sem isso o cartao ficaria vazio dizendo
  // "nenhuma atividade nesta semana", que e a explicacao errada.
  const semDadoDeSprint = base.length > 0 && !base.some((it) => it.quadro_tipo);
  const naSprint = semDadoDeSprint ? [] : base.filter(ehDeSprint);

  // cada item vira so o par de datas que o burndown usa
  const escopo = [];
  for (const it of naSprint) {
    const nasceu = it.criado ? soDia(it.criado) : null;
    if (!nasceu || nasceu > sexta) continue;
    const fim = ehConcluida(it.status, incluirCancelados) ? dataDeConclusao(it) : null;
    const fechou = fim ? soDia(fim) : null;
    if (fechou && fechou < inicio) continue;
    escopo.push({ nasceu, fechou });
  }

  /** O que ainda estava aberto no fim de `dia`. */
  const restanteEm = (dia) => escopo.filter(
    (e) => e.nasceu <= dia && !(e.fechou && e.fechou <= dia),
  ).length;

  // De onde a reta parte. Sai daqui, e nao de `dias[0].restante`, porque uma
  // semana inteira no futuro (o filtro de datas aceita) nao tem dia decorrido
  // nenhum — e mesmo assim a fila de hoje ja e um ponto de partida legitimo.
  const partida = restanteEm(dias[0]);

  const serie = dias.map((dia, i) => {
    const futuro = dia > hoje;
    return {
      dia,
      ideal: +(partida * ((DIAS_UTEIS - 1 - i) / (DIAS_UTEIS - 1))).toFixed(1),
      restante: futuro ? null : restanteEm(dia),
      concluidas: futuro ? null : escopo.filter((e) => e.fechou === dia).length,
      criadas: futuro ? null : escopo.filter((e) => e.nasceu === dia).length,
      futuro,
    };
  });

  const decorridos = serie.filter((d) => !d.futuro);
  const ultimo = decorridos[decorridos.length - 1] ?? null;
  const herdado = escopo.filter((e) => e.nasceu < inicio).length;

  return {
    inicio,
    fim: sexta,
    escopo: escopo.length,
    // quanto do recorte ficou de fora por nao ser trabalho de sprint, e se a
    // base sequer tem o dado — a nota do cartao explica os dois casos
    foraDeSprint: base.length - naSprint.length,
    semDadoDeSprint,
    // o que ja vinha aberto de antes e o que nasceu dentro da semana
    herdado,
    novas: escopo.length - herdado,
    partida,
    dias: serie,
    concluidas: decorridos.reduce((s, d) => s + d.concluidas, 0),
    restante: ultimo ? ultimo.restante : partida,
    // sobra acima da reta = atrasado; abaixo = adiantado
    desvio: ultimo ? +(ultimo.restante - ultimo.ideal).toFixed(1) : 0,
    ultimoDia: ultimo ? ultimo.dia : null,
    emCurso: inicio <= hoje && hoje <= sexta,
  };
}

// ------------------------------------------------------------ ranking por pontos

/**
 * Minimo de tickets pontuados para disputar o podio.
 *
 * A classificacao e por **media** de pontos por ticket, e media de amostra
 * minuscula nao mede desempenho: quem fechou um unico item de 13 pontos ficaria
 * eternamente em primeiro sobre quem entregou vinte. Abaixo do corte a pessoa
 * nao some — sai do podio e aparece na lista de "amostra pequena", com os
 * numeros dela visiveis e a razao dita na tela.
 */
const MIN_TICKETS_RANKING = 3;

/** Uma casa decimal, sem o ruido de ponto flutuante. */
const arred1 = (n) => Math.round(n * 10) / 10;

/**
 * Ranking de desempenho por story points, entre as atividades **concluidas no
 * periodo**.
 *
 * A classificacao e pela **media de pontos por ticket**: mede o peso do que a
 * pessoa puxou, nao o volume. Quem fecha muita coisa pequena nao passa na
 * frente de quem fecha pouca coisa grande — e o oposto tambem vale, por isso o
 * total de pontos e a contagem de tickets ficam visiveis ao lado, e cada um
 * deles ainda rende uma conquista propria.
 *
 * Tres decisoes que mudam quem aparece:
 *
 *   - **so conta ticket estimado**. Item sem story point nao entra nem no
 *     numerador nem no denominador; entrar como zero puxaria a media de quem
 *     trabalha num projeto que nao pontua para baixo, medindo o processo do
 *     projeto em vez da pessoa. Quantos ficaram de fora sai em `semEstimativa`.
 *   - **ponto zero conta**. Zero e uma estimativa ("isso nao custa nada"), e
 *     `null` e a falta dela — ver `normalizarPontos`.
 *   - **sem responsavel nao disputa**. "(vazio)" nao e uma pessoa, e liderar o
 *     ranking com o trabalho de ninguem seria so um bug bonito.
 *   - **epico nao e trabalho de ninguem**. Um epico pontuado carrega, por
 *     construcao, a soma do que os filhos dele custam — contar os dois daria o
 *     mesmo esforco duas vezes, e daria ao dono do epico o credito do time
 *     inteiro. Historia e subtarefa continuam contando cada uma por si: sao as
 *     unidades que as pessoas realmente recebem, e a media e **por ticket**.
 *
 * @param {object[]} concluidas atividades ja recortadas pelo periodo e filtros
 * @returns {object} podio, amostra pequena, conquistas e o rodape de cobertura
 */
function rankingPorPontos(concluidas) {
  const porPessoa = new Map();
  let semEstimativa = 0;
  let semResponsavel = 0;
  let epicos = 0;

  for (const it of concluidas) {
    if (ehEpico(it.tipo_item)) { epicos++; continue; }
    const pontos = it.pontos;
    if (pontos == null || !Number.isFinite(pontos)) { semEstimativa++; continue; }
    if (!it.responsavel || it.responsavel === SEM_RESPONSAVEL) { semResponsavel++; continue; }

    if (!porPessoa.has(it.responsavel)) {
      porPessoa.set(it.responsavel, {
        responsavel: it.responsavel,
        tickets: 0,
        pontos: 0,
        maiorTicket: 0,
        // a chave do item mais pesado, para a conquista poder apontar qual foi
        maiorChave: null,
      });
    }
    const p = porPessoa.get(it.responsavel);
    p.tickets++;
    p.pontos += pontos;
    if (pontos > p.maiorTicket) { p.maiorTicket = pontos; p.maiorChave = it.chave ?? null; }
  }

  const todos = [...porPessoa.values()].map((p) => ({
    ...p,
    pontos: arred1(p.pontos),
    media: arred1(p.pontos / p.tickets),
  }));

  // desempate: media, depois total de pontos, depois nome — sem o segundo
  // criterio duas pessoas com media 3,0 trocariam de lugar a cada carregamento
  const ordenar = (a, b) => b.media - a.media
    || b.pontos - a.pontos
    || a.responsavel.localeCompare(b.responsavel, 'pt-BR');

  const podio = todos.filter((p) => p.tickets >= MIN_TICKETS_RANKING).sort(ordenar);
  const amostraPequena = todos.filter((p) => p.tickets < MIN_TICKETS_RANKING).sort(ordenar);

  // As conquistas saem de **todo mundo** que pontuou, nao so do podio: o corte
  // de amostra existe para nao coroar media de um ticket so, e nao para negar a
  // quem fez o item mais pesado da semana o credito por ele.
  const maiorPor = (chave) => todos.reduce(
    (melhor, p) => (melhor === null || p[chave] > melhor[chave] ? p : melhor),
    null,
  );
  const lider = podio[0] ?? null;
  const conquistas = [
    lider && {
      id: 'peso-pesado',
      emoji: '🏋️',
      titulo: 'Peso pesado',
      quem: lider.responsavel,
      detalhe: `${arred1(lider.media).toFixed(1).replace('.', ',')} pontos por ticket`,
      razao: 'A maior média de pontos por ticket — puxou o trabalho mais pesado.',
    },
    maiorPor('pontos') && {
      id: 'maratonista',
      emoji: '🏃',
      titulo: 'Maratonista',
      quem: maiorPor('pontos').responsavel,
      detalhe: `${maiorPor('pontos').pontos} pontos no total`,
      razao: 'Somou mais story points no período, contando tudo o que fechou.',
    },
    maiorPor('tickets') && {
      id: 'artilheiro',
      emoji: '🎯',
      titulo: 'Artilheiro',
      quem: maiorPor('tickets').responsavel,
      detalhe: `${maiorPor('tickets').tickets} tickets concluídos`,
      razao: 'Fechou mais atividades pontuadas, independente do tamanho delas.',
    },
    maiorPor('maiorTicket')?.maiorTicket > 0 && {
      id: 'escalador',
      emoji: '⛰️',
      titulo: 'Escalador',
      quem: maiorPor('maiorTicket').responsavel,
      detalhe: `${maiorPor('maiorTicket').maiorTicket} pontos`
        + (maiorPor('maiorTicket').maiorChave ? ` em ${maiorPor('maiorTicket').maiorChave}` : ''),
      razao: 'Entregou o ticket mais pesado do período — o maior item sozinho.',
    },
  ].filter(Boolean);

  const elegiveis = concluidas.length - epicos;
  const pontuadas = elegiveis - semEstimativa;
  return {
    podio,
    amostraPequena,
    conquistas,
    minTickets: MIN_TICKETS_RANKING,
    // rodape de honestidade: de quantas conclusoes o cartao esta realmente falando
    concluidas: concluidas.length,
    pontuadas,
    semEstimativa,
    semResponsavel,
    epicos,
    cobertura: elegiveis ? arred1((pontuadas / elegiveis) * 100) : 0,
    totalPontos: arred1(todos.reduce((s, p) => s + p.pontos, 0)),
    participantes: todos.length,
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

// ------------------------------------------------------------ arvore de filtros

/** Rotulo do espaco quando o item veio do Jira sem projeto — igual ao `contarPor`. */
const SEM_ESPACO = '(vazio)';

/**
 * Ordena os nos de um nivel da arvore: o balde de "resto" ("(vazio)", "(sem
 * épico)") vai sempre para o fim, e o resto desce por volume.
 *
 * O criterio e o mesmo de `ordenarResponsaveis` e `contarPorEpico`, so que
 * generico — os tres niveis da arvore leem melhor com a mesma regra: quem tem
 * mais trabalho aparece primeiro, e o que nao e uma categoria de verdade nao
 * disputa o topo com quem e.
 */
function ordenarNos(nos, resto) {
  return nos.sort((a, b) => {
    if (a.valor === resto) return 1;
    if (b.valor === resto) return -1;
    return b.total - a.total || a.rotulo.localeCompare(b.rotulo, 'pt-BR');
  });
}

/**
 * Arvore da barra lateral: responsavel -> espaco -> epico, com a contagem de
 * cada no.
 *
 * As tres dimensoes viviam em listas separadas, e as listas nao se falavam: os
 * epicos de um espaco so apareciam depois de marcar o espaco, e nao havia como
 * ver em que espacos uma pessoa trabalha sem filtrar por ela primeiro. A arvore
 * responde as tres perguntas de uma vez, sem gastar um clique de filtro para
 * cada uma.
 *
 * **A arvore ignora as proprias tres selecoes** — e o mesmo motivo de
 * `porDimensao`: marcar "Maria" nao pode apagar o resto das pessoas da barra,
 * senao nao haveria mais como trocar a selecao, so desfaze-la. Ja periodo,
 * tipo, status e prioridade valem: sao recortes de fora da hierarquia, e o
 * numero ao lado de cada no tem que bater com o que a tela mostra.
 *
 * Cada `total` conta itens do universo do periodo (criadas ou concluidas
 * dentro dele, ver `separarPorPeriodo`), entao o total de um no e sempre a soma
 * dos filhos — um item tem um responsavel, um espaco e um epico, e nao entra em
 * dois ramos.
 */
function arvoreDeFiltros(todos, filtros, incluirCancelados) {
  const base = aplicarRecortes(todos, {
    ...filtros, espacos: [], epicos: [], responsaveis: [],
  });
  const { universo } = separarPorPeriodo(base, filtros, incluirCancelados);

  const pessoas = new Map();
  for (const it of universo) {
    const quem = it.responsavel || SEM_RESPONSAVEL;
    if (!pessoas.has(quem)) {
      pessoas.set(quem, { valor: quem, rotulo: quem, total: 0, filhos: new Map() });
    }
    const pessoa = pessoas.get(quem);
    pessoa.total++;

    const onde = it.espaco || SEM_ESPACO;
    if (!pessoa.filhos.has(onde)) {
      pessoa.filhos.set(onde, { valor: onde, rotulo: onde, total: 0, filhos: new Map() });
    }
    const espaco = pessoa.filhos.get(onde);
    espaco.total++;

    const qual = epicoDe(it);
    if (!espaco.filhos.has(qual)) {
      espaco.filhos.set(qual, {
        valor: qual,
        rotulo: it.epico ? rotuloEpico(it.epico, it.epico_resumo) : SEM_EPICO,
        total: 0,
      });
    }
    espaco.filhos.get(qual).total++;
  }

  return ordenarNos([...pessoas.values()], SEM_RESPONSAVEL).map((pessoa) => ({
    valor: pessoa.valor,
    rotulo: pessoa.rotulo,
    total: pessoa.total,
    filhos: ordenarNos([...pessoa.filhos.values()], SEM_ESPACO).map((espaco) => ({
      valor: espaco.valor,
      rotulo: espaco.rotulo,
      total: espaco.total,
      filhos: ordenarNos([...espaco.filhos.values()], SEM_EPICO),
    })),
  }));
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

  // O filtro de **datas** vale aqui nos dois conjuntos, e a janela de semanas
  // passa a ser o proprio intervalo (ver `janelaDeSemanas`) — sem recorte, o
  // rabo padrao de oito semanas. Ja o de **responsaveis** vale so no segundo:
  // o ranking (1o) traz todo mundo, porque e por ele que se troca a selecao;
  // os totais por semana e o resumo (2o) seguem quem estiver selecionado.
  // Espaco, epico, tipo e prioridade continuam valendo nos dois.
  const semanal = produtividadeSemanal(
    separarPorPeriodo(
      aplicarRecortes(todos, { ...filtros, responsaveis: [] }),
      filtros,
      incluirCancelados,
    ).concluidas,
    concluidas,
    { de: filtros.de ?? null, ate: filtros.ate ?? null },
  );

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
    // as tres dimensoes da barra lateral, aninhadas (ver `arvoreDeFiltros`)
    arvore: arvoreDeFiltros(todos, filtros, incluirCancelados),
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
    // sem cartao proprio desde que o ranking tomou o lugar dele; sobrou porque
    // o painel ainda conta "Épicos com tickets" e o filtro de épico continua
    porEpico: semDim('epicos', (c) => contarPorEpico(c.universo)),
    // Ranking de desempenho por story points. Ignora o filtro de responsável,
    // como a pizza ao lado: a graça do pódio é comparar as pessoas entre si, e
    // marcar alguém na faixa de filtros deixaria um pódio de uma pessoa só,
    // sem como trocar a seleção. Os demais filtros valem normalmente.
    ranking: semDim('responsaveis', (c) => rankingPorPontos(c.concluidas)),
    porTipo: semDim('tipos', (c) => contarPor(c.universo, 'tipo_item')),
    porPrioridade: semDim('prioridades', (c) => contarNaOrdem(c.universo, 'prioridade', ORDEM_PRIORIDADE)),
    concluidasPorResponsavel: semDim(
      'responsaveis', (c) => ordenarResponsaveis(contarPor(c.concluidas, 'responsavel')),
    ),
    criadasPorResponsavel: semDim(
      'responsaveis', (c) => ordenarResponsaveis(contarPor(c.criadas, 'responsavel')),
    ),
    serieMensal: serieMensal(semData.criadas, semData.concluidas),
    produtividadeSemanal: semanal,
    // Mesma semana do cartao de produtividade — a ultima da janela. Tres
    // diferencas na populacao, e as tres de proposito:
    //   - o **periodo** nao vale: um item aberto em julho e ainda pendente pesa
    //     no burndown de agosto, e a data de criacao dele esta fora do recorte;
    //   - o filtro de **status** nao vale: o grafico e feito de aberto contra
    //     concluido, e recortar por status responderia sozinho a pergunta;
    //   - o **backlog fica de fora**, dentro de burndownSemanal (ver
    //     `ehDeSprint`): so entra o que esta numa sprint, ou no quadro nos
    //     projetos Kanban.
    // Espaco, epico, responsavel, tipo e prioridade continuam valendo.
    burndown: burndownSemanal(
      aplicarRecortes(todos, { ...filtros, status: [] }),
      { inicio: semanal.resumo.inicio, incluirCancelados },
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
