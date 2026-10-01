; NSIS additions for the Windows installer (package.json build.nsis.include).
;
; The adb server StickPilot starts runs from the install folder. If it's still running
; (the app was force-closed, or this is an update over a running copy), Windows won't
; let its files be replaced or deleted. Stop that adb, and only that one: an adb from
; another install (Android Studio, platform-tools) is left alone.

!macro stopBundledAdb
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-Process -Name adb -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like '*\StickPilot\resources\vendor\*' } | Stop-Process -Force -ErrorAction SilentlyContinue"`
  Pop $0
!macroend

; Install or update: before any file is copied
!macro customInit
  !insertmacro stopBundledAdb
!macroend

; Uninstall: after StickPilot itself was closed, before its files are removed
!macro customUnInstall
  !insertmacro stopBundledAdb
!macroend
