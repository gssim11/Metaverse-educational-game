@echo off
rem PhysioCap: one-time setup. Copies the code to Documents\Cowork\PhysioCap and keeps it updated.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0sync_to_cowork.ps1" -Install
pause
