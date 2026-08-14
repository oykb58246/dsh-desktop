; Persist the selected installation folder for both a supportable audit trail and
; the next installation run.  The per-machine NSIS installer elevates before the
; install section runs, so C:\ is writable at that point.
;
; electron-builder prepends this file to the generated installer.nsi, so the
; macros below override the default (empty) hooks:
;   - customInit runs inside Function .onInit, after elevation and before the
;     installation-directory page is shown.  It preselects the folder recorded
;     by the previous run and falls back to the default program-files location.
;   - customInstall runs at the end of the install section, after the files are
;     copied, and records the folder the user finally chose.
;
; Named labels are used instead of relative jumps so the control flow cannot
; be broken by miscounted offsets when the macros are expanded inline.

!macro customInit
  StrCpy $INSTDIR "$PROGRAMFILES64\DSH Desktop"
  IfFileExists "C:\dsh-desktop.ini" 0 dsh_desktop_init_default
  ReadINIStr $R0 "C:\dsh-desktop.ini" "DSH Desktop" "InstallPath"
  StrCmp $R0 "" dsh_desktop_init_default 0
  StrCpy $INSTDIR $R0
  dsh_desktop_init_default:
!macroend

!macro customInstall
  WriteINIStr "C:\dsh-desktop.ini" "DSH Desktop" "InstallPath" "$INSTDIR"
!macroend
; initMultiUser normally ships in electron-builder's assistedInstaller.nsh, which
; the custom installer script does not include.  Provide it here so both the
; installer and the uninstaller build resolve it.
!macro initMultiUser
  !ifdef INSTALL_MODE_PER_ALL_USERS
    !insertmacro setInstallModePerAllUsers
  !else
    ${If} ${UAC_IsInnerInstance}
    ${AndIfNot} ${UAC_IsAdmin}
      # special return value for outer instance so it knows we did not have admin rights
      SetErrorLevel 0x666666
      Quit
    ${endIf}

    !ifndef MULTIUSER_INIT_TEXT_ADMINREQUIRED
      !define MULTIUSER_INIT_TEXT_ADMINREQUIRED "$(^Caption) requires administrator privileges."
    !endif

    !ifndef MULTIUSER_INIT_TEXT_POWERREQUIRED
      !define MULTIUSER_INIT_TEXT_POWERREQUIRED "$(^Caption) requires at least Power User privileges."
    !endif

    !ifndef MULTIUSER_INIT_TEXT_ALLUSERSNOTPOSSIBLE
      !define MULTIUSER_INIT_TEXT_ALLUSERSNOTPOSSIBLE "Your user account does not have sufficient privileges to install $(^Name) for all users of this computer."
    !endif

    StrCpy $hasPerMachineInstallation "0"
    StrCpy $hasPerUserInstallation "0"

    ReadRegStr $perMachineInstallationFolder HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${if} $perMachineInstallationFolder != ""
      StrCpy $hasPerMachineInstallation "1"
    ${endif}

    ReadRegStr $perUserInstallationFolder HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${if} $perUserInstallationFolder != ""
      StrCpy $hasPerUserInstallation "1"
    ${endif}

    ${GetParameters} $R0
    ${GetOptions} $R0 "/allusers" $R1
    ${IfNot} ${Errors}
      StrCpy $hasPerMachineInstallation "1"
      StrCpy $hasPerUserInstallation "0"
    ${EndIf}

    ${GetOptions} $R0 "/currentuser" $R1
    ${IfNot} ${Errors}
      StrCpy $hasPerMachineInstallation "0"
      StrCpy $hasPerUserInstallation "1"
    ${EndIf}

    ${if} $hasPerUserInstallation == "1"
    ${andif} $hasPerMachineInstallation == "0"
      !insertmacro setInstallModePerUser
    ${elseif} $hasPerUserInstallation == "0"
      ${andif} $hasPerMachineInstallation == "1"
      !insertmacro setInstallModePerAllUsers
    ${else}
      !ifdef INSTALL_MODE_PER_ALL_USERS
        !insertmacro setInstallModePerAllUsers
      !else
        !ifdef INSTALL_MODE_PER_ALL_USERS_DEFAULT
          !insertmacro setInstallModePerAllUsers
        !else
          !insertmacro setInstallModePerUser
        !endif
      !endif
    ${endif}
  !endif
!macroend
