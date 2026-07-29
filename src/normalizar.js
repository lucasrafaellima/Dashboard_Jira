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

// Cada projeto do Jira tem o seu proprio workflow, entao o mesmo conceito chega
// escrito de varios jeitos: "Feito", "FECHADO" e "Concluido" sao a mesma coisa,
// assim como "A fazer" e "A Fazer". A tabela abaixo reduz tudo a um conjunto
// pequeno de rotulos canonicos, cada um com a sua categoria macro.
//
// O nome original de cada item continua guardado na coluna `status_origem`, e
// aparece na tabela de padronizacao do dashboard — nada e perdido.

export const CATEGORIAS = ['A fazer', 'Em andamento', 'Concluído', 'Cancelado'];

const STATUS_CANONICO = new Map();

function padronizarStatus(rotulo, categoria, ...variantes) {
  const destino = { rotulo, categoria };
  STATUS_CANONICO.set(chaveComparacao(rotulo), destino);
  for (const v of variantes) STATUS_CANONICO.set(chaveComparacao(v), destino);
}

padronizarStatus('A fazer', 'A fazer',
  'A Fazer', 'Tarefas pendentes', 'Backlog', 'To Do', 'Aberto', 'Open', 'Novo', 'New', 'Pendente');

padronizarStatus('Em andamento', 'Em andamento',
  'Fazendo', 'In Progress', 'Em desenvolvimento', 'Em execução', 'Doing');

padronizarStatus('Em análise', 'Em andamento',
  'Em análise (QA)', 'Em analise QA', 'Em revisão', 'In Review', 'Code Review', 'Em homologação', 'Em teste');

padronizarStatus('Aguardando', 'Em andamento',
  'Aguardando pelo suporte', 'Esperando ação externa', 'PAUSADO', 'Estacionamento',
  'Waiting', 'Waiting for support', 'On Hold', 'Em espera', 'Bloqueado', 'Blocked', 'Impedido');

padronizarStatus('Escalado', 'Em andamento', 'ESCALADO', 'Escalated');

padronizarStatus('Concluído', 'Concluído',
  'Feito', 'FECHADO', 'Fechado', 'Concluido', 'Concluída', 'Resolvido', 'Pronto',
  'Done', 'Closed', 'Resolved', 'Complete', 'Completed');

padronizarStatus('Cancelado', 'Cancelado',
  'Cancelada', 'Cancelled', 'Canceled', 'Descartado', 'Rejeitado', 'Rejected', 'Duplicado');

/** Categorias da API do Jira (campo status.statusCategory.key). */
const CATEGORIA_API = { new: 'A fazer', indeterminate: 'Em andamento', done: 'Concluído' };

/**
 * Reduz um status a { rotulo, categoria } canonicos.
 * Status desconhecido mantem o proprio nome e usa a categoria que a API informou
 * — assim um workflow novo nao some do dashboard nem e classificado errado.
 * @param {string} status nome do status como veio do Jira
 * @param {string} [categoriaApi] "new" | "indeterminate" | "done"
 */
export function canonizarStatus(status, categoriaApi) {
  const bruto = String(status ?? '').trim();
  const conhecido = STATUS_CANONICO.get(chaveComparacao(bruto));
  if (conhecido) return { ...conhecido, padronizado: true };
  return {
    rotulo: bruto || 'Sem status',
    categoria: CATEGORIA_API[String(categoriaApi ?? '').toLowerCase()] ?? 'Outros',
    padronizado: false,
  };
}

export function categoriaStatus(status, categoriaApi) {
  return canonizarStatus(status, categoriaApi).categoria;
}

/**
 * Uma atividade conta como concluida quando a categoria dela e "Concluído",
 * independente do nome que o projeto de origem usa.
 * Cancelados ficam de fora por padrao: nao foram entregues, so encerrados.
 * @param {string} status status (canonico ou bruto)
 * @param {boolean} [incluirCancelados] soma tambem os cancelados
 */
export function ehConcluida(status, incluirCancelados = false) {
  const c = categoriaStatus(status);
  return c === 'Concluído' || (incluirCancelados && c === 'Cancelado');
}

// ------------------------------------------------------------ prioridade

const PRIORIDADE_CANONICA = new Map();
function padronizarPrioridade(rotulo, ...variantes) {
  PRIORIDADE_CANONICA.set(chaveComparacao(rotulo), rotulo);
  for (const v of variantes) PRIORIDADE_CANONICA.set(chaveComparacao(v), rotulo);
}
padronizarPrioridade('Altíssima', 'Highest', 'Crítica', 'Critical', 'Blocker', 'Altissima', 'Urgente');
padronizarPrioridade('Alta', 'High', 'Major');
padronizarPrioridade('Média', 'Medium', 'Normal', 'Media');
padronizarPrioridade('Baixa', 'Low', 'Minor');
padronizarPrioridade('Baixíssima', 'Lowest', 'Trivial', 'Baixissima');

/** Ordem para os graficos, da mais urgente para a menos. */
export const ORDEM_PRIORIDADE = ['Altíssima', 'Alta', 'Média', 'Baixa', 'Baixíssima', 'Sem prioridade'];

export function normalizarPrioridade(prioridade) {
  const s = String(prioridade ?? '').trim();
  if (!s) return 'Sem prioridade';
  return PRIORIDADE_CANONICA.get(chaveComparacao(s)) ?? s;
}

// ------------------------------------------------------------ resolucao

const RESOLUCAO_CANONICA = new Map();
function padronizarResolucao(rotulo, ...variantes) {
  RESOLUCAO_CANONICA.set(chaveComparacao(rotulo), rotulo);
  for (const v of variantes) RESOLUCAO_CANONICA.set(chaveComparacao(v), rotulo);
}
padronizarResolucao('Concluído', 'Itens concluídos', 'Itens concluidos', 'Done', 'Feito', 'Resolvido', 'Resolved', 'Pronto', 'Fixed');
padronizarResolucao('Não será feito', "Won't Do", 'Nao vai ser feito', 'Não vai ser feito', "Won't Fix", 'Descartado', 'Declined');
padronizarResolucao('Duplicado', 'Duplicate', 'Duplicada', 'Duplicate Issue');
padronizarResolucao('Sem solução', 'Cannot Reproduce', 'Não reproduzível', 'Incompleto', 'Incomplete', 'Inconclusivo');

/** Resolucoes que significam "encerrado sem entregar" — nao contam como concluida. */
const RESOLUCAO_NAO_ENTREGUE = new Set(['Não será feito', 'Duplicado', 'Sem solução']);

export function normalizarResolucao(resolucao) {
  const s = String(resolucao ?? '').trim();
  if (!s) return '';
  return RESOLUCAO_CANONICA.get(chaveComparacao(s)) ?? s;
}

export function ehResolucaoNaoEntregue(resolucao) {
  return RESOLUCAO_NAO_ENTREGUE.has(normalizarResolucao(resolucao));
}

// ------------------------------------------------------------ espacos

// Rotulos canonicos dos espacos/produtos. A coluna "Origem" ora traz o nome do
// espaco, ora o nome do arquivo csv de onde a linha veio — os dois caem aqui.
const APELIDO_ESPACO = new Map();
function apelidar(canonico, ...apelidos) {
  APELIDO_ESPACO.set(chaveComparacao(canonico), canonico);
  for (const a of apelidos) APELIDO_ESPACO.set(chaveComparacao(a), canonico);
}
// "Overflow" continua na lista de apelidos porque planilhas e bases antigas
// gravaram o espaco com esse nome errado — todas caem no rotulo certo.
apelidar('Workflow(Kestra)', 'Workflow', 'Overflow', 'Overflow(Kestra)', 'Davi', 'status-davi-25-07.csv', 'WIK');
apelidar('CRM Loja', 'CRM Loja/Campo', 'status-crm-loja-campo-25-07.csv', 'CRM');
apelidar('HUB', 'Hub', 'status-hub-25-07.csv');
apelidar('HUB Configurador', 'Hub Configurador', 'status-hub-configurador-25-07.csv', 'HC');
apelidar('Coagro Work', 'status-coagro-work-25-07.csv', 'GCW');
apelidar('NWE', 'status-nwe-25-07.csv');
apelidar('APP Receituário', 'APP Receituario', 'App Receituário', 'AR', 'status-app-receituario-25-07.csv');

/** Rotulo canonico se o texto for um apelido conhecido de espaco; senao null. */
export function apelidoEspaco(valor) {
  const s = String(valor ?? '').trim();
  return s ? APELIDO_ESPACO.get(chaveComparacao(s)) ?? null : null;
}

/**
 * Rotulo do espaco para dados vindos da API: apelido da chave do projeto,
 * apelido do nome, ou o proprio nome. Usado tanto na sincronizacao quanto na
 * repadronizacao da base, para os dois nunca discordarem.
 */
export function espacoDoProjeto(chaveProjeto, nomeProjeto) {
  return apelidoEspaco(chaveProjeto)
    ?? apelidoEspaco(nomeProjeto)
    ?? (String(nomeProjeto ?? '').trim() || String(chaveProjeto ?? '').trim() || 'Sem espaço');
}

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
    'sub task': 'Subtarefa',
    subtarefa: 'Subtarefa',
    'sub tarefa': 'Subtarefa',
    task: 'Tarefa',
    tarefa: 'Tarefa',
    story: 'História',
    historia: 'História',
    bug: 'Bug',
    defect: 'Bug',
    epic: 'Epic',
    epico: 'Epic',
    funcao: 'Função',
    // Jira Service Management, que responde pela maior parte da base
    'service request': 'Solicitação de Serviço',
    'solicitacao de servico': 'Solicitação de Serviço',
    'service request with approvals': 'Solicitação de Serviço (Aprovação)',
    'solicitacao de servico aprovacao': 'Solicitação de Serviço (Aprovação)',
    incident: 'Incidente ou Interrupções',
    incidente: 'Incidente ou Interrupções',
    'incidente ou interrupcoes': 'Incidente ou Interrupções',
    problem: 'Problema',
    problema: 'Problema',
    change: 'Mudança',
    mudanca: 'Mudança',
    idea: 'Ideia',
    ideia: 'Ideia',
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
 *
 * O status e a resolucao passam pela padronizacao: o nome original fica em
 * `status_origem` e o rotulo unificado em `status`. Quando a resolucao diz que o
 * item foi encerrado sem entregar ("Won't Do", duplicado...), ele vira Cancelado
 * mesmo que o workflow o tenha marcado como fechado.
 */
export function normalizarLinha(bruto) {
  const chave = String(bruto.chave ?? '').trim().toUpperCase();
  if (!chave || !/^[A-Z][A-Z0-9]*-\d+$/.test(chave)) return null;

  const statusOrigem = String(bruto.status ?? '').trim() || 'Sem status';
  const origem = String(bruto.origem ?? '').trim();
  const projeto = String(bruto.projeto ?? '').trim();

  const resolucao = normalizarResolucao(bruto.resolucao);
  let { rotulo: status, categoria } = canonizarStatus(statusOrigem, bruto.categoria_api);
  if (categoria === 'Concluído' && ehResolucaoNaoEntregue(resolucao)) {
    status = 'Cancelado';
    categoria = 'Cancelado';
  }

  return {
    chave,
    tipo_item: normalizarTipo(bruto.tipo_item),
    id_item: String(bruto.id_item ?? '').trim(),
    resumo: String(bruto.resumo ?? '').trim(),
    responsavel: normalizarPessoa(bruto.responsavel),
    id_responsavel: String(bruto.id_responsavel ?? '').trim(),
    relator: normalizarPessoa(bruto.relator),
    id_relator: String(bruto.id_relator ?? '').trim(),
    prioridade: normalizarPrioridade(bruto.prioridade),
    status,
    status_origem: statusOrigem,
    status_categoria: categoria,
    resolucao,
    criado: normalizarData(bruto.criado),
    atualizado: normalizarData(bruto.atualizado),
    data_limite: normalizarData(bruto.data_limite),
    projeto,
    origem,
    espaco: normalizarEspaco(origem, projeto, chave),
  };
}
