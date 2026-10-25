; electron-builder runs this in its Unicode NSIS installer. Explicitly create
; launch shortcuts to the packaged Electron executable: the POS must never
; depend on a VBS, PowerShell, browser, or system Node.js launcher.

; The published v0.2.2 installer used Inno Setup. Its AppId creates this HKCU
; uninstall key. Electron Builder uses a different installer implementation,
; so it cannot discover that key automatically. Reuse only the recorded legacy
; install directory when its launcher is present; financial data lives outside
; the installation directory and is never copied, reset, or removed here.
!macro customInit
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\{5D39E18D-5FC2-4A76-8E89-3D864EC4A98D}_is1" "Inno Setup: App Path"
  ${If} $0 == ""
    ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\{5D39E18D-5FC2-4A76-8E89-3D864EC4A98D}_is1" "InstallLocation"
  ${EndIf}
  ${If} $0 != ""
    IfFileExists "$0\Launch-RestaurantPOS.vbs" 0 +2
      StrCpy $INSTDIR $0
  ${EndIf}
!macroend

!macro customInstall
  CreateShortCut "$DESKTOP\مطعم أفندينا.lnk" "$INSTDIR\RestaurantPOS.exe"
  CreateShortCut "$SMPROGRAMS\مطعم أفندينا.lnk" "$INSTDIR\RestaurantPOS.exe"
!macroend

!macro customUnInstall
  Delete "$DESKTOP\مطعم أفندينا.lnk"
  Delete "$SMPROGRAMS\مطعم أفندينا.lnk"
!macroend
