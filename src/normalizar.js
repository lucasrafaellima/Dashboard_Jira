// Regras de formatacao/normalizacao dos dados, baseadas no layout do
// arquivo "base_unificada_copia.xlsx" (export do Jira + coluna Origem).

/** As 16 colunas da base unificada, na ordem, com o campo interno correspondente. */
export const COLUNAS = [
  { titulo: 'Tipo de item', campo: 'tipo_item' },
  { titulo: 'Chave da item', campo: 'chave' },
  { titulo: 'ID da item', campo: 'id_item' },
  { titulo: 'Resumo', campo: 'resumo' },
  { titulo: 'Responsável', campo: 'responsavel' },
  { titulo: 'ID do responsável', campo: 'id_responsavel' },
  { titulo: 'Relator', campo: 'relator' },
  { titulo: 'ID do relator', campo: 'id_relator' },
  { titulo: 'Prioridade', campo: 'prioridade' },
  { titulo: 'Status', campo: 'status' },
  { titulo: 'Resolução', campo: 'resolucao' },
  { titulo: 'Criado', campo: 'criado' },
  { titulo: 'Atualizado(a)', campo: 'atualizado' },
  { titulo: 'Data limite', campo: 'data_limite' },
  { titulo: 'Projeto', campo: 'projeto' },
  { titulo: 'Origem', campo: 'origem' },
];

export const CAMPOS_OBRIGATORIOS = ['chave', 'status'];

/** minusculo, sem acento e sem pontuacao — usado para casar cabecalhos e apelidos. */
export function chaveComparacao(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const POR_TITULO = new Map(COLUNAS.map((c) => [chaveComparacao(c.titulo), c.campo]));
// variacoes toleradas de cabecalho
for (const [alias, campo] of [
  ['chave do item', 'chave'],
  ['chave', 'chave'],
  ['id do item', 'id_item'],
  ['atualizado', 'atualizado'],
  ['atualizada', 'atualizado'],
  ['tipo do item', 'tipo_item'],
  ['tipo de problema', 'tipo_item'],
  ['espaco', 'origem'],
  ['prazo', 'data_limite'],
]) POR_TITULO.set(chaveComparacao(alias), campo);

/** Mapeia um cabecalho da planilha para o campo interno (ou null). */
export function campoDoCabecalho(titulo) {
  return POR_TITULO.get(chaveComparacao(titulo)) ?? null;
}

// ------------------------------------------------------------ datas

const RE_ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/;
const RE_BR = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/;
const MESES_PT = {
  jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6,
  jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12,
};
const RE_EXTENSO = /^(\d{1,2})\s+de\s+([a-zç]{3})[a-zç]*\.?\s+de\s+(\d{4})(?:,?\s+(\d{1,2}):(\d{2}))?/i;

/**
 * Normaliza qualquer formato de data encontrado nas planilhas para
 * "YYYY-MM-DDTHH:MM:SS". Aceita ISO, dd/mm/aaaa, "26 de jun. de 2026, 10:28"
 * e serial numerico do Excel. Devolve null quando vazio/invalido.
 */
export function normalizarData(valor) {
  if (valor == null) return null;
  const s = String(valor).trim();
  if (!s) return null;

  const p = (n, t = 2) => String(n).padStart(t, '0');
  const montar = (a, me, d, h = 0, mi = 0, sg = 0) =>
    `${p(a, 4)}-${p(me)}-${p(d)}T${p(h)}:${p(mi)}:${p(sg)}`;

  let m = RE_ISO.exec(s);
  if (m) return montar(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));

  m = RE_BR.exec(s);
  if (m) {
    let ano = +m[3];
    if (ano < 100) ano += ano < 70 ? 2000 : 1900;
    return montar(ano, +m[2], +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  }

  m = RE_EXTENSO.exec(s);
  if (m) {
    const mes = MESES_PT[m[2].toLowerCase().slice(0, 3)];
    if (mes) return montar(+m[3], mes, +m[1], +(m[4] || 0), +(m[5] || 0));
  }

  // serial do Excel em celula sem formato de data
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n > 20000 && n < 80000) {
      const d = new Date(Math.round((n - 25569) * 86400000));
      if (!Number.isNaN(d.getTime())) {
        return montar(
          d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(),
          d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(),
        );
      }
    }
  }
  return null;
}

// ------------------------------------------------------------ status

export const SEM_RESPONSAVEL = '(vazio)';

/** Categoria macro do status (para o funil A fazer / Em andamento / Concluido). */
const CATEGORIA_STATUS = new Map(
  Object.entries({
    'a fazer': 'A fazer',
    'tarefas pendentes': 'A fazer',
    backlog: 'A fazer',
    'em andamento': 'Em andamento',
    fazendo: 'Em andamento',
    'em analise qa': 'Em andamento',
    'em analise': 'Em andamento',
    'esperando acao externa': 'Em andamento',
    'em revisao': 'Em andamento',
    feito: 'Concluído',
    concluido: 'Concluído',
    cancelado: 'Cancelado',
  }),
);

export function categoriaStatus(status) {
  return CATEGORIA_STATUS.get(chaveComparacao(status)) ?? 'Outros';
}

/**
 * Status contados como "concluida".
 * Padrao = apenas "Feito", que reproduz exatamente os numeros do
 * DashBoard_Jira de referencia (188 concluidas / 65,28%).
 * Modo amplo = todo status cuja categoria e "Concluido" (inclui "Concluído").
 */
export const STATUS_CONCLUIDO_PADRAO = ['Feito'];

export function ehConcluida(status, amplo = false) {
  if (amplo) return categoriaStatus(status) === 'Concluído';
  return STATUS_CONCLUIDO_PADRAO.some((s) => chaveComparacao(s) === chaveComparacao(status));
}

// ------------------------------------------------------------ espacos

// Rotulos canonicos dos espacos/produtos. A coluna "Origem" ora traz o nome do
// espaco, ora o nome do arquivo csv de onde a linha veio — os dois caem aqui.
const APELIDO_ESPACO = new Map();
function apelidar(canonico, ...apelidos) {
  APELIDO_ESPACO.set(chaveComparacao(canonico), canonico);
  for (const a of apelidos) APELIDO_ESPACO.set(chaveComparacao(a), canonico);
}
apelidar('Overflow(Kestra)', 'Overflow', 'Workflow(Kestra)', 'Davi', 'status-davi-25-07.csv', 'WIK');
apelidar('CRM Loja', 'CRM Loja/Campo', 'status-crm-loja-campo-25-07.csv', 'CRM');
apelidar('HUB', 'Hub', 'status-hub-25-07.csv');
apelidar('HUB Configurador', 'Hub Configurador', 'status-hub-configurador-25-07.csv', 'HC');
apelidar('Coagro Work', 'status-coagro-work-25-07.csv', 'GCW');
apelidar('NWE', 'status-nwe-25-07.csv');
apelidar('APP Receituário', 'APP Receituario', 'App Receituário', 'AR', 'status-app-receituario-25-07.csv');

function titulo(s) {
  return s
    .split(/\s+/)
    .map((p) => (p.length <= 3 && p === p.toUpperCase() ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(' ');
}

/** Rotulo canonico do espaco a partir de Origem / Projeto / Chave. */
export function normalizarEspaco(origem, projeto, chave) {
  for (const bruto of [origem, projeto]) {
    const s = String(bruto ?? '').trim();
    if (!s) continue;
    const conhecido = APELIDO_ESPACO.get(chaveComparacao(s));
    if (conhecido) return conhecido;
    // nome de arquivo desconhecido: "status-algo-25-07.csv" -> "Algo"
    const arq = /^status[-_](.+?)([-_]\d{2}[-_]\d{2})?\.(csv|xlsx)$/i.exec(s);
    if (arq) return titulo(arq[1].replace(/[-_]+/g, ' '));
    return s;
  }
  const prefixo = String(chave ?? '').split('-')[0];
  const porPrefixo = APELIDO_ESPACO.get(chaveComparacao(prefixo));
  return porPrefixo ?? (prefixo || 'Sem espaço');
}

// ------------------------------------------------------------ pessoas / tipos

const APELIDO_TIPO = new Map(
  Object.entries({
    subtask: 'Subtarefa',
    subtarefa: 'Subtarefa',
    'sub tarefa': 'Subtarefa',
    task: 'Tarefa',
    tarefa: 'Tarefa',
    story: 'História',
    historia: 'História',
    bug: 'Bug',
    epic: 'Epic',
    epico: 'Epic',
    funcao: 'Função',
  }),
);

export function normalizarTipo(tipo) {
  const s = String(tipo ?? '').trim();
  if (!s) return 'Sem tipo';
  return APELIDO_TIPO.get(chaveComparacao(s)) ?? s;
}

/** Nome de pessoa; ausencia (celula vazia ou "Sem responsável") vira "(vazio)". */
export function normalizarPessoa(nome) {
  const s = String(nome ?? '').trim();
  if (!s) return SEM_RESPONSAVEL;
  const k = chaveComparacao(s);
  if (k === 'sem responsavel' || k === 'nao atribuido' || k === 'unassigned' || k === 'vazio') {
    return SEM_RESPONSAVEL;
  }
  return s;
}

/**
 * Converte uma linha crua (objeto campo->valor) no registro final gravado no banco.
 * Devolve null se a linha nao tiver chave.
 */
export function normalizarLinha(bruto) {
  const chave = String(bruto.chave ?? '').trim().toUpperCase();
  if (!chave || !/^[A-Z][A-Z0-9]*-\d+$/.test(chave)) return null;

  const status = String(bruto.status ?? '').trim() || 'Sem status';
  const origem = String(bruto.origem ?? '').trim();
  const projeto = String(bruto.projeto ?? '').trim();

  return {
    chave,
    tipo_item: normalizarTipo(bruto.tipo_item),
    id_item: String(bruto.id_item ?? '').trim(),
    resumo: String(bruto.resumo ?? '').trim(),
    responsavel: normalizarPessoa(bruto.responsavel),
    id_responsavel: String(bruto.id_responsavel ?? '').trim(),
    relator: normalizarPessoa(bruto.relator),
    id_relator: String(bruto.id_relator ?? '').trim(),
    prioridade: String(bruto.prioridade ?? '').trim() || 'Sem prioridade',
    status,
    status_categoria: categoriaStatus(status),
    resolucao: String(bruto.resolucao ?? '').trim(),
    criado: normalizarData(bruto.criado),
    atualizado: normalizarData(bruto.atualizado),
    data_limite: normalizarData(bruto.data_limite),
    projeto,
    origem,
    espaco: normalizarEspaco(origem, projeto, chave),
  };
}
