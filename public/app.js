// Dashboard Jira — front-end vanilla, graficos em SVG escritos a mao.

const $ = (sel) => document.querySelector(sel);

const PALETA = ['#4472c4', '#e15759', '#70ad47', '#7c6bc4', '#4ec5d9', '#f0a22e', '#8c8c8c', '#2f6f9f', '#c0504d'];
const COR_STATUS = {
  'Feito': '#4472c4',
  'Concluído': '#70ad47',
  'A fazer': '#8faadc',
  'Tarefas pendentes': '#b4c7e7',
  'Fazendo': '#f0a22e',
  'Em andamento': '#f6c66a',
  'Em análise (QA)': '#7c6bc4',
  'Esperando ação externa': '#8c8c8c',
};
const corStatus = (s) => COR_STATUS[s] || '#4472c4';

const estado = {
  espacos: new Set(),
  responsaveis: new Set(),
  de: '',
  ate: '',
  amplo: false,
  dados: null,
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

// ------------------------------------------------------------ graficos

/** Barras verticais com rotulo de valor no topo — "Status das Atividades". */
function barrasVerticais(dados, { cor } = {}) {
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
    saida += `<rect x="${x}" y="${y}" width="${larguraBarra}" height="${Math.max(alt, 0)}" fill="${cor ? cor(d.rotulo) : PALETA[0]}" rx="2"><title>${esc(d.rotulo)}: ${d.total}</title></rect>`;
    saida += `<text class="rotulo-valor" x="${x + larguraBarra / 2}" y="${y - 6}" text-anchor="middle">${d.total}</text>`;

    const palavras = String(d.rotulo).split(' ');
    const linhas = [];
    let atual = '';
    for (const p of palavras) {
      if ((atual + ' ' + p).trim().length > 13) { linhas.push(atual.trim()); atual = p; }
      else atual = `${atual} ${p}`;
    }
    if (atual.trim()) linhas.push(atual.trim());
    linhas.slice(0, 3).forEach((linha, j) => {
      saida += `<text class="eixo" x="${margem.esq + passo * i + passo / 2}" y="${margem.top + alturaUtil + 16 + j * 11}" text-anchor="middle">${esc(linha)}</text>`;
    });
  });

  saida += `<line class="grade" x1="${margem.esq}" y1="${margem.top + alturaUtil}" x2="${L - margem.dir}" y2="${margem.top + alturaUtil}" stroke="#9db4cf"/>`;
  return svg(L, A, saida);
}

/** Barras horizontais — "Tickets criados por espaços". */
function barrasHorizontais(dados, { cor } = {}) {
  if (!dados.length) return vazio();

  const L = 560;
  const alturaLinha = 26;
  const margem = { top: 10, dir: 54, baixo: 10, esq: 130 };
  const A = margem.top + margem.baixo + dados.length * alturaLinha;
  const larguraUtil = L - margem.esq - margem.dir;
  const max = Math.max(...dados.map((d) => d.total)) || 1;

  let saida = '';
  dados.forEach((d, i) => {
    const y = margem.top + i * alturaLinha;
    const larg = (d.total / max) * larguraUtil;
    const rotulo = String(d.rotulo).length > 20 ? `${String(d.rotulo).slice(0, 19)}…` : d.rotulo;
    saida += `<text class="eixo" x="${margem.esq - 8}" y="${y + alturaLinha / 2 + 3}" text-anchor="end">${esc(rotulo)}<title>${esc(d.rotulo)}</title></text>`;
    saida += `<rect x="${margem.esq}" y="${y + 4}" width="${Math.max(larg, 1)}" height="${alturaLinha - 10}" fill="${cor ? cor(d.rotulo) : PALETA[0]}" rx="2"><title>${esc(d.rotulo)}: ${d.total}</title></rect>`;
    saida += `<text class="rotulo-valor" x="${margem.esq + larg + 7}" y="${y + alturaLinha / 2 + 4}">${d.total}</text>`;
  });
  return svg(L, A, saida);
}

/** Pizza com legenda — "Atividades concluídas por responsável". */
function pizza(dados) {
  const validos = dados.filter((d) => d.total > 0);
  if (!validos.length) return vazio();

  const L = 560, A = 270;
  const cx = 140, cy = A / 2, r = 100;
  const total = validos.reduce((s, d) => s + d.total, 0);

  let saida = '';
  let anguloAtual = -Math.PI / 2;

  validos.forEach((d, i) => {
    const fatia = (d.total / total) * Math.PI * 2;
    const cor = PALETA[i % PALETA.length];
    if (validos.length === 1) {
      saida += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${cor}"><title>${esc(d.rotulo)}: ${d.total}</title></circle>`;
    } else {
      const x1 = cx + r * Math.cos(anguloAtual);
      const y1 = cy + r * Math.sin(anguloAtual);
      const fim = anguloAtual + fatia;
      const x2 = cx + r * Math.cos(fim);
      const y2 = cy + r * Math.sin(fim);
      const grande = fatia > Math.PI ? 1 : 0;
      saida += `<path d="M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${grande} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z" fill="${cor}" stroke="#fff" stroke-width="1.5"><title>${esc(d.rotulo)}: ${d.total} (${((d.total / total) * 100).toFixed(1)}%)</title></path>`;
      anguloAtual = fim;
    }
  });

  validos.forEach((d, i) => {
    const y = 34 + i * 24;
    saida += `<rect x="285" y="${y - 9}" width="11" height="11" rx="2" fill="${PALETA[i % PALETA.length]}"/>`;
    const pct = ((d.total / total) * 100).toFixed(1);
    saida += `<text class="legenda" x="303" y="${y}">${esc(d.rotulo)} — ${d.total} (${pct}%)</text>`;
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
    [['criadas', PALETA[0], -1], ['concluidas', PALETA[2], 1]].forEach(([campo, cor, lado]) => {
      const alt = (d[campo] / max) * alturaUtil;
      const x = centro + lado * 2 + (lado < 0 ? -larguraBarra : 0);
      const y = margem.top + alturaUtil - alt;
      saida += `<rect x="${x}" y="${y}" width="${larguraBarra}" height="${Math.max(alt, 0)}" fill="${cor}" rx="2"><title>${mesCurto(d.mes)} — ${campo}: ${d[campo]}</title></rect>`;
      if (d[campo] > 0) saida += `<text class="rotulo-valor" x="${x + larguraBarra / 2}" y="${y - 5}" text-anchor="middle">${d[campo]}</text>`;
    });
    saida += `<text class="eixo" x="${centro}" y="${margem.top + alturaUtil + 16}" text-anchor="middle">${mesCurto(d.mes)}</text>`;
  });

  saida += `<rect x="${margem.esq}" y="6" width="10" height="10" rx="2" fill="${PALETA[0]}"/><text class="legenda" x="${margem.esq + 15}" y="15">criadas</text>`;
  saida += `<rect x="${margem.esq + 78}" y="6" width="10" height="10" rx="2" fill="${PALETA[2]}"/><text class="legenda" x="${margem.esq + 93}" y="15">concluídas</text>`;
  return svg(L, A, saida);
}

// ------------------------------------------------------------ slicers

function montarSlicer(el, opcoes, selecionadas, contagens) {
  el.innerHTML = opcoes
    .map((op) => {
      const n = contagens.get(op);
      return `<li data-valor="${esc(op)}" class="${selecionadas.has(op) ? 'ativo' : ''}" title="${esc(op)}">
        <span>${esc(op)}</span>${n != null ? `<span class="qtd">${n}</span>` : ''}
      </li>`;
    })
    .join('');
}

function ligarSlicer(el, conjunto) {
  el.addEventListener('click', (ev) => {
    const li = ev.target.closest('li');
    if (!li) return;
    const valor = li.dataset.valor;
    if (conjunto.has(valor)) conjunto.delete(valor);
    else conjunto.add(valor);
    carregar();
  });
}

// ------------------------------------------------------------ carregamento

function queryFiltros() {
  const p = new URLSearchParams();
  if (estado.espacos.size) p.set('espacos', [...estado.espacos].join('|'));
  if (estado.responsaveis.size) p.set('responsaveis', [...estado.responsaveis].join('|'));
  if (estado.de) p.set('de', estado.de);
  if (estado.ate) p.set('ate', estado.ate);
  if (estado.amplo) p.set('amplo', '1');
  return p.toString();
}

async function carregar() {
  const qs = queryFiltros();
  const [dash, detalhe] = await Promise.all([
    fetch(`/api/dashboard?${qs}`).then((r) => r.json()),
    fetch(`/api/itens?${qs}&limite=500`).then((r) => r.json()),
  ]);
  estado.dados = dash;
  renderizar(dash, detalhe);
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

  const contEspaco = new Map(d.porEspaco.map((x) => [x.rotulo, x.total]));
  const contResp = new Map(d.criadasPorResponsavel.map((x) => [x.rotulo, x.total]));
  montarSlicer($('#slicer-espacos'), d.opcoes.espacos, estado.espacos, contEspaco);
  montarSlicer($('#slicer-responsaveis'), d.opcoes.responsaveis, estado.responsaveis, contResp);

  $('#grafico-status').innerHTML = barrasVerticais(
    [...d.porStatus].sort((a, b) => a.rotulo.localeCompare(b.rotulo, 'pt-BR')),
    { cor: corStatus },
  );
  $('#grafico-responsaveis').innerHTML = pizza(d.concluidasPorResponsavel);
  $('#grafico-espacos').innerHTML = barrasHorizontais(
    [...d.porEspaco].sort((a, b) => a.rotulo.localeCompare(b.rotulo, 'pt-BR')),
  );
  $('#grafico-mensal').innerHTML = barrasAgrupadas(d.serieMensal);
  $('#grafico-tipos').innerHTML = barrasHorizontais(d.porTipo, { cor: (_, i) => PALETA[0] });
  $('#grafico-prioridades').innerHTML = barrasHorizontais(d.porPrioridade);

  $('#panorama').innerHTML = [
    ['A fazer', num(i.aFazer)],
    ['Em andamento', num(i.emAndamento)],
    ['Concluídas', num(i.concluidas)],
    ['Sem responsável', num(i.semResponsavel)],
    ['Fora do prazo (data limite vencida)', num(i.atrasadas)],
    ['Tempo médio até concluir', `${d.tempoDeConclusao.mediaDias} dias`],
    ['Tempo mediano até concluir', `${d.tempoDeConclusao.medianaDias} dias`],
    ['Espaços ativos', num(d.porEspaco.length)],
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
        <td>${dataCurta(it.criado)}</td>
        <td>${dataCurta(it.atualizado)}</td>
      </tr>`,
    )
    .join('') || '<tr><td colspan="9">Nenhuma atividade para os filtros selecionados.</td></tr>';

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

// ------------------------------------------------------------ eventos

function iniciar() {
  ligarSlicer($('#slicer-espacos'), estado.espacos);
  ligarSlicer($('#slicer-responsaveis'), estado.responsaveis);

  $('#amplo').addEventListener('change', (e) => { estado.amplo = e.target.checked; carregar(); });
  $('#de').addEventListener('change', (e) => { estado.de = e.target.value; carregar(); });
  $('#ate').addEventListener('change', (e) => { estado.ate = e.target.value; carregar(); });

  $('#btn-limpar-filtros').addEventListener('click', () => {
    estado.espacos.clear();
    estado.responsaveis.clear();
    estado.de = '';
    estado.ate = '';
    estado.amplo = false;
    $('#de').value = '';
    $('#ate').value = '';
    $('#amplo').checked = false;
    carregar();
  });

  $('#btn-pdf').addEventListener('click', () => window.print());

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

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-remover]');
    if (!btn) return;
    if (!confirm('Remover essa importação e todas as atividades que vieram dela?')) return;
    await fetch(`/api/importacoes/${btn.dataset.remover}`, { method: 'DELETE' });
    await carregar();
  });

  carregar();
}

iniciar();
