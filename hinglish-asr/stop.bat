@echo off
rem Stops the Hinglish ASR server started by start.bat.
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"127.0.0.1:8765 .*LISTENING"') do taskkill /pid %%p /f >nul 2>&1
echo Stopped (if it was running).
