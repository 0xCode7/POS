Option Explicit

Dim shell, filesystem, root, command, powerShell, argument
Set shell = CreateObject("WScript.Shell")
Set filesystem = CreateObject("Scripting.FileSystemObject")
root = filesystem.GetParentFolderName(WScript.ScriptFullName)
powerShell = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
If Not filesystem.FileExists(powerShell) Then powerShell = "powershell.exe"

command = """" & powerShell & """ -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & root & "\Start-RestaurantPOS.ps1""" -ShowErrorDialog"
For Each argument In WScript.Arguments
  command = command & " " & QuoteArgument(argument)
Next
shell.Run command, 0, False

Function QuoteArgument(value)
  QuoteArgument = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
