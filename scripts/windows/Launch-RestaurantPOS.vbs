Option Explicit

Dim shell, filesystem, root, command
Set shell = CreateObject("WScript.Shell")
Set filesystem = CreateObject("Scripting.FileSystemObject")
root = filesystem.GetParentFolderName(WScript.ScriptFullName)
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & root & "\Start-RestaurantPOS.ps1""" -ShowErrorDialog"
shell.Run command, 0, False
