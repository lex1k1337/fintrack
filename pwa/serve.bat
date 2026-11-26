@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === FinTrack PWA Server ===
echo Откройте в Chrome на телефоне (в той же Wi-Fi сети) один из адресов:
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
  for /f "tokens=1" %%b in ("%%a") do echo   http://%%b:8080
)
echo.
echo На телефоне нажмите меню Chrome (три точки) -^> "Добавить на гл. экран" / "Установить приложение".
echo После установки этот сервер можно выключить навсегда.
echo.
python -m http.server 8080 --bind 0.0.0.0
pause
