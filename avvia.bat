@echo off
rem ---------------------------------------------------------------------------
rem ForexVision - avvio dell'applicazione (Windows)
rem
rem   avvia.bat                 avvia il ponte sulla porta 8199 e apre l'app nel
rem                             browser di sistema; quando chiudi la finestra
rem                             dell'app il ponte si ferma e questa finestra esce
rem   avvia.bat --stop          ferma un ponte rimasto attivo sulla porta
rem   avvia.bat --lan           rende l'app raggiungibile dalla rete locale
rem   avvia.bat --port 9000     usa un'altra porta (predefinita: 8199)
rem   avvia.bat --host IND      indirizzo di ascolto esplicito
rem   avvia.bat --no-browser    non apre il browser (stampa l'indirizzo da aprire)
rem
rem La porta e' sempre la stessa e non c'e' ripiego silenzioso: se e' occupata lo
rem script lo dice e non parte. La chiusura della finestra dell'app ferma il ponte
rem perche' la pagina tiene aperta una connessione col server (/api/sessione):
rem quando la finestra sparisce la connessione cade e il server si ferma da solo.
rem ---------------------------------------------------------------------------
setlocal
set "DIR=%~dp0"
set "PORT=8199"
if defined FOREXVISION_PORT set "PORT=%FOREXVISION_PORT%"
set "HOST=127.0.0.1"
set "APRI=1"
set "STOP=0"

:opzioni
if "%~1"=="" goto ponte
if /i "%~1"=="--stop"       ( set "STOP=1" & shift & goto opzioni )
if /i "%~1"=="--lan"        ( set "HOST=0.0.0.0" & shift & goto opzioni )
if /i "%~1"=="--no-browser" ( set "APRI=0" & shift & goto opzioni )
if /i "%~1"=="--port"       ( set "PORT=%~2" & shift & shift & goto opzioni )
if /i "%~1"=="--host"       ( set "HOST=%~2" & shift & shift & goto opzioni )
echo Opzione non riconosciuta: %~1
echo Uso: avvia.bat [--lan ^| --port N ^| --host INDIRIZZO ^| --stop ^| --no-browser]
pause
exit /b 2

:ponte
if "%STOP%"=="1" goto stop

rem --- Python 3 (py.exe, python.exe o python3.exe nel PATH) ---
set "PYEXE="
set "PYNAME="
call :trova py.exe
if not defined PYEXE call :trova python.exe
if not defined PYEXE call :trova python3.exe
if not defined PYEXE (
  echo Python 3 non trovato.
  echo Installalo da https://www.python.org/downloads/ e riprova, lasciando
  echo attiva l'opzione "Add python.exe to PATH" durante l'installazione.
  pause
  exit /b 1
)
set "PYARG="
if /i "%PYNAME%"=="py" set "PYARG=-3"
set "NOBROWSER="
if "%APRI%"=="0" set "NOBROWSER= --no-browser"

echo Avvio del ponte ForexVision sulla porta %PORT% ...
echo.
"%PYEXE%" %PYARG% "%DIR%server.py" --port %PORT% --host %HOST% --strict-port --close-token%NOBROWSER%
if errorlevel 1 (
  echo.
  echo Il ponte non e' partito: il messaggio qui sopra dice perche'.
  pause
  exit /b 1
)
echo.
echo Fine: il ponte non e' piu' attivo.
exit /b 0

:stop
set "FERMATO="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do (
  echo Fermo il processo %%P, che ascolta sulla porta %PORT% ...
  taskkill /PID %%P /T /F >nul 2>&1
  set "FERMATO=1"
)
if defined FERMATO (
  echo Ponte fermato.
) else (
  echo Nessun ponte attivo sulla porta %PORT%.
)
exit /b 0

:trova
rem Prima occorrenza di %1 nel PATH: la usiamo come interprete.
for /f "delims=" %%W in ('where %1 2^>nul') do (
  if not defined PYEXE (
    set "PYEXE=%%W"
    set "PYNAME=%~n1"
  )
)
goto :eof
