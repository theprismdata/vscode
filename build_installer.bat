@echo off
"%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe" ^
  /dNameLong="IntelliCen Studio" ^
  /dNameShort="IntelliCen Studio" ^
  /dVersion="1.112.0" ^
  /dRawVersion="1.112.0" ^
  /dNameVersion="IntelliCen Studio 1.112.0" ^
  /dSourceDir="F:\1.Developing\VSCode-win32-x64" ^
  /dRepoDir="F:\1.Developing\vscode" ^
  /dOutputDir="F:\1.Developing\installer-output" ^
  /dInstallTarget="system" ^
  /dAppId="{{D77B7E06-80BA-4137-BCF4-654B95CCEBC5}" ^
  /dDirName="IntelliCen Studio" ^
  /dExeBasename="intellicen-studio" ^
  /dArchitecturesAllowed="x64compatible" ^
  /dArchitecturesInstallIn64BitMode="x64compatible" ^
  /dVersionedResourcesFolder="." ^
  /dTunnelApplicationName="intellicen-studio-tunnel" ^
  /dRegValueName="IntelliCenStudio" ^
  /dAppUserId="IntelliCen.Studio" ^
  /dProductJsonPath="F:\1.Developing\VSCode-win32-x64\resources\app\product.json" ^
  "F:\1.Developing\vscode\build\win32\code.iss"
