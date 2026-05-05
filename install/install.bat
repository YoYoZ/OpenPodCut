@echo off
REM OpenPodCut installer
REM Installs the extension to Premiere Pro's CEP extensions folder.
REM Supports two modes:
REM   1. ZXP via Adobe UXP installer (preferred -- no debug mode needed)
REM   2. Direct copy fallback (requires debug mode / enable_debug_mode.bat)

cd /d "%~dp0"

REM ── Locate ZXP ───────────────────────────────────────────────────────────────
set "ZXP="
for %%f in ("OpenPodCut-v*.zxp") do set "ZXP=%%~ff"

REM ── Try ZXP install via UPIA (Adobe installer CLI) ────────────────────────────
if defined ZXP (
    set "UPIA="
    for /d %%d in ("%APPDATA%\Adobe\UPIA\*") do (
        if exist "%%d\UPIA.exe" set "UPIA=%%d\UPIA.exe"
    )
    if not defined UPIA (
        for /d %%d in ("%LOCALAPPDATA%\Adobe\UPIA\*") do (
            if exist "%%d\UPIA.exe" set "UPIA=%%d\UPIA.exe"
        )
    )

    if defined UPIA (
        echo Installing %ZXP% via Adobe installer...
        "%UPIA%" --install="%ZXP%"
        if %ERRORLEVEL% EQU 0 (
            echo.
            echo [OK] Extension installed via ZXP.
            echo Restart Premiere Pro, then go to Window ^> Extensions ^> OpenPodCut
            pause
            exit /b 0
        )
        echo [WARN] ZXP installer returned an error -- falling back to direct copy.
        echo.
    ) else (
        echo [INFO] Adobe installer not found -- falling back to direct copy.
        echo        ^(This requires debug mode to be enabled^)
        echo.
    )
)

REM ── Fallback: direct copy ─────────────────────────────────────────────────────
set "SRC=%~dp0..\cep-extension"
set "DEST=%APPDATA%\Adobe\CEP\extensions\podcast-cutter"

if not exist "%SRC%\bin\analyzer\analyzer.exe" (
    echo ERROR: analyzer.exe not found at %SRC%\bin\analyzer\
    echo Build it first:  cd analyzer  ^&  build.bat
    pause
    exit /b 1
)

echo Installing to %DEST% ...
if exist "%DEST%" rmdir /s /q "%DEST%"
mkdir "%DEST%"
xcopy /e /i /q "%SRC%\*" "%DEST%\"

echo.
echo [OK] Extension installed via direct copy.
echo      If the panel does not appear, run enable_debug_mode.bat as Administrator.
echo      Then restart Premiere Pro and go to Window ^> Extensions ^> OpenPodCut
pause
