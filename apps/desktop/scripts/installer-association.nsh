!include LogicLib.nsh

!define HTMLLELUJAH_HDECK_EXTENSION_KEY "Software\Classes\.hdeck"
!define HTMLLELUJAH_HDECK_PROGID "HTMLlelujah presentation"

!ifndef BUILD_UNINSTALLER
  Var htmllelujahPriorHdeckProgId

  !macro HTMLLELUJAH_RESTORE_FOREIGN_HDECK_DEFAULT
    ${If} $htmllelujahPriorHdeckProgId != ""
    ${AndIf} $htmllelujahPriorHdeckProgId != "${HTMLLELUJAH_HDECK_PROGID}"
      WriteRegStr SHELL_CONTEXT "${HTMLLELUJAH_HDECK_EXTENSION_KEY}" "" $htmllelujahPriorHdeckProgId
      System::Call 'shell32::SHChangeNotify(i, i, i, i) v (0x08000000, 0x1000, 0, 0)'
    ${EndIf}
  !macroend

  !macro HTMLLELUJAH_ROLL_BACK_FAILED_HDECK_DEFAULT
    ${If} $htmllelujahPriorHdeckProgId == ""
      ReadRegStr $R0 SHELL_CONTEXT "${HTMLLELUJAH_HDECK_EXTENSION_KEY}" ""
      ${If} $R0 == "${HTMLLELUJAH_HDECK_PROGID}"
        DeleteRegValue SHELL_CONTEXT "${HTMLLELUJAH_HDECK_EXTENSION_KEY}" ""
      ${EndIf}
    ${Else}
      !insertmacro HTMLLELUJAH_RESTORE_FOREIGN_HDECK_DEFAULT
    ${EndIf}
    System::Call 'shell32::SHChangeNotify(i, i, i, i) v (0x08000000, 0x1000, 0, 0)'
  !macroend

  # initMultiUser has already selected SHELL_CONTEXT when electron-builder expands customInit.
  # Capture the current default before repair/upgrade uninstalls the old version or APP_ASSOCIATE
  # writes HTMLlelujah. customInstall runs immediately after APP_ASSOCIATE and restores a foreign
  # default while leaving the product's OpenWithProgids value registered.
  !macro customInit
    ReadRegStr $htmllelujahPriorHdeckProgId SHELL_CONTEXT "${HTMLLELUJAH_HDECK_EXTENSION_KEY}" ""
  !macroend

  !macro customInstall
    !insertmacro HTMLLELUJAH_RESTORE_FOREIGN_HDECK_DEFAULT
  !macroend

  # A failed install rolls the default back to its captured state. User cancellation can occur
  # on UI pages before registration or after a completed section, so it only reapplies a captured
  # foreign default; doing so is harmless in either phase.
  Function .onInstFailed
    !insertmacro HTMLLELUJAH_ROLL_BACK_FAILED_HDECK_DEFAULT
  FunctionEnd

  Function .onUserAbort
    !insertmacro HTMLLELUJAH_RESTORE_FOREIGN_HDECK_DEFAULT
  FunctionEnd
!endif

!macro HTMLLELUJAH_PRUNE_HDECK_ASSOCIATION
  ReadRegStr $R0 SHELL_CONTEXT "${HTMLLELUJAH_HDECK_EXTENSION_KEY}" ""
  StrCmp $R0 "${HTMLLELUJAH_HDECK_PROGID}" 0 association_not_owned
    DeleteRegValue SHELL_CONTEXT "${HTMLLELUJAH_HDECK_EXTENSION_KEY}" ""

  association_not_owned:
  DeleteRegKey /ifempty SHELL_CONTEXT "${HTMLLELUJAH_HDECK_EXTENSION_KEY}\OpenWithProgids"
  DeleteRegKey /ifempty SHELL_CONTEXT "${HTMLLELUJAH_HDECK_EXTENSION_KEY}"
!macroend

# electron-builder removes the product ProgID and its OpenWithProgids value, but its upstream
# APP_UNASSOCIATE macro intentionally leaves the extension's default value behind. Run after the
# normal uninstall section so only product-owned, now-empty association keys are pruned.
!ifdef BUILD_UNINSTALLER
  Function un.onUninstSuccess
    !insertmacro HTMLLELUJAH_PRUNE_HDECK_ASSOCIATION
    System::Call 'shell32::SHChangeNotify(i, i, i, i) v (0x08000000, 0x1000, 0, 0)'
  FunctionEnd
!endif
