@echo off
rem Double-click this file on Windows. The first run sets everything up (a few minutes).
cd /d "%~dp0"
if not exist .venv (
  echo Setting up for the first time...
  py -3 -m venv .venv 2>nul || python -m venv .venv
)
call .venv\Scripts\activate.bat
python -m pip install --quiet --disable-pip-version-check -r backend\requirements.txt
if errorlevel 1 (
  echo.
  echo Installing the Python packages failed. Read the message above, then see "If something goes wrong" in README.md.
  pause
  exit /b 1
)
python run.py %*
pause
