# Deploy do notebook para o servidor, sem GitHub e sem senha (chave SSH sem frase-senha).
# Uso (na raiz do repositório, no notebook):  .\scripts\deploy-servidor.ps1
# Faz: busca origin/main, empacota só o que o servidor não tem, copia por scp,
# avança o repositório do servidor (ff-only), reconstrói o frontend e reinicia o bot.
# O painel X2 (npm run x2-painel) NÃO reinicia por aqui: roda numa aba do terminal do servidor.
$ErrorActionPreference = 'Stop'
$Servidor = 'Administrator@192.168.0.2'
$Repo = 'C:\Users\Administrator\Documents\PROJETOS - 2026\chatbot_rildon'
$Bundle = Join-Path $env:TEMP 'deploy.bundle'

git fetch origin main
$alvo = (git rev-parse origin/main).Trim()
$atual = (ssh -o BatchMode=yes $Servidor "cd /d `"$Repo`" && git rev-parse HEAD").Trim()
if ($atual -eq $alvo) { Write-Host "Servidor já está em $alvo."; }
else {
  git bundle create $Bundle refs/remotes/origin/main "^$atual"
  scp -o BatchMode=yes $Bundle "${Servidor}:C:/Users/Administrator/deploy.bundle"
  ssh -o BatchMode=yes $Servidor "cd /d `"$Repo`" && git -c gc.auto=0 fetch C:\Users\Administrator\deploy.bundle refs/remotes/origin/main && git -c gc.auto=0 merge --ff-only FETCH_HEAD && npm run build:frontend"
}
ssh -o BatchMode=yes $Servidor "docker restart chatbot_rildon_app"
$mudouPainel = git diff --name-only "$atual" "$alvo" -- scripts/x2-painel scripts/x2-*.js
ssh -o BatchMode=yes $Servidor "cd /d `"$Repo`" && git log --oneline -1"
if ($mudouPainel) { Write-Host "ATENÇÃO: mudou código do painel X2 — reinicie 'npm run x2-painel' na aba do servidor (Ctrl+C e rodar de novo)." -ForegroundColor Yellow }
