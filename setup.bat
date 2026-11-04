@echo off
rem JobApplyAI setup / update. Double-click it, or run .\setup.bat in PowerShell.
rem First time: installs everything. Later: pulls the latest code from GitHub and updates.
rem Your own files (resume, config\profile.yaml, config\search.yaml, data, reports, .env)
rem are git-ignored, so this never changes or deletes them.
setlocal EnableDelayedExpansion
cd /d "%~dp0"
title JobApplyAI setup
echo.
echo === JobApplyAI setup / update ===
echo.

where git >nul 2>nul
if errorlevel 1 (
  echo [X] Git is not installed. Install it from https://git-scm.com/downloads and run this again.
  goto :fail
)
where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js is not installed. Install the LTS version from https://nodejs.org and run this again.
  goto :fail
)
if not exist ".git" (
  echo [X] This folder is not a git clone, so it cannot update itself.
  echo     Download it with:  git clone https://github.com/tejash-veer46/JobSearchAITool.git
  goto :fail
)

rem Close the dashboard first: it locks files that npm may need to replace.
netstat -ano | findstr /r /c:"127.0.0.1:4317 .*LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo [!] The dashboard is running. Close its console window first, then run setup again.
  goto :fail
)

for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD') do set "BRANCH=%%b"
set STASHED=

rem Changes to the tool's own files would block the update: keep them safe in a git stash.
git diff --quiet
set CHANGED=%errorlevel%
git diff --cached --quiet
if not "%errorlevel%"=="0" set CHANGED=1
if not "%CHANGED%"=="0" (
  echo [i] You changed some of the tool's own files. Saving those changes aside ^(git stash^) so the update can go ahead...
  git stash push -m "setup.bat backup %date% %time%"
  if errorlevel 1 goto :fail
  set STASHED=1
)

if not "!BRANCH!"=="main" (
  echo [i] Switching from branch !BRANCH! to main...
  git checkout main
  if errorlevel 1 goto :fail
)

echo [1/4] Getting the latest code from GitHub...
git fetch origin main
if errorlevel 1 (
  echo [X] Could not reach GitHub. Check your internet connection and try again.
  goto :fail
)
git merge --ff-only origin/main
if errorlevel 1 (
  echo [X] Your copy has commits that are not on GitHub, so it cannot be updated automatically.
  echo     To discard them and match GitHub exactly, run:  git reset --hard origin/main
  goto :fail
)

echo [2/4] Installing / updating dependencies...
call npm install --no-audit --no-fund
if errorlevel 1 goto :fail

echo [3/4] Updating your config with new companies and settings...
call npm run -s cli -- sync-config
if errorlevel 1 goto :fail

echo [4/4] Checking the tool starts...
call npm run -s cli -- --help >nul
if errorlevel 1 goto :fail

echo.
for /f "delims=" %%v in ('git log -1 --format^="%%h  %%s  (%%cr)"') do echo [OK] Up to date: %%v
if defined STASHED (
  echo.
  echo [i] Your earlier changes to the tool's files are saved. To bring them back:  git stash pop
)
echo.
echo Start the dashboard with start-dashboard.cmd
echo.
pause
exit /b 0

:fail
echo.
echo Setup did not finish. Read the message above, fix it, and run setup.bat again.
echo.
pause
exit /b 1
