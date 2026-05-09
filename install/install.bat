@echo off
setlocal EnableDelayedExpansion
REM OpenPodCut installer
REM Run this file from inside the extracted zip folder.

cd /d "%~dp0"

echo ============================================================
echo  OpenPodCut Installer
echo ============================================================
echo.

REM ── Locate ZXP (optional — only present in signed releases) ──────────────────
set "ZXP="
for %%f in ("OpenPodCut-v*.zxp") do set "ZXP=%%~ff"

REM ── Try ZXP install via UPIA (Adobe installer CLI) ───────────────────────────
if defined ZXP (
    echo Found ZXP: %ZXP%
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
        echo Installing via Adobe Extension installer...
        "!UPIA!" --install="!ZXP!"
        if !ERRORLEVEL! EQU 0 (
            echo.
            echo [OK] Extension installed via ZXP.
            echo Restart Premiere Pro, then go to Window ^> Extensions ^> OpenPodCut
            goto :done
        )
        echo [WARN] ZXP installer returned an error -- falling back to direct copy.
        echo.
    ) else (
        echo [INFO] Adobe installer not found -- using direct copy instead.
        echo.
    )
)

REM ── Direct copy ───────────────────────────────────────────────────────────────
set "SRC=%~dp0..\cep-extension"
set "DEST=%APPDATA%\Adobe\CEP\extensions\podcast-cutter"

echo Source:      %SRC%
echo Destination: %DEST%
echo.

if not exist "%SRC%" (
    echo ERROR: cep-extension folder not found at:
    echo   %SRC%
    echo.
    echo Make sure you are running install.bat from inside the extracted zip folder.
    goto :fail
)

if not exist "%SRC%\bin\analyzer\analyzer.exe" (
    echo ERROR: analyzer.exe not found at:
    echo   %SRC%\bin\analyzer\analyzer.exe
    echo.
    echo The zip may be incomplete or corrupted. Please re-download from GitHub releases.
    goto :fail
)

if exist "%DEST%" (
    echo Removing previous installation...
    rmdir /s /q "%DEST%"
)

mkdir "%DEST%"
xcopy /e /i /q "%SRC%\*" "%DEST%\"
if !ERRORLEVEL! NEQ 0 (
    echo ERROR: xcopy failed with error !ERRORLEVEL!
    goto :fail
)

echo.
echo [OK] Extension installed.
echo.
echo If the panel does not appear in Premiere:
echo   1. Run enable_debug_mode.bat as Administrator
echo   2. Restart Premiere Pro
echo   3. Go to Window ^> Extensions ^> OpenPodCut

:done
echo.
pause
exit /b 0

:fail
echo.
echo Installation failed. See message above.
echo.
pause
exit /b 1
