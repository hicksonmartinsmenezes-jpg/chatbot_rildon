@echo off
chcp 65001 >nul
cd /d "%~dp0.."
echo Iniciando o Painel Fotos X2 (o navegador abre sozinho quando estiver pronto)...
node scripts\x2-painel\server.js
echo.
echo ============================================
echo O servidor parou. Pressione uma tecla para fechar esta janela.
echo ============================================
pause >nul
