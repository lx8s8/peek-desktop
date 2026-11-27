; Windows NSIS 安装与卸载前置钩子：
; 自动关闭正在运行的 Peek Desktop 主进程及子进程并等待文件锁释放，避免覆盖安装失败或弹窗打断。

!macro PeekStopRunningApp
  DetailPrint "Stopping running ${PRODUCTNAME} instances..."
  nsExec::Exec '"$SYSDIR\taskkill.exe" /IM "${MAINBINARYNAME}.exe"'
  Pop $0
  ${If} $0 = 0
    Sleep 400
  ${EndIf}
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM "${MAINBINARYNAME}.exe"'
  Pop $0
  ${If} $0 = 0
    Sleep 500
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro PeekStopRunningApp
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro PeekStopRunningApp
!macroend
