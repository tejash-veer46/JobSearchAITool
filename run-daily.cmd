@echo off
rem Daily job fetch and scoring. Run by the "JobApplyAI daily fetch" scheduled task.
cd /d "%~dp0"
echo ==== %date% %time% >> data\run.log
call npm run -s cli -- run >> data\run.log 2>&1
