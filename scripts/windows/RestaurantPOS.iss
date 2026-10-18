#define AppName "Restaurant POS"
#ifndef ReleaseVersion
  #define ReleaseVersion "0.1.0"
#endif
#ifndef SourceRoot
  #error SourceRoot must be provided by Build-Release.ps1
#endif
#ifndef ReleaseDirectory
  #error ReleaseDirectory must be provided by Build-Release.ps1
#endif

[Setup]
AppId={{5D39E18D-5FC2-4A76-8E89-3D864EC4A98D}
AppName={#AppName}
AppVersion={#ReleaseVersion}
AppPublisher=Restaurant POS
DefaultDirName={localappdata}\Programs\Restaurant POS
DefaultGroupName=Restaurant POS
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#ReleaseDirectory}
OutputBaseFilename=RestaurantPOS-Setup
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=Restaurant POS
CloseApplications=no
RestartApplications=no
DisableWelcomePage=no

[Languages]
Name: "arabic"; MessagesFile: "compiler:Languages\Arabic.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "إنشاء اختصار على سطح المكتب"; GroupDescription: "اختصارات إضافية:"

[Files]
Source: "{#ReleaseDirectory}\RestaurantPOS-portable\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Restaurant POS"; Filename: "{app}\Launch-RestaurantPOS.vbs"; WorkingDir: "{app}"
Name: "{autodesktop}\Restaurant POS"; Filename: "{app}\Launch-RestaurantPOS.vbs"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\Launch-RestaurantPOS.vbs"; Description: "تشغيل Restaurant POS الآن"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}"
