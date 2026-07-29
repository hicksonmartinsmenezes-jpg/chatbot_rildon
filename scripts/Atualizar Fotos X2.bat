@echo off
chcp 65001 >nul
cd /d "%~dp0.."
node scripts\x2-fotos-menu.js
echo.
echo ============================================
echo Pressione uma tecla para fechar esta janela.
echo ============================================
pause >nul
