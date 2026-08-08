// Monta a pasta `site/` igual ao workflow do GitHub Pages e serve por HTTP, sem
// nenhuma rota /api. Serve para ver o modo publico (login pelo Firebase, dados
// vindos do Firestore) antes de publicar de verdade.
//
//   node tools/servir-site.js [porta]
//
// `localhost` ja vem nos dominios autorizados do Firebase, entao o login Google
// funciona daqui igual funcionaria no ar.
import { createServer } from 'node:http';
import { readFile, mkdir, rm, cp } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(RAIZ, 'site');
const PORTA = Number(process.argv[2]) || 4000;

// os mesmos dois modulos que o workflow copia para compartilhado/
const COMPARTILHADOS = ['metricas.js', 'normalizar.js'];

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function montar() {
  await rm(SITE, { recursive: true, force: true });
  await mkdir(join(SITE, 'compartilhado'), { recursive: true });
  await cp(join(RAIZ, 'public'), SITE, { recursive: true });
  for (const nome of COMPARTILHADOS) {
    await cp(join(RAIZ, 'src', nome), join(SITE, 'compartilhado', nome));
  }
}

await montar();

createServer(async (req, res) => {
  const caminho = new URL(req.url, 'http://localhost').pathname;
  const relativo = caminho === '/' ? 'index.html' : caminho.slice(1);
  const destino = normalize(join(SITE, relativo));
  if (!destino.startsWith(SITE)) {
    res.writeHead(403).end('Acesso negado');
    return;
  }
  try {
    const conteudo = await readFile(destino);
    res.writeHead(200, { 'Content-Type': TIPOS[extname(destino)] || 'application/octet-stream' });
    res.end(conteudo);
  } catch {
    // e exatamente o que o GitHub Pages faz com /api/saude: 404.
    // E assim que o front descobre que nao ha backend e entra no modo publico.
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Não encontrado');
  }
}).listen(PORTA, '127.0.0.1', () => {
  console.log(`Modo público em http://localhost:${PORTA}`);
  console.log('Sem rotas /api — a tela vai pedir login e buscar os dados no Firestore.');
});
