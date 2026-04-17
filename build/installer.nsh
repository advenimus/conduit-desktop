!macro customInstall
  ; Refresh Windows icon cache so updated icons appear immediately
  nsExec::ExecToLog 'ie4uinit.exe -show'
!macroend
