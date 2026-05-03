@echo off
REM Copy Podcast Cutter extension to Premiere Pro CEP extensions folder

set "DEST=%APPDATA%\Adobe\CEP\extensions\podcast-cutter"
set "SRC=%~dp0..\cep-extension"

echo Installing Podcast Cutter to:
echo %DEST%
echo.

if not exist "%SRC%\bin\analyzer.exe" (
    echo ERROR: analyzer.exe not found.
    echo Build it first: cd analyzer ^& build.bat
    pause
    exit /b 1
)

if exist "%DEST%" (
    echo Removing old installation...
    rmdir /s /q "%DEST%"
)

mkdir "%DEST%"
xcopy /e /i /q "%SRC%\*" "%DEST%\"

echo.
echo Done! Open Premiere Pro and go to Window ^> Extensions ^> Podcast Cutter
pause
