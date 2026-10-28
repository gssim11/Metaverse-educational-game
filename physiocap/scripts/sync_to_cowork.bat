@echo off
rem PhysioCap: one-time setup. Copies the code to Documents\Cowork\PhysioCap and keeps it updated.
rem No options = -Install. Options are passed through, e.g.  sync_to_cowork.bat -Uninstall
if "%~1"=="" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0sync_to_cowork.ps1" -Install
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0sync_to_cowork.ps1" %*
)
pause
