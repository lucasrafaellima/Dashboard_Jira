// Identificacao do projeto no Firebase.
//
// Pode ficar no repositorio sem problema: a apiKey do Firebase Web identifica o
// projeto, nao autoriza nada. Quem controla acesso e a dupla
// "dominios autorizados no Authentication" + "firestore.rules".
export const CONFIG_FIREBASE = {
  apiKey: 'AIzaSyBs7Bc4KzcI0SSbN-zoTz0kBY81g-pIoHk',
  authDomain: 'dashboard-81c66.firebaseapp.com',
  projectId: 'dashboard-81c66',
  storageBucket: 'dashboard-81c66.firebasestorage.app',
  messagingSenderId: '452479294897',
  appId: '1:452479294897:web:99a360614ea3cd5f8af190',
  // measurementId omitido de proposito: o Analytics pesa ~100 KB, cria cookie e
  // uma discussao de consentimento que um painel interno nao precisa ter.
};
