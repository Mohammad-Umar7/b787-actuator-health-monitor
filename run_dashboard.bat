@echo off
rem Starts AcuMain without Docker and opens it in the browser.
rem With a key in the .env file the agent uses Claude; without one it uses the built-in planner.
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo First run: setting up Python. This takes a few minutes...
  python -m venv .venv
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt
)
".venv\Scripts\python.exe" -m acumain --open %*
pause
