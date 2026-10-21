; Windows installer additions (electron-builder nsis.include). Per-user install, so everything goes to HKCU.

!include "nsDialogs.nsh"
!include "LogicLib.nsh"

; Open with Frameshell for videos, audio and images (#184, ADR 0015, 0017): a ProgID plus an OpenWithProgids entry per extension.
; Explorer lists the app in Open with; the extension's default program stays the user's choice. The ProgID keeps its first
; name, Frameshell.Video, so an update still finds and removes what an older installer wrote.
; "Edit with Frameshell" in the right-click menu of those files (#185), when the installer's box is checked.
!macro frameshellVideoTypes ACTION
  !insertmacro ${ACTION} "mp4"
  !insertmacro ${ACTION} "mov"
  !insertmacro ${ACTION} "m4v"
  !insertmacro ${ACTION} "mkv"
  !insertmacro ${ACTION} "webm"
  !insertmacro ${ACTION} "wav"
  !insertmacro ${ACTION} "mp3"
  !insertmacro ${ACTION} "m4a"
  !insertmacro ${ACTION} "aac"
  !insertmacro ${ACTION} "flac"
  !insertmacro ${ACTION} "ogg"
  !insertmacro ${ACTION} "opus"
  !insertmacro ${ACTION} "png"
  !insertmacro ${ACTION} "jpg"
  !insertmacro ${ACTION} "jpeg"
  !insertmacro ${ACTION} "gif"
  !insertmacro ${ACTION} "webp"
!macroend

!macro frameshellOpenWithAdd EXT
  WriteRegStr HKCU "Software\Classes\.${EXT}\OpenWithProgids" "Frameshell.Video" ""
!macroend

!macro frameshellOpenWithRemove EXT
  DeleteRegValue HKCU "Software\Classes\.${EXT}\OpenWithProgids" "Frameshell.Video"
!macroend

!macro frameshellContextMenuAdd EXT
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.${EXT}\shell\Frameshell" "" "Edit with Frameshell"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.${EXT}\shell\Frameshell" "Icon" "$appExe,0"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.${EXT}\shell\Frameshell\command" "" '"$appExe" "%1"'
!macroend

!macro frameshellContextMenuRemove EXT
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.${EXT}\shell\Frameshell"
!macroend

!ifndef BUILD_UNINSTALLER
  ; 1 = add the context menu entry. Checked by default; an update (silent, no pages) keeps the earlier choice.
  Var frameshellContextMenu
  Var frameshellContextMenuBox

  !macro customInit
    StrCpy $frameshellContextMenu 1
    ReadRegStr $0 HKCU "Software\Frameshell" "ContextMenu"
    ${If} $0 == "0"
      StrCpy $frameshellContextMenu 0
    ${EndIf}
  !macroend

  ; Expanded among the installer's page declarations, after MUI2 is included: the page functions live here too.
  !macro customPageAfterChangeDir
    Page custom frameshellOptionsPage frameshellOptionsLeave

  Function frameshellOptionsPage
    !insertmacro MUI_HEADER_TEXT "Options" "Choose how Frameshell fits into Explorer."
    nsDialogs::Create 1018
    Pop $0
    ${NSD_CreateCheckbox} 0 0 100% 12u "Add $\"Edit with Frameshell$\" to the right-click menu of videos, audio and images"
    Pop $frameshellContextMenuBox
    ${If} $frameshellContextMenu == 1
      ${NSD_Check} $frameshellContextMenuBox
    ${EndIf}
    ${NSD_CreateLabel} 0 18u 100% 24u "Frameshell is also listed in $\"Open with$\" for videos, audio and images. It never becomes their default program."
    Pop $0
    nsDialogs::Show
  FunctionEnd

  Function frameshellOptionsLeave
    ${NSD_GetState} $frameshellContextMenuBox $frameshellContextMenu
  FunctionEnd
  !macroend

  !macro customInstall
    WriteRegStr HKCU "Software\Classes\Frameshell.Video" "" "Video"
    WriteRegStr HKCU "Software\Classes\Frameshell.Video" "FriendlyTypeName" "Video"
    WriteRegStr HKCU "Software\Classes\Frameshell.Video\DefaultIcon" "" "$appExe,0"
    WriteRegStr HKCU "Software\Classes\Frameshell.Video\shell\open" "FriendlyAppName" "${PRODUCT_NAME}"
    WriteRegStr HKCU "Software\Classes\Frameshell.Video\shell\open\command" "" '"$appExe" "%1"'
    !insertmacro frameshellVideoTypes frameshellOpenWithAdd
    ${If} $frameshellContextMenu == 1
      !insertmacro frameshellVideoTypes frameshellContextMenuAdd
    ${Else}
      !insertmacro frameshellVideoTypes frameshellContextMenuRemove
    ${EndIf}
    WriteRegStr HKCU "Software\Frameshell" "ContextMenu" "$frameshellContextMenu"
    ; SHCNE_ASSOCCHANGED: Explorer rereads associations without a sign-out.
    System::Call "shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)"
  !macroend
!endif

!macro customUnInstall
  !insertmacro frameshellVideoTypes frameshellOpenWithRemove
  !insertmacro frameshellVideoTypes frameshellContextMenuRemove
  DeleteRegKey HKCU "Software\Classes\Frameshell.Video"
  ; An update runs the old uninstaller after the new installer read the choice, so dropping it here is safe.
  DeleteRegValue HKCU "Software\Frameshell" "ContextMenu"
  DeleteRegKey /ifempty HKCU "Software\Frameshell"
  System::Call "shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)"
!macroend
