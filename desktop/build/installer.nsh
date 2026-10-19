; electron-builder runs this in its Unicode NSIS installer. Explicitly create
; launch shortcuts to the packaged Electron executable: the POS must never
; depend on a VBS, PowerShell, browser, or system Node.js launcher.
!macro customInstall
  CreateShortCut "$DESKTOP\مطعم أفندينا.lnk" "$INSTDIR\RestaurantPOS.exe"
  CreateShortCut "$SMPROGRAMS\مطعم أفندينا.lnk" "$INSTDIR\RestaurantPOS.exe"
!macroend

!macro customUnInstall
  Delete "$DESKTOP\مطعم أفندينا.lnk"
  Delete "$SMPROGRAMS\مطعم أفندينا.lnk"
!macroend
