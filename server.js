// Servidor HTTP do dashboard — node:http puro, sem dependencias.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { conectar, listarImportacoes, removerImportacao, limparTudo, contarItens } from './src/banco.js';
import { importarArquivo } from './src/ingestao.js';
import { montarDashboard, listarDetalhe } from './src/metricas.js';

const RAIZ = dirname(fileURLToPath(import.meta.url));
const PUBLICO = join(RAIZ, 'public');
const PASTA_DADOS = join(RAIZ, 'data');
const PORTA = Number(process.env.PORT) || 3000;
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
    amplo: url.searchParams.get('amplo') === '1',
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
servidor.listen(PORTA, () => {
  console.log(`Dashboard Jira em http://localhost:${PORTA}  (${contarItens()} itens na base)`);
});
