// Puxa as issues direto da API do Jira e grava na base.
//   node tools/sincronizar.js              -> incremental (so o que mudou desde a ultima vez)
//   node tools/sincronizar.js --completa   -> le tudo de novo e remove issues que sumiram do Jira
//   node tools/sincronizar.js --testar     -> so testa a conexao e lista os projetos visiveis
import { conectar, contarItens } from '../src/banco.js';
import { lerConfig, configPublica } from '../src/config.js';
import { verificarConexao, listarProjetos } from '../src/jira.js';
import { sincronizar, resolverOrigens } from '../src/sincronizacao.js';

const argv = process.argv.slice(2);
const completa = argv.includes('--completa') || argv.includes('--full');
const soTestar = argv.includes('--testar') || argv.includes('--test');

// Nada de process.exit() aqui: com requisicoes HTTP recem-encerradas ele derruba
// o processo no Windows. Definimos process.exitCode e deixamos o Node sair sozinho.
async function principal() {
  conectar();
  const cfg = lerConfig();

  if (!cfg.configurado) {
    console.error('Jira não configurado.');
    console.error('Crie o arquivo .env na raiz do projeto com JIRA_URL, JIRA_EMAIL e JIRA_TOKEN,');
    console.error('ou use o botão "Configurar Jira" no dashboard. Passo a passo: docs/CONFIGURACAO-JIRA.md');
    process.exitCode = 1;
    return;
  }

  console.log(`Site:  ${cfg.url}`);
  console.log(`Conta: ${cfg.email || '(token pessoal, sem e-mail)'}  token ${configPublica().tokenMascarado}`);

  try {
    const conexao = await verificarConexao(cfg);
    console.log(`Conexão OK — autenticado como ${conexao.conta} (API v${conexao.api}).\n`);
  } catch (e) {
    console.error(`\nFalha na conexão: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  if (soTestar) {
    try {
      const projetos = await listarProjetos(cfg);
      console.log(`Projetos visíveis (${projetos.length}):`);
      for (const p of projetos) console.log(`  ${p.chave.padEnd(12)} ${p.nome}`);
      console.log('\nColoque as chaves desejadas em JIRA_PROJETOS (separadas por vírgula).');
    } catch (e) {
      console.error(`Não consegui listar os projetos: ${e.message}`);
      process.exitCode = 1;
    }
    return;
  }

  const origens = await resolverOrigens(cfg);
  console.log(`Origens (${origens.length}, uma por vez): ${origens.map((o) => o.origem).join(', ')}`);
  console.log(completa ? 'Modo: sincronização completa.\n' : 'Modo: incremental (só o que mudou).\n');

  // imprime o resultado de cada origem assim que ela termina: numa base grande a
  // passada inteira demora, e acompanhar de perto ajuda a ver onde travou
  const r = await sincronizar({
    completa,
    config: cfg,
    origens,
    aoProgredir: (p) => {
      if (p.fase === 'lendo') {
        process.stdout.write(`${`  [${p.indice}/${p.total}] ${p.origem}: ${p.lidas} issues…`.padEnd(78)}\r`);
      } else if (p.fase === 'concluida') {
        process.stdout.write(`${' '.repeat(78)}\r`);
        console.log(
          `+ [${p.indice}/${p.total}] ${p.origem}: ${p.itens} issues -> ${p.novos} novas, `
          + `${p.atualizados} atualizadas${p.removidos ? `, ${p.removidos} removidas` : ''}`,
        );
        for (const aviso of p.avisos ?? []) console.log(`    aviso: ${aviso}`);
      } else if (p.fase === 'erro') {
        process.stdout.write(`${' '.repeat(78)}\r`);
        console.error(`! [${p.indice}/${p.total}] ${p.origem}: ${p.erro}`);
      }
    },
  });

  console.log(
    `\nConcluído em ${(r.duracaoMs / 1000).toFixed(1)}s — ${r.novos} novas, ${r.atualizados} atualizadas`
    + `${r.removidos ? `, ${r.removidos} removidas` : ''}`
    + `${r.falhas ? `, ${r.falhas} origem(ns) com erro` : ''}.`,
  );
  if (r.epicosResolvidos) console.log(`Hierarquia: ${r.epicosResolvidos} itens tiveram o épico atualizado.`);
  console.log(`Base agora com ${contarItens()} itens.`);
  if (r.falhas) process.exitCode = 1;
}

await principal();
