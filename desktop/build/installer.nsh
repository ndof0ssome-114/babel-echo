; The assisted installer supplies the directory page. Uninstall asks before
; removing the app, keeps the old profile by default, and deletes it only after
; the normal uninstall section succeeds. Silent upgrades always keep data.

!ifdef BUILD_UNINSTALLER
  Var keepBabelEchoData
!endif

!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customUnInit
  StrCpy $keepBabelEchoData "1"
  ${IfNot} ${isUpdated}
    ${IfNot} ${Silent}
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "确定要卸载巴别回声吗？" IDYES +2
      Abort
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON1 "是否保留本机会议录音、转写、存档和设置？$\r$\n选择“是”将保留这些数据，便于重新安装后继续使用。$\r$\n选择“否”将在卸载完成后删除当前用户保存的全部巴别回声数据，包括 API Key。" IDYES +2
      StrCpy $keepBabelEchoData "0"
    ${EndIf}
  ${EndIf}
!macroend

!macro customUninstallPage
  UninstPage custom un.CleanupBabelEchoData
  Function un.CleanupBabelEchoData
    ${IfNot} ${isUpdated}
      ${If} $keepBabelEchoData == "0"
        ${If} $installMode == "all"
          SetShellVarContext current
        ${EndIf}
        RMDir /r "$APPDATA\miaoji-desktop"
        IfFileExists "$APPDATA\miaoji-desktop\*.*" 0 +2
          MessageBox MB_OK|MB_ICONEXCLAMATION "应用已卸载，但本机数据未能完全删除。请手动检查：$APPDATA\miaoji-desktop"
        ${If} $installMode == "all"
          SetShellVarContext all
        ${EndIf}
      ${EndIf}
    ${EndIf}
    ; No visible page is needed after the uninstall progress page.
    Abort
  FunctionEnd
!macroend
