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
import { gerarXlsx } from './src/xlsx-escrita.js';

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

// Uma sincronizacao por vez — o botao da tela, a API e o agendador compartilham
// a mesma execucao. Ela roda em segundo plano e o progresso fica aqui: com
// dezenas de projetos a passada leva minutos, tempo demais para manter uma
// requisicao HTTP aberta esperando o fim.
let emAndamento = null;

const estadoInicial = () => ({
  rodando: false,
  completa: false,
  fase: 'parada',
  iniciadoEm: null,
  terminadoEm: null,
  total: 0,
  indice: 0,
  origem: null,
  lidas: 0,
  gravados: 0,
  origens: [],
  concluidas: [],
  resultado: null,
  erro: null,
});

let estadoSync = estadoInicial();

/** Traduz os eventos de `sincronizar` no estado que a tela consulta. */
function aplicarProgresso(p) {
  if (p.fase === 'inicio') {
    estadoSync.total = p.total;
    estadoSync.origens = p.origens;
    console.log(`[jira] sincronizando ${p.total} origem(ns), uma por vez: ${p.origens.join(', ')}`);
    return;
  }

  estadoSync.fase = p.fase;
  if (p.origem) estadoSync.origem = p.origem;
  if (p.indice) estadoSync.indice = p.indice;

  if (p.fase === 'consultando') {
    estadoSync.lidas = 0;
    estadoSync.gravados = 0;
    return;
  }
  if (p.fase === 'conferindo') return;
  if (p.fase === 'lendo') {
    estadoSync.lidas = p.lidas ?? 0;
    estadoSync.gravados = p.gravados ?? 0;
    return;
  }
  if (p.fase === 'concluida') {
    estadoSync.concluidas.push({
      origem: p.origem, ok: true, itens: p.itens, novos: p.novos,
      atualizados: p.atualizados, removidos: p.removidos, truncado: p.truncado,
    });
    console.log(
      `[jira] ${p.indice}/${p.total} ${p.origem}: ${p.lidas} lidas -> ${p.novos} novas, `
      + `${p.atualizados} atualizadas${p.removidos ? `, ${p.removidos} removidas` : ''}`
      + `${p.avisos?.length ? ` (${p.avisos.join('; ')})` : ''}`,
    );
    return;
  }
  if (p.fase === 'erro') {
    estadoSync.concluidas.push({ origem: p.origem, ok: false, erro: p.erro });
    console.error(`[jira] ${p.indice}/${p.total} ${p.origem}: ${p.erro}`);
  }
}

async function executarSincronizacao(opcoes) {
  try {
    const r = await sincronizar({ ...opcoes, aoProgredir: aplicarProgresso });
    estadoSync.resultado = r;
    estadoSync.fase = 'finalizada';
    console.log(
      `[jira] passada concluída em ${(r.duracaoMs / 1000).toFixed(1)}s: ${r.novos} novas, `
      + `${r.atualizados} atualizadas${r.removidos ? `, ${r.removidos} removidas` : ''}`
      + `${r.falhas ? ` — ${r.falhas} origem(ns) com erro` : ''}`,
    );
    return r;
  } catch (e) {
    estadoSync.erro = e.message;
    estadoSync.fase = 'falhou';
    console.error(`[jira] falha na sincronização: ${e.message}`);
    return null;
  } finally {
    estadoSync.rodando = false;
    estadoSync.terminadoEm = new Date().toISOString();
    emAndamento = null;
  }
}

/** Dispara a sincronizacao se nao houver outra rodando. Nunca bloqueia. */
function iniciarSincronizacao(opcoes = {}) {
  if (emAndamento) {
    return { iniciada: false, motivo: 'Já existe uma sincronização em andamento.', estado: estadoSync };
  }
  estadoSync = { ...estadoInicial(), rodando: true, completa: !!opcoes.completa, fase: 'iniciando', iniciadoEm: new Date().toISOString() };
  emAndamento = executarSincronizacao(opcoes);
  return { iniciada: true, estado: estadoSync };
}

function agendarSincronizacao() {
  const cfg = lerConfig();
  if (!cfg.configurado || !cfg.intervaloMinutos) return;

  const intervalo = Math.max(cfg.intervaloMinutos, 1) * 60000;
  const rodar = () => {
    const r = iniciarSincronizacao();
    if (!r.iniciada) {
      console.log(`[jira] passada anterior ainda em andamento (${estadoSync.indice}/${estadoSync.total}); pulando esta rodada.`);
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
    epicos: lista('epicos'),
    responsaveis: lista('responsaveis'),
    tipos: lista('tipos'),
    status: lista('status'),
    prioridades: lista('prioridades'),
    de: data('de'),
    ate: data('ate'),
    incluirCancelados: url.searchParams.get('cancelados') === '1',
  };
}

// Colunas da planilha exportada — as mesmas da tabela "Atividades" na tela.
const COLUNAS_EXPORTACAO = [
  { titulo: 'Chave', chave: 'chave', largura: 14 },
  { titulo: 'Tipo', chave: 'tipo_item', largura: 16 },
  { titulo: 'Resumo', chave: 'resumo', largura: 60 },
  { titulo: 'Responsável', chave: 'responsavel', largura: 24 },
  { titulo: 'Status', chave: 'status', largura: 16 },
  { titulo: 'Prioridade', chave: 'prioridade', largura: 14 },
  { titulo: 'Espaço', chave: 'espaco', largura: 24 },
  { titulo: 'Épico', chave: 'epico_rotulo', largura: 34 },
  { titulo: 'Pai', chave: 'pai', largura: 14 },
  { titulo: 'Criado', chave: 'criado', tipo: 'data', largura: 18 },
  { titulo: 'Concluído em', chave: 'concluido', tipo: 'data', largura: 18 },
  { titulo: 'Atualizado', chave: 'atualizado', tipo: 'data', largura: 18 },
];

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

    // mesma tabela de "Atividades" da tela, em .xlsx e com os mesmos filtros
    if (rota === '/api/exportar' && req.method === 'GET') {
      const filtros = lerFiltros(url);
      // sem limite por padrao: a tela mostra as 500 primeiras, a planilha leva
      // tudo o que o filtro selecionou
      const limite = Math.min(Number(url.searchParams.get('limite')) || Infinity, 200000);
      const { itens, total } = listarDetalhe(filtros, limite);

      const planilha = gerarXlsx({ aba: 'Atividades', colunas: COLUNAS_EXPORTACAO, linhas: itens });
      const nome = `atividades-jira-${new Date().toISOString().slice(0, 10)}.xlsx`;
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${nome}"`,
        'Content-Length': planilha.length,
        'X-Total-Filtrado': String(total),
        'Cache-Control': 'no-store',
      });
      return res.end(planilha);
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

    // progresso da passada em andamento (a tela consulta de segundo em segundo)
    if (rota === '/api/jira/sincronizar/estado' && req.method === 'GET') {
      return json(res, 200, estadoSync);
    }

    if (rota === '/api/jira/sincronizar' && req.method === 'POST') {
      const completa = url.searchParams.get('completa') === '1';
      const cfg = lerConfig();
      if (!cfg.configurado) {
        return json(res, 400, {
          erro: 'Jira não configurado: faltam a URL do site e/ou o token da API.',
        });
      }

      const inicio = iniciarSincronizacao({ completa });
      // ?esperar=1 devolve o resultado completo (util em scripts e no curl);
      // sem ele a resposta sai na hora e o cliente acompanha pelo /estado
      if (url.searchParams.get('esperar') === '1') {
        const r = emAndamento ? await emAndamento : estadoSync.resultado;
        return r ? json(res, 200, r) : json(res, 502, { erro: estadoSync.erro ?? 'falha na sincronização' });
      }
      return json(res, inicio.iniciada ? 202 : 200, inicio);
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
