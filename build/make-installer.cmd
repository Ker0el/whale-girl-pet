@echo off
chcp 65001 >nul
setlocal

rem 鲸鱼娘桌宠 — 一条命令产出安装程序
rem
rem   1. electron-builder 产出 dist\win-unpacked\（程序 + 运行时 + 素材）
rem   2. Inno Setup 把它编成单文件安装程序
rem
rem 需要先装 Inno Setup 6（https://jrsoftware.org/isdl.php），
rem 并确保 Windows 区域设置里「Beta: 使用 Unicode UTF-8 提供全球语言支持」
rem 关闭 —— 中文文件名在区域设置不是 UTF-8 时会被 Inno 编成乱码。

cd /d "%~dp0.."

echo [1/2] 打包程序目录...
call npm run build:dir || goto :fail
if not exist "dist\win-unpacked\鲸鱼娘桌宠.exe" (
  echo      构建产物缺少 鲸鱼娘桌宠.exe
  goto :fail
)

echo.
echo [2/2] 查找 Inno Setup 编译器...

set "ISCC="
for %%P in (iscc.exe) do if not defined ISCC set "ISCC=%%~$PATH:P"
if not defined ISCC if exist "%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe" set "ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
if not defined ISCC if exist "%ProgramFiles%\Inno Setup 6\ISCC.exe" set "ISCC=%ProgramFiles%\Inno Setup 6\ISCC.exe"
if not defined ISCC if exist "D:\Program Files (x86)\Inno Setup 6\ISCC.exe" set "ISCC=D:\Program Files (x86)\Inno Setup 6\ISCC.exe"

if not defined ISCC (
  echo      找不到 ISCC.exe。请安装 Inno Setup 6，或把它加到 PATH。
  goto :fail
)
echo      使用 %ISCC%

"%ISCC%" "build\installer.iss" || goto :fail

echo.
echo 完成。安装程序在 dist\ 下。
exit /b 0

:fail
echo.
echo 构建失败。
exit /b 1
