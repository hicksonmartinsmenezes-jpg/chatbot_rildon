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
const readline = require('readline');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const CLIENT_ID     = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const TOKEN_PATH     = process.env.GOOGLE_DRIVE_OAUTH_TOKEN_PATH;

// Redirect URI "out-of-band" — o Google mostra o código NA PRÓPRIA TELA em
// vez de tentar redirecionar pra um servidor (não precisa subir servidor
// local nem expor porta nenhuma pra essa autorização pontual).
const REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';
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
  console.log('\n2) O Google vai mostrar um código na tela — copie e cole aqui embaixo.\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const code = await new Promise((resolve) => rl.question('Código: ', (answer) => { rl.close(); resolve(String(answer || '').trim()); }));

  if (!code) {
    console.error('❌ Nenhum código informado.');
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
