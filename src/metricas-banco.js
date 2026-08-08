// Adaptador do lado servidor: liga as metricas puras (metricas.js) ao SQLite.
// Existe para que `metricas.js` nao conheca banco nenhum e possa rodar tambem no
// navegador, onde a fonte vem do snapshot do Firestore. Aqui as assinaturas
// continuam as de sempre, entao `server.js` nao precisou mudar as rotas.
import { listarItens, listarImportacoes, listarSincronizacoes } from './banco.js';
import * as metricas from './metricas.js';

export function montarDashboard(filtros = {}) {
  return metricas.montarDashboard({
    itens: listarItens(),
    importacoes: listarImportacoes(20), // mesmo limite de antes
    sincronizacoes: listarSincronizacoes(),
  }, filtros);
}

export function listarDetalhe(filtros = {}, limite = 500) {
  // so `itens` e usado aqui; nao vale pagar as outras duas consultas
  return metricas.listarDetalhe({ itens: listarItens() }, filtros, limite);
}
