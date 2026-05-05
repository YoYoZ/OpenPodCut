@echo off
REM Signs the cep-extension folder into a .zxp file using the bundled self-signed cert.
REM Run from the repo root OR from the install\ folder — script always resolves paths correctly.

cd /d "%~dp0.."

set "SIGN=%~dp0ZXPSignCmd.exe"
set "SRC=%CD%\cep-extension"
set "P12=%~dp0selfsigned.p12"
set "PASS=openpodcut"

REM Read version from manifest
for /f "tokens=3 delims= " %%v in ('findstr /i "ExtensionBundleVersion" "%SRC%\CSXS\manifest.xml"') do (
    set "RAW=%%v"
    goto :found
)
:found
for /f "tokens=2 delims==""" %%v in ("%RAW%") do set "VER=%%v"

set "OUT=%~dp0OpenPodCut-v%VER%.zxp"

echo Signing %SRC% ...
"%SIGN%" -sign "%SRC%" "%OUT%" "%P12%" "%PASS%"

if %ERRORLEVEL% EQU 0 (
    echo [OK] Created %OUT%
) else (
    echo [FAIL] Signing failed - exit code %ERRORLEVEL%
    exit /b 1
)
