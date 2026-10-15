#!/usr/bin/env node
/**
 * scripts/x2-drive-oauth-setup.js
 *
 * Autorização única (ou re-autorização, se o token expirar/for revogado) do
 * upload automático de catálogo pro Google Drive — ver scripts/x2-drive-
 * lancamentos.js e o comentário no .env sobre a troca de conta de serviço
 * pra OAuth (2026-09-16: conta de serviço falhou com "Service Accounts do
 * not have storage quota", porque não tem cota própria em pasta de Gmail
 * pessoal — só funciona com Drive Compartilhado, exclusivo de Workspace).
 *
 * Esse arquivo estava REFERENCIADO no .env desde 2026-09-16 mas nunca tinha
 * sido criado de fato — por isso o upload automático ficava sempre pendente
 * (achado investigando por que o PDF não subiu no Drive depois de uma
 * atualização de fotos/produtos, 2026-09-21).
 *
 * Uso (rode no terminal do usuário, uma vez só — ou de novo se o token
 * expirar/for revogado):
 *   node scripts/x2-drive-oauth-setup.js
 *
 * O script mostra um link, você abre no navegador, faz login com a conta
 * Google DONA da pasta do Drive, autoriza, e cola de volta aqui o código
 * que o Google mostra na tela. O token final (com refresh_token, que não
 * expira sozinho) é salvo em GOOGLE_DRIVE_OAUTH_TOKEN_PATH (.env).
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const CLIENT_ID     = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const TOKEN_PATH     = process.env.GOOGLE_DRIVE_OAUTH_TOKEN_PATH;

// Fluxo "loopback" (2026-09-30): o antigo "out-of-band" (urn:ietf:wg:oauth:2.0:oob)
// foi descontinuado pelo Google e não funciona mais. Agora o Google redireciona
// pra um servidor temporário em 127.0.0.1 (só durante esta autorização), que
// captura o código sozinho — não precisa copiar/colar nada. Vale para clientes
// OAuth do tipo "App para computador" (Desktop app).
const http = require('http');
const PORTA = Number(process.env.GOOGLE_OAUTH_LOOPBACK_PORT || 53682);
const REDIRECT_URI = `http://127.0.0.1:${PORTA}`;
const SCOPES = ['https://www.googleapis.com/auth/drive'];

async function main() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('❌ GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET não configurados no .env.');
    console.error('   Ver o passo a passo em .env.example (seção "Upload automático... Google Drive") pra criar o OAuth Client ID no Google Cloud Console antes de rodar este script.');
    process.exit(1);
  }
  if (!TOKEN_PATH) {
    console.error('❌ GOOGLE_DRIVE_OAUTH_TOKEN_PATH não configurado no .env.');
    process.exit(1);
  }

  const { google } = require('googleapis');
  const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline', // obrigatório pra ganhar refresh_token (senão o acesso expira em ~1h e pede login de novo toda hora)
    prompt: 'consent',      // força mostrar a tela de consentimento sempre — garante que um refresh_token novo venha, mesmo se essa conta já tiver autorizado antes
    scope: SCOPES,
  });

  console.log('\n1) Abra este link no navegador, faça login com a conta Google DONA da pasta do Drive, e autorize:\n');
  console.log(authUrl);
  console.log(`\n2) Depois de autorizar, o Google volta pra ${REDIRECT_URI} e este script segue sozinho (aguardando até 5 min).\n`);

  const code = await new Promise((resolve, reject) => {
    const servidor = http.createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      const c = url.searchParams.get('code');
      const erro = url.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(c ? '<h2>Autorizado! Pode fechar esta aba e voltar ao terminal.</h2>' : `<h2>Falhou: ${erro || 'sem código'}</h2>`);
      if (c || erro) { servidor.close(); c ? resolve(c) : reject(new Error(erro)); }
    });
    servidor.on('error', reject);
    servidor.listen(PORTA, '127.0.0.1');
    setTimeout(() => { servidor.close(); reject(new Error('tempo esgotado (5 min) sem autorização')); }, 5 * 60 * 1000);
  }).catch((e) => { console.error('❌ ' + e.message); process.exit(1); });

  if (!code) {
    console.error('❌ Nenhum código recebido.');
    process.exit(1);
  }

  try {
    const { tokens } = await oAuth2Client.getToken(code);
    // Salva o objeto COMPLETO (access_token, refresh_token, scope,
    // token_type, expiry_date) — não só o refresh_token solto. A lib
    // googleapis usa o access_token/expiry_date pra evitar um round-trip
    // de refresh a cada chamada, e renova sozinha quando expira (desde que
    // o refresh_token esteja presente).
    fs.mkdirSync(path.dirname(path.resolve(TOKEN_PATH)), { recursive: true });
    fs.writeFileSync(path.resolve(TOKEN_PATH), JSON.stringify(tokens, null, 2));
    console.log(`\n✅ Token salvo em ${TOKEN_PATH}. Upload automático pro Drive liberado — não precisa rodar este script de novo, a menos que o acesso seja revogado.`);
  } catch (err) {
    console.error('❌ Falha ao trocar o código pelo token:', err.message);
    process.exit(1);
  }
}

main();
