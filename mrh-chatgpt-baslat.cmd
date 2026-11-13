@echo off
chcp 65001 >nul
title MRH P6 Studio - ChatGPT MCP
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 22.13+ required: https://nodejs.org & pause & exit /b 1)
rem Allow editing / Duzenlemeye izin: set MRH_EDIT=1
node --disable-warning=ExperimentalWarning mrh\mrh-mcp.js --http --port 4791
pause
