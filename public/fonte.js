// Decide, no boot, de onde vem o dado: do backend Node ou do Firestore.
//
// A escolha e feita por sondagem em vez de um sinalizador gravado no build.
// A diferenca importa: um sinalizador pode ser publicado errado e o site quebra
// silenciosamente; a sondagem se corrige sozinha. Rodou com `npm start`, achou o
// /api/saude e usa a API; abriu no GitHub Pages, a rota nao existe e cai no
// Firestore. Nao ha combinacao possivel de arquivos que produza o modo errado.
//
// O import dinamico tambem evita baixar os ~200 KB do SDK do Firebase quando se
// esta rodando local com servidor.

export async function escolherFonte() {
  try {
    // relativo de proposito: no Pages o site vive em /Dashboard_Jira/
    const r = await fetch('api/saude', { cache: 'no-store' });
    if (r.ok && (await r.json())?.ok) return import('./fonte-api.js');
  } catch {
    // sem backend atras desta pagina — segue para o modo publico
  }
  return import('./fonte-firestore.js');
}
