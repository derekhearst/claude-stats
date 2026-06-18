@echo off
REM Wrapper for Windows Task Scheduler. Runs the collector once.
cd /d "%~dp0"
bun collect.mjs >> collector.log 2>&1
