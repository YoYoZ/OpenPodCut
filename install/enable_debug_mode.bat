@echo off
REM Enable unsigned CEP extensions in Premiere Pro
REM Run as administrator

echo Enabling CEP debug mode for Premiere Pro...

REM Try CSXS versions 7 through 12 (covers Premiere 2018-2026)
for %%v in (7 8 9 10 11 12) do (
    reg add "HKEY_CURRENT_USER\SOFTWARE\Adobe\CSXS.%%v" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
)

echo Done. Restart Premiere Pro if it was open.
pause
