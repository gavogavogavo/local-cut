@echo off
cd /d "%~dp0"
title Local Cut Editor
echo Open http://127.0.0.1:4181 after the editor says ready.
echo Keep this window open while editing and exporting.
call npm start
pause
