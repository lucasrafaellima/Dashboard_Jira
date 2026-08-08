// Ponto unico de contato com o Firebase. Todo o resto do front importa daqui,
// para a versao do SDK ficar declarada num lugar so.
//
// Sem bundler: os modulos vem prontos do CDN do Google, em ESM.
// Duas regras ao mexer nas URLs abaixo:
//   1. as tres tem que ficar na MESMA versao — misturar quebra o registro
//      interno de componentes do SDK;
//   2. nada de builds `-compat`, que sao o shim da v8 e trazem o SDK inteiro.
//
// Usamos o Firestore "lite" (36 KB na rede, contra 115 KB do completo): ele tem
// getDoc/getDocs e nao tem listeners em tempo real, que e exatamente o caso aqui
// — o painel le um snapshot publicado de tempos em tempos, nao um fluxo vivo.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js';
import {
  getFirestore, doc, getDoc, collection, getDocs,
} from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore-lite.js';
import { CONFIG_FIREBASE } from './firebase-config.js';

const app = initializeApp(CONFIG_FIREBASE);

export const auth = getAuth(app);
export const bd = getFirestore(app);

export {
  GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
  doc, getDoc, collection, getDocs,
};
