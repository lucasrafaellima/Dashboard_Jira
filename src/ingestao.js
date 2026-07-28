// Ingestao: recebe o conteudo de um .xlsx ou .csv exportado do Jira,
// descobre a aba certa, mapeia os cabecalhos e grava no banco.
import { createHash } from 'node:crypto';
import { lerPlanilhas } from './xlsx.js';
import {
  campoDoCabecalho, normalizarLinha, CAMPOS_OBRIGATORIOS,
} from './normalizar.js';
import { gravarItens, registrarImportacao, jaImportado } from './banco.js';

// ------------------------------------------------------------ CSV

function detectarSeparador(cabecalho) {
  const cand = [';', ',', '\t'];
  let melhor = ';';
  let max = -1;
  for (const c of cand) {
    const n = cabecalho.split(c).length;
    if (n > max) { max = n; melhor = c; }
  }
  return melhor;
}

/** Parser de CSV com aspas duplas escapadas (""), CRLF e BOM. */
function lerCsv(texto) {
  const limpo = texto.replace(/^﻿/, '');
  const primeiraLinha = limpo.slice(0, limpo.indexOf('\n') === -1 ? limpo.length : limpo.indexOf('\n'));
  const sep = detectarSeparador(primeiraLinha);

  const linhas = [];
  let campo = '';
  let atual = [];
  let aspas = false;

  for (let i = 0; i < limpo.length; i++) {
    const c = limpo[i];
    if (aspas) {
      if (c === '"') {
        if (limpo[i + 1] === '"') { campo += '"'; i++; } else aspas = false;
      } else campo += c;
      continue;
    }
    if (c === '"') { aspas = true; continue; }
    if (c === sep) { atual.push(campo); campo = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { atual.push(campo); linhas.push(atual); atual = []; campo = ''; continue; }
    campo += c;
  }
  if (campo !== '' || atual.length) { atual.push(campo); linhas.push(atual); }
  return linhas.map((l) => l.map((v) => v.trim()));
}

// ------------------------------------------------------------ escolha da aba

/** Acha a linha de cabecalho (entre as 10 primeiras) e o mapa coluna->campo. */
function analisarCabecalho(linhas) {
  const limite = Math.min(10, linhas.length);
  let melhor = null;

  for (let i = 0; i < limite; i++) {
    const linha = linhas[i] || [];
    const mapa = new Map();
    for (let c = 0; c < linha.length; c++) {
      const campo = campoDoCabecalho(linha[c]);
      if (campo && !mapa.has(campo)) mapa.set(campo, c);
    }
    if (!CAMPOS_OBRIGATORIOS.every((f) => mapa.has(f))) continue;
    if (!melhor || mapa.size > melhor.mapa.size) melhor = { linhaCabecalho: i, mapa };
  }
  return melhor;
}

/** Entre todas as abas, escolhe a que tem os cabecalhos da base e mais linhas. */
function escolherAba(abas, nomePreferido) {
  const candidatas = [];
  for (const aba of abas) {
    const cab = analisarCabecalho(aba.linhas);
    if (!cab) continue;
    const dados = aba.linhas.length - cab.linhaCabecalho - 1;
    candidatas.push({ ...aba, ...cab, dados });
  }
  if (!candidatas.length) return null;
  if (nomePreferido) {
    const escolhida = candidatas.find((c) => c.nome === nomePreferido);
    if (escolhida) return escolhida;
  }
  candidatas.sort((a, b) => b.mapa.size - a.mapa.size || b.dados - a.dados);
  return candidatas[0];
}

// ------------------------------------------------------------ API

/**
 * Processa o conteudo de um arquivo e grava no banco.
 * @param {Buffer} conteudo
 * @param {string} nomeArquivo
 * @param {{aba?:string, forcar?:boolean}} opcoes
 */
export function importarArquivo(conteudo, nomeArquivo, opcoes = {}) {
  const hash = createHash('sha256').update(conteudo).digest('hex').slice(0, 16);

  if (!opcoes.forcar) {
    const anterior = jaImportado(hash);
    if (anterior) {
      return {
        arquivo: nomeArquivo, aba: anterior.aba, hash, duplicado: true,
        linhas: 0, novos: 0, atualizados: 0, ignorados: 0,
        aviso: `Conteúdo idêntico já importado em ${anterior.importado_em} (${anterior.arquivo}).`,
      };
    }
  }

  const ehCsv = /\.csv$/i.test(nomeArquivo);
  const abas = ehCsv
    ? [{ nome: nomeArquivo, oculta: false, linhas: lerCsv(conteudo.toString('utf8')) }]
    : lerPlanilhas(conteudo);

  const aba = escolherAba(abas, opcoes.aba);
  if (!aba) {
    const nomes = abas.map((a) => a.nome).join(', ') || '(nenhuma)';
    throw new Error(
      `Nenhuma aba com o formato da base unificada foi encontrada em "${nomeArquivo}". ` +
      `Abas lidas: ${nomes}. São necessárias ao menos as colunas "Chave da item" e "Status".`,
    );
  }

  const registros = [];
  let descartados = 0;
  for (let i = aba.linhaCabecalho + 1; i < aba.linhas.length; i++) {
    const linha = aba.linhas[i];
    if (!linha || !linha.length) continue;
    const bruto = {};
    for (const [campo, col] of aba.mapa) bruto[campo] = linha[col] ?? '';
    const registro = normalizarLinha(bruto);
    if (registro) registros.push(registro);
    else if (linha.some((v) => String(v ?? '').trim())) descartados++;
  }

  if (!registros.length) {
    throw new Error(`A aba "${aba.nome}" de "${nomeArquivo}" não tem nenhuma linha válida (com "Chave da item").`);
  }

  const r = gravarItens(registros, nomeArquivo);
  const resultado = {
    arquivo: nomeArquivo,
    aba: aba.nome,
    hash,
    duplicado: false,
    linhas: registros.length,
    novos: r.novos,
    atualizados: r.atualizados,
    ignorados: r.ignorados + descartados,
    colunasReconhecidas: [...aba.mapa.keys()],
  };
  registrarImportacao(resultado);
  return resultado;
}
