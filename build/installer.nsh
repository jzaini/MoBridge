; 覆盖 NSIS 安装目录的末段(APP_FILENAME)。
;
; 为什么需要:electron-builder 的目录名规则(targetUtil.js getWindowsInstallationDirName)
; 要求产品名只含 ASCII 字母数字,「墨桥」过不了,于是回退到包名 mo-bridge,并在安装时
; 强制在用户所选目录下再建一层 mo-bridge(assistedInstaller.nsh 的 StrContains 追加逻辑)。
;
; 覆盖成 MoBridge 后三处口径一致:
;   1. 安装目录追加检查用 MoBridge——用户所选路径已含 MoBridge 时(如 D:\app\AI\MoBridge)
;      不再追加,装到所选目录本身;
;   2. 默认目录 = %LOCALAPPDATA%\Programs\MoBridge;
;   3. 卸载清理 %APPDATA%\MoBridge——与主进程 userData 数据目录(显式设置为该路径)一致。
!undef APP_FILENAME
!define APP_FILENAME "MoBridge"
