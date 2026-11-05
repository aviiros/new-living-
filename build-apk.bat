@echo off
REM Windows:  double-click, or run  build-apk.bat  (add --release for a signed build)
cd /d "%~dp0"
node scripts\build-apk.js %*
if errorlevel 1 (echo. & echo Build failed. See the messages above. & pause & exit /b 1)
pause
