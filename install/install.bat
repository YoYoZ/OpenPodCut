@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo ============================================================
echo  OpenPodCut Installer
echo ============================================================
echo.

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
    echo ERROR: Copy failed with code !ERRORLEVEL!
    goto :fail
)

echo.
echo [OK] Installed successfully.
echo.
echo Next steps:
echo   1. Run enable_debug_mode.bat as Administrator ^(only needed once^)
echo   2. Restart Premiere Pro
echo   3. Window ^> Extensions ^> OpenPodCut
echo.
pause
exit /b 0

:fail
echo.
echo Installation failed. See message above.
echo.
pause
exit /b 1
