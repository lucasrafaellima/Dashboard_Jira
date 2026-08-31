// Banco embutido (node:sqlite). Uma linha por item do Jira, deduplicado pela
// "Chave da item" — reimportar planilhas com sobreposicao atualiza, nao duplica.
import { DatabaseSync } from 'node:sqlite';
import { ehEpico } from './normalizar.js';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CAMINHO_BANCO = process.env.DB_PATH || join(RAIZ, 'db', 'jira.db');

let db = null;

export function conectar() {
  if (db) return db;
  mkdirSync(dirname(CAMINHO_BANCO), { recursive: true });
  db = new DatabaseSync(CAMINHO_BANCO);
  db.exec('PRAGMA journal_mode = WAL;');
  criarEsquema(db);
  migrar(db);
  return db;
}

/** Colunas adicionadas depois que bancos ja existiam em uso. */
function migrar(d) {
  const colunas = new Set(d.prepare('PRAGMA table_info(itens)').all().map((c) => c.name));
  if (!colunas.has('status_origem')) {
    d.exec('ALTER TABLE itens ADD COLUMN status_origem TEXT;');
    // nas linhas antigas o status gravado ainda e o nome original vindo do Jira
    d.exec('UPDATE itens SET status_origem = status WHERE status_origem IS NULL;');
  }
  // hierarquia do Jira: pai direto de cada item e o epico no topo da cadeia
  for (const c of ['pai', 'pai_tipo', 'pai_resumo', 'epico', 'epico_resumo']) {
    if (!colunas.has(c)) d.exec(`ALTER TABLE itens ADD COLUMN ${c} TEXT;`);
  }
  d.exec('CREATE INDEX IF NOT EXISTS idx_itens_epico ON itens(epico);');

  // data em que o Jira registrou a resolucao — e ela que diz em que mes a
  // atividade foi concluida, nao a data do ultimo toque no item
  if (!colunas.has('concluido_em')) d.exec('ALTER TABLE itens ADD COLUMN concluido_em TEXT;');
  d.exec('CREATE INDEX IF NOT EXISTS idx_itens_concluido ON itens(concluido_em);');

  // sprint/quadro: separam trabalho aceito de backlog, e e disso que o burndown
  // e feito. Base migrada chega com tudo vazio e so se preenche na proxima
  // sincronizacao — ate la `ehDeSprint()` responde "nao" para todo mundo.
  for (const c of ['sprint', 'sprint_estado', 'quadro', 'quadro_tipo']) {
    if (!colunas.has(c)) d.exec(`ALTER TABLE itens ADD COLUMN ${c} TEXT;`);
  }
  if (!colunas.has('no_backlog')) d.exec('ALTER TABLE itens ADD COLUMN no_backlog INTEGER DEFAULT 0;');
}

function criarEsquema(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS itens (
      chave            TEXT PRIMARY KEY,
      tipo_item        TEXT,
      id_item          TEXT,
      resumo           TEXT,
      responsavel      TEXT,
      id_responsavel   TEXT,
      relator          TEXT,
      id_relator       TEXT,
      prioridade       TEXT,
      status           TEXT,
      status_origem    TEXT,
      status_categoria TEXT,
      resolucao        TEXT,
      criado           TEXT,
      atualizado       TEXT,
      -- quando o Jira resolveu o item; base do "concluídas no mês"
      concluido_em     TEXT,
      data_limite      TEXT,
      projeto          TEXT,
      origem           TEXT,
      espaco           TEXT,
      -- hierarquia: "pai" e a issue imediatamente acima; "epico" e o topo da
      -- cadeia (subtarefa -> historia -> epico), resolvido em resolverEpicos()
      pai              TEXT,
      pai_tipo         TEXT,
      pai_resumo       TEXT,
      epico            TEXT,
      epico_resumo     TEXT,
      -- sprint da propria issue; "quadro"/"no_backlog" dependem de consultar o
      -- quadro agil do projeto e sao carimbados por resolverQuadros()
      sprint           TEXT,
      sprint_estado    TEXT,
      quadro           TEXT,
      quadro_tipo      TEXT,
      no_backlog       INTEGER DEFAULT 0,
      arquivo_origem   TEXT,
      importado_em     TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_itens_espaco      ON itens(espaco);
    -- o indice de "epico" nasce em migrar(): aqui ele quebraria as bases
    -- criadas antes da coluna existir, que so ganham a coluna la
    CREATE INDEX IF NOT EXISTS idx_itens_responsavel ON itens(responsavel);
    CREATE INDEX IF NOT EXISTS idx_itens_status      ON itens(status);
    CREATE INDEX IF NOT EXISTS idx_itens_criado      ON itens(criado);

    CREATE TABLE IF NOT EXISTS importacoes (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      arquivo      TEXT NOT NULL,
      aba          TEXT,
      hash         TEXT,
      linhas       INTEGER DEFAULT 0,
      novos        INTEGER DEFAULT 0,
      atualizados  INTEGER DEFAULT 0,
      ignorados    INTEGER DEFAULT 0,
      importado_em TEXT
    );

    -- Uma linha por origem sincronizada da API do Jira (chave do projeto, ou
    -- "(consulta)" quando o usuario define um JQL livre). Guarda a marca d'agua
    -- do maior "updated" ja visto, usada na sincronizacao incremental.
    CREATE TABLE IF NOT EXISTS sincronizacoes (
      origem       TEXT PRIMARY KEY,
      jql          TEXT,
      itens        INTEGER DEFAULT 0,
      novos        INTEGER DEFAULT 0,
      atualizados  INTEGER DEFAULT 0,
      removidos    INTEGER DEFAULT 0,
      marca_agua   TEXT,
      erro         TEXT,
      sincronizado_em TEXT
    );
  `);
}

const CAMPOS = [
  'chave', 'tipo_item', 'id_item', 'resumo', 'responsavel', 'id_responsavel',
  'relator', 'id_relator', 'prioridade', 'status', 'status_origem', 'status_categoria',
  'resolucao', 'criado', 'atualizado', 'concluido_em', 'data_limite', 'projeto', 'origem', 'espaco',
  'pai', 'pai_tipo', 'pai_resumo', 'epico', 'epico_resumo',
  // `quadro`, `quadro_tipo` e `no_backlog` ficam de fora de proposito: eles nao
  // vem na issue, e escrever aqui apagaria o carimbo de resolverQuadros() a
  // cada passada para reconstruir tudo em seguida
  'sprint', 'sprint_estado',
  'arquivo_origem', 'importado_em',
];

/**
 * Grava um lote de registros normalizados.
 * A linha so sobrescreve a existente se for igual ou mais recente (coluna
 * "Atualizado(a)"), para que uma planilha antiga nao apague dados novos.
 */
export function gravarItens(registros, arquivoOrigem) {
  const d = conectar();
  const agora = new Date().toISOString();

  // `epico`/`epico_resumo` nao vem prontos da API — quem os calcula e
  // resolverEpicos(), subindo a cadeia de pais. Uma linha nova chega com eles
  // vazios, entao aqui o valor ja gravado e preservado; sem isso cada passada
  // apagaria a hierarquia para o passo seguinte reconstruir.
  const DERIVADOS = new Set(['epico', 'epico_resumo']);
  const atribuir = (c) => (DERIVADOS.has(c)
    ? `${c} = COALESCE(NULLIF(excluded.${c}, ''), itens.${c})`
    : `${c} = excluded.${c}`);

  const existente = d.prepare('SELECT atualizado FROM itens WHERE chave = ?');
  const inserir = d.prepare(`
    INSERT INTO itens (${CAMPOS.join(', ')})
    VALUES (${CAMPOS.map((c) => `$${c}`).join(', ')})
    ON CONFLICT(chave) DO UPDATE SET
      ${CAMPOS.filter((c) => c !== 'chave').map(atribuir).join(',\n      ')}
    WHERE COALESCE(excluded.atualizado, '') >= COALESCE(itens.atualizado, '')
  `);

  let novos = 0;
  let atualizados = 0;
  let ignorados = 0;

  d.exec('BEGIN');
  try {
    for (const r of registros) {
      const anterior = existente.get(r.chave);
      const params = {};
      for (const c of CAMPOS) params[c] = r[c] ?? null;
      params.arquivo_origem = arquivoOrigem;
      params.importado_em = agora;
      inserir.run(params);

      if (!anterior) novos++;
      else if ((r.atualizado ?? '') >= (anterior.atualizado ?? '')) atualizados++;
      else ignorados++;
    }
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  return { novos, atualizados, ignorados, total: registros.length };
}

/**
 * Preenche `epico`/`epico_resumo` de toda a base subindo a cadeia de pais.
 *
 * O Jira so entrega o pai imediato de cada issue: uma subtarefa aponta para a
 * historia, que aponta para o epico. Aqui a cadeia e percorrida ate o topo para
 * que todo ticket saiba a qual epico do espaco ele pertence. Um epico e o
 * proprio epico dele, entao filtrar por um epico traz ele e tudo que esta
 * pendurado nele.
 *
 * Roda sobre a base inteira porque um pai pode ter chegado numa passada
 * anterior (ou por outro projeto) — resolver so o lote recem-lido deixaria
 * buracos na hierarquia.
 *
 * @returns {number} quantos itens tiveram o epico corrigido
 */
export function resolverEpicos() {
  const d = conectar();
  const linhas = d.prepare(`
    SELECT chave, tipo_item, resumo, pai, pai_tipo, pai_resumo, epico, epico_resumo FROM itens
  `).all();
  const porChave = new Map(linhas.map((l) => [l.chave, l]));
  const memo = new Map();

  function resolver(chave, profundidade = 0) {
    if (memo.has(chave)) return memo.get(chave);
    // marca antes de subir: se a cadeia voltar para ca, o ciclo para aqui
    memo.set(chave, null);

    const it = porChave.get(chave);
    let achado = null;
    if (it && profundidade < 20) {
      if (ehEpico(it.tipo_item)) {
        achado = { epico: it.chave, resumo: it.resumo ?? '' };
      } else if (it.pai) {
        achado = porChave.has(it.pai)
          ? resolver(it.pai, profundidade + 1)
          // pai fora da base (projeto que nao e sincronizado): sobra o que veio
          // junto com o filho na propria issue
          : (ehEpico(it.pai_tipo) ? { epico: it.pai, resumo: it.pai_resumo ?? '' } : null);
      }
    }
    memo.set(chave, achado);
    return achado;
  }

  const atualizar = d.prepare('UPDATE itens SET epico = ?, epico_resumo = ? WHERE chave = ?');
  let corrigidos = 0;

  d.exec('BEGIN');
  try {
    for (const l of linhas) {
      const achado = resolver(l.chave);
      const epico = achado?.epico || null;
      const resumo = achado?.resumo || null;
      // "" e NULL dizem a mesma coisa aqui ("sem epico"): comparar normalizado
      // evita reescrever a base inteira a cada passada
      if (epico !== (l.epico || null) || resumo !== (l.epico_resumo || null)) {
        atualizar.run(epico, resumo, l.chave);
        corrigidos++;
      }
    }
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  return corrigidos;
}

/**
 * Regrava, de uma vez, a que quadro agil cada item pertence e se ele esta no
 * backlog desse quadro. E o que permite ao burndown separar trabalho aceito de
 * fila de espera (ver `ehDeSprint`).
 *
 * O casamento item -> quadro e pelo **prefixo da chave** ("WIK-358" -> WIK), e
 * nao pela coluna `origem`: linha vinda de planilha guarda ali o nome do
 * arquivo, e so a chave existe nos dois caminhos de entrada.
 *
 * Item de projeto que **nao** esta na lista fica sem quadro. E o mesmo caminho
 * de duas situacoes diferentes, as duas corretas: o projeto nunca teve quadro
 * agil, ou tinha e perdeu — nos dois casos ele para de contar como sprint.
 *
 * @param {Array<{projeto:string, quadro:string, tipo:'scrum'|'kanban',
 *                backlog:string[]|null}>} quadros um por quadro do site;
 *   `backlog: null` = o Jira nao soube responder, e ninguem daquele quadro e
 *   marcado como backlog
 * @returns {number} quantos itens mudaram de carimbo
 */
export function marcarQuadros(quadros) {
  const d = conectar();

  const porProjeto = new Map();
  for (const q of quadros ?? []) {
    const chave = String(q?.projeto ?? '').trim().toUpperCase();
    if (!chave) continue;
    porProjeto.set(chave, {
      quadro: q.quadro || null,
      tipo: q.tipo || null,
      backlog: q.backlog ? new Set(q.backlog) : null,
    });
  }

  const linhas = d.prepare('SELECT chave, quadro, quadro_tipo, no_backlog FROM itens').all();
  const atualizar = d.prepare('UPDATE itens SET quadro = ?, quadro_tipo = ?, no_backlog = ? WHERE chave = ?');
  let mudados = 0;

  d.exec('BEGIN');
  try {
    for (const l of linhas) {
      const info = porProjeto.get(String(l.chave).split('-')[0]) ?? null;
      const quadro = info?.quadro ?? null;
      const tipo = info?.tipo ?? null;
      const noBacklog = info?.backlog?.has(l.chave) ? 1 : 0;
      if (quadro === (l.quadro || null) && tipo === (l.quadro_tipo || null)
        && noBacklog === (l.no_backlog ? 1 : 0)) continue;
      atualizar.run(quadro, tipo, noBacklog, l.chave);
      mudados++;
    }
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  return mudados;
}

export function registrarImportacao({ arquivo, aba, hash, linhas, novos, atualizados, ignorados }) {
  const d = conectar();
  d.prepare(`
    INSERT INTO importacoes (arquivo, aba, hash, linhas, novos, atualizados, ignorados, importado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(arquivo, aba ?? null, hash ?? null, linhas ?? 0, novos ?? 0, atualizados ?? 0, ignorados ?? 0, new Date().toISOString());
}

export function listarImportacoes(limite = 50) {
  return conectar()
    .prepare('SELECT * FROM importacoes ORDER BY id DESC LIMIT ?')
    .all(limite);
}

/** Ja existe uma importacao com esse hash de conteudo? */
export function jaImportado(hash) {
  if (!hash) return null;
  return conectar().prepare('SELECT * FROM importacoes WHERE hash = ? ORDER BY id DESC LIMIT 1').get(hash) ?? null;
}

export function listarItens() {
  return conectar().prepare('SELECT * FROM itens').all();
}

export function contarItens() {
  return conectar().prepare('SELECT COUNT(*) AS n FROM itens').get().n;
}

export function limparTudo() {
  const d = conectar();
  d.exec('DELETE FROM itens; DELETE FROM importacoes; DELETE FROM sincronizacoes;');
}

/** Remove os itens vindos de um arquivo especifico e o registro da importacao. */
export function removerImportacao(id) {
  const d = conectar();
  const imp = d.prepare('SELECT * FROM importacoes WHERE id = ?').get(id);
  if (!imp) return null;
  const r = d.prepare('DELETE FROM itens WHERE arquivo_origem = ?').run(imp.arquivo);
  d.prepare('DELETE FROM importacoes WHERE id = ?').run(id);
  return { arquivo: imp.arquivo, itensRemovidos: Number(r.changes ?? 0) };
}

// ------------------------------------------------------------ sincronizacao com a API

/** Rotulo gravado em itens.arquivo_origem para o que veio da API. */
export const origemJira = (origem) => `jira:${origem}`;

export function lerSincronizacao(origem) {
  return conectar().prepare('SELECT * FROM sincronizacoes WHERE origem = ?').get(origem) ?? null;
}

export function listarSincronizacoes() {
  return conectar().prepare('SELECT * FROM sincronizacoes ORDER BY origem').all();
}

/** Grava (ou atualiza) o resultado da ultima sincronizacao de uma origem. */
export function registrarSincronizacao({ origem, jql, itens, novos, atualizados, removidos, marcaAgua, erro }) {
  conectar().prepare(`
    INSERT INTO sincronizacoes (origem, jql, itens, novos, atualizados, removidos, marca_agua, erro, sincronizado_em)
    VALUES ($origem, $jql, $itens, $novos, $atualizados, $removidos, $marca_agua, $erro, $sincronizado_em)
    ON CONFLICT(origem) DO UPDATE SET
      jql = excluded.jql,
      itens = excluded.itens,
      novos = excluded.novos,
      atualizados = excluded.atualizados,
      removidos = excluded.removidos,
      -- so avanca a marca d'agua; um erro nao pode fazer ela retroceder
      marca_agua = COALESCE(MAX(COALESCE(excluded.marca_agua, ''), COALESCE(sincronizacoes.marca_agua, '')), ''),
      erro = excluded.erro,
      sincronizado_em = excluded.sincronizado_em
  `).run({
    origem,
    jql: jql ?? null,
    itens: itens ?? 0,
    novos: novos ?? 0,
    atualizados: atualizados ?? 0,
    removidos: removidos ?? 0,
    marca_agua: marcaAgua ?? null,
    erro: erro ?? null,
    sincronizado_em: new Date().toISOString(),
  });
}

/** Apaga os itens de uma origem sincronizada e o registro dela. */
export function removerSincronizacao(origem) {
  const d = conectar();
  const reg = lerSincronizacao(origem);
  if (!reg) return null;
  const r = d.prepare('DELETE FROM itens WHERE arquivo_origem = ?').run(origemJira(origem));
  d.prepare('DELETE FROM sincronizacoes WHERE origem = ?').run(origem);
  return { origem, itensRemovidos: Number(r.changes ?? 0) };
}

/** Quantos itens da base vieram de uma origem sincronizada. */
export function contarItensDaOrigem(origem) {
  return conectar()
    .prepare('SELECT COUNT(*) AS n FROM itens WHERE arquivo_origem = ?')
    .get(origemJira(origem)).n;
}

/**
 * Apaga os itens de uma origem que nao vieram na lista de chaves — usado na
 * sincronizacao completa, para refletir issues excluidas ou movidas no Jira.
 */
export function removerAusentes(origem, chaves) {
  const d = conectar();
  const atuais = d.prepare('SELECT chave FROM itens WHERE arquivo_origem = ?').all(origemJira(origem));
  const vivos = new Set(chaves);
  const sumidos = atuais.map((r) => r.chave).filter((c) => !vivos.has(c));
  if (!sumidos.length) return 0;

  const apagar = d.prepare('DELETE FROM itens WHERE chave = ?');
  d.exec('BEGIN');
  try {
    for (const c of sumidos) apagar.run(c);
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  return sumidos.length;
}
