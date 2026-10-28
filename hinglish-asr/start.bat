@echo off
rem Overlay Hinglish ASR server: sets up its own venv once, then starts the
rem server in the background with no console window (logs in server.log).
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo Creating virtual environment...
  rem faster-whisper needs Python 3.10-3.12 wheels, so prefer those versions.
  py -3.12 -m venv .venv 2>nul || py -3.11 -m venv .venv 2>nul || py -3.10 -m venv .venv 2>nul || python -m venv .venv
  if not exist ".venv\Scripts\python.exe" (
    echo Could not create a Python venv. Install Python 3.10-3.12 from python.org.
    exit /b 1
  )
  ".venv\Scripts\python.exe" -m pip install --upgrade pip >> install.log 2>&1
  echo Installing packages ^(first run only, a few minutes^)...
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt >> install.log 2>&1
  if errorlevel 1 (
    echo Package install failed, see install.log
    exit /b 1
  )
)

rem pythonw.exe runs without a console window.
start "" /b ".venv\Scripts\pythonw.exe" server.py
echo Hinglish ASR starting on http://127.0.0.1:8765  (first start downloads the model)
echo In Overlay: Settings - Speech-to-Text - Self-hosted - URL http://127.0.0.1:8765/v1
endlocal
