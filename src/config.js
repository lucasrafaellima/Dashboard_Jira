// Configuracao da conexao com o Jira.
// Tres fontes, nessa ordem de prioridade:
//   1. variaveis do ambiente de verdade (shell, servico, docker)
//   2. arquivo .env na raiz — relido a cada consulta, sem reiniciar o servidor
//   3. config/jira.json — gravado pela tela de configuracao do dashboard
// O token nunca sai daqui: `configPublica()` devolve so uma mascara.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const ARQUIVO_ENV = join(RAIZ, '.env');
export const ARQUIVO_CONFIG = process.env.JIRA_CONFIG || join(RAIZ, 'config', 'jira.json');

// Fotografia do ambiente ANTES de carregar o .env: so o que veio de fora
// (shell, servico, docker) tem prioridade sobre o arquivo. Precisa ser tirada
// aqui em cima, antes do loadEnvFile abaixo misturar as duas coisas.
const ENV_DO_SISTEMA = { ...process.env };

// Publica o .env no process.env para quem le direto de la (PORT, HOST, DB_PATH).
// Trocar um desses ainda pede reinicio; a configuracao do Jira, nao — ela passa
// por `valorDoAmbiente()`, que rele o arquivo sempre que ele muda.
if (existsSync(ARQUIVO_ENV)) {
  try {
    process.loadEnvFile(ARQUIVO_ENV);
  } catch (e) {
    console.warn(`Aviso: nao consegui ler o .env (${e.message}).`);
  }
}

// ------------------------------------------------------------ .env ao vivo

/**
 * Le "CHAVE=valor" linha a linha. Aceita comentarios, `export` na frente e
 * valores entre aspas. Nao expande variaveis — o .env daqui guarda texto puro.
 */
function interpretarEnv(texto) {
  const valores = {};
  for (const linha of String(texto).split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(linha);
    if (!m) continue;
    let valor = m[2].trim();
    const aspas = /^(['"])([\s\S]*)\1$/.exec(valor);
    if (aspas) valor = aspas[2];
    else valor = valor.replace(/\s+#.*$/, '').trim(); // comentario no fim da linha
    valores[m[1]] = valor;
  }
  return valores;
}

// releitura preguicosa: so reprocessa o arquivo quando a data/tamanho mudam
let cacheEnv = { assinatura: null, valores: {} };

function envDoArquivo() {
  let info;
  try {
    info = statSync(ARQUIVO_ENV);
  } catch {
    cacheEnv = { assinatura: null, valores: {} };
    return cacheEnv.valores;
  }
  const assinatura = `${info.mtimeMs}:${info.size}`;
  if (assinatura !== cacheEnv.assinatura) {
    try {
      cacheEnv = { assinatura, valores: interpretarEnv(readFileSync(ARQUIVO_ENV, 'utf8')) };
    } catch (e) {
      console.warn(`Aviso: nao consegui reler o .env (${e.message}).`);
      cacheEnv = { assinatura, valores: {} };
    }
  }
  return cacheEnv.valores;
}

/**
 * Valor de uma variavel: ambiente de verdade primeiro, depois o .env atual.
 * Vale a presenca da chave, nao o conteudo — "JIRA_PROJETOS=" (vazio) continua
 * significando "todos os projetos visiveis", como antes.
 */
function valorDoAmbiente(nome) {
  if (Object.hasOwn(ENV_DO_SISTEMA, nome)) return ENV_DO_SISTEMA[nome];
  const doArquivo = envDoArquivo();
  return Object.hasOwn(doArquivo, nome) ? doArquivo[nome] : undefined;
}

/** Espelho de `process.env` para a configuracao do Jira, com o .env sempre atual. */
function ambiente() {
  const nomes = [
    'JIRA_URL', 'JIRA_EMAIL', 'JIRA_TOKEN', 'JIRA_PROJETOS', 'JIRA_JQL',
    'JIRA_INTERVALO_MIN', 'JIRA_MAX_ISSUES', 'JIRA_PAUSA_MS',
  ];
  const env = {};
  for (const n of nomes) {
    const v = valorDoAmbiente(n);
    if (v !== undefined) env[n] = v;
  }
  return env;
}

const PADRAO = {
  url: '',
  email: '',
  token: '',
  projetos: [],
  jql: '',
  intervaloMinutos: 0,
  // limite de issues por projeto em cada passada; o que sobrar vem na proxima
  maxIssues: 20000,
  // pausa entre um projeto e o proximo, para nao esbarrar no limite do Jira
  pausaMs: 400,
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
  const env = ambiente();
  const cfg = {
    url: normalizarUrl(env.JIRA_URL || arq.url || PADRAO.url),
    email: String(env.JIRA_EMAIL || arq.email || PADRAO.email).trim(),
    token: String(env.JIRA_TOKEN || arq.token || PADRAO.token).trim(),
    projetos: lista(env.JIRA_PROJETOS ?? arq.projetos ?? PADRAO.projetos),
    jql: String(env.JIRA_JQL || arq.jql || PADRAO.jql).trim(),
    intervaloMinutos: inteiro(env.JIRA_INTERVALO_MIN ?? arq.intervaloMinutos, PADRAO.intervaloMinutos),
    maxIssues: inteiro(env.JIRA_MAX_ISSUES ?? arq.maxIssues, PADRAO.maxIssues) || PADRAO.maxIssues,
    pausaMs: inteiro(env.JIRA_PAUSA_MS ?? arq.pausaMs, PADRAO.pausaMs),
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
  if (parcial.pausaMs != null) novo.pausaMs = inteiro(parcial.pausaMs, PADRAO.pausaMs);

  mkdirSync(dirname(ARQUIVO_CONFIG), { recursive: true });
  writeFileSync(ARQUIVO_CONFIG, `${JSON.stringify(novo, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return configPublica();
}
