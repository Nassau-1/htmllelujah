!macro HTMLLELUJAH_PRUNE_HDECK_ASSOCIATION
  ReadRegStr $R0 SHELL_CONTEXT "Software\Classes\.hdeck" ""
  StrCmp $R0 "HTMLlelujah presentation" 0 association_not_owned
    DeleteRegValue SHELL_CONTEXT "Software\Classes\.hdeck" ""

  association_not_owned:
  DeleteRegKey /ifempty SHELL_CONTEXT "Software\Classes\.hdeck\OpenWithProgids"
  DeleteRegKey /ifempty SHELL_CONTEXT "Software\Classes\.hdeck"
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
