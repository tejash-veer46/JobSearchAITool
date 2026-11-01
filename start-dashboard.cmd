@echo off
rem Double-click to open the JobApplyAI dashboard. It prefills the next batch of jobs on start.
cd /d "%~dp0"
title JobApplyAI dashboard (close this window to stop)
call npm run -s cli -- dashboard
pause
