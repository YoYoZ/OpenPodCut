@echo off
REM Build analyzer.exe with PyInstaller, then auto-deploy to CEP extension.
REM Run from any directory -- script always cd's to its own folder first.

cd /d "%~dp0"

echo Installing dependencies...
pip install -r requirements.txt --quiet
pip install pyinstaller --quiet

echo Building analyzer.exe...

for /f "delims=" %%i in ('python -c "import silero_vad, os; print(os.path.dirname(silero_vad.__file__))"') do set "SILERO_PATH=%%i"
echo Silero-VAD path: %SILERO_PATH%

pyinstaller ^
    --onedir ^
    --noupx ^
    --noconfirm ^
    --name analyzer ^
    --distpath ..\cep-extension\bin ^
    --workpath build\work ^
    --specpath build ^
    --collect-all silero_vad ^
    --collect-all torchaudio ^
    --collect-all soundfile ^
    --hidden-import torchaudio ^
    --hidden-import torchaudio.functional ^
    --hidden-import torchaudio.transforms ^
    --hidden-import soundfile ^
    analyzer.py

if not exist "..\cep-extension\bin\analyzer\analyzer.exe" (
    echo [FAIL] Build failed - check output above
    exit /b 1
)
echo [OK] analyzer.exe built successfully

REM --- Deploy to AppData CEP extension ---
set "DEST=%APPDATA%\Adobe\CEP\extensions\podcast-cutter"
echo Deploying to %DEST%...

robocopy "..\cep-extension\bin\analyzer" "%DEST%\bin\analyzer" /E /PURGE /NFL /NDL /NJH /NJS

REM Remove stale .py source files (exe ignores them, they only cause confusion)
if exist "%DEST%\bin\analyzer\analyzer.py" del "%DEST%\bin\analyzer\analyzer.py"
if exist "%DEST%\bin\analyzer\cuts.py"     del "%DEST%\bin\analyzer\cuts.py"
if exist "%DEST%\bin\analyzer\vad.py"      del "%DEST%\bin\analyzer\vad.py"

copy /Y "..\cep-extension\index.html"    "%DEST%\index.html"    >nul
copy /Y "..\cep-extension\main.js"       "%DEST%\main.js"       >nul
copy /Y "..\cep-extension\host\host.jsx" "%DEST%\host\host.jsx" >nul

echo [OK] Deploy complete -- reload CEP panel in Premiere.
