; 鲸鱼娘桌宠 — Inno Setup 打包脚本
;
; 编译：ISCC.exe build\installer.iss
; 前置：先跑 npm run build:dir，产出 dist\win-unpacked\
;
; 安装目录默认是「安装程序所在文件夹」下建同名子文件夹 —— Inno 的 {src}
; 常量就是 setup 文件所在目录，正好对上这个需求。
;
; 所有路径都锚定到 {#SourcePath}（脚本自身所在目录，ISPP 预定义），
; 不依赖编译时的工作目录。

#define AppName "鲸鱼娘桌宠"
#define AppVersion "1.2.0"
#define AppPublisher "星空"
#define AppExeName "鲸鱼娘桌宠.exe"
#define RootDir SourcePath + ".."
#define AppDir RootDir + "\dist\win-unpacked"

[Setup]
; 固定 AppId：升级安装时靠它识别同一个程序，不要改
AppId={{8F3A7C21-4E5B-4A9D-9C6E-2B1D7F0A3E84}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
VersionInfoVersion={#AppVersion}

; {src} = setup 文件所在目录。装到它下面的同名子文件夹，而不是把文件直接
; 撒在 setup 旁边。
DefaultDirName={src}\{#AppName}
DisableDirPage=no
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes

; 桌宠不需要管理员权限；万一装到受保护目录（比如 Program Files），
; 允许用户在向导里主动提权。
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog

OutputDir={#RootDir}\dist
; 文件名用 ASCII：GitHub 的 release 附件名不接受非 ASCII（中文会被清洗成
; "-.-1.0.0.exe" 这种），而且中文经 bash 传给 gh 时还会被转码破坏。
; 对外显示的中文名走 AppName / 窗口标题 / 快捷方式，不受影响。
OutputBaseFilename=whale-girl-pet-setup-{#AppVersion}
SetupIconFile={#RootDir}\assets\icon.ico
UninstallDisplayIcon={app}\{#AppExeName}
UninstallDisplayName={#AppName}

; Electron 自己的文件用 LZMA 压得很狠（370MB → ~100MB）。
; 素材是另一回事，见下面 [Files] 里的 nocompression。
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "chinesesimplified"; MessagesFile: "{#SourcePath}ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "快捷方式"; Flags: checkedonce

[Files]
; 程序与运行时：压缩
Source: "{#AppDir}\*"; DestDir: "{app}"; Excludes: "素材,蓝色大肥鱼表情包"; \
    Flags: ignoreversion recursesubdirs createallsubdirs

; 素材：GIF 已经压过了，再走一遍 LZMA 大约只能省 0.5%，却把打包时间从
; 几十秒拖到十几分钟。直接存。
Source: "{#AppDir}\素材\*"; DestDir: "{app}\素材"; \
    Flags: ignoreversion recursesubdirs createallsubdirs nocompression
Source: "{#AppDir}\蓝色大肥鱼表情包\*"; DestDir: "{app}\蓝色大肥鱼表情包"; \
    Flags: ignoreversion recursesubdirs createallsubdirs nocompression

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExeName}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "立即启动 {#AppName}"; \
    Flags: nowait postinstall skipifsilent
