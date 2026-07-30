// Escritor de .xlsx (OpenXML) sem dependencias externas — o par do leitor em
// xlsx.js. Monta os XML da pasta de trabalho e empacota tudo num zip escrito na
// mao, comprimido com node:zlib.
import { deflateRawSync } from 'node:zlib';

// ---------------------------------------------------------------- ZIP

const TABELA_CRC = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = TABELA_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Data/hora no formato DOS usado pelo cabecalho do zip. */
function dataDos(d = new Date()) {
  const hora = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
  const data = ((Math.max(d.getFullYear() - 1980, 0)) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { hora, data };
}

/**
 * Monta um zip a partir de Map<nome, Buffer|string>.
 * Escreve local headers, diretorio central e EOCD — o minimo que o Excel espera.
 */
function escreverZip(arquivos) {
  const { hora, data } = dataDos();
  const pedacos = [];
  const central = [];
  let offset = 0;

  for (const [nome, conteudo] of arquivos) {
    const bruto = Buffer.isBuffer(conteudo) ? conteudo : Buffer.from(conteudo, 'utf8');
    const comprimido = deflateRawSync(bruto, { level: 9 });
    const nomeBuf = Buffer.from(nome, 'utf8');
    const crc = crc32(bruto);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // versao necessaria
    local.writeUInt16LE(0x0800, 6);      // nomes em UTF-8
    local.writeUInt16LE(8, 8);           // deflate
    local.writeUInt16LE(hora, 10);
    local.writeUInt16LE(data, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comprimido.length, 18);
    local.writeUInt32LE(bruto.length, 22);
    local.writeUInt16LE(nomeBuf.length, 26);
    pedacos.push(local, nomeBuf, comprimido);

    const entrada = Buffer.alloc(46);
    entrada.writeUInt32LE(0x02014b50, 0);
    entrada.writeUInt16LE(20, 4);        // versao de quem escreveu
    entrada.writeUInt16LE(20, 6);
    entrada.writeUInt16LE(0x0800, 8);
    entrada.writeUInt16LE(8, 10);
    entrada.writeUInt16LE(hora, 12);
    entrada.writeUInt16LE(data, 14);
    entrada.writeUInt32LE(crc, 16);
    entrada.writeUInt32LE(comprimido.length, 20);
    entrada.writeUInt32LE(bruto.length, 24);
    entrada.writeUInt16LE(nomeBuf.length, 28);
    entrada.writeUInt32LE(offset, 42);
    central.push(entrada, nomeBuf);

    offset += local.length + nomeBuf.length + comprimido.length;
  }

  const dirCentral = Buffer.concat(central);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(arquivos.size, 8);
  fim.writeUInt16LE(arquivos.size, 10);
  fim.writeUInt32LE(dirCentral.length, 12);
  fim.writeUInt32LE(offset, 16);

  return Buffer.concat([...pedacos, dirCentral, fim]);
}

// ---------------------------------------------------------------- XML

/** Escapa texto e tira caracteres de controle que o Excel recusa. */
function escXml(valor) {
  return String(valor ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 0 -> A, 25 -> Z, 26 -> AA. */
function letraColuna(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  }
  return s;
}

/**
 * "YYYY-MM-DDTHH:MM:SS" -> serial do Excel (base 1899-12-30).
 * Le os campos como estao, sem converter fuso: a planilha mostra a mesma
 * data/hora que o dashboard.
 */
export function isoParaSerial(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(iso ?? ''));
  if (!m) return null;
  const dias = Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 + 25569;
  if (!Number.isFinite(dias)) return null;
  const fracao = ((+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0)) / 86400;
  return +(dias + fracao).toFixed(10);
}

// indices de estilo usados nas celulas (ver cellXfs abaixo)
const ESTILO = { normal: 0, cabecalho: 1, data: 2 };

const ESTILOS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy\\ hh:mm"/></numFmts>
<fonts count="2">
<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF4472C4"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function celula(ref, valor, coluna) {
  if (valor == null || valor === '') return '';

  if (coluna.tipo === 'data') {
    const serial = isoParaSerial(valor);
    if (serial == null) return `<c r="${ref}" t="inlineStr"><is><t>${escXml(valor)}</t></is></c>`;
    return `<c r="${ref}" s="${ESTILO.data}"><v>${serial}</v></c>`;
  }
  if (coluna.tipo === 'numero') {
    const n = Number(valor);
    if (!Number.isFinite(n)) return `<c r="${ref}" t="inlineStr"><is><t>${escXml(valor)}</t></is></c>`;
    return `<c r="${ref}"><v>${n}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escXml(valor)}</t></is></c>`;
}

function abaXml(colunas, linhas) {
  const ultimaCol = letraColuna(colunas.length - 1);
  const totalLinhas = linhas.length + 1;

  const cabecalho = colunas
    .map((c, i) => `<c r="${letraColuna(i)}1" s="${ESTILO.cabecalho}" t="inlineStr"><is><t>${escXml(c.titulo)}</t></is></c>`)
    .join('');

  const corpo = linhas
    .map((item, i) => {
      const r = i + 2;
      const celulas = colunas.map((c, j) => celula(`${letraColuna(j)}${r}`, item[c.chave], c)).join('');
      return `<row r="${r}">${celulas}</row>`;
    })
    .join('');

  const cols = colunas
    .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.largura ?? 18}" customWidth="1"/>`)
    .join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:${ultimaCol}${totalLinhas}"/>
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${cols}</cols>
<sheetData><row r="1" ht="20" customHeight="1">${cabecalho}</row>${corpo}</sheetData>
<autoFilter ref="A1:${ultimaCol}${totalLinhas}"/>
</worksheet>`;
}

/** O Excel recusa alguns caracteres em nome de aba, e o limite e 31 chars. */
function nomeAbaValido(nome) {
  return (String(nome || 'Dados').replace(/[\\/?*[\]:]/g, ' ').trim() || 'Dados').slice(0, 31);
}

/**
 * Gera um .xlsx de uma aba so.
 * @param {{aba?: string, colunas: Array<{titulo:string, chave:string, tipo?:'texto'|'data'|'numero', largura?:number}>, linhas: object[]}} opcoes
 * @returns {Buffer}
 */
export function gerarXlsx({ aba = 'Dados', colunas, linhas = [] }) {
  if (!colunas?.length) throw new Error('Informe ao menos uma coluna para gerar a planilha.');
  const nome = nomeAbaValido(aba);

  const arquivos = new Map([
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${escXml(nome)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`],
    ['xl/styles.xml', ESTILOS_XML],
    ['xl/worksheets/sheet1.xml', abaXml(colunas, linhas)],
  ]);

  return escreverZip(arquivos);
}
