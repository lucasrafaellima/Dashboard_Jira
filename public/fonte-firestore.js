// Fonte de dados do modo publico (GitHub Pages): o snapshot vem do Firestore e
// a agregacao acontece aqui no navegador, com o MESMO motor do servidor
// (compartilhado/metricas.js). Nao existem duas implementacoes das metricas.
import { bd, doc, getDoc, collection, getDocs } from './firebase.js';
import { exigirLogin, avisarSemPermissao } from './portao.js';
import { montarDashboard, listarDetalhe } from './compartilhado/metricas.js';

export const modo = 'publico';
export const rotuloExportar = '⤓ CSV';
export const dicaExportar = 'Baixar em .csv tudo o que os filtros atuais selecionaram (abre no Excel)';

let fonte = null;   // { itens, importacoes, sincronizacoes } — baixado uma vez
let geradoEm = null;

/** Junta as partes (so existem se o snapshot passar de 1 MiB) e descomprime. */
async function descompactar(d) {
  let bruto;
  if (Number(d.partes ?? 1) > 1) {
    const partes = await getDocs(collection(bd, 'painel', 'atual', 'partes'));
    const fatias = partes.docs
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map((p) => p.data().carga.toUint8Array());
    bruto = new Uint8Array(fatias.reduce((n, f) => n + f.length, 0));
    let pos = 0;
    for (const f of fatias) { bruto.set(f, pos); pos += f.length; }
  } else {
    bruto = d.carga.toUint8Array();
  }

  if (d.formato !== 'gzip+json') return JSON.parse(new TextDecoder().decode(bruto));

  if (!('DecompressionStream' in window)) {
    throw new Error('Este navegador não descomprime gzip. Atualize para uma versão recente.');
  }
  const fluxo = new Blob([bruto]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(fluxo).text());
}

/** Login, download e descompactacao — uma vez so por carregamento de pagina. */
async function garantirFonte() {
  if (fonte) return fonte;

  const { email } = await exigirLogin();

  let snap;
  try {
    snap = await getDoc(doc(bd, 'painel', 'atual'));
  } catch (e) {
    // e o que acontece quando a conta nao esta em `permitidos/`
    if (e?.code === 'permission-denied') {
      avisarSemPermissao(email);
      throw new Error('sem permissão');
    }
    throw e;
  }
  if (!snap.exists()) {
    throw new Error('Nenhum snapshot publicado ainda. Rode a sincronização no GitHub Actions.');
  }

  const d = snap.data();
  fonte = await descompactar(d);
  geradoEm = d.geradoEm?.toDate?.() ?? null;
  return fonte;
}

export async function carregarDados(filtros) {
  const dados = await garantirFonte();
  return {
    dashboard: montarDashboard(dados, filtros),
    detalhe: listarDetalhe(dados, filtros, 500),
    // a data em que o snapshot foi publicado — nao a hora em que esta aba abriu
    publicadoEm: geradoEm,
  };
}

/**
 * Sem Node do outro lado nao da para gerar .xlsx (o escritor usa zlib e Buffer),
 * entao aqui sai CSV — que o Excel abre igual, com BOM e ponto-e-virgula para o
 * separador nao brigar com a virgula decimal do pt-BR.
 */
export async function exportar(filtros) {
  const dados = await garantirFonte();
  const { itens } = listarDetalhe(dados, filtros, Infinity);

  const COLUNAS = [
    ['chave', 'Chave'], ['tipo_item', 'Tipo'], ['resumo', 'Resumo'],
    ['responsavel', 'Responsável'], ['status', 'Status'], ['prioridade', 'Prioridade'],
    ['espaco', 'Espaço'], ['epico_rotulo', 'Épico'], ['criado', 'Criado'],
    ['atualizado', 'Atualizado'], ['concluido_em', 'Concluído em'], ['data_limite', 'Data limite'],
  ];

  const escapar = (v) => {
    const s = v == null ? '' : String(v);
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const linhas = [
    COLUNAS.map(([, rotulo]) => escapar(rotulo)).join(';'),
    ...itens.map((it) => COLUNAS.map(([campo]) => escapar(it[campo])).join(';')),
  ];

  const hoje = new Date().toISOString().slice(0, 10);
  return {
    // ﻿ = BOM, senao o Excel no Windows estraga os acentos
    blob: new Blob([`﻿${linhas.join('\r\n')}`], { type: 'text/csv;charset=utf-8' }),
    nome: `atividades-jira-${hoje}.csv`,
  };
}
