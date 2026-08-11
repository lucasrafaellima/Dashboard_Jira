// Dashboard Jira — front-end vanilla, graficos em SVG escritos a mao.
//
// Roda em dois modos, decididos em `fonte.js` no boot:
//   servidor — com `npm start` atras; o Node agrega e a tela tem tudo (config
//              do Jira, upload de planilha, sincronizacao, exportacao .xlsx);
//   publico  — GitHub Pages; login pelo Firebase, dados de um snapshot no
//              Firestore, agregacao aqui mesmo, e so leitura.
import { escolherFonte } from './fonte.js';
import { DIMENSOES } from './filtros.js';

const $ = (sel) => document.querySelector(sel);

/** Preenchido no boot por `iniciar()`; ver fonte-api.js / fonte-firestore.js. */
let fonte = null;

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

// ------------------------------------------------------------ utilidades

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (n) => Number(n ?? 0).toLocaleString('pt-BR');

function dataCurta(iso) {
  if (!iso) return '—';
  const [d, h] = iso.split('T');
  const [a, m, dia] = d.split('-');
  return `${dia}/${m}/${a}${h ? ` ${h.slice(0, 5)}` : ''}`;
}

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function mesCurto(ym) {
  const [a, m] = ym.split('-');
  return `${MESES[+m - 1]}/${a.slice(2)}`;
}

/** Semana em texto curto: "04–10/ago", ou "28/jul–03/ago" quando vira o mês. */
function rotuloSemana(inicio, fim) {
  const [, mi, di] = inicio.split('-');
  const [, mf, df] = fim.split('-');
  return mi === mf
    ? `${di}–${df}/${MESES[+mf - 1]}`
    : `${di}/${MESES[+mi - 1]}–${df}/${MESES[+mf - 1]}`;
}

/** Semana por extenso, para tooltips: "04/08 a 10/08/2026". */
const semanaPorExtenso = (inicio, fim) =>
  `${inicio.slice(8)}/${inicio.slice(5, 7)} a ${fim.slice(8)}/${fim.slice(5, 7)}/${fim.slice(0, 4)}`;

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

/**
 * Largura de viewBox para o gráfico que vai dentro de `el`: a do próprio quadro,
 * em pixels. O SVG ocupa 100% da largura do quadro, então casar as duas medidas
 * faz o desenho sair em escala 1:1 — e só assim o `font-size` do CSS vale como
 * está escrito.
 *
 * Com largura fixa era a escala que mandava no tamanho da letra: o mesmo gráfico
 * de 760 de viewBox saía com a fonte cheia no cartão largo e com dois terços
 * dela nos cartões de três colunas (tipos, prioridades, épicos), onde o
 * navegador encolhia texto e barras juntos. Era ali que os rótulos ficavam
 * ilegíveis.
 *
 * `minimo` segura o piso: num celular o cartão fica mais estreito do que o
 * desenho comporta, e aí é melhor deixar o SVG encolher sozinho — como antes —
 * do que espremer o gráfico até as barras sumirem.
 */
function larguraDo(el, minimo) {
  return Math.max(Math.round(el?.clientWidth ?? 0), minimo);
}

/** Corta o texto em `n` caracteres, com reticências no lugar do que sobrou. */
const cortar = (texto, n) => {
  const t = String(texto);
  return t.length > n ? `${t.slice(0, Math.max(1, n - 1))}…` : t;
};

/**
 * Largura média de um caractere nos rótulos dos gráficos (12px Segoe UI). Serve
 * para decidir o que cabe numa coluna antes de desenhar — medir de verdade
 * exigiria pôr o texto na tela e ler de volta, a cada rótulo de cada gráfico.
 */
const LARGURA_LETRA = 6.6;

/** Distância entre duas linhas de um rótulo de eixo quebrado em várias. */
const ALTURA_LINHA_ROTULO = 14;

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

/** Soma dias a uma data "aaaa-mm-dd", devolvendo outra. */
const somarDias = (dia, n) =>
  new Date(Date.parse(`${dia}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** O período atual é exatamente uma semana inteira? Devolve a segunda ou null. */
function semanaSelecionada() {
  if (!estado.de || !estado.ate) return null;
  return estado.ate === somarDias(estado.de, 6) ? estado.de : null;
}

/** O que está selecionado numa dimensão, com a mesma interface de um Set. */
function selecao(dim) {
  if (dim === 'mes') {
    const m = mesSelecionado();
    return { has: (v) => v === m, size: m ? 1 : 0 };
  }
  if (dim === 'semana') {
    const s = semanaSelecionada();
    return { has: (v) => v === s, size: s ? 1 : 0 };
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

/**
 * Quebra um rotulo em ate `maxLinhas` linhas de `porLinha` caracteres. O que
 * nao couber vira reticencias na ultima linha — cortar e melhor do que deixar o
 * texto invadir a coluna do vizinho.
 */
function quebrarRotulo(texto, porLinha, maxLinhas) {
  const linhas = [];
  let atual = '';
  for (const palavra of String(texto).split(' ')) {
    if (!atual) atual = palavra;
    else if (`${atual} ${palavra}`.length <= porLinha) atual += ` ${palavra}`;
    else { linhas.push(atual); atual = palavra; }
  }
  if (atual) linhas.push(atual);

  // uma palavra sozinha maior que a linha (um nome de status comprido) nao foi
  // quebrada pelo laco acima: corta cada linha no limite
  const cabidas = linhas.slice(0, maxLinhas).map((l) => cortar(l, porLinha));
  if (linhas.length > maxLinhas) cabidas[maxLinhas - 1] = cortar(cabidas[maxLinhas - 1], porLinha - 1);
  return cabidas;
}

/** Altura da área de plotagem — igual em todos os gráficos de coluna. */
const ALTURA_PLOTAGEM = 210;

/** Seno de 45°, o ângulo em que os rótulos deitam quando a coluna aperta. */
const SENO_45 = 0.7071;

/**
 * Barras verticais com rotulo de valor no topo — "Status das Atividades".
 *
 * A altura do quadro sai do que os rotulos pedem embaixo, e nao de um numero
 * fixo: assim a area de plotagem tem sempre a mesma altura, com dois rotulos
 * curtos ou com vinte e seis semanas deitadas.
 *
 * @param {object[]} dados pontos `{ rotulo, total, valor?, dica? }`
 * @param {object} [opcoes]
 * @param {(rotulo: string, ponto: object) => string} [opcoes.cor] cor da barra
 * @param {string} [opcoes.dim] dimensao que o clique filtra
 * @param {number} [opcoes.largura] largura do viewBox, em pixels (ver larguraDo)
 */
function barrasVerticais(dados, { cor, dim, largura } = {}) {
  if (!dados.length) return vazio();

  const L = largura ?? 760;
  const esq = 52, dir = 12, top = 28;
  const larguraUtil = L - esq - dir;
  const alturaUtil = ALTURA_PLOTAGEM;
  const max = topoEixo(Math.max(...dados.map((d) => d.total)));
  const passo = larguraUtil / dados.length;
  const larguraBarra = Math.min(56, passo * 0.55);

  // Quantas letras cabem numa linha de rotulo dentro da coluna. Com folga o
  // rotulo quebra em ate tres linhas deitadas; apertado, ele vira de lado —
  // picar "04–10/ago" em pedacos de quatro letras nao se le de jeito nenhum.
  const porLinha = Math.floor((passo - 5) / LARGURA_LETRA);
  const emPe = porLinha < 8;
  const rotulos = dados.map((d) =>
    (emPe ? [cortar(d.rotulo, 18)] : quebrarRotulo(d.rotulo, porLinha, 3)));

  // rotulo em pe ainda encosta no vizinho quando as colunas sao muitas: mostra
  // um a cada tantos. A barra e a faixa de clique continuam ali para filtrar
  const salto = emPe ? Math.max(1, Math.ceil(13 / Math.max(passo * SENO_45, 1))) : 1;

  // o espaco embaixo e o que os rotulos ocupam: em pe eles medem a diagonal do
  // proprio texto, deitados medem uma altura de linha cada
  const alturaRotulos = emPe
    ? Math.round(Math.max(...rotulos.map((r) => r[0].length)) * LARGURA_LETRA * SENO_45)
    : Math.max(...rotulos.map((r) => r.length)) * ALTURA_LINHA_ROTULO;
  const baixo = 16 + alturaRotulos;
  const A = top + alturaUtil + baixo;
  const baseRotulo = top + alturaUtil + (emPe ? 14 : 20);

  let saida = '';
  for (let i = 0; i <= 5; i++) {
    const v = (max / 5) * i;
    const y = top + alturaUtil - (v / max) * alturaUtil;
    saida += `<line class="grade" x1="${esq}" y1="${y}" x2="${L - dir}" y2="${y}"/>`;
    saida += `<text class="eixo" x="${esq - 9}" y="${y + 4}" text-anchor="end">${v}</text>`;
  }

  dados.forEach((d, i) => {
    const alt = max ? (d.total / max) * alturaUtil : 0;
    const x = esq + passo * i + (passo - larguraBarra) / 2;
    const y = top + alturaUtil - alt;
    const centro = esq + passo * i + passo / 2;
    const val = valorDe(d);
    // a barra pode ser rasteira ou zerada: a área de clique cobre a coluna
    // inteira, senão sobraria um alvo de 1px
    let bloco = `<rect${clicavel(dim, val, 'area-clique')} x="${esq + passo * i}" y="${top}" width="${passo}" height="${alturaUtil}" fill="transparent"><title>${esc(d.dica ?? `${d.rotulo}: ${d.total}`)}</title></rect>`;
    bloco += `<rect${clicavel(dim, val, 'cresce-y')} x="${x}" y="${y}" width="${larguraBarra}" height="${Math.max(alt, 0)}" fill="${cor ? cor(d.rotulo, d) : PALETA[0]}" rx="2"${atraso(i)}><title>${esc(d.dica ?? `${d.rotulo}: ${d.total}`)}</title></rect>`;
    bloco += `<text class="rotulo-valor surge" x="${x + larguraBarra / 2}" y="${y - 7}" text-anchor="middle"${atraso(i)}>${d.total}</text>`;

    if (i % salto === 0) {
      const gira = emPe ? ` transform="rotate(-45 ${centro.toFixed(1)} ${baseRotulo})"` : '';
      const ancora = emPe ? 'end' : 'middle';
      rotulos[i].forEach((linha, j) => {
        bloco += `<text${clicavel(dim, val, 'eixo surge')} x="${centro.toFixed(1)}"`
          + ` y="${baseRotulo + j * ALTURA_LINHA_ROTULO}" text-anchor="${ancora}"${gira}${atraso(i)}>`
          + `${esc(linha)}<title>${esc(d.rotulo)}</title></text>`;
      });
    }
    saida += grupo(bloco);
  });

  saida += `<line class="grade" x1="${esq}" y1="${top + alturaUtil}" x2="${L - dir}" y2="${top + alturaUtil}" stroke="#9db4cf"/>`;
  return svg(L, A, saida);
}

/** Barras horizontais — "Tickets criados por espaços". */
function barrasHorizontais(dados, { cor, dim, largura } = {}) {
  if (!dados.length) return vazio();

  const L = largura ?? 560;
  // a linha e alta o bastante para o nome caber sem encostar no de cima
  const alturaLinha = 30;
  // A coluna dos nomes e uma fatia da largura, e nao uma medida fixa: no cartao
  // estreito ela cede espaco para a barra, no largo cabe "Acompanhamento -
  // Gestão" inteiro. O corte do texto acompanha a fatia que sobrou.
  const esq = Math.round(Math.min(Math.max(L * 0.32, 110), 215));
  const margem = { top: 10, dir: 52, baixo: 10, esq };
  const maxRotulo = Math.max(10, Math.floor((esq - 12) / LARGURA_LETRA));
  const A = margem.top + margem.baixo + dados.length * alturaLinha;
  const larguraUtil = L - margem.esq - margem.dir;
  const max = Math.max(...dados.map((d) => d.total)) || 1;

  let saida = '';
  dados.forEach((d, i) => {
    const y = margem.top + i * alturaLinha;
    const larg = (d.total / max) * larguraUtil;
    const rotulo = cortar(d.rotulo, maxRotulo);
    const val = valorDe(d);
    // faixa invisível na linha toda: clicar em qualquer ponto dela filtra
    let bloco = `<rect${clicavel(dim, val, 'area-clique')} x="0" y="${y}" width="${L}" height="${alturaLinha}" fill="transparent"><title>${esc(d.rotulo)}: ${d.total}</title></rect>`;
    bloco += `<text${clicavel(dim, val, 'eixo surge')} x="${margem.esq - 9}" y="${y + alturaLinha / 2 + 4}" text-anchor="end"${atraso(i)}>${esc(rotulo)}<title>${esc(d.rotulo)}</title></text>`;
    bloco += `<rect${clicavel(dim, val, 'cresce-x')} x="${margem.esq}" y="${y + 6}" width="${Math.max(larg, 1)}" height="${alturaLinha - 12}" fill="${cor ? cor(d.rotulo) : PALETA[0]}" rx="2"${atraso(i)}><title>${esc(d.rotulo)}: ${d.total}</title></rect>`;
    bloco += `<text class="rotulo-valor surge" x="${margem.esq + larg + 8}" y="${y + alturaLinha / 2 + 4}"${atraso(i)}>${d.total}</text>`;
    saida += grupo(bloco);
  });
  return svg(L, A, saida);
}

/** Pizza com legenda — "Atividades concluídas por responsável". */
function pizza(dados, { dim, largura } = {}) {
  const validos = dados.filter((d) => d.total > 0);
  if (!validos.length) return vazio();

  const L = largura ?? 560;
  // a legenda cresce com o numero de responsaveis; o quadro acompanha para ela
  // nao vazar o cartao (na impressao isso virava texto por cima da borda)
  const alturaItem = 27;

  // Lado a lado, o disco e a legenda dividem a largura. Num cartao estreito —
  // celular, onde a grade vira uma coluna so — os dois nao cabem: a legenda
  // desce para baixo do disco, em vez de comecar fora do quadro.
  const empilhado = L < 430;
  const r = empilhado ? Math.min(88, L / 2 - 24) : 100;
  const cx = empilhado ? L / 2 : 32 + r;
  // onde a legenda comeca e quanto texto cabe nela ate a borda do quadro
  const xLegenda = empilhado ? 14 : cx + r + 24;
  const xTexto = xLegenda + 21;
  const topoLegenda = empilhado ? 2 * r + 34 : 36;
  const fimLegenda = topoLegenda + validos.length * alturaItem;
  const A = empilhado ? fimLegenda + 6 : Math.max(2 * r + 40, fimLegenda + 10);
  const cy = empilhado ? r + 14 : A / 2;
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
    const y = topoLegenda + i * alturaItem;
    const val = valorDe(d);
    const pct = ((d.total / total) * 100).toFixed(1);
    // o nome cede primeiro: o numero e o percentual sao o que a legenda existe
    // para dizer, e sem eles a fatia vira so uma cor
    const sufixo = ` — ${d.total} (${pct}%)`;
    const nome = cortar(d.rotulo, Math.max(6, Math.floor((L - xTexto - 6) / LARGURA_LETRA) - sufixo.length));
    // a linha inteira da legenda filtra, não só o texto
    let bloco = `<rect${clicavel(dim, val, 'area-clique')} x="${xLegenda - 4}" y="${y - 14}" width="${L - xLegenda}" height="${alturaItem - 4}" fill="transparent"><title>${esc(d.rotulo)}: ${d.total} (${pct}%)</title></rect>`;
    bloco += `<rect${clicavel(dim, val, 'secundaria surge')} x="${xLegenda}" y="${y - 10}" width="12" height="12" rx="2" fill="${PALETA[i % PALETA.length]}"${atraso(i)}/>`;
    bloco += `<text${clicavel(dim, val, 'legenda surge')} x="${xTexto}" y="${y}"${atraso(i)}>${esc(nome)}${esc(sufixo)}<title>${esc(d.rotulo)}</title></text>`;
    saida += grupo(bloco);
  });

  return svg(L, A, saida);
}

/** Barras agrupadas — evolucao mensal. */
function barrasAgrupadas(serie, { largura } = {}) {
  if (!serie.length) return vazio();

  const L = largura ?? 860;
  // o topo abre espaço para a legenda e ainda deixa o rótulo da barra mais alta
  // passar por baixo dela
  const margem = { top: 42, dir: 12, baixo: 46, esq: 52 };
  const alturaUtil = ALTURA_PLOTAGEM;
  const A = margem.top + alturaUtil + margem.baixo;
  const larguraUtil = L - margem.esq - margem.dir;
  const max = topoEixo(Math.max(1, ...serie.flatMap((d) => [d.criadas, d.concluidas])));
  const passo = larguraUtil / serie.length;
  const larguraBarra = Math.min(26, passo * 0.32);
  // com muitos meses na janela os nomes se tocam: mostra um a cada tantos
  const salto = Math.max(1, Math.ceil(40 / Math.max(passo, 1)));

  let saida = '';
  for (let i = 0; i <= 5; i++) {
    const v = (max / 5) * i;
    const y = margem.top + alturaUtil - (v / max) * alturaUtil;
    saida += `<line class="grade" x1="${margem.esq}" y1="${y}" x2="${L - margem.dir}" y2="${y}"/>`;
    saida += `<text class="eixo" x="${margem.esq - 9}" y="${y + 4}" text-anchor="end">${Math.round(v)}</text>`;
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
      if (d[campo] > 0) bloco += `<text class="rotulo-valor surge" x="${x + larguraBarra / 2}" y="${y - 7}" text-anchor="middle"${atraso(i)}>${d[campo]}</text>`;
    });
    if (i % salto === 0) {
      bloco += `<text${clicavel('mes', d.mes, 'eixo surge')} x="${centro}" y="${margem.top + alturaUtil + 20}" text-anchor="middle"${atraso(i)}>${mesCurto(d.mes)}</text>`;
    }
    saida += grupo(bloco);
  });

  saida += `<rect x="${margem.esq}" y="8" width="12" height="12" rx="2" fill="${PALETA[0]}"/><text class="legenda" x="${margem.esq + 17}" y="18">criadas</text>`;
  saida += `<rect x="${margem.esq + 92}" y="8" width="12" height="12" rx="2" fill="${PALETA[2]}"/><text class="legenda" x="${margem.esq + 109}" y="18">concluídas</text>`;
  return svg(L, A, saida);
}

// -------------------------------------------------------- produtividade semanal

/**
 * Faisca: uma barrinha por semana, dentro da celula da tabela. Serve para ler o
 * ritmo do colaborador de relance — se a semana atual e um pico, um vale ou o
 * de sempre. A ultima barra e a semana corrente e vem destacada.
 *
 * A escala e a **do proprio colaborador** (o maximo dele), nao a da equipe:
 * quem entrega 3 por semana teria barras invisiveis ao lado de quem entrega 30,
 * e a leitura aqui e da tendencia de cada um, nao da comparacao entre eles —
 * essa fica nas colunas de numero ao lado.
 */
function faiscaSemanal(serie, semanas) {
  const L = 108, A = 22;
  const max = Math.max(1, ...serie);
  const passo = L / serie.length;
  // com o periodo filtrado a janela pode ter duas ou tres semanas: sem o teto,
  // a "faisca" viraria um bloco de 50px que nao parece um grafico de ritmo
  const larg = Math.min(12, Math.max(2, passo - 2.5));

  const barras = serie
    .map((v, i) => {
      const alt = (v / max) * A;
      const s = semanas[i];
      const ultima = i === serie.length - 1;
      // uma semana zerada nao desenha nada: um trapo de 1px seria confundido
      // com uma entrega
      const altura = v ? Math.max(alt, 2) : 0;
      return `<rect x="${(i * passo).toFixed(1)}" y="${(A - altura).toFixed(1)}"`
        + ` width="${larg.toFixed(1)}" height="${altura.toFixed(1)}" rx="1"`
        + ` fill="${ultima ? PALETA[0] : '#c3d4ea'}">`
        + `<title>${s ? `${rotuloSemana(s.inicio, s.fim)}: ` : ''}${v}</title></rect>`;
    })
    .join('');

  return `<svg class="faisca" viewBox="0 0 ${L} ${A}" width="${L}" height="${A}" role="img"`
    + ` aria-label="últimas ${serie.length} semanas">${barras}</svg>`;
}

/**
 * Variação em pílula: seta, percentual e a diferença absoluta entre parênteses.
 *
 * O absoluto anda junto porque sozinho o percentual mente de tamanho — sair de
 * 1 para 2 conclusões é "+100%" e não significa quase nada. Sem base (o
 * colaborador não entregou nada no trecho comparado) não existe percentual, e
 * a pílula diz "novo" em vez de inventar um número.
 */
function pilulaVariacao(variacao, delta) {
  if (!delta) return '<span class="variacao estavel">estável</span>';
  const sobe = delta > 0;
  const pct = variacao == null
    ? 'novo'
    : `${sobe ? '+' : ''}${variacao.toFixed(1).replace('.', ',')}%`;
  const abs = `${sobe ? '+' : ''}${num(delta)}`;
  return `<span class="variacao ${sobe ? 'sobe' : 'cai'}">${sobe ? '▲' : '▼'} ${pct}`
    + ` <em>(${abs})</em></span>`;
}

/** Cartão de produtividade semanal: faixa de indicadores + ranking + faíscas. */
function renderizarProdutividade(p) {
  // um servidor antigo ainda no ar responde sem este bloco (o payload sai do
  // processo em memória, não do disco). Sem a saída aqui o cartão derrubaria o
  // render inteiro, e a tabela de atividades lá embaixo sumiria junto.
  if (!p?.semanas?.length) {
    $('#tabela-produtividade tbody').innerHTML =
      '<tr><td colspan="6">Indisponível — reinicie o servidor para carregar esta métrica.</td></tr>';
    return;
  }

  const { resumo, semanas, colaboradores } = p;
  const atual = semanas[semanas.length - 1];

  // quando a última semana não fechou — ou porque ainda está correndo, ou porque
  // o filtro de datas cortou no meio dela — a comparação é contra o mesmo trecho
  // da semana anterior; senão toda segunda-feira pareceria um desabamento
  const parcial = resumo.parcial ?? (resumo.emCurso && resumo.decorridos < 7);
  const rotuloBase = parcial ? 'mesmo trecho da semana anterior' : 'semana anterior';

  // um período curto cabe numa semana só: sem semana anterior na janela não há
  // variação nem média, e "▲ novo" contra o zero mentiria
  const semBase = !!resumo.semComparacao;
  const traco = '<span class="variacao estavel">—</span>';
  const variacao = (v, d) => (semBase ? traco : pilulaVariacao(v, d));

  // os indicadores e o gráfico ao lado seguem o responsável selecionado; só o
  // ranking abaixo ignora essa seleção. Dizer de quem é o número evita ler o
  // total de uma pessoa como se fosse o da equipe
  const recorte = estado.responsaveis.size ? listaCurta(estado.responsaveis, 3) : '';
  $('#semanas-recorte').textContent = recorte ? `— ${recorte}` : '— equipe inteira';

  $('#produtividade-semana').textContent =
    `— semana de ${semanaPorExtenso(resumo.inicio, resumo.fim)}`
    + (parcial ? ` (${resumo.decorridos} de 7 dias corridos)` : '')
    + (recorte ? ` · indicadores de ${recorte}` : '');

  // com o período filtrado a "semana atual" é a última do intervalo, não a de hoje
  const dequem = recorte || 'toda a equipe';
  const daSemana = resumo.filtrada ? 'na última semana do período' : 'na semana atual';
  const semJanela = semanas.length === 1
    ? 'O período filtrado cabe numa única semana: não há semana anterior na janela.'
    : 'O período filtrado corta a semana anterior pela metade: sem base cheia, não dá para comparar.';
  $('#produtividade-kpis').innerHTML = [
    ['Concluídas na semana', num(resumo.atual), `Atividades concluídas ${daSemana} — ${dequem}`],
    [`Contra ${rotuloBase}`, variacao(resumo.variacao, resumo.delta),
      semBase ? semJanela
        : `Base de comparação: ${num(resumo.comparavel)} conclusões${parcial ? ` (a semana anterior fechou com ${num(resumo.anterior)})` : ''}`],
    ['Colaboradores ativos', num(resumo.ativos), `Quantos concluíram ao menos uma atividade ${daSemana} — ${dequem}`],
    ['Média por colaborador', String(resumo.porColaborador).replace('.', ','), 'Concluídas na semana ÷ colaboradores ativos'],
    ['Média das semanas anteriores', semBase ? '—' : String(resumo.media).replace('.', ','),
      semBase ? semJanela : `Ritmo nas ${semanas.length - 1} semanas anteriores — ${dequem}`],
  ]
    .map(([r, v, dica]) => `<li title="${esc(dica)}"><b>${v}</b><span>${r}</span></li>`)
    .join('');

  $('#th-comparavel').textContent = parcial ? 'Mesmo trecho anterior' : 'Semana anterior';
  $('#th-comparavel').title = parcial
    ? 'A última semana não fechou: a comparação usa a semana anterior só até o mesmo dia'
    : 'Semana anterior fechada';

  const temSelecao = estado.responsaveis.size > 0;
  $('#tabela-produtividade tbody').innerHTML = colaboradores
    .map((c) => {
      const selecionado = estado.responsaveis.has(c.rotulo);
      const classes = ['linha-colab', selecionado ? 'ativa' : '', temSelecao && !selecionado ? 'apagada' : '']
        .filter(Boolean).join(' ');
      return `<tr class="${classes}" data-dim="responsaveis" data-valor="${esc(c.rotulo)}">
        <td><span${clicavel('responsaveis', c.rotulo)}>${esc(c.rotulo)}</span></td>
        <td class="numero destaque">${num(c.atual)}</td>
        <td class="numero">${semBase ? '—' : num(c.comparavel)}</td>
        <td class="numero">${variacao(c.variacao, c.delta)}</td>
        <td class="faisca-celula">${faiscaSemanal(c.serie, semanas)}</td>
        <td class="numero suave">${semBase ? '—' : String(c.media).replace('.', ',')}</td>
      </tr>`;
    })
    .join('') || `<tr><td colspan="6">Nenhuma atividade concluída ${resumo.filtrada
      ? 'no período filtrado' : 'nas últimas semanas'} para os filtros selecionados.</td></tr>`;

  const janela = semanas.length > 1
    ? `${rotuloSemana(semanas[0].inicio, semanas[0].fim)} a ${rotuloSemana(atual.inicio, atual.fim)}`
    : rotuloSemana(atual.inicio, atual.fim);
  $('#produtividade-nota').textContent = [
    `Cada atividade entra na semana em que foi concluída. Janela de`
      + ` ${semanas.length === 1 ? '1 semana' : `${semanas.length} semanas`}`
      + ` (${janela}), de segunda a domingo.`,
    'O ranking traz sempre todo mundo, mesmo com alguém selecionado — é por ele que se troca a'
      + ' seleção. Os indicadores acima e o gráfico ao lado seguem quem estiver marcado.',
    resumo.filtrada
      ? 'A janela acompanha o filtro de período, junto com espaço, épico, tipo e prioridade. Uma'
        + ' semana que o intervalo pega pela metade conta só os dias dentro dele e sai mais clara'
        + ' no gráfico ao lado.'
      : 'O filtro de período não está aplicado; espaço, épico, tipo e prioridade valem.',
    resumo.truncada
      ? `O período filtrado é mais longo que ${semanas.length} semanas: o cartão mostra as`
        + ` ${semanas.length} últimas dele.`
      : null,
    semBase ? `${semJanela} A variação e a média ficam de fora.` : null,
    resumo.emCurso || resumo.filtrada
      ? null
      : 'Sem conclusões nas últimas semanas: a janela recuou até a última semana com entregas.',
  ].filter(Boolean).join(' ');
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

/** Clicar numa semana recorta o período nela (segunda a domingo); de novo, desfaz. */
function alternarSemana(inicio) {
  const ligada = semanaSelecionada() !== inicio;
  estado.de = ligada ? inicio : '';
  estado.ate = ligada ? somarDias(inicio, 6) : '';
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
    } else if (dim === 'semana') {
      alternarSemana(valor);
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

/**
 * Os filtros da tela como objeto. E esta a forma que as duas fontes recebem: a
 * do servidor serializa em query string, a do Firestore repassa direto para o
 * `metricas.js`. Um formato so, entao nao ha um parser para sair de sincronia.
 */
function filtrosAtuais() {
  const f = {
    de: estado.de || null,
    ate: estado.ate || null,
    incluirCancelados: estado.incluirCancelados,
  };
  for (const dim of DIMENSOES) f[dim] = [...estado[dim]];
  return f;
}

/** Só esmaece o painel se a resposta passar disso — evita piscar no clique. */
const ESPERA_ATE_ESMAECER_MS = 140;

async function carregar() {
  const painel = $('#painel');
  const esmaecer = setTimeout(() => painel.classList.add('carregando'), ESPERA_ATE_ESMAECER_MS);
  try {
    const { dashboard, detalhe, publicadoEm } = await fonte.carregarDados(filtrosAtuais());
    estado.dados = dashboard;
    renderizar(dashboard, detalhe);
    if (publicadoEm) mostrarValidade(publicadoEm);
  } catch (e) {
    // no modo publico o "sem permissão" ja virou mensagem no portao
    if (e?.message !== 'sem permissão') {
      $('#resumo-base').textContent = `Não foi possível carregar: ${e.message}`;
    }
  } finally {
    clearTimeout(esmaecer);
    painel.classList.remove('carregando');
  }
}

/** No modo publico o cabecalho mostra a validade do dado, nao a conexao ao Jira. */
function mostrarValidade(quando) {
  const etiqueta = $('#status-jira');
  etiqueta.className = 'etiqueta';
  etiqueta.textContent = `dados de ${quando.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  })}`;
}

/**
 * Piso da largura de viewBox dos graficos. Abaixo disso — um celular em pe — o
 * desenho nao tem mais como ceder espaco, e vale deixar o SVG encolher junto
 * com o cartao.
 */
const LARGURA_MINIMA = 320;

/**
 * Desenha os graficos a partir dos dados ja carregados.
 *
 * Esta fora do `renderizar` porque o tamanho do cartao entra no desenho: o
 * viewBox de cada grafico e a largura medida do quadro onde ele vai (ver
 * `larguraDo`), entao mudar a largura da janela pede um redesenho — mas so dos
 * graficos, e nao da tabela de centenas de linhas ao lado deles.
 */
function desenharGraficos() {
  const d = estado.dados;
  if (!d) return;

  const em = (seletor, montar) => {
    const el = $(seletor);
    if (el) el.innerHTML = montar(larguraDo(el, LARGURA_MINIMA));
  };

  em('#grafico-status', (largura) => barrasVerticais(
    [...d.porStatus].sort((a, b) => a.rotulo.localeCompare(b.rotulo, 'pt-BR')),
    { cor: corStatus, dim: 'status', largura },
  ));
  em('#grafico-responsaveis', (largura) =>
    pizza(d.concluidasPorResponsavel, { dim: 'responsaveis', largura }));
  em('#grafico-espacos', (largura) => barrasHorizontais(
    [...d.porEspaco].sort((a, b) => a.rotulo.localeCompare(b.rotulo, 'pt-BR')),
    { dim: 'espacos', largura },
  ));
  em('#grafico-mensal', (largura) => barrasAgrupadas(d.serieMensal, { largura }));
  em('#grafico-tipos', (largura) =>
    barrasHorizontais(d.porTipo, { cor: () => PALETA[0], dim: 'tipos', largura }));
  em('#grafico-prioridades', (largura) =>
    barrasHorizontais(d.porPrioridade, { dim: 'prioridades', largura }));

  // so os 12 maiores: a lista inteira de epicos nao cabe num grafico de barras.
  // O que estiver selecionado entra de todo jeito, senão sumiria da tela sem
  // dar como desmarcar
  const epicos = d.porEpico ?? [];
  const visiveis = epicos.slice(0, 12);
  for (const e of epicos.slice(12)) if (estado.epicos.has(e.valor)) visiveis.push(e);
  em('#grafico-epicos', (largura) => barrasHorizontais(visiveis, { dim: 'epicos', largura }));

  // o cartao semanal vem do mesmo bloco de produtividade que monta a tabela ao
  // lado; um servidor antigo responde sem ele (ver renderizarProdutividade)
  const semanas = d.produtividadeSemanal?.semanas ?? [];
  em('#grafico-semanas', (largura) => (semanas.length
    ? barrasVerticais(
      semanas.map((s) => ({
        rotulo: rotuloSemana(s.inicio, s.fim),
        valor: s.inicio,
        total: s.total,
        parcial: s.parcial,
        dica: `${semanaPorExtenso(s.inicio, s.fim)}: ${s.total} concluída(s)`
          + (s.parcial ? ' — semana em curso' : ''),
      })),
      // a semana em curso sai mais clara: ela ainda vai crescer, e uma barra
      // cheia ao lado das fechadas leria como queda
      { dim: 'semana', cor: (_, ponto) => (ponto.parcial ? '#a9cd8a' : PALETA[2]), largura },
    )
    : vazio('Indisponível.')));
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

  renderizarProdutividade(d.produtividadeSemanal);
  desenharGraficos();

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
    // servidor: .xlsx pronto do Node. Modo público: CSV gerado aqui.
    const { blob, nome } = await fonte.exportar(filtrosAtuais());

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

async function iniciar() {
  // Primeira coisa: descobrir se ha backend. Tudo abaixo depende disso.
  fonte = await escolherFonte();
  document.body.classList.add(fonte.modo === 'publico' ? 'somente-leitura' : 'com-servidor');
  $('#btn-excel').textContent = fonte.rotuloExportar;
  $('#btn-excel').title = fonte.dicaExportar;

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

  // A largura do cartão faz parte do desenho (ver desenharGraficos): mudar o
  // tamanho da janela — ou virar o celular — pede os gráficos de novo. Só
  // depois que ela para, senão seria um redesenho por pixel arrastado.
  let redesenho;
  addEventListener('resize', () => {
    clearTimeout(redesenho);
    redesenho = setTimeout(desenharGraficos, 180);
  });

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
    // esconder o botão no CSS não impede um clique pelo devtools de chegar aqui
    if (fonte.modo !== 'servidor') return;
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

  await carregar();

  // Daqui para baixo é tudo /api/*. No modo público não existe backend: chamar
  // isso encheria o console de 404 e deixaria o cabeçalho preso em
  // "verificando conexão…" para sempre.
  if (fonte.modo !== 'servidor') return;

  carregarConfigJira();
  // a sincronização automática roda no servidor; a tela só se pendura nela
  vigiarSincronizacaoDeFundo();
  setInterval(vigiarSincronizacaoDeFundo, 30000);
}

iniciar();
