# Backup diario do banco no Windows (chama scripts/backup.sh via Git Bash).
#
# O backup.sh so le variaveis de ambiente (nao le o .env sozinho) e precisa de
# bash + openssl + gzip. Este wrapper carrega o .env, roda o backup.sh com o
# bash do Git for Windows e, opcionalmente, copia o arquivo cifrado para uma
# segunda pasta/disco (BACKUP_COPY_DIR no .env, ex: G:\backups-rildon).
#
# Agendar (todo dia 03:00), no PowerShell, dentro da pasta do projeto:
#   $a = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$PWD\scripts\backup-windows.ps1`""
#   Register-ScheduledTask -TaskName "Backup Rildon" -Action $a -Trigger (New-ScheduledTaskTrigger -Daily -At 3am) -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable)
# Requisitos: Docker Desktop ligado na hora do backup; Git for Windows instalado.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$envFile = Join-Path $root ".env"
if (-not (Test-Path $envFile)) { throw ".env nao encontrado em $root" }

foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*([A-Z][A-Z0-9_]*)=(.*)$') {
        $name = $Matches[1]
        $value = $Matches[2].Trim().Trim('"').Trim("'")
        Set-Item -Path "Env:$name" -Value $value
    }
}

if (-not $env:BACKUP_ENCRYPTION_KEY) {
    throw "BACKUP_ENCRYPTION_KEY nao definida no .env (o backup nao e gerado sem cifra)."
}

$bash = "C:\Program Files\Git\bin\bash.exe"
if (-not (Test-Path $bash)) { throw "Git Bash nao encontrado em $bash" }

$logDir = Join-Path $root "backups"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir "backup-windows.log"

"[{0}] iniciando backup" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss") | Add-Content $log
# O backup.sh escreve avisos em stderr (ex: BACKUP_REMOTE nao definido). No
# PowerShell isso viraria erro fatal com "Stop"; entao relaxamos so nesta
# chamada e decidimos sucesso/falha pelo codigo de saida real.
$ErrorActionPreference = "Continue"
& $bash "scripts/backup.sh" 2>&1 | ForEach-Object { "$_" } | Tee-Object -FilePath $log -Append
$codigo = $LASTEXITCODE
$ErrorActionPreference = "Stop"
if ($codigo -ne 0) { throw "backup.sh falhou (codigo $codigo). Veja $log" }

$ultimo = Get-ChildItem $logDir -Filter "*.sql.gz.enc" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($ultimo -and $env:BACKUP_COPY_DIR) {
    New-Item -ItemType Directory -Force -Path $env:BACKUP_COPY_DIR | Out-Null
    Copy-Item $ultimo.FullName -Destination $env:BACKUP_COPY_DIR -Force
    "[{0}] copia extra em {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $env:BACKUP_COPY_DIR | Add-Content $log
}
"[{0}] backup concluido: {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $ultimo.Name | Add-Content $log
