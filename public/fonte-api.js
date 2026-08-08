// Fonte de dados do modo servidor: quem agrega e o Node, como sempre foi.
//
// Os caminhos aqui sao RELATIVOS ('api/...' e nao '/api/...') porque no GitHub
// Pages o site vive em /Dashboard_Jira/ — caminho absoluto sairia do lugar.
// Neste modo isso e indiferente, mas mantem uma regra so para o front inteiro.
import { DIMENSOES } from './filtros.js';

export const modo = 'servidor';
export const rotuloExportar = '⤓ Excel';
export const dicaExportar = 'Baixar em .xlsx tudo o que os filtros atuais selecionaram';

/** Serializa os filtros do jeito que `lerFiltros` no server.js espera. */
function query(f) {
  const p = new URLSearchParams();
  for (const dim of DIMENSOES) {
    if (f[dim]?.length) p.set(dim, f[dim].join('|'));
  }
  if (f.de) p.set('de', f.de);
  if (f.ate) p.set('ate', f.ate);
  if (f.incluirCancelados) p.set('cancelados', '1');   // o nome curto e o do servidor
  return p.toString();
}

export async function carregarDados(filtros) {
  const qs = query(filtros);
  const [dashboard, detalhe] = await Promise.all([
    fetch(`api/dashboard?${qs}`).then((r) => r.json()),
    fetch(`api/itens?${qs}&limite=500`).then((r) => r.json()),
  ]);
  return { dashboard, detalhe, publicadoEm: null };
}

/** No servidor a planilha sai pronta do Node, com formatacao e compressao. */
export async function exportar(filtros) {
  const r = await fetch(`api/exportar?${query(filtros)}`);
  if (!r.ok) {
    const erro = await r.json().catch(() => ({}));
    throw new Error(erro.erro || `falha ao gerar a planilha (HTTP ${r.status})`);
  }
  const nome = (r.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1]
    || 'atividades-jira.xlsx';
  return { blob: await r.blob(), nome };
}
