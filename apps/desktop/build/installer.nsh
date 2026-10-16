; Windows installer additions (electron-builder nsis.include). Per-user install, so everything goes to HKCU.

; Open with Frameshell for videos (#184): a ProgID plus an OpenWithProgids entry per extension. Explorer lists the app
; in Open with; the extension's default program stays the user's choice.
!macro frameshellVideoTypes ACTION
  !insertmacro ${ACTION} "mp4"
  !insertmacro ${ACTION} "mov"
  !insertmacro ${ACTION} "m4v"
  !insertmacro ${ACTION} "mkv"
  !insertmacro ${ACTION} "webm"
!macroend

!macro frameshellOpenWithAdd EXT
  WriteRegStr HKCU "Software\Classes\.${EXT}\OpenWithProgids" "Frameshell.Video" ""
!macroend

!macro frameshellOpenWithRemove EXT
  DeleteRegValue HKCU "Software\Classes\.${EXT}\OpenWithProgids" "Frameshell.Video"
!macroend

!macro customInstall
  WriteRegStr HKCU "Software\Classes\Frameshell.Video" "" "Video"
  WriteRegStr HKCU "Software\Classes\Frameshell.Video" "FriendlyTypeName" "Video"
  WriteRegStr HKCU "Software\Classes\Frameshell.Video\DefaultIcon" "" "$appExe,0"
  WriteRegStr HKCU "Software\Classes\Frameshell.Video\shell\open" "FriendlyAppName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "Software\Classes\Frameshell.Video\shell\open\command" "" '"$appExe" "%1"'
  !insertmacro frameshellVideoTypes frameshellOpenWithAdd
  ; SHCNE_ASSOCCHANGED: Explorer rereads associations without a sign-out.
  System::Call "shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)"
!macroend

!macro customUnInstall
  !insertmacro frameshellVideoTypes frameshellOpenWithRemove
  DeleteRegKey HKCU "Software\Classes\Frameshell.Video"
  System::Call "shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)"
!macroend
