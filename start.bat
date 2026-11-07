@echo off
echo Starting PaidLoop at http://localhost:8000
cd /d "%~dp0backend"
"..\.venv\Scripts\python.exe" -m paidloop
