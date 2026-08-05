// Dashboard Jira — front-end vanilla, graficos em SVG escritos a mao.

const $ = (sel) => document.querySelector(sel);

const PALETA = ['#4472c4', '#e15759', '#70ad47', '#7c6bc4', '#4ec5d9', '#f0a22e', '#8c8c8c', '#2f6f9f', '#c0504d'];
// rotulos canonicos produzidos pela padronizacao (src/normalizar.js)
const COR_STATUS = {
  'Concluído': '#70ad47',
  'A fazer': '#8faadc',
  'Em andamento': '#f0a22e',
  'Em análise': '#7c6bc4',
  'Aguardando': '#8c8c8c',
  'Escalado': '#e15759',
  'Cancelado': '#b0776f',
};
const COR_CATEGORIA = {
  'A fazer': '#8faadc',
  'Em andamento': '#f0a22e',
  'Concluído': '#70ad47',
  'Cancelado': '#b0776f',
};
const corStatus = (s) => COR_STATUS[s] || '#4472c4';

const estado = {
  espacos: new Set(),
  // guarda a chave do epico ("WIK-193"), nao o titulo: o mesmo titulo
  // ("Julho de 2026") se repete em espacos diferentes
  epicos: new Set(),
  responsaveis: new Set(),
  // dimensões que só existem como clique no gráfico — não têm segmentador
  tipos: new Set(),
  status: new Set(),
  prioridades: new Set(),
  de: '',
  ate: '',
  incluirCancelados: false,
  dados: null,
  origemJira: '',
};

/** Filtros em conjunto, na ordem em que aparecem na capa do relatório. */
const DIMENSOES = ['espacos', 'epicos', 'responsaveis', 'tipos', 'status', 'prioridades'];

// ------------------------------------------------------------ utilidades

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (n) => Number(n ?? 0).toLocaleString('pt-BR');

function dataCurta(iso) {
  if (!iso) return '—';
  const [d, h] = iso.split('T');
  const [a, m, dia] = d.split('-');
  return `${dia}/${m}/${a}${h ? ` ${h.slice(0, 5)}` : ''}`;
}

function mesCurto(ym) {
  const [a, m] = ym.split('-');
  return `${['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'][+m - 1]}/${a.slice(2)}`;
}

/** Topo "redondo" do eixo Y (1, 2, 5 x 10^n). */
function topoEixo(max) {
  if (max <= 5) return 5;
  const exp = Math.pow(10, Math.floor(Math.log10(max)));
  for (const p of [1, 2, 2.5, 5, 10]) {
    if (max <= p * exp) return p * exp;
  }
  return 10 * exp;
}

function svg(largura, altura, conteudo) {
  return `<svg viewBox="0 0 ${largura} ${altura}" role="img">${conteudo}</svg>`;
}

const vazio = (msg = 'Sem dados para os filtros selecionados.') => `<p class="vazio">${msg}</p>`;

// ------------------------------------------------------ graficos que filtram

/** Último dia do mês "aaaa-mm", como "2026-08-31". */
function ultimoDiaDoMes(ym) {
  const [ano, mes] = ym.split('-').map(Number);
  return `${ym}-${String(new Date(ano, mes, 0).getDate()).padStart(2, '0')}`;
}

/** O período atual é exatamente um mês inteiro? Devolve "aaaa-mm" ou null. */
function mesSelecionado() {
  if (!estado.de || !estado.ate) return null;
  const ym = estado.de.slice(0, 7);
  return estado.de === `${ym}-01` && estado.ate === ultimoDiaDoMes(ym) ? ym : null;
}

/** O que está selecionado numa dimensão, com a mesma interface de um Set. */
function selecao(dim) {
  if (dim === 'mes') {
    const m = mesSelecionado();
    return { has: (v) => v === m, size: m ? 1 : 0 };
  }
  return estado[dim] ?? { has: () => false, size: 0 };
}

/**
 * Classes de marca que não são a marca principal da categoria.
 * "secundaria" é a genérica, para quem repete a ação sem ter estilo próprio —
 * usar "legenda" nesses casos pintaria a marca com a cor do texto.
 */
const PAPEIS_DE_APOIO = ['area-clique', 'eixo', 'legenda', 'secundaria'];

/**
 * Atributos que transformam uma marca do gráfico (barra, fatia, rótulo) em
 * filtro clicável. O clique é tratado por um único ouvinte no painel, que lê
 * `data-dim` e `data-valor`.
 *
 * Quem já está selecionado ganha `ativa`; havendo seleção, o resto fica
 * `apagada` — é assim que o gráfico mostra o recorte sem esconder as outras
 * categorias, que continuam clicáveis para trocar a seleção.
 *
 * Só a marca principal (a barra, a fatia) entra na navegação por teclado. A
 * faixa invisível de clique e o rótulo repetem a mesma ação: se também fossem
 * focáveis, o Tab pararia três vezes na mesma categoria.
 *
 * @param {string} dim nome do filtro ("status", "espacos", "mes"...)
 * @param {string} valor valor a alternar no clique
 * @param {string} [extra] outras classes: papel ("eixo", "legenda",
 *   "area-clique") e/ou animação de entrada ("cresce-y", "surge")
 */
function clicavel(dim, valor, extra = '') {
  const v = String(valor ?? '');
  const sel = selecao(dim);
  const ativa = sel.has(v);
  const classes = [extra, 'marca', ativa ? 'ativa' : '', sel.size && !ativa ? 'apagada' : '']
    .filter(Boolean).join(' ');

  // papéis de apoio: repetem a ação da marca principal e ficam fora do Tab
  const apoio = PAPEIS_DE_APOIO.filter((c) => extra.includes(c));
  let acessibilidade = '';
  if (!apoio.length) {
    acessibilidade = ` tabindex="0" role="button" aria-pressed="${ativa}"`
      + ` aria-label="Filtrar por ${esc(v)}"`;
  } else if (apoio.includes('area-clique')) {
    // alvo invisível, duplicata da marca visível: leitor de tela ignora
    acessibilidade = ' aria-hidden="true"';
  }
  return ` class="${classes}" data-dim="${esc(dim)}" data-valor="${esc(v)}"${acessibilidade}`;
}

/** Valor filtrável de um ponto do gráfico — os épicos filtram pela chave. */
const valorDe = (d) => d.valor ?? d.rotulo;

/**
 * Junta as marcas de uma mesma categoria (faixa de clique, barra e rótulo) num
 * grupo. É o que faz o destaque do cursor cobrir a mesma área que o clique:
 * passar o mouse em qualquer parte da linha acende a linha inteira.
 */
const grupo = (conteudo) => `<g class="grupo-marca">${conteudo}</g>`;

/**
 * Atraso da animação de entrada, escalonado por posição — as marcas aparecem
 * em cascata em vez de todas de uma vez. O teto evita que um gráfico com
 * muitas categorias demore a assentar.
 */
const atraso = (i) => ` style="animation-delay:${Math.min(i * 28, 260)}ms"`;

// ------------------------------------------------------------ graficos

/** Barras verticais com rotulo de valor no topo — "Status das Atividades". */
function barrasVerticais(dados, { cor, dim } = {}) {
  if (!dados.length) return vazio();

  const L = 760, A = 300;
  const margem = { top: 22, dir: 12, baixo: 58, esq: 44 };
  const larguraUtil = L - margem.esq - margem.dir;
  const alturaUtil = A - margem.top - margem.baixo;
  const max = topoEixo(Math.max(...dados.map((d) => d.total)));
  const passo = larguraUtil / dados.length;
  const larguraBarra = Math.min(56, passo * 0.55);

  let saida = '';
  for (let i = 0; i <= 5; i++) {
    const v = (max / 5) * i;
    const y = margem.top + alturaUtil - (v / max) * alturaUtil;
    saida += `<line class="grade" x1="${margem.esq}" y1="${y}" x2="${L - margem.dir}" y2="${y}"/>`;
    saida += `<text class="eixo" x="${margem.esq - 8}" y="${y + 3}" text-anchor="end">${v}</text>`;
  }

  dados.forEach((d, i) => {
    const alt = max ? (d.total / max) * alturaUtil : 0;
    const x = margem.esq + passo * i + (passo - larguraBarra) / 2;
    const y = margem.top + alturaUtil - alt;
    const val = valorDe(d);
    // a barra pode ser rasteira ou zerada: a área de clique cobre a coluna
    // inteira, senão sobraria um alvo de 1px
    let bloco = `<rect${clicavel(dim, val, 'area-clique')} x="${margem.esq + passo * i}" y="${margem.top}" width="${passo}" height="${alturaUtil}" fill="transparent"><title>${esc(d.rotulo)}: ${d.total}</title></rect>`;
    bloco += `<rect${clicavel(dim, val, 'cresce-y')} x="${x}" y="${y}" width="${larguraBarra}" height="${Math.max(alt, 0)}" fill="${cor ? cor(d.rotulo) : PALETA[0]}" rx="2"${atraso(i)}><title>${esc(d.rotulo)}: ${d.total}</title></rect>`;
    bloco += `<text class="rotulo-valor surge" x="${x + larguraBarra / 2}" y="${y - 6}" text-anchor="middle"${atraso(i)}>${d.total}</text>`;

    const palavras = String(d.rotulo).split(' ');
    const linhas = [];
    let atual = '';
    for (const p of palavras) {
      if ((atual + ' ' + p).trim().length > 13) { linhas.push(atual.trim()); atual = p; }
      else atual = `${atual} ${p}`;
    }
    if (atual.trim()) linhas.push(atual.trim());
    linhas.slice(0, 3).forEach((linha, j) => {
      bloco += `<text${clicavel(dim, val, 'eixo surge')} x="${margem.esq + passo * i + passo / 2}" y="${margem.top + alturaUtil + 16 + j * 11}" text-anchor="middle"${atraso(i)}>${esc(linha)}</text>`;
    });
    saida += grupo(bloco);
  });

  saida += `<line class="grade" x1="${margem.esq}" y1="${margem.top + alturaUtil}" x2="${L - margem.dir}" y2="${margem.top + alturaUtil}" stroke="#9db4cf"/>`;
  return svg(L, A, saida);
}

/** Barras horizontais — "Tickets criados por espaços". */
function barrasHorizontais(dados, { cor, dim } = {}) {
  if (!dados.length) return vazio();

  const L = 560;
  const alturaLinha = 26;
  // margem esquerda larga o bastante para nomes como "Acompanhamento - Gestão"
  const margem = { top: 10, dir: 54, baixo: 10, esq: 152 };
  const A = margem.top + margem.baixo + dados.length * alturaLinha;
  const larguraUtil = L - margem.esq - margem.dir;
  const max = Math.max(...dados.map((d) => d.total)) || 1;

  let saida = '';
  dados.forEach((d, i) => {
    const y = margem.top + i * alturaLinha;
    const larg = (d.total / max) * larguraUtil;
    const rotulo = String(d.rotulo).length > 25 ? `${String(d.rotulo).slice(0, 24)}…` : d.rotulo;
    const val = valorDe(d);
    // faixa invisível na linha toda: clicar em qualquer ponto dela filtra
    let bloco = `<rect${clicavel(dim, val, 'area-clique')} x="0" y="${y}" width="${L}" height="${alturaLinha}" fill="transparent"><title>${esc(d.rotulo)}: ${d.total}</title></rect>`;
    bloco += `<text${clicavel(dim, val, 'eixo surge')} x="${margem.esq - 8}" y="${y + alturaLinha / 2 + 3}" text-anchor="end"${atraso(i)}>${esc(rotulo)}<title>${esc(d.rotulo)}</title></text>`;
    bloco += `<rect${clicavel(dim, val, 'cresce-x')} x="${margem.esq}" y="${y + 4}" width="${Math.max(larg, 1)}" height="${alturaLinha - 10}" fill="${cor ? cor(d.rotulo) : PALETA[0]}" rx="2"${atraso(i)}><title>${esc(d.rotulo)}: ${d.total}</title></rect>`;
    bloco += `<text class="rotulo-valor surge" x="${margem.esq + larg + 7}" y="${y + alturaLinha / 2 + 4}"${atraso(i)}>${d.total}</text>`;
    saida += grupo(bloco);
  });
  return svg(L, A, saida);
}

/** Pizza com legenda — "Atividades concluídas por responsável". */
function pizza(dados, { dim } = {}) {
  const validos = dados.filter((d) => d.total > 0);
  if (!validos.length) return vazio();

  const L = 560;
  // a legenda cresce com o numero de responsaveis; o quadro acompanha para ela
  // nao vazar o cartao (na impressao isso virava texto por cima da borda)
  const A = Math.max(270, 44 + validos.length * 24);
  const cx = 140, cy = A / 2, r = 100;
  const total = validos.reduce((s, d) => s + d.total, 0);

  let saida = '';
  let anguloAtual = -Math.PI / 2;

  validos.forEach((d, i) => {
    const fatia = (d.total / total) * Math.PI * 2;
    const cor = PALETA[i % PALETA.length];
    const val = valorDe(d);
    if (validos.length === 1) {
      saida += grupo(`<circle${clicavel(dim, val, 'surge')} cx="${cx}" cy="${cy}" r="${r}" fill="${cor}"><title>${esc(d.rotulo)}: ${d.total}</title></circle>`);
    } else {
      const x1 = cx + r * Math.cos(anguloAtual);
      const y1 = cy + r * Math.sin(anguloAtual);
      const fim = anguloAtual + fatia;
      const x2 = cx + r * Math.cos(fim);
      const y2 = cy + r * Math.sin(fim);
      const grande = fatia > Math.PI ? 1 : 0;
      saida += grupo(`<path${clicavel(dim, val, 'surge')} d="M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${grande} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z" fill="${cor}" stroke="#fff" stroke-width="1.5"${atraso(i)}><title>${esc(d.rotulo)}: ${d.total} (${((d.total / total) * 100).toFixed(1)}%)</title></path>`);
      anguloAtual = fim;
    }
  });

  validos.forEach((d, i) => {
    const y = 34 + i * 24;
    const val = valorDe(d);
    const pct = ((d.total / total) * 100).toFixed(1);
    // a linha inteira da legenda filtra, não só o texto
    let bloco = `<rect${clicavel(dim, val, 'area-clique')} x="281" y="${y - 13}" width="${L - 285}" height="20" fill="transparent"><title>${esc(d.rotulo)}: ${d.total} (${pct}%)</title></rect>`;
    bloco += `<rect${clicavel(dim, val, 'secundaria surge')} x="285" y="${y - 9}" width="11" height="11" rx="2" fill="${PALETA[i % PALETA.length]}"${atraso(i)}/>`;
    bloco += `<text${clicavel(dim, val, 'legenda surge')} x="303" y="${y}"${atraso(i)}>${esc(d.rotulo)} — ${d.total} (${pct}%)</text>`;
    saida += grupo(bloco);
  });

  return svg(L, A, saida);
}

/** Barras agrupadas — evolucao mensal. */
function barrasAgrupadas(serie) {
  if (!serie.length) return vazio();

  const L = 860, A = 300;
  const margem = { top: 26, dir: 12, baixo: 44, esq: 44 };
  const larguraUtil = L - margem.esq - margem.dir;
  const alturaUtil = A - margem.top - margem.baixo;
  const max = topoEixo(Math.max(1, ...serie.flatMap((d) => [d.criadas, d.concluidas])));
  const passo = larguraUtil / serie.length;
  const larguraBarra = Math.min(26, passo * 0.32);

  let saida = '';
  for (let i = 0; i <= 5; i++) {
    const v = (max / 5) * i;
    const y = margem.top + alturaUtil - (v / max) * alturaUtil;
    saida += `<line class="grade" x1="${margem.esq}" y1="${y}" x2="${L - margem.dir}" y2="${y}"/>`;
    saida += `<text class="eixo" x="${margem.esq - 8}" y="${y + 3}" text-anchor="end">${Math.round(v)}</text>`;
  }

  serie.forEach((d, i) => {
    const centro = margem.esq + passo * i + passo / 2;
    // clicar no mês recorta o período nele inteiro (ver alternarMes)
    let bloco = `<rect${clicavel('mes', d.mes, 'area-clique')} x="${margem.esq + passo * i}" y="${margem.top}" width="${passo}" height="${alturaUtil}" fill="transparent"><title>${mesCurto(d.mes)} — ${d.criadas} criadas, ${d.concluidas} concluídas</title></rect>`;
    [['criadas', PALETA[0], -1], ['concluidas', PALETA[2], 1]].forEach(([campo, cor, lado]) => {
      const alt = (d[campo] / max) * alturaUtil;
      const x = centro + lado * 2 + (lado < 0 ? -larguraBarra : 0);
      const y = margem.top + alturaUtil - alt;
      // só a barra de "criadas" recebe foco: as duas do mês fazem a mesma coisa
      const papel = campo === 'criadas' ? 'cresce-y' : 'cresce-y secundaria';
      bloco += `<rect${clicavel('mes', d.mes, papel)} x="${x}" y="${y}" width="${larguraBarra}" height="${Math.max(alt, 0)}" fill="${cor}" rx="2"${atraso(i)}><title>${mesCurto(d.mes)} — ${campo}: ${d[campo]}</title></rect>`;
      if (d[campo] > 0) bloco += `<text class="rotulo-valor surge" x="${x + larguraBarra / 2}" y="${y - 5}" text-anchor="middle"${atraso(i)}>${d[campo]}</text>`;
    });
    bloco += `<text${clicavel('mes', d.mes, 'eixo surge')} x="${centro}" y="${margem.top + alturaUtil + 16}" text-anchor="middle"${atraso(i)}>${mesCurto(d.mes)}</text>`;
    saida += grupo(bloco);
  });

  saida += `<rect x="${margem.esq}" y="6" width="10" height="10" rx="2" fill="${PALETA[0]}"/><text class="legenda" x="${margem.esq + 15}" y="15">criadas</text>`;
  saida += `<rect x="${margem.esq + 78}" y="6" width="10" height="10" rx="2" fill="${PALETA[2]}"/><text class="legenda" x="${margem.esq + 93}" y="15">concluídas</text>`;
  return svg(L, A, saida);
}

// ------------------------------------------------------------ capa do relatorio

/** Lista curta com reticencias — evita uma capa gigante quando ha muitos filtros. */
function listaCurta(conjunto, limite = 6) {
  const itens = [...conjunto];
  if (itens.length <= limite) return itens.join(', ');
  return `${itens.slice(0, limite).join(', ')} +${itens.length - limite}`;
}

/**
 * Preenche o cabecalho e o rodape que so aparecem no PDF. Sem isso o relatorio
 * sai sem dizer de que periodo ele fala nem que filtros estavam ligados.
 */
function montarCapaRelatorio(d, detalhe) {
  const i = d.indicadores;
  const periodo = d.periodo.inicio
    ? `${dataCurta(d.periodo.inicio).slice(0, 10)} a ${dataCurta(d.periodo.fim).slice(0, 10)}`
    : 'sem período definido';

  $('#capa-periodo').textContent =
    `${num(i.criadas)} atividades no recorte · período ${periodo} · base com ${num(d.baseTotal)} atividades`;

  const agora = new Date();
  $('#capa-gerado').innerHTML =
    `<b>Gerado em</b> ${agora.toLocaleDateString('pt-BR')} às ${agora.toLocaleTimeString('pt-BR').slice(0, 5)}`;
  $('#capa-origem').textContent = estado.origemJira ? `Origem: ${estado.origemJira}` : '';

  const filtros = [];
  if (estado.espacos.size) filtros.push(`<b>Espaços:</b> ${esc(listaCurta(estado.espacos))}`);
  if (estado.epicos.size) {
    // na capa vale o titulo do epico, nao a chave crua que fica no filtro
    const porValor = new Map((d.opcoes.epicos ?? []).map((e) => [e.valor, e.rotulo]));
    filtros.push(`<b>Épicos:</b> ${esc(listaCurta([...estado.epicos].map((v) => porValor.get(v) ?? v), 4))}`);
  }
  if (estado.responsaveis.size) filtros.push(`<b>Responsáveis:</b> ${esc(listaCurta(estado.responsaveis))}`);
  // dimensões que só se filtram clicando no gráfico
  for (const [dim, titulo] of [['tipos', 'Tipos'], ['status', 'Status'], ['prioridades', 'Prioridades']]) {
    if (estado[dim].size) filtros.push(`<b>${titulo}:</b> ${esc(listaCurta(estado[dim]))}`);
  }
  if (estado.de || estado.ate) {
    const de = estado.de ? dataCurta(estado.de).slice(0, 10) : 'início';
    const ate = estado.ate ? dataCurta(estado.ate).slice(0, 10) : 'hoje';
    filtros.push(`<b>Período:</b> ${de} a ${ate} <em>(criadas ou concluídas no intervalo)</em>`);
  }
  if (estado.incluirCancelados) filtros.push('<b>Cancelados</b> contam como concluídas');

  $('#capa-filtros').innerHTML = filtros.length
    ? `<span class="capa-etiqueta">Filtros aplicados</span> ${filtros.join(' &nbsp;·&nbsp; ')}`
    : '<span class="capa-etiqueta">Sem filtros</span> o relatório cobre a base inteira';

  $('#rodape-detalhe').textContent =
    `${num(detalhe.total)} atividades no recorte · ${agora.toLocaleDateString('pt-BR')}`;
}

// ------------------------------------------------------------ slicers

/**
 * Cada opcao pode ser um texto (o valor e o rotulo sao a mesma coisa) ou um par
 * { valor, rotulo } — e o caso dos epicos, filtrados pela chave e exibidos com
 * o titulo junto.
 */
function montarSlicer(el, opcoes, selecionadas, contagens) {
  el.innerHTML = opcoes
    .map((op) => {
      const valor = typeof op === 'string' ? op : op.valor;
      const rotulo = typeof op === 'string' ? op : op.rotulo;
      const n = contagens.get(valor);
      return `<li data-valor="${esc(valor)}" class="${selecionadas.has(valor) ? 'ativo' : ''}" title="${esc(rotulo)}">
        <span>${esc(rotulo)}</span>${n != null ? `<span class="qtd">${n}</span>` : ''}
      </li>`;
    })
    .join('') || '<li class="vazio-slicer">nada para selecionar</li>';
}

/** Clicar num mês recorta o período nele inteiro; clicar de novo, desfaz. */
function alternarMes(ym) {
  if (mesSelecionado() === ym) {
    estado.de = '';
    estado.ate = '';
  } else {
    estado.de = `${ym}-01`;
    estado.ate = ultimoDiaDoMes(ym);
  }
  $('#de').value = estado.de;
  $('#ate').value = estado.ate;
}

/**
 * Um ouvinte só para todos os gráficos: eles são reescritos a cada carga, e
 * religar evento por evento em cada barra seria trabalho perdido.
 */
function ligarGraficos() {
  const acionar = (alvo) => {
    const { dim, valor } = alvo.dataset;
    if (dim === 'mes') {
      alternarMes(valor);
    } else {
      const conjunto = estado[dim];
      if (!conjunto) return;
      if (conjunto.has(valor)) conjunto.delete(valor);
      else conjunto.add(valor);
    }
    carregar();
  };

  const painel = $('#painel');
  painel.addEventListener('click', (ev) => {
    const alvo = ev.target.closest('[data-dim]');
    if (alvo) acionar(alvo);
  });
  // teclado: as marcas são focáveis (tabindex), então respondem a Enter/Espaço
  painel.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const alvo = ev.target.closest?.('[data-dim]');
    if (!alvo) return;
    ev.preventDefault();
    acionar(alvo);
  });
}

function ligarSlicer(el, conjunto) {
  el.addEventListener('click', (ev) => {
    const li = ev.target.closest('li');
    if (!li?.dataset.valor) return;
    const valor = li.dataset.valor;
    if (conjunto.has(valor)) conjunto.delete(valor);
    else conjunto.add(valor);
    carregar();
  });
}

// ------------------------------------------------------------ carregamento

function queryFiltros() {
  const p = new URLSearchParams();
  for (const dim of DIMENSOES) {
    if (estado[dim].size) p.set(dim, [...estado[dim]].join('|'));
  }
  if (estado.de) p.set('de', estado.de);
  if (estado.ate) p.set('ate', estado.ate);
  if (estado.incluirCancelados) p.set('cancelados', '1');
  return p.toString();
}

/** Só esmaece o painel se a resposta passar disso — evita piscar no clique. */
const ESPERA_ATE_ESMAECER_MS = 140;

async function carregar() {
  const qs = queryFiltros();
  const painel = $('#painel');
  const esmaecer = setTimeout(() => painel.classList.add('carregando'), ESPERA_ATE_ESMAECER_MS);
  try {
    const [dash, detalhe] = await Promise.all([
      fetch(`/api/dashboard?${qs}`).then((r) => r.json()),
      fetch(`/api/itens?${qs}&limite=500`).then((r) => r.json()),
    ]);
    estado.dados = dash;
    renderizar(dash, detalhe);
  } finally {
    clearTimeout(esmaecer);
    painel.classList.remove('carregando');
  }
}

function renderizar(d, detalhe) {
  const i = d.indicadores;

  $('#kpi-criadas').textContent = num(i.criadas);
  $('#kpi-concluidas').textContent = num(i.concluidas);
  $('#kpi-taxa').textContent = `${i.taxaConclusao.toFixed(2).replace('.', ',')}%`;

  const periodo = d.periodo.inicio
    ? `${dataCurta(d.periodo.inicio).slice(0, 10)} a ${dataCurta(d.periodo.fim).slice(0, 10)}`
    : 'sem período';
  $('#resumo-base').textContent =
    `${num(d.baseTotal)} atividades na base · ${num(i.criadas)} no filtro · ${periodo}`;

  montarCapaRelatorio(d, detalhe);

  const contEspaco = new Map(d.porEspaco.map((x) => [x.rotulo, x.total]));
  const contEpico = new Map((d.porEpico ?? []).map((x) => [x.valor, x.total]));
  const contResp = new Map(d.criadasPorResponsavel.map((x) => [x.rotulo, x.total]));
  montarSlicer($('#slicer-espacos'), d.opcoes.espacos, estado.espacos, contEspaco);
  montarSlicer($('#slicer-epicos'), d.opcoes.epicos ?? [], estado.epicos, contEpico);
  montarSlicer($('#slicer-responsaveis'), d.opcoes.responsaveis, estado.responsaveis, contResp);

  $('#grafico-status').innerHTML = barrasVerticais(
    [...d.porStatus].sort((a, b) => a.rotulo.localeCompare(b.rotulo, 'pt-BR')),
    { cor: corStatus, dim: 'status' },
  );
  $('#grafico-responsaveis').innerHTML = pizza(d.concluidasPorResponsavel, { dim: 'responsaveis' });
  $('#grafico-espacos').innerHTML = barrasHorizontais(
    [...d.porEspaco].sort((a, b) => a.rotulo.localeCompare(b.rotulo, 'pt-BR')),
    { dim: 'espacos' },
  );
  $('#grafico-mensal').innerHTML = barrasAgrupadas(d.serieMensal);
  $('#grafico-tipos').innerHTML = barrasHorizontais(d.porTipo, { cor: () => PALETA[0], dim: 'tipos' });
  $('#grafico-prioridades').innerHTML = barrasHorizontais(d.porPrioridade, { dim: 'prioridades' });
  // so os 12 maiores: a lista inteira de epicos nao cabe num grafico de barras.
  // O que estiver selecionado entra de todo jeito, senão sumiria da tela sem
  // dar como desmarcar
  const epicos = d.porEpico ?? [];
  const visiveis = epicos.slice(0, 12);
  for (const e of epicos.slice(12)) if (estado.epicos.has(e.valor)) visiveis.push(e);
  $('#grafico-epicos').innerHTML = barrasHorizontais(visiveis, { dim: 'epicos' });

  $('#panorama').innerHTML = [
    ['A fazer', num(i.aFazer)],
    ['Em andamento', num(i.emAndamento)],
    ['Concluídas no período', num(i.concluidas)],
    ['Criadas e concluídas dentro do período', num(i.criadasEConcluidas ?? 0)],
    ['Canceladas', num(i.canceladas)],
    ['Sem responsável', num(i.semResponsavel)],
    ['Fora do prazo (data limite vencida)', num(i.atrasadas)],
    ['Tempo médio até concluir', `${d.tempoDeConclusao.mediaDias} dias`],
    ['Tempo mediano até concluir', `${d.tempoDeConclusao.medianaDias} dias`],
    ['Espaços ativos', num(d.porEspaco.length)],
    ['Épicos com tickets', num((d.porEpico ?? []).filter((e) => e.valor !== '(sem épico)').length)],
  ]
    .map(([r, v]) => `<li><span>${r}</span><b>${v}</b></li>`)
    .join('');

  $('#contagem-tabela').textContent = `— ${num(detalhe.total)} no filtro${detalhe.total > detalhe.itens.length ? `, exibindo ${detalhe.itens.length}` : ''}`;
  $('#tabela-itens tbody').innerHTML = detalhe.itens
    .map(
      (it) => `<tr>
        <td>${esc(it.chave)}</td>
        <td>${esc(it.tipo_item)}</td>
        <td class="resumo">${esc(it.resumo)}</td>
        <td>${esc(it.responsavel)}</td>
        <td><span class="pilula" style="background:${corStatus(it.status)}22;color:${corStatus(it.status)}">${esc(it.status)}</span></td>
        <td>${esc(it.prioridade)}</td>
        <td>${esc(it.espaco)}</td>
        <td class="epico" title="${esc(it.epico_rotulo ?? '')}">${esc(it.epico_rotulo ?? '')}</td>
        <td>${dataCurta(it.criado)}</td>
        <td>${dataCurta(it.concluido)}</td>
        <td>${dataCurta(it.atualizado)}</td>
      </tr>`,
    )
    .join('') || '<tr><td colspan="11">Nenhuma atividade para os filtros selecionados.</td></tr>';

  const padronizacao = d.padronizacao ?? [];
  $('#tabela-padronizacao tbody').innerHTML = padronizacao
    .map((p) => {
      const origens = p.origens
        .map((o) => `<span class="pilula ${o.rotulo === p.status ? 'origem-igual' : 'origem-unificada'}">${esc(o.rotulo)} · ${num(o.total)}</span>`)
        .join(' ');
      return `<tr>
        <td><span class="pilula" style="background:${corStatus(p.status)}22;color:${corStatus(p.status)}">${esc(p.status)}</span></td>
        <td>${esc(p.categoria)}</td>
        <td>${num(p.total)}</td>
        <td>${origens}</td>
      </tr>`;
    })
    .join('') || '<tr><td colspan="4">Sem atividades para os filtros selecionados.</td></tr>';

  const sincronizacoes = d.sincronizacoes ?? [];
  const itensSync = sincronizacoes.reduce((s, x) => s + (x.itens || 0), 0);
  $('#resumo-sync').textContent = sincronizacoes.length
    ? `— ${sincronizacoes.length} origem(ns), ${num(itensSync)} itens na última passada`
    : '— nenhuma sincronização ainda';

  $('#tabela-sincronizacoes tbody').innerHTML = sincronizacoes
    .map(
      (s) => `<tr>
        <td><b>${esc(s.origem)}</b></td>
        <td>${num(s.itens)}</td><td>${num(s.novos)}</td><td>${num(s.atualizados)}</td>
        <td>${dataCurta(s.sincronizado_em)}</td>
        <td>${s.erro
          ? `<span class="pilula erro-pilula" title="${esc(s.erro)}">erro</span>`
          : '<span class="pilula ok-pilula">ok</span>'}</td>
        <td><button class="btn-mini" data-remover-sync="${esc(s.origem)}">remover</button></td>
      </tr>`,
    )
    .join('') || '<tr><td colspan="7">Nenhuma origem sincronizada. Clique em “Configurar Jira”.</td></tr>';

  $('#tabela-importacoes tbody').innerHTML = d.importacoes
    .map(
      (imp) => `<tr>
        <td>${esc(imp.arquivo)}</td><td>${esc(imp.aba || '—')}</td>
        <td>${num(imp.linhas)}</td><td>${num(imp.novos)}</td><td>${num(imp.atualizados)}</td>
        <td>${dataCurta(imp.importado_em)}</td>
        <td><button class="btn-mini" data-remover="${imp.id}">remover</button></td>
      </tr>`,
    )
    .join('') || '<tr><td colspan="7">Nenhuma planilha importada ainda.</td></tr>';
}

// ------------------------------------------------------------ exportar Excel

/**
 * Baixa a tabela de atividades em .xlsx respeitando os filtros da tela.
 * A tela mostra no maximo 500 linhas; a planilha leva tudo o que o filtro pegou.
 */
async function exportarExcel() {
  const botao = $('#btn-excel');
  const rotulo = botao.textContent;
  botao.disabled = true;
  botao.textContent = 'Gerando…';

  try {
    const r = await fetch(`/api/exportar?${queryFiltros()}`);
    if (!r.ok) {
      const erro = await r.json().catch(() => ({}));
      throw new Error(erro.erro || `falha ao gerar a planilha (HTTP ${r.status})`);
    }
    const blob = await r.blob();
    const nome = (r.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1]
      || 'atividades-jira.xlsx';

    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = nome;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  } catch (e) {
    alert(`Não foi possível exportar: ${e.message}`);
  } finally {
    botao.disabled = false;
    botao.textContent = rotulo;
  }
}

// ------------------------------------------------------------ upload

async function enviarArquivos(lista) {
  const log = $('#log-upload');
  for (const arquivo of lista) {
    const li = document.createElement('li');
    li.textContent = `Enviando ${arquivo.name}…`;
    log.prepend(li);
    try {
      const r = await fetch(`/api/upload?nome=${encodeURIComponent(arquivo.name)}`, {
        method: 'POST',
        headers: { 'X-Nome-Arquivo': encodeURIComponent(arquivo.name), 'Content-Type': 'application/octet-stream' },
        body: arquivo,
      });
      const dados = await r.json();
      if (!r.ok) throw new Error(dados.erro || 'falha no envio');
      if (dados.duplicado) {
        li.className = 'aviso';
        li.textContent = `${arquivo.name}: ${dados.aviso}`;
      } else {
        li.textContent =
          `${arquivo.name} [aba "${dados.aba}"]: ${dados.linhas} linhas — ` +
          `${dados.novos} novas, ${dados.atualizados} atualizadas` +
          (dados.ignorados ? `, ${dados.ignorados} ignoradas` : '');
      }
    } catch (e) {
      li.className = 'erro';
      li.textContent = `${arquivo.name}: ${e.message}`;
    }
  }
  await carregar();
}

// ------------------------------------------------------------ Jira (API)

/** Escreve uma linha no log do modal do Jira. */
function logJira(texto, classe = '') {
  const li = document.createElement('li');
  li.className = classe;
  li.textContent = texto;
  $('#log-jira').prepend(li);
  return li;
}

function pintarStatusJira(cfg, sincronizacoes = []) {
  const el = $('#status-jira');
  if (!cfg.configurado) {
    el.className = 'etiqueta alerta';
    el.textContent = 'Jira não configurado';
    el.title = 'Clique em "Configurar Jira" para conectar a API.';
    return;
  }
  // a capa do PDF pode ter sido montada antes desta resposta chegar
  estado.origemJira = cfg.url.replace(/^https?:\/\//, '');
  $('#capa-origem').textContent = estado.origemJira ? `Origem: ${estado.origemJira}` : '';

  const comErro = sincronizacoes.filter((s) => s.erro);
  const ultima = sincronizacoes
    .map((s) => s.sincronizado_em)
    .filter(Boolean)
    .sort()
    .pop();
  el.className = comErro.length ? 'etiqueta alerta' : 'etiqueta ok';
  const host = cfg.url.replace(/^https?:\/\//, '');
  el.textContent = comErro.length
    ? `${host} — ${comErro.length} origem(ns) com erro`
    : `${host} — última sincronização ${ultima ? dataCurta(ultima) : 'nunca'}`;
  el.title = comErro.map((s) => `${s.origem}: ${s.erro}`).join('\n') || `Conectado a ${cfg.url}`;
}

async function carregarConfigJira({ preencher = false } = {}) {
  const r = await fetch('/api/jira/config').then((x) => x.json());
  const cfg = r.config;
  pintarStatusJira(cfg, r.sincronizacoes);
  if (preencher) {
    $('#jira-url').value = cfg.url || '';
    $('#jira-email').value = cfg.email || '';
    $('#jira-token').value = '';
    $('#jira-token').placeholder = cfg.temToken
      ? `token salvo (${cfg.tokenMascarado}) — deixe em branco para manter`
      : 'cole o token aqui';
    $('#jira-projetos').value = (cfg.projetos || []).join(', ');
    $('#jira-jql').value = cfg.jql || '';
    $('#jira-intervalo').value = cfg.intervaloMinutos ?? 0;

    const travados = Object.entries(cfg.travadoPorEnv || {}).filter(([, v]) => v).map(([k]) => k);
    if (travados.length) {
      logJira(
        `Definidos no .env e por isso não editáveis aqui: ${travados.join(', ')}.`,
        'aviso',
      );
    }
  }
  return cfg;
}

function corpoConfigJira() {
  return {
    url: $('#jira-url').value.trim(),
    email: $('#jira-email').value.trim(),
    token: $('#jira-token').value.trim() || undefined,
    projetos: $('#jira-projetos').value,
    jql: $('#jira-jql').value.trim(),
    intervaloMinutos: Number($('#jira-intervalo').value) || 0,
  };
}

async function testarJira() {
  const li = logJira('Testando conexão…');
  try {
    const r = await fetch('/api/jira/testar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: $('#jira-url').value.trim(),
        email: $('#jira-email').value.trim(),
        token: $('#jira-token').value.trim() || undefined,
      }),
    }).then((x) => x.json());
    if (!r.ok) throw new Error(r.erro || 'não foi possível conectar');
    li.textContent = `Conectado como ${r.conta} (API v${r.api}).`;
    return true;
  } catch (e) {
    li.className = 'erro';
    li.textContent = e.message;
    return false;
  }
}

async function listarProjetosJira() {
  const li = logJira('Buscando projetos visíveis…');
  try {
    const r = await fetch('/api/jira/projetos').then((x) => x.json());
    if (r.erro) throw new Error(r.erro);
    const caixa = $('#lista-projetos');
    caixa.classList.remove('oculto');
    const escolhidos = new Set(
      $('#jira-projetos').value.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean),
    );
    caixa.innerHTML = r.projetos
      .map((p) => `<button type="button" class="chip ${escolhidos.has(p.chave) ? 'ativo' : ''}"
        data-chave="${esc(p.chave)}" title="${esc(p.nome)}">${esc(p.chave)} · ${esc(p.nome)}</button>`)
      .join('') || '<span class="vazio">Nenhum projeto visível para essa conta.</span>';
    li.textContent = `${r.projetos.length} projeto(s) visíveis. Clique para incluir ou tirar da sincronização.`;
  } catch (e) {
    li.className = 'erro';
    li.textContent = e.message;
  }
}

/** Alterna uma chave de projeto no campo de projetos. */
function alternarProjeto(chave, botao) {
  const atuais = $('#jira-projetos').value.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  const i = atuais.indexOf(chave);
  if (i >= 0) atuais.splice(i, 1);
  else atuais.push(chave);
  $('#jira-projetos').value = atuais.join(', ');
  botao.classList.toggle('ativo', i < 0);
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/** Uma linha de resumo por origem sincronizada. */
function resumoDasOrigens(origens = []) {
  return origens
    .map((o) => (o.ok
      ? `${o.origem}: ${num(o.itens)} lidas (${num(o.novos)} novas, ${num(o.atualizados)} atualizadas${o.removidos ? `, ${num(o.removidos)} removidas` : ''})`
      : `${o.origem}: ERRO — ${o.erro}`))
    .join(' · ');
}

/**
 * Acompanha a passada que esta rodando no servidor.
 * A sincronizacao vai projeto por projeto e pode levar minutos, entao a tela
 * consulta o progresso em vez de esperar uma resposta HTTP demorada.
 */
async function acompanharSincronizacao({ li, botao } = {}) {
  let ultimoIndice = 0;

  for (;;) {
    const e = await fetch('/api/jira/sincronizar/estado').then((x) => x.json());

    if (li) {
      const onde = e.total ? `Projeto ${e.indice}/${e.total}` : 'Preparando';
      const alvo = e.origem ? ` — ${e.origem}` : '';
      const detalhe = e.fase === 'lendo' ? `: ${num(e.lidas)} issues lidas`
        : e.fase === 'conferindo' ? ': conferindo o que foi excluído' : '';
      li.textContent = e.rodando ? `${onde}${alvo}${detalhe}…` : 'Finalizando…';
    }
    if (botao && e.total) botao.textContent = `Sincronizando ${e.indice}/${e.total}…`;

    // cada projeto que termina ja aparece nos gráficos
    if (e.indice > ultimoIndice) {
      ultimoIndice = e.indice;
      if (ultimoIndice > 1) carregar().catch(() => {});
    }

    if (!e.rodando) return e;
    await espera(1000);
  }
}

async function sincronizarAgora({ completa = false } = {}) {
  const botao = $('#btn-sincronizar');
  const rotuloAnterior = '⟳ Sincronizar Jira';
  botao.disabled = true;
  botao.textContent = completa ? 'Sincronizando tudo…' : 'Sincronizando…';
  const li = logJira(completa ? 'Sincronização completa em andamento…' : 'Sincronizando…');

  try {
    const inicio = await fetch(`/api/jira/sincronizar${completa ? '?completa=1' : ''}`, { method: 'POST' })
      .then((x) => x.json());
    if (inicio.erro) throw new Error(inicio.erro);
    if (!inicio.iniciada) logJira(inicio.motivo || 'Acompanhando a sincronização em andamento.', 'aviso');

    const estado = await acompanharSincronizacao({ li, botao });
    if (estado.erro) throw new Error(estado.erro);

    const r = estado.resultado;
    if (!r) {
      li.textContent = 'Sincronização encerrada sem resultado.';
      li.className = 'aviso';
    } else {
      li.className = r.falhas ? 'aviso' : '';
      li.textContent = `${resumoDasOrigens(r.origens)} — em ${(r.duracaoMs / 1000).toFixed(1)}s`;
      if (r.truncadas) {
        logJira(
          `${r.truncadas} origem(ns) atingiram o limite de issues por passada; `
          + 'o restante entra na próxima sincronização.',
          'aviso',
        );
      }
    }
  } catch (e) {
    li.className = 'erro';
    li.textContent = e.message;
  } finally {
    botao.disabled = false;
    botao.textContent = rotuloAnterior;
    await carregar();
    await carregarConfigJira();
  }
}

let vigiando = false;

/** Se o agendador estiver sincronizando, mostra isso no cabeçalho. */
async function vigiarSincronizacaoDeFundo() {
  if (vigiando) return;
  vigiando = true;
  try {
    const e = await fetch('/api/jira/sincronizar/estado').then((x) => x.json());
    if (!e.rodando) return;
    const etiqueta = $('#status-jira');
    etiqueta.className = 'etiqueta';
    etiqueta.textContent = `sincronizando ${e.indice}/${e.total}…`;
    await acompanharSincronizacao({});
    await carregar();
    await carregarConfigJira();
  } catch { /* servidor reiniciando: a próxima checagem resolve */ } finally {
    vigiando = false;
  }
}

async function salvarJira() {
  const li = logJira('Salvando configuração…');
  try {
    const r = await fetch('/api/jira/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpoConfigJira()),
    }).then((x) => x.json());
    if (r.erro) throw new Error(r.erro);
    li.textContent = `Configuração salva em ${r.config.arquivoConfig}.`;
    $('#jira-token').value = '';
    await carregarConfigJira({ preencher: false });
    await sincronizarAgora();
  } catch (e) {
    li.className = 'erro';
    li.textContent = e.message;
  }
}

// ------------------------------------------------------------ eventos

function iniciar() {
  ligarSlicer($('#slicer-espacos'), estado.espacos);
  ligarSlicer($('#slicer-epicos'), estado.epicos);
  ligarSlicer($('#slicer-responsaveis'), estado.responsaveis);
  ligarGraficos();

  $('#cancelados').addEventListener('change', (e) => { estado.incluirCancelados = e.target.checked; carregar(); });
  $('#de').addEventListener('change', (e) => { estado.de = e.target.value; carregar(); });
  $('#ate').addEventListener('change', (e) => { estado.ate = e.target.value; carregar(); });

  $('#btn-limpar-filtros').addEventListener('click', () => {
    for (const dim of DIMENSOES) estado[dim].clear();
    estado.de = '';
    estado.ate = '';
    estado.incluirCancelados = false;
    $('#de').value = '';
    $('#ate').value = '';
    $('#cancelados').checked = false;
    carregar();
  });

  $('#btn-pdf').addEventListener('click', () => window.print());
  $('#btn-excel').addEventListener('click', exportarExcel);

  const modal = $('#modal');
  $('#btn-importar').addEventListener('click', () => modal.classList.remove('oculto'));
  $('#btn-fechar').addEventListener('click', () => modal.classList.add('oculto'));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('oculto'); });

  const area = $('#area-solta');
  const entrada = $('#arquivo');
  area.addEventListener('click', () => entrada.click());
  entrada.addEventListener('change', () => { if (entrada.files.length) enviarArquivos([...entrada.files]); entrada.value = ''; });
  ['dragenter', 'dragover'].forEach((ev) =>
    area.addEventListener(ev, (e) => { e.preventDefault(); area.classList.add('sobre'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    area.addEventListener(ev, (e) => { e.preventDefault(); area.classList.remove('sobre'); }));
  area.addEventListener('drop', (e) => {
    const arquivos = [...(e.dataTransfer?.files || [])].filter((f) => /\.(xlsx|csv)$/i.test(f.name));
    if (arquivos.length) enviarArquivos(arquivos);
  });

  // --- Jira
  const modalJira = $('#modal-jira');
  $('#btn-config-jira').addEventListener('click', async () => {
    modalJira.classList.remove('oculto');
    await carregarConfigJira({ preencher: true });
  });
  $('#btn-fechar-jira').addEventListener('click', () => modalJira.classList.add('oculto'));
  modalJira.addEventListener('click', (e) => { if (e.target === modalJira) modalJira.classList.add('oculto'); });

  $('#btn-sincronizar').addEventListener('click', () => sincronizarAgora());
  $('#btn-sync-completa').addEventListener('click', () => {
    if (confirm('A sincronização completa relê todas as issues e remove da base as que não existem mais no Jira. Continuar?')) {
      sincronizarAgora({ completa: true });
    }
  });
  $('#btn-testar').addEventListener('click', testarJira);
  $('#btn-listar-projetos').addEventListener('click', listarProjetosJira);
  $('#btn-salvar-jira').addEventListener('click', salvarJira);
  $('#lista-projetos').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) alternarProjeto(chip.dataset.chave, chip);
  });

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-remover]');
    if (btn) {
      if (!confirm('Remover essa importação e todas as atividades que vieram dela?')) return;
      await fetch(`/api/importacoes/${btn.dataset.remover}`, { method: 'DELETE' });
      await carregar();
      return;
    }
    const btnSync = e.target.closest('[data-remover-sync]');
    if (btnSync) {
      const origem = btnSync.dataset.removerSync;
      if (!confirm(`Remover a origem "${origem}" e todas as atividades que vieram dela?`)) return;
      await fetch(`/api/jira/sincronizacoes/${encodeURIComponent(origem)}`, { method: 'DELETE' });
      await carregar();
      await carregarConfigJira();
    }
  });

  carregar();
  carregarConfigJira();
  // a sincronização automática roda no servidor; a tela só se pendura nela
  vigiarSincronizacaoDeFundo();
  setInterval(vigiarSincronizacaoDeFundo, 30000);
}

iniciar();
