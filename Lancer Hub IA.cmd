@echo off
rem Lance le Hub IA (reconstruit l'appli puis l'ouvre). Laisse cette fenetre ouverte : elle affiche les journaux.
cd /d "%~dp0"
rem Si Windows n'a pas encore pris en compte l'installation de Node, on l'ajoute nous-memes.
where npm >nul 2>nul || set "PATH=%ProgramFiles%\nodejs;%PATH%"
call npm start
if errorlevel 1 pause
