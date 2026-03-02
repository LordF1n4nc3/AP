@echo off
title RC Partners - Dashboard AP
echo.
echo  ========================================
echo   RC Partners - Dashboard AP
echo   Iniciando servidor...
echo  ========================================
echo.

cd /d "%~dp0"

:: Usar PowerShell para cargar bien la ruta del sistema y evitar errores de Node
powershell -NoProfile -ExecutionPolicy Bypass -Command "$env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User'); if (!(Get-Command node -ErrorAction SilentlyContinue)) { Write-Host '[ERROR] Node.js no esta instalado. Descargalo de https://nodejs.org' -ForegroundColor Red; exit 1 }; if (!(Test-Path node_modules)) { Write-Host 'Instalando dependencias...'; npm install }; Write-Host 'Abriendo navegador en http://localhost:3000 ...' -ForegroundColor Cyan; Write-Host '(Podes cerrar esta ventana con Ctrl+C cuando termines)' -ForegroundColor DarkGray; Start-Process 'http://localhost:3000'; npm run dev"

pause

