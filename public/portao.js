// Portao de login do modo publico (GitHub Pages).
//
// Importante entender o que isto e e o que nao e: um site no GitHub Pages e
// sempre alcancavel por qualquer um. Esta tela e conforto de navegacao, nao
// seguranca. Quem impede um estranho de ler os dados e o `firestore.rules` —
// nada e buscado do Firestore antes do login, e mesmo que alguem apague esta
// div pelo devtools, a leitura volta `permission-denied`.
import {
  auth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from './firebase.js';

const $ = (sel) => document.querySelector(sel);

function mostrar(estado, { mensagem = '', email = '' } = {}) {
  const portao = $('#portao');
  const msg = $('#portao-msg');
  const entrar = $('#btn-entrar');
  const sair = $('#portao-sair');

  portao.classList.toggle('oculto', estado === 'liberado');
  document.body.classList.toggle('travado', estado !== 'liberado');
  msg.textContent = mensagem;
  entrar.classList.toggle('oculto', estado !== 'deslogado');
  // sem esta saida, quem entrou com a conta Google errada fica preso na tela
  sair.classList.toggle('oculto', estado !== 'sem-permissao');

  if (estado === 'liberado' && email) {
    $('#usuario').textContent = email;
    $('#usuario').classList.remove('oculto');
    $('#btn-sair').classList.remove('oculto');
  }
}

/**
 * Resolve quando houver uma sessao valida e autorizada.
 * @returns {Promise<{email: string}>}
 */
export function exigirLogin() {
  return new Promise((resolve) => {
    // enquanto o onAuthStateChanged nao responde, nao da para saber se ha sessao.
    // Mostrar "Entrar" aqui faria o botao piscar para quem ja esta logado.
    mostrar('verificando', { mensagem: 'Verificando sessão…' });

    $('#btn-entrar').onclick = async () => {
      try {
        mostrar('verificando', { mensagem: 'Abrindo o login do Google…' });
        await signInWithPopup(auth, new GoogleAuthProvider());
        // o onAuthStateChanged abaixo assume daqui
      } catch (e) {
        const recado = e?.code === 'auth/popup-blocked'
          ? 'O navegador bloqueou a janela de login. Libere pop-ups para este site e tente de novo.'
          : e?.code === 'auth/unauthorized-domain'
            ? 'Este domínio não está autorizado no Firebase (Authentication → Settings → Authorized domains).'
            : e?.code === 'auth/popup-closed-by-user'
              ? 'Login cancelado.'
              : `Não foi possível entrar: ${e?.message ?? e}`;
        mostrar('deslogado', { mensagem: recado });
      }
    };

    $('#portao-sair').onclick = () => signOut(auth).then(() => location.reload());
    $('#btn-sair').onclick = () => signOut(auth).then(() => location.reload());

    onAuthStateChanged(auth, (usuario) => {
      if (!usuario) {
        mostrar('deslogado', { mensagem: 'Entre com sua conta Google para ver o painel.' });
        return;
      }
      mostrar('liberado', { email: usuario.email });
      resolve({ email: usuario.email });
    });
  });
}

/**
 * A leitura do snapshot so falha com `permission-denied` quando a conta nao
 * esta na lista de permitidos — e ai a mensagem precisa dizer isso, e nao
 * "erro ao carregar", senao ninguem entende o que fazer.
 */
export function avisarSemPermissao(email) {
  mostrar('sem-permissao', {
    mensagem: `A conta ${email} não está liberada para ver este painel. `
      + 'Peça a liberação a quem administra o dashboard, ou entre com outra conta.',
  });
}

export function avisarFalha(mensagem) {
  mostrar('deslogado', { mensagem });
}
