# Deploy do notebook para o servidor, sem GitHub e sem senha (chave SSH sem frase-senha).
# Uso (na raiz do repositorio, no notebook):  .\scripts\deploy-servidor.ps1
# Faz: busca origin/main, empacota so o que o servidor nao tem, copia por scp,
# avanca o repositorio do servidor (ff-only), reconstroi o frontend e reinicia o bot.
# O painel X2 (npm run x2-painel) NAO reinicia por aqui: roda numa aba do terminal do servidor.
# 'Continue': o git/ssh escrevem progresso normal em stderr e o 'Stop' do PowerShell trataria isso como erro.
$ErrorActionPreference = 'Continue'
function Falhou($m) { Write-Host "ERRO: $m" -ForegroundColor Red; exit 1 }
$Servidor = 'Administrator@192.168.0.2'
$Repo = 'C:\Users\Administrator\Documents\PROJETOS - 2026\chatbot_rildon'
$Bundle = Join-Path $env:TEMP 'deploy.bundle'

git fetch origin main 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Falhou 'git fetch falhou.' }
$alvo = (git rev-parse origin/main).Trim()
$atual = (ssh -o BatchMode=yes $Servidor "cd /d `"$Repo`" && git rev-parse HEAD").Trim()
if ($atual -eq $alvo) { Write-Host "Servidor ja esta em $alvo."; }
else {
  git bundle create $Bundle refs/remotes/origin/main "^$atual" 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Falhou 'git bundle falhou (o commit do servidor existe aqui?).' }
  scp -o BatchMode=yes $Bundle "${Servidor}:C:/Users/Administrator/deploy.bundle"
  if ($LASTEXITCODE -ne 0) { Falhou 'scp falhou.' }
  ssh -o BatchMode=yes $Servidor "cd /d `"$Repo`" && git -c gc.auto=0 fetch C:\Users\Administrator\deploy.bundle refs/remotes/origin/main && git -c gc.auto=0 merge --ff-only FETCH_HEAD && npm run build:frontend"
  if ($LASTEXITCODE -ne 0) { Falhou 'atualizacao no servidor falhou (merge/build).' }
}
ssh -o BatchMode=yes $Servidor "docker restart chatbot_rildon_app"
$mudouPainel = git diff --name-only "$atual" "$alvo" -- scripts/x2-painel scripts/x2-*.js
ssh -o BatchMode=yes $Servidor "cd /d `"$Repo`" && git log --oneline -1"
if ($mudouPainel) { Write-Host "ATENCAO: mudou codigo do painel X2 - reinicie 'npm run x2-painel' na aba do servidor (Ctrl+C e rodar de novo)." -ForegroundColor Yellow }
