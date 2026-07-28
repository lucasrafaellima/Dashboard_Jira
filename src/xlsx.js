// Leitor de .xlsx (OpenXML) sem dependencias externas.
// Le o zip na mao, descompacta com node:zlib e interpreta o XML das planilhas.
import { inflateRawSync } from 'node:zlib';

// ---------------------------------------------------------------- ZIP

function acharEocd(buf) {
  const limite = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= limite; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/** Le um zip em memoria e devolve Map<nomeDoArquivo, Buffer>. */
export function lerZip(buf) {
  const eocd = acharEocd(buf);
  if (eocd < 0) throw new Error('Arquivo nao parece um .xlsx valido (fim do zip nao encontrado).');

  const total = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  const arquivos = new Map();

  for (let i = 0; i < total; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) break;
    const metodo = buf.readUInt16LE(pos + 10);
    const tamComp = buf.readUInt32LE(pos + 20);
    const tamNome = buf.readUInt16LE(pos + 28);
    const tamExtra = buf.readUInt16LE(pos + 30);
    const tamComent = buf.readUInt16LE(pos + 32);
    const offLocal = buf.readUInt32LE(pos + 42);
    const nome = buf.toString('utf8', pos + 46, pos + 46 + tamNome);

    const nomeLocal = buf.readUInt16LE(offLocal + 26);
    const extraLocal = buf.readUInt16LE(offLocal + 28);
    const inicio = offLocal + 30 + nomeLocal + extraLocal;
    const bruto = buf.subarray(inicio, inicio + tamComp);

    try {
      arquivos.set(nome, metodo === 8 ? inflateRawSync(bruto) : Buffer.from(bruto));
    } catch {
      // entrada corrompida ou metodo desconhecido: ignora, nao e fatal
    }
    pos += 46 + tamNome + tamExtra + tamComent;
  }
  return arquivos;
}

// ---------------------------------------------------------------- XML

function decodificar(s) {
  if (s.indexOf('&') === -1) return s;
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function atributos(trecho) {
  const attrs = {};
  const re = /([\w:]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(trecho))) attrs[m[1]] = decodificar(m[2]);
  return attrs;
}

function textoDeRuns(xml) {
  let texto = '';
  const re = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(xml))) texto += decodificar(m[1]);
  return texto;
}

function lerSharedStrings(xml) {
  if (!xml) return [];
  const lista = [];
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g;
  let m;
  while ((m = re.exec(xml))) lista.push(m[1] ? textoDeRuns(m[1]) : '');
  return lista;
}

// numFmtId nativos que representam data/hora
const FMT_DATA_NATIVO = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

/** Devolve Set com os indices de estilo (atributo s da celula) que sao data. */
function lerEstilosDeData(xml) {
  const estilos = new Set();
  if (!xml) return estilos;

  const customData = new Set();
  const reFmt = /<numFmt\b([^>]*)\/>/g;
  let m;
  while ((m = reFmt.exec(xml))) {
    const a = atributos(m[1]);
    const codigo = (a.formatCode || '').replace(/\[[^\]]*\]/g, '').replace(/"[^"]*"/g, '');
    if (/[ymdhs]/i.test(codigo) && /[ymd]/i.test(codigo)) customData.add(Number(a.numFmtId));
  }

  const bloco = xml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/);
  if (!bloco) return estilos;
  const reXf = /<xf\b([^>]*?)(?:\/>|>[\s\S]*?<\/xf>)/g;
  let idx = 0;
  while ((m = reXf.exec(bloco[1]))) {
    const id = Number(atributos(m[1]).numFmtId || 0);
    if (FMT_DATA_NATIVO.has(id) || customData.has(id)) estilos.add(idx);
    idx++;
  }
  return estilos;
}

function indiceColuna(ref) {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/** Serial do Excel (base 1899-12-30) -> "YYYY-MM-DDTHH:MM:SS". */
export function serialParaIso(serial) {
  if (!Number.isFinite(serial) || serial <= 0) return null;
  const ms = Math.round((serial - 25569) * 86400000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n, t = 2) => String(n).padStart(t, '0');
  return (
    `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

/** Le uma aba e devolve matriz de linhas (array de strings por coluna). */
function lerAba(xml, shared, estilosData) {
  const linhas = [];
  const reLinha = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  let ml;
  while ((ml = reLinha.exec(xml))) {
    const numero = Number(atributos(ml[1]).r || linhas.length + 1);
    const celulas = [];
    const reCel = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let mc;
    let auto = 0;
    while ((mc = reCel.exec(ml[2]))) {
      const a = atributos(mc[1]);
      const corpo = mc[2] || '';
      const col = a.r ? indiceColuna(a.r) : auto;
      auto = col + 1;

      let valor = '';
      if (a.t === 'inlineStr') {
        valor = textoDeRuns(corpo);
      } else if (a.t === 's') {
        const bruto = (corpo.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        valor = bruto != null ? (shared[Number(bruto)] ?? '') : '';
      } else {
        const bruto = (corpo.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        if (bruto == null) valor = '';
        else if (a.t === 'str' || a.t === 'e' || a.t === 'b') valor = decodificar(bruto);
        else {
          const num = Number(bruto);
          const ehData = a.s != null && estilosData.has(Number(a.s)) && Number.isFinite(num);
          valor = ehData ? serialParaIso(num) ?? '' : decodificar(bruto);
        }
      }
      celulas[col] = typeof valor === 'string' ? valor.trim() : valor;
    }
    linhas[numero - 1] = celulas;
  }
  // preenche buracos (linhas totalmente vazias omitidas pelo Excel)
  for (let i = 0; i < linhas.length; i++) if (!linhas[i]) linhas[i] = [];
  return linhas;
}

// ---------------------------------------------------------------- API

/**
 * Le um .xlsx e devolve todas as abas com dados tabulares.
 * @returns {Array<{nome:string, oculta:boolean, linhas:string[][]}>}
 */
export function lerPlanilhas(buf) {
  const zip = lerZip(buf);
  const txt = (nome) => {
    const b = zip.get(nome);
    return b ? b.toString('utf8') : '';
  };

  const shared = lerSharedStrings(txt('xl/sharedStrings.xml'));
  const estilosData = lerEstilosDeData(txt('xl/styles.xml'));

  // rId -> caminho da aba
  const rels = new Map();
  const reRel = /<Relationship\b([^>]*)\/>/g;
  let m;
  const relsXml = txt('xl/_rels/workbook.xml.rels');
  while ((m = reRel.exec(relsXml))) {
    const a = atributos(m[1]);
    if (a.Id && a.Target) {
      let alvo = a.Target.replace(/^\/xl\//, '').replace(/^\.\//, '');
      if (!alvo.startsWith('xl/')) alvo = `xl/${alvo}`;
      rels.set(a.Id, alvo);
    }
  }

  const abas = [];
  const reAba = /<sheet\b([^>]*)\/>/g;
  const wbXml = txt('xl/workbook.xml');
  while ((m = reAba.exec(wbXml))) {
    const a = atributos(m[1]);
    const caminho = rels.get(a['r:id']);
    if (!caminho) continue;
    const xml = txt(caminho);
    if (!xml) continue;
    abas.push({
      nome: a.name || caminho,
      oculta: a.state === 'hidden' || a.state === 'veryHidden',
      linhas: lerAba(xml, shared, estilosData),
    });
  }

  // fallback: workbook.xml ausente/ilegivel -> varre sheetN.xml direto
  if (abas.length === 0) {
    for (const [nome, b] of zip) {
      if (/^xl\/worksheets\/sheet\d+\.xml$/.test(nome)) {
        abas.push({ nome, oculta: false, linhas: lerAba(b.toString('utf8'), shared, estilosData) });
      }
    }
  }
  return abas;
}
