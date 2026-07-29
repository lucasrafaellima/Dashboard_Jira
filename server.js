// Servidor HTTP do dashboard — node:http puro, sem dependencias.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  conectar, listarImportacoes, removerImportacao, limparTudo, contarItens,
  listarSincronizacoes, removerSincronizacao,
} from './src/banco.js';
import { importarArquivo } from './src/ingestao.js';
import { montarDashboard, listarDetalhe } from './src/metricas.js';
import { lerConfig, configPublica, salvarConfig } from './src/config.js';
import { verificarConexao, listarProjetos } from './src/jira.js';
import { sincronizar } from './src/sincronizacao.js';

const RAIZ = dirname(fileURLToPath(import.meta.url));
const PUBLICO = join(RAIZ, 'public');
const PASTA_DADOS = join(RAIZ, 'data');
const PORTA = Number(process.env.PORT) || 3000;
// o servidor guarda o token do Jira, entao por padrao so escuta na propria
// maquina. Para expor na rede local: HOST=0.0.0.0 npm start
const HOST = process.env.HOST || '127.0.0.1';
const LIMITE_UPLOAD = 40 * 1024 * 1024;

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res, status, corpo) {
  const texto = JSON.stringify(corpo);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(texto),
    'Cache-Control': 'no-store',
  });
  res.end(texto);
}

function corpoBinario(req) {
  return new Promise((resolve, reject) => {
    const partes = [];
    let tamanho = 0;
    req.on('data', (c) => {
      tamanho += c.length;
      if (tamanho > LIMITE_UPLOAD) {
        reject(new Error('Arquivo maior que o limite de 40 MB.'));
        req.destroy();
        return;
      }
      partes.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(partes)));
    req.on('error', reject);
  });
}

async function corpoJson(req) {
  const bruto = (await corpoBinario(req)).toString('utf8').trim();
  if (!bruto) return {};
  try {
    return JSON.parse(bruto);
  } catch {
    throw new Error('Corpo da requisição não é um JSON válido.');
  }
}

// ------------------------------------------------------------ sincronizacao

// uma sincronizacao por vez: o botao da tela e o agendador compartilham a mesma
let emAndamento = null;

function sincronizarUmaVez(opcoes = {}) {
  if (!emAndamento) {
    emAndamento = sincronizar(opcoes).finally(() => { emAndamento = null; });
  }
  return emAndamento;
}

function agendarSincronizacao() {
  const cfg = lerConfig();
  if (!cfg.configurado || !cfg.intervaloMinutos) return;

  const intervalo = Math.max(cfg.intervaloMinutos, 1) * 60000;
  const rodar = async () => {
    try {
      const r = await sincronizarUmaVez();
      const falhas = r.origens.filter((o) => !o.ok);
      console.log(
        `[jira] sincronizado: ${r.novos} novas, ${r.atualizados} atualizadas`
        + `${r.removidos ? `, ${r.removidos} removidas` : ''}`
        + `${falhas.length ? ` — ${falhas.length} origem(ns) com erro: ${falhas.map((f) => f.erro).join(' | ')}` : ''}`,
      );
    } catch (e) {
      console.error(`[jira] falha na sincronização automática: ${e.message}`);
    }
  };

  console.log(`[jira] sincronização automática a cada ${cfg.intervaloMinutos} min.`);
  rodar();
  setInterval(rodar, intervalo).unref();
}

async function servirEstatico(req, res, caminhoUrl) {
  const relativo = caminhoUrl === '/' ? 'index.html' : caminhoUrl.slice(1);
  const destino = normalize(join(PUBLICO, relativo));
  if (!destino.startsWith(PUBLICO)) {
    res.writeHead(403).end('Acesso negado');
    return;
  }
  try {
    const conteudo = await readFile(destino);
    res.writeHead(200, { 'Content-Type': TIPOS[extname(destino)] || 'application/octet-stream' });
    res.end(conteudo);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Não encontrado');
  }
}

/** Converte a query string nos filtros aceitos por montarDashboard. */
function lerFiltros(url) {
  const lista = (nome) => {
    const v = url.searchParams.get(nome);
    return v ? v.split('|').map((s) => s.trim()).filter(Boolean) : [];
  };
  const data = (nome) => {
    const v = url.searchParams.get(nome);
    return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  };
  return {
    espacos: lista('espacos'),
    responsaveis: lista('responsaveis'),
    tipos: lista('tipos'),
    status: lista('status'),
    de: data('de'),
    ate: data('ate'),
    incluirCancelados: url.searchParams.get('cancelados') === '1',
  };
}

const servidor = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const rota = url.pathname;

  try {
    if (rota === '/api/dashboard' && req.method === 'GET') {
      return json(res, 200, montarDashboard(lerFiltros(url)));
    }

    if (rota === '/api/itens' && req.method === 'GET') {
      const limite = Math.min(Number(url.searchParams.get('limite')) || 500, 5000);
      return json(res, 200, listarDetalhe(lerFiltros(url), limite));
    }

    if (rota === '/api/importacoes' && req.method === 'GET') {
      return json(res, 200, { itens: contarItens(), importacoes: listarImportacoes(100) });
    }

    // ---------------------------------------------------------- Jira (API)

    if (rota === '/api/jira/config' && req.method === 'GET') {
      return json(res, 200, { config: configPublica(), sincronizacoes: listarSincronizacoes() });
    }

    if (rota === '/api/jira/config' && req.method === 'POST') {
      const corpo = await corpoJson(req);
      return json(res, 200, { config: salvarConfig(corpo), sincronizacoes: listarSincronizacoes() });
    }

    if (rota === '/api/jira/testar' && req.method === 'POST') {
      // aceita credenciais no corpo para testar antes de salvar
      const corpo = await corpoJson(req);
      const cfg = { ...lerConfig() };
      if (corpo.url) cfg.url = String(corpo.url).trim().replace(/\/+$/, '');
      if (corpo.email != null) cfg.email = String(corpo.email).trim();
      if (corpo.token) cfg.token = String(corpo.token).trim();
      if (cfg.url && !/^https?:\/\//i.test(cfg.url)) cfg.url = `https://${cfg.url}`;
      try {
        return json(res, 200, await verificarConexao(cfg));
      } catch (e) {
        return json(res, 200, { ok: false, erro: e.message });
      }
    }

    if (rota === '/api/jira/projetos' && req.method === 'GET') {
      try {
        return json(res, 200, { projetos: await listarProjetos(lerConfig()) });
      } catch (e) {
        return json(res, 502, { erro: e.message });
      }
    }

    if (rota === '/api/jira/sincronizar' && req.method === 'POST') {
      const completa = url.searchParams.get('completa') === '1';
      try {
        return json(res, 200, await sincronizarUmaVez({ completa }));
      } catch (e) {
        return json(res, 502, { erro: e.message });
      }
    }

    if (rota.startsWith('/api/jira/sincronizacoes/') && req.method === 'DELETE') {
      const origem = decodeURIComponent(rota.slice('/api/jira/sincronizacoes/'.length));
      const r = removerSincronizacao(origem);
      return r ? json(res, 200, r) : json(res, 404, { erro: 'Origem não encontrada.' });
    }

    if (rota === '/api/upload' && req.method === 'POST') {
      const nome = decodeURIComponent(req.headers['x-nome-arquivo'] || url.searchParams.get('nome') || 'planilha.xlsx');
      if (!/\.(xlsx|csv)$/i.test(nome)) {
        return json(res, 400, { erro: 'Envie um arquivo .xlsx ou .csv exportado do Jira.' });
      }
      const conteudo = await corpoBinario(req);
      if (!conteudo.length) return json(res, 400, { erro: 'Arquivo vazio.' });

      const resultado = importarArquivo(conteudo, nome, { forcar: url.searchParams.get('forcar') === '1' });
      // guarda uma copia em data/ para o historico e para o npm run import
      await mkdir(PASTA_DADOS, { recursive: true });
      await writeFile(join(PASTA_DADOS, nome.replace(/[\\/:*?"<>|]/g, '_')), conteudo);
      return json(res, 200, resultado);
    }

    if (rota.startsWith('/api/importacoes/') && req.method === 'DELETE') {
      const id = Number(rota.split('/').pop());
      if (!Number.isInteger(id)) return json(res, 400, { erro: 'ID inválido.' });
      const r = removerImportacao(id);
      return r ? json(res, 200, r) : json(res, 404, { erro: 'Importação não encontrada.' });
    }

    if (rota === '/api/limpar' && req.method === 'POST') {
      limparTudo();
      return json(res, 200, { ok: true });
    }

    if (rota.startsWith('/api/')) return json(res, 404, { erro: 'Rota não encontrada.' });

    return await servirEstatico(req, res, rota);
  } catch (e) {
    return json(res, 500, { erro: e.message });
  }
});

conectar();
servidor.listen(PORTA, HOST, () => {
  const cfg = configPublica();
  console.log(`Dashboard Jira em http://localhost:${PORTA}  (${contarItens()} itens na base)`);
  console.log(
    cfg.configurado
      ? `[jira] conectado a ${cfg.url}${cfg.projetos.length ? ` — projetos: ${cfg.projetos.join(', ')}` : ''}`
      : '[jira] sem configuração de API. Clique em "Configurar Jira" no dashboard ou crie o arquivo .env '
        + '(instruções em docs/CONFIGURACAO-JIRA.md).',
  );
  agendarSincronizacao();
});
