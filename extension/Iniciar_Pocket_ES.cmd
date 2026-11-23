@echo off
uvx pocket-tts serve --language spanish --host 127.0.0.1 --port 8766
if errorlevel 1 pause
