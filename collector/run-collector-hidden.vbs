' Launches run-collector.cmd with no visible console window (window style 0).
' Resolves the .cmd next to this script so the folder can be moved without breaking the task.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("Wscript.Shell").Run "cmd /c """ & dir & "\run-collector.cmd""", 0, False
