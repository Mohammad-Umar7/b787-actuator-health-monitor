@echo off
rem Starts the dashboard and opens it in the browser.
rem To show a new data file:  run_dashboard.bat --data "path\to\new file.xlsx"
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo First run: setting up Python. This takes a minute...
  python -m venv .venv
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt
)
".venv\Scripts\python.exe" dashboard\server.py --open %*
pause
