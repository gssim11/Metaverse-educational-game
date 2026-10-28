@echo off
rem Open the PhysioCap app in the browser (starts a local web server; close the window to stop).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\serve_local.ps1"
