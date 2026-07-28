// Importa em lote todas as planilhas da pasta data/ (ou os caminhos passados).
//   node tools/importar.js                  -> importa data/*.xlsx e data/*.csv
//   node tools/importar.js caminho.xlsx     -> importa arquivos especificos
//   node tools/importar.js --reset          -> zera a base antes de importar
//   node tools/importar.js --forcar         -> reimporta mesmo se o conteudo ja foi visto
//   node tools/importar.js --aba "Sheet1"   -> forca uma aba especifica
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importarArquivo } from '../src/ingestao.js';
import { conectar, limparTudo, contarItens } from '../src/banco.js';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const PASTA_DADOS = join(RAIZ, 'data');

const argv = process.argv.slice(2);
const reset = argv.includes('--reset');
const forcar = argv.includes('--forcar');
const idxAba = argv.indexOf('--aba');
const aba = idxAba >= 0 ? argv[idxAba + 1] : undefined;
const alvos = argv.filter((a, i) => !a.startsWith('--') && i !== idxAba + 1);

async function listarDaPasta() {
  try {
    const nomes = await readdir(PASTA_DADOS);
    return nomes
      .filter((n) => /\.(xlsx|csv)$/i.test(n) && !n.startsWith('~$'))
      .sort()
      .map((n) => join(PASTA_DADOS, n));
  } catch {
    return [];
  }
}

conectar();
if (reset) {
  limparTudo();
  console.log('Base zerada.');
}

const arquivos = alvos.length ? alvos : await listarDaPasta();
if (!arquivos.length) {
  console.log(`Nenhuma planilha encontrada em ${PASTA_DADOS}.`);
  console.log('Coloque os arquivos .xlsx/.csv exportados do Jira nessa pasta e rode de novo.');
  process.exit(0);
}

let ok = 0;
for (const caminho of arquivos) {
  const nome = basename(caminho);
  try {
    const conteudo = await readFile(caminho);
    const r = importarArquivo(conteudo, nome, { aba, forcar });
    if (r.duplicado) {
      console.log(`- ${nome}: ignorado (${r.aviso})`);
    } else {
      console.log(
        `+ ${nome} [aba "${r.aba}"]: ${r.linhas} linhas -> ${r.novos} novas, ` +
        `${r.atualizados} atualizadas, ${r.ignorados} ignoradas`,
      );
      ok++;
    }
  } catch (e) {
    console.error(`! ${nome}: ${e.message}`);
  }
}

console.log(`\n${ok} arquivo(s) importado(s). Base agora com ${contarItens()} itens.`);
