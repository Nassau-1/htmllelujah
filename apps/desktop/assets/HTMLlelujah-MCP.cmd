@echo off
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0HTMLlelujah.exe" "%~dp0resources\app.asar\dist-electron\mcp-cli.js"
exit /b %ERRORLEVEL%
