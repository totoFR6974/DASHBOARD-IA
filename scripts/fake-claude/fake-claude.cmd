@echo off
rem Faux CLI "claude" (tests du Hub IA, sans quota) : lance fake-claude.mjs avec Node.
rem Pour le hub, HUB_CLAUDE_BIN peut pointer vers ce .cmd : le hub lance alors directement le .mjs voisin.
rem (fichier en ASCII : cmd.exe lit les .cmd dans la page de code de la console)
node "%~dp0fake-claude.mjs" %*
