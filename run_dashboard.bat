@echo off
rem Starts the dashboard and opens it in the browser.
rem After the model or the data changes:  run_dashboard.bat --rebuild
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo First run: setting up Python. This takes a minute...
  python -m venv .venv
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt
)
".venv\Scripts\python.exe" dashboard\server.py --open %*
pause
