# Correcoes do relatorio X2 - rode UMA vez no PowerShell, na pasta do projeto:
#   cd "C:\Users\Administrator\Documents\PROJETOS - 2026\chatbot_rildon"
#   powershell -ExecutionPolicy Bypass -File .\aplicar-correcoes-x2.ps1
$fotos = "src\config\catalogo-x2\fotos"

# 1) Restaura o zip de INSTRUMENTO DE PAINEL (343 fotos) do ultimo backup bom
Copy-Item "$fotos\instrumento-painel.zip.bak-1789490970648" "$fotos\instrumento-painel.zip" -Force
"instrumento-painel.zip restaurado: {0:N1} MB" -f ((Get-Item "$fotos\instrumento-painel.zip").Length / 1MB)

# 2) Mantem so os 3 backups mais recentes de cada secao (+ o ultimo com conteudo real)
$baks = Get-ChildItem $fotos -Filter "*.zip.bak-*"
$liberado = 0
$baks | Group-Object { $_.Name -replace '\.zip\.bak-\d+$','' } | ForEach-Object {
  $lista = $_.Group | Sort-Object { [int64]($_.Name -replace '^.*\.bak-','') } -Descending
  $bom = $lista | Where-Object { $_.Length -gt 1024 } | Select-Object -First 1
  $lista | Select-Object -Skip 3 | Where-Object { -not $bom -or $_.Name -ne $bom.Name } | ForEach-Object {
    $liberado += $_.Length; Remove-Item $_.FullName -Force
  }
}
"Espaco liberado: {0:N1} GB" -f ($liberado / 1GB)

# 3) Confere: nenhum zip vivo pode estar vazio
Get-ChildItem $fotos -Filter "*.zip" | Where-Object { $_.Length -lt 1024 } | ForEach-Object { "ATENCAO zip vazio: $($_.Name)" }
