// Portao de login do modo publico (GitHub Pages).
//
// Importante entender o que isto e e o que nao e: um site no GitHub Pages e
// sempre alcancavel por qualquer um. Esta tela e conforto de navegacao, nao
// seguranca. Quem impede um estranho de ler os dados e o `firestore.rules` —
// nada e buscado do Firestore antes do login, e mesmo que alguem apague esta
// div pelo devtools, a leitura volta `permission-denied`.
import {
  auth, GoogleAuthProvider, OAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from './firebase.js';

/**
 * Os provedores aceitos. Qual conta a pessoa usa e indiferente para o painel:
 * quem manda no acesso e o **e-mail**, que precisa estar em `permitidos/` no
 * Firestore. Entrar pelo Google ou pelo Outlook com o mesmo endereco da no
 * mesmo lugar — e, por causa disso, o Firebase trata os dois como uma conta so
 * (ver `auth/account-exists-with-different-credential` em `recadoDeErro`).
 */
const PROVEDORES = {
  google: { rotulo: 'Google', criar: () => new GoogleAuthProvider() },
  outlook: {
    rotulo: 'Outlook',
    criar: () => {
      // nao existe MicrosoftAuthProvider: e o OAuthProvider generico apontado
      // para o provedor 'microsoft.com' habilitado no console do Firebase
      const p = new OAuthProvider('microsoft.com');
      p.setCustomParameters({
        // sem isto a Microsoft pula direto para a conta ja aberta no navegador;
        // quem tem a corporativa e a pessoal precisa poder escolher
        prompt: 'select_account',
        // 'common' aceita conta corporativa (Microsoft 365) e pessoal
        // (@outlook.com, @hotmail.com). Trocar pelo ID do tenant da empresa
        // fecha o login so para quem e de casa.
        tenant: 'common',
      });
      return p;
    },
  },
};

const $ = (sel) => document.querySelector(sel);

function mostrar(estado, { mensagem = '', email = '' } = {}) {
  const portao = $('#portao');
  const msg = $('#portao-msg');
  const entrar = $('#portao-entrar');
  const sair = $('#portao-sair');

  portao.classList.toggle('oculto', estado === 'liberado');
  document.body.classList.toggle('travado', estado !== 'liberado');
  msg.textContent = mensagem;
  entrar.classList.toggle('oculto', estado !== 'deslogado');
  // sem esta saida, quem entrou com a conta errada fica preso na tela
  sair.classList.toggle('oculto', estado !== 'sem-permissao');

  if (estado === 'liberado' && email) {
    $('#usuario').textContent = email;
    $('#usuario').classList.remove('oculto');
    $('#btn-sair').classList.remove('oculto');
  }
}

/** Traduz o codigo do Firebase para algo que diga o que fazer a seguir. */
function recadoDeErro(e, rotulo) {
  switch (e?.code) {
    case 'auth/popup-blocked':
      return 'O navegador bloqueou a janela de login. Libere pop-ups para este site e tente de novo.';
    case 'auth/unauthorized-domain':
      return 'Este domínio não está autorizado no Firebase (Authentication → Settings → Authorized domains).';
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return 'Login cancelado.';
    case 'auth/operation-not-allowed':
      return `O login com ${rotulo} ainda não foi habilitado no Firebase`
        + ' (Authentication → Sign-in method). Avise quem administra o dashboard.';
    // o Firebase guarda uma conta por e-mail: quem já entrou por um provedor
    // não entra pelo outro com o mesmo endereço
    case 'auth/account-exists-with-different-credential':
      return `O e-mail ${e?.customData?.email ?? 'desta conta'} já entrou aqui por outro`
        + ' provedor. Use o botão que você usou da primeira vez.';
    default:
      return `Não foi possível entrar com ${rotulo}: ${e?.message ?? e}`;
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

    const entrarCom = (chave) => async () => {
      const { rotulo, criar } = PROVEDORES[chave];
      try {
        mostrar('verificando', { mensagem: `Abrindo o login do ${rotulo}…` });
        await signInWithPopup(auth, criar());
        // o onAuthStateChanged abaixo assume daqui
      } catch (e) {
        mostrar('deslogado', { mensagem: recadoDeErro(e, rotulo) });
      }
    };

    $('#btn-entrar').onclick = entrarCom('google');
    $('#btn-entrar-outlook').onclick = entrarCom('outlook');

    $('#portao-sair').onclick = () => signOut(auth).then(() => location.reload());
    $('#btn-sair').onclick = () => signOut(auth).then(() => location.reload());

    onAuthStateChanged(auth, (usuario) => {
      if (!usuario) {
        mostrar('deslogado', { mensagem: 'Entre com sua conta Google ou Outlook para ver o painel.' });
        return;
      }
      // a lista de permitidos e indexada por e-mail. Uma conta Microsoft sem
      // e-mail no perfil (acontece em tenant que nao expoe o endereco) nunca
      // casaria com ela, e sem este aviso a pessoa so veria "sem permissão"
      if (!usuario.email) {
        mostrar('sem-permissao', {
          mensagem: 'Esta conta entrou sem informar um e-mail, e é pelo e-mail que a liberação'
            + ' é feita. Entre com uma conta que exponha o endereço.',
        });
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
