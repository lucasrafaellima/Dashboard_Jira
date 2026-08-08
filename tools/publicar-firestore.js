// Publica a base como um unico snapshot comprimido no Firestore, que e de onde
// o site estatico (GitHub Pages) le os dados.
//
//   node tools/publicar-firestore.js
//
// Credencial da service account, na ordem: FIREBASE_SERVICE_ACCOUNT (o JSON
// inteiro, e assim que a GitHub Action passa) ou FIREBASE_CHAVE /
// GOOGLE_APPLICATION_CREDENTIALS (caminho de um arquivo .json).
//
// Sem dependencias de proposito, como o resto do projeto: o JWT e assinado com
// node:crypto e a gravacao vai pela API REST do Firestore.
import { createSign } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { listarItens, listarImportacoes, listarSincronizacoes } from '../src/banco.js';

// Um documento do Firestore cabe em 1 MiB contando nomes de campo e overhead.
// 900 KB por documento deixa margem tranquila. Hoje a base inteira da ~120 KB,
// entao o fatiamento nunca dispara — a variavel existe para conseguir exercitar
// esse caminho sem esperar a base crescer 8x.
const LIMITE_POR_DOC = Number(process.env.LIMITE_POR_DOC) || 900_000;
const COLECAO = 'painel';
const DOC = 'atual';
const VERSAO_ESQUEMA = 1;

function carregarConta() {
  const bruto = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (bruto?.trim()) {
    try {
      return JSON.parse(bruto);
    } catch (e) {
      throw new Error(`FIREBASE_SERVICE_ACCOUNT não é um JSON válido: ${e.message}`);
    }
  }
  const caminho = process.env.FIREBASE_CHAVE || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (caminho) return JSON.parse(readFileSync(caminho, 'utf8'));

  throw new Error(
    'Credencial ausente.\n\n'
    + 'Baixe a chave em: Firebase → Project settings → Service accounts →\n'
    + '  Generate new private key\n'
    + '  https://console.firebase.google.com/project/_/settings/serviceaccounts/adminsdk\n\n'
    + 'Depois aponte para ela:\n'
    + '  PowerShell:  $env:FIREBASE_CHAVE = "$env:USERPROFILE\\.firebase\\chave.json"\n'
    + '  bash:        export FIREBASE_CHAVE=~/.firebase/chave.json\n\n'
    + 'No GitHub Actions o caminho não serve: lá vai o conteúdo do arquivo\n'
    + 'no secret FIREBASE_SERVICE_ACCOUNT.',
  );
}

const b64url = (v) => Buffer.from(v).toString('base64url');

/** Assina o JWT da service account e troca por um access token OAuth2. */
async function obterToken(conta) {
  const agora = Math.floor(Date.now() / 1000);
  const cabecalho = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const corpo = b64url(JSON.stringify({
    iss: conta.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: agora,
    exp: agora + 3600,
  }));
  const assinatura = createSign('RSA-SHA256')
    .update(`${cabecalho}.${corpo}`)
    .sign(conta.private_key, 'base64url');

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${cabecalho}.${corpo}.${assinatura}`,
    }),
  });
  if (!r.ok) throw new Error(`Falha no OAuth (${r.status}): ${await r.text()}`);
  return (await r.json()).access_token;
}

/** Cliente minimo da API REST do Firestore. */
function api(conta, token) {
  const base = `https://firestore.googleapis.com/v1/projects/${conta.project_id}`
    + '/databases/(default)/documents';
  const cabecalhos = { Authorization: `Bearer ${token}` };

  return {
    /** PATCH com updateMask explicito: grava exatamente os campos informados. */
    async gravar(caminho, campos) {
      const mascara = Object.keys(campos)
        .map((c) => `updateMask.fieldPaths=${encodeURIComponent(c)}`)
        .join('&');
      const r = await fetch(`${base}/${caminho}?${mascara}`, {
        method: 'PATCH',
        headers: { ...cabecalhos, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: campos }),
      });
      if (!r.ok) throw new Error(`Falha ao gravar ${caminho} (${r.status}): ${await r.text()}`);
    },

    /** Só os IDs; o conteúdo das partes antigas não interessa. */
    async listarIds(caminho) {
      const r = await fetch(`${base}/${caminho}?pageSize=300&mask.fieldPaths=__name__`, {
        headers: cabecalhos,
      });
      if (r.status === 404) return [];
      if (!r.ok) throw new Error(`Falha ao listar ${caminho} (${r.status}): ${await r.text()}`);
      const dados = await r.json();
      return (dados.documents ?? []).map((d) => d.name.split('/').pop());
    },

    async apagar(caminho) {
      const r = await fetch(`${base}/${caminho}`, { method: 'DELETE', headers: cabecalhos });
      if (!r.ok && r.status !== 404) {
        throw new Error(`Falha ao apagar ${caminho} (${r.status}): ${await r.text()}`);
      }
    },
  };
}

async function principal() {
  const conta = carregarConta();

  // mesma forma que `metricas.js` espera como `fonte`
  const fonte = {
    itens: listarItens(),
    importacoes: listarImportacoes(20),
    sincronizacoes: listarSincronizacoes(),
  };
  if (!fonte.itens.length) {
    throw new Error('A base está vazia — sincronize antes de publicar.');
  }

  const cru = Buffer.from(JSON.stringify(fonte), 'utf8');
  const gz = gzipSync(cru, { level: 9 });
  const partes = Math.ceil(gz.length / LIMITE_POR_DOC);

  console.log(`Itens: ${fonte.itens.length}`);
  console.log(`Payload: ${(cru.length / 1024 / 1024).toFixed(2)} MB `
    + `-> ${(gz.length / 1024).toFixed(0)} KB comprimido (${partes} parte(s))`);

  const token = await obterToken(conta);
  const fs = api(conta, token);

  const campos = {
    versaoEsquema: { integerValue: String(VERSAO_ESQUEMA) },
    formato: { stringValue: 'gzip+json' },
    geradoEm: { timestampValue: new Date().toISOString() },
    linhas: { integerValue: String(fonte.itens.length) },
    partes: { integerValue: String(partes) },
    origem: { stringValue: process.env.GITHUB_ACTIONS ? 'github-actions' : 'local' },
  };

  // Caso comum: cabe tudo no documento principal.
  // bytesValue viaja em base64, mas o Firestore guarda e cobra os bytes crus.
  if (partes === 1) campos.carga = { bytesValue: gz.toString('base64') };

  await fs.gravar(`${COLECAO}/${DOC}`, campos);

  if (partes > 1) {
    for (let i = 0; i < partes; i++) {
      const fatia = gz.subarray(i * LIMITE_POR_DOC, (i + 1) * LIMITE_POR_DOC);
      await fs.gravar(`${COLECAO}/${DOC}/partes/${i}`, {
        carga: { bytesValue: fatia.toString('base64') },
      });
    }
  }

  // Subcolecao sobrevive ao PATCH do pai: se a publicacao anterior tinha mais
  // partes que esta, as sobras precisam sair na mao ou o cliente remonta lixo.
  const sobras = (await fs.listarIds(`${COLECAO}/${DOC}/partes`))
    .filter((id) => partes === 1 || Number(id) >= partes);
  for (const id of sobras) {
    await fs.apagar(`${COLECAO}/${DOC}/partes/${id}`);
    console.log(`  parte obsoleta removida: ${id}`);
  }

  console.log(`Publicado em ${COLECAO}/${DOC} (projeto ${conta.project_id}).`);
}

// Sem process.exit(): com requisicoes recem-encerradas ele derruba o processo no
// Windows. Mesma abordagem do tools/sincronizar.js.
try {
  await principal();
} catch (e) {
  console.error(`\nFalha ao publicar: ${e.message}`);
  process.exitCode = 1;
}
