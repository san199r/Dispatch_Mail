Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
strPath = fso.GetParentFolderName(WScript.ScriptFullName)

WshShell.CurrentDirectory = strPath
WshShell.Run "cmd /c node server.js", 0, False

WScript.Sleep 2000
WshShell.Run "http://localhost:4173"
