// Reaplica as regras de padronizacao (src/normalizar.js) nas linhas ja gravadas.
//
// Use depois de mexer nas tabelas de status, prioridade, tipo ou resolucao —
// sem isso, os itens antigos so seriam corrigidos numa sincronizacao completa.
//
//   node tools/padronizar.js            -> mostra o que mudaria, sem gravar
//   node tools/padronizar.js --aplicar  -> grava as correcoes
import { conectar } from '../src/banco.js';
import {
  canonizarStatus, normalizarPrioridade, normalizarTipo,
  normalizarResolucao, ehResolucaoNaoEntregue, espacoDoProjeto, normalizarEspaco,
} from '../src/normalizar.js';

const aplicar = process.argv.includes('--aplicar');
const db = conectar();

const linhas = db.prepare(`
  SELECT chave, status, status_origem, status_categoria, prioridade, tipo_item, resolucao,
         espaco, origem, projeto, arquivo_origem
  FROM itens
`).all();

/** Itens da API guardam a chave do projeto em `origem`; os de planilha, texto livre. */
const espacoDe = (it) => (String(it.arquivo_origem ?? '').startsWith('jira:')
  ? espacoDoProjeto(it.origem, it.projeto)
  : normalizarEspaco(it.origem, it.projeto, it.chave));

const mudancas = [];
for (const it of linhas) {
  // o nome original e o que estiver em status_origem; nas linhas antigas, o proprio status
  const bruto = it.status_origem || it.status;
  const resolucao = normalizarResolucao(it.resolucao);
  let { rotulo: status, categoria } = canonizarStatus(bruto);
  if (categoria === 'Concluído' && ehResolucaoNaoEntregue(resolucao)) {
    status = 'Cancelado';
    categoria = 'Cancelado';
  }
  const prioridade = normalizarPrioridade(it.prioridade);
  const tipo = normalizarTipo(it.tipo_item);
  const espaco = espacoDe(it);

  if (status !== it.status || categoria !== it.status_categoria || prioridade !== it.prioridade
      || tipo !== it.tipo_item || resolucao !== (it.resolucao ?? '') || bruto !== it.status_origem
      || espaco !== it.espaco) {
    mudancas.push({ chave: it.chave, bruto, status, categoria, prioridade, tipo, resolucao, espaco, antes: it });
  }
}

// ------------------------------------------------------------ relatorio

const resumo = new Map();
for (const m of mudancas) {
  const k = `${m.antes.status} → ${m.status}`;
  if (m.antes.status !== m.status) resumo.set(k, (resumo.get(k) || 0) + 1);
}
const prio = new Map();
for (const m of mudancas) {
  if (m.antes.prioridade !== m.prioridade) {
    const k = `${m.antes.prioridade} → ${m.prioridade}`;
    prio.set(k, (prio.get(k) || 0) + 1);
  }
}
const espacos = new Map();
for (const m of mudancas) {
  if (m.antes.espaco !== m.espaco) {
    const k = `${m.antes.espaco} → ${m.espaco}`;
    espacos.set(k, (espacos.get(k) || 0) + 1);
  }
}

console.log(`${linhas.length} itens na base, ${mudancas.length} precisam de ajuste.\n`);

if (resumo.size) {
  console.log('Status:');
  for (const [k, n] of [...resumo].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${k}`);
}
if (prio.size) {
  console.log('\nPrioridade:');
  for (const [k, n] of [...prio].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${k}`);
}
if (espacos.size) {
  console.log('\nEspaço:');
  for (const [k, n] of [...espacos].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${k}`);
}

if (!aplicar) {
  console.log('\nNada foi gravado. Rode de novo com --aplicar para efetivar.');
} else if (mudancas.length) {
  const atualizar = db.prepare(`
    UPDATE itens SET status = $status, status_origem = $bruto, status_categoria = $categoria,
                     prioridade = $prioridade, tipo_item = $tipo, resolucao = $resolucao,
                     espaco = $espaco
    WHERE chave = $chave
  `);
  db.exec('BEGIN');
  try {
    for (const m of mudancas) {
      atualizar.run({
        chave: m.chave, status: m.status, bruto: m.bruto, categoria: m.categoria,
        prioridade: m.prioridade, tipo: m.tipo, resolucao: m.resolucao, espaco: m.espaco,
      });
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  console.log(`\n${mudancas.length} itens atualizados.`);
} else {
  console.log('\nBase já está padronizada.');
}

console.log('\nComo ficou:');
for (const r of db.prepare('SELECT status_categoria c, status s, COUNT(*) n FROM itens GROUP BY s ORDER BY n DESC').all()) {
  console.log(`  ${String(r.s).padEnd(22)} ${String(r.c).padEnd(14)} ${String(r.n).padStart(5)}`);
}
