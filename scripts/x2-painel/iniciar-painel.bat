@echo off
REM PEDIDO DO USUARIO (2026-09-12): "ele nunca fica desligado, preciso que
REM ative essa rotina pra evitar ele nao funcionar" -- o computador fica
REM sempre ligado, mas o Painel X2 (npm run x2-painel) so roda se alguem
REM abrir o terminal manualmente. A rotina "Atualizar precos / estoque" (a
REM cada 5h) so dispara se esse processo estiver de pe -- se ninguem abriu
REM o painel depois de reiniciar o PC, a rotina simplesmente nao roda.
REM
REM Este .bat existe pra dar um alvo simples (sem aspas aninhadas) pro
REM Agendador de Tarefas do Windows chamar "ao fazer logon" -- ver
REM instrucoes de registro no chat. Ele so entra na pasta do projeto e
REM sobe o painel; se a janela fechar (ex: PC reiniciou), o Agendador abre
REM de novo sozinho no proximo logon.

cd /d "C:\Users\marke\OneDrive\Área de Trabalho\PROJETOS gitHUB\bot"
call npm run x2-painel
