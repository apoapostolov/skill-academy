' Autostart for Skill Academy: brings the service up hidden, with no console and no focus steal.
'
' Copy this file into the Startup folder:
'   %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\skill-academy-service.vbs
'
' It runs scripts/service.mjs, which writes ~/.skill-academy/start-app.vbs and then starts
' scripts/serve.mjs windowless with its output appended to ~/.skill-academy/logs/app.log.
' Stop it with `npm run stop` in the repository.
Set sh = CreateObject("WScript.Shell")
repo = "C:\git-public\skill-academy"
node = "C:\Program Files\nodejs\node.exe"
If Not CreateObject("Scripting.FileSystemObject").FileExists(node) Then node = "node.exe"
sh.CurrentDirectory = repo
sh.Run """" & node & """ """ & repo & "\scripts\service.mjs""", 0, False
