// Banco embutido (node:sqlite). Uma linha por item do Jira, deduplicado pela
// "Chave da item" — reimportar planilhas com sobreposicao atualiza, nao duplica.
import { DatabaseSync } from 'node:sqlite';
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
  return db;
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
      status_categoria TEXT,
      resolucao        TEXT,
      criado           TEXT,
      atualizado       TEXT,
      data_limite      TEXT,
      projeto          TEXT,
      origem           TEXT,
      espaco           TEXT,
      arquivo_origem   TEXT,
      importado_em     TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_itens_espaco      ON itens(espaco);
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
  'relator', 'id_relator', 'prioridade', 'status', 'status_categoria', 'resolucao',
  'criado', 'atualizado', 'data_limite', 'projeto', 'origem', 'espaco',
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

  const existente = d.prepare('SELECT atualizado FROM itens WHERE chave = ?');
  const inserir = d.prepare(`
    INSERT INTO itens (${CAMPOS.join(', ')})
    VALUES (${CAMPOS.map((c) => `$${c}`).join(', ')})
    ON CONFLICT(chave) DO UPDATE SET
      ${CAMPOS.filter((c) => c !== 'chave').map((c) => `${c} = excluded.${c}`).join(',\n      ')}
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
