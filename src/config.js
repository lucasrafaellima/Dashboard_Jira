// Configuracao da conexao com o Jira.
// Duas fontes, nessa ordem de prioridade:
//   1. variaveis de ambiente (inclusive as do arquivo .env na raiz)
//   2. config/jira.json — gravado pela tela de configuracao do dashboard
// O token nunca sai daqui: `configPublica()` devolve so uma mascara.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const ARQUIVO_ENV = join(RAIZ, '.env');
export const ARQUIVO_CONFIG = process.env.JIRA_CONFIG || join(RAIZ, 'config', 'jira.json');

// carrega o .env uma unica vez, se existir (nao sobrescreve variaveis ja definidas)
if (existsSync(ARQUIVO_ENV)) {
  try {
    process.loadEnvFile(ARQUIVO_ENV);
  } catch (e) {
    console.warn(`Aviso: nao consegui ler o .env (${e.message}).`);
  }
}

const PADRAO = {
  url: '',
  email: '',
  token: '',
  projetos: [],
  jql: '',
  intervaloMinutos: 0,
  maxIssues: 20000,
};

function lerArquivo() {
  try {
    return JSON.parse(readFileSync(ARQUIVO_CONFIG, 'utf8'));
  } catch {
    return {};
  }
}

function lista(valor) {
  if (Array.isArray(valor)) return valor.map((v) => String(v).trim()).filter(Boolean);
  return String(valor ?? '')
    .split(/[,;|\s]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function inteiro(valor, padrao) {
  const n = Number(valor);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : padrao;
}

/** Normaliza a URL do site: sem barra final, com https:// se faltar o esquema. */
export function normalizarUrl(url) {
  const s = String(url ?? '').trim().replace(/\/+$/, '');
  if (!s) return '';
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

/** Configuracao efetiva (com token). Uso interno do servidor. */
export function lerConfig() {
  const arq = lerArquivo();
  const env = process.env;
  const cfg = {
    url: normalizarUrl(env.JIRA_URL || arq.url || PADRAO.url),
    email: String(env.JIRA_EMAIL || arq.email || PADRAO.email).trim(),
    token: String(env.JIRA_TOKEN || arq.token || PADRAO.token).trim(),
    projetos: lista(env.JIRA_PROJETOS ?? arq.projetos ?? PADRAO.projetos),
    jql: String(env.JIRA_JQL || arq.jql || PADRAO.jql).trim(),
    intervaloMinutos: inteiro(env.JIRA_INTERVALO_MIN ?? arq.intervaloMinutos, PADRAO.intervaloMinutos),
    maxIssues: inteiro(env.JIRA_MAX_ISSUES ?? arq.maxIssues, PADRAO.maxIssues) || PADRAO.maxIssues,
  };
  cfg.configurado = Boolean(cfg.url && cfg.token);
  // de onde veio cada valor — ajuda a explicar por que a tela nao consegue editar
  cfg.travadoPorEnv = {
    url: Boolean(env.JIRA_URL),
    email: Boolean(env.JIRA_EMAIL),
    token: Boolean(env.JIRA_TOKEN),
    projetos: env.JIRA_PROJETOS != null,
    jql: Boolean(env.JIRA_JQL),
    intervaloMinutos: env.JIRA_INTERVALO_MIN != null,
  };
  return cfg;
}

/** Versao segura para mandar ao navegador — token vira mascara. */
export function configPublica() {
  const { token, ...resto } = lerConfig();
  return {
    ...resto,
    temToken: Boolean(token),
    tokenMascarado: token ? `${'•'.repeat(Math.max(token.length - 4, 4))}${token.slice(-4)}` : '',
    arquivoConfig: ARQUIVO_CONFIG,
  };
}

/**
 * Grava (mesclando) o que veio da tela em config/jira.json.
 * Campo ausente ou string vazia mantem o valor anterior — assim da para salvar
 * a configuracao sem redigitar o token toda vez.
 */
export function salvarConfig(parcial = {}) {
  const atual = lerArquivo();
  const novo = { ...atual };

  if (parcial.url != null) novo.url = normalizarUrl(parcial.url);
  if (parcial.email != null) novo.email = String(parcial.email).trim();
  if (parcial.token) novo.token = String(parcial.token).trim();
  if (parcial.token === '') delete novo.token;
  if (parcial.projetos != null) novo.projetos = lista(parcial.projetos);
  if (parcial.jql != null) novo.jql = String(parcial.jql).trim();
  if (parcial.intervaloMinutos != null) novo.intervaloMinutos = inteiro(parcial.intervaloMinutos, 0);
  if (parcial.maxIssues != null) novo.maxIssues = inteiro(parcial.maxIssues, PADRAO.maxIssues);

  mkdirSync(dirname(ARQUIVO_CONFIG), { recursive: true });
  writeFileSync(ARQUIVO_CONFIG, `${JSON.stringify(novo, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return configPublica();
}
