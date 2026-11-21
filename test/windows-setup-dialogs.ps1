# Exercise only the unsigned test app's own MessageBox dialogs. A Windows policy
# or publisher prompt surfaces as a timeout, and never receives input from this test.
param([Parameter(Mandatory = $true)][string]$Setup)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Run the setup-dialog test only on a fresh GitHub-hosted Windows runner.'
}
if (![IO.Path]::IsPathFullyQualified($Setup)) { throw 'Provide an absolute installer path.' }
$exe = (Resolve-Path -LiteralPath $Setup).Path
$base = Join-Path $env:LOCALAPPDATA 'Programs/GrowthBrain'
$app = Join-Path $base app
$desktop = Join-Path $app 'GrowthBrain.exe'
$data = Join-Path $env:LOCALAPPDATA GrowthBrain
$link = Join-Path ([Environment]::GetFolderPath('Programs')) 'Growth Brain.lnk'
foreach ($path in $base, $data, $link) {
    if (Get-Item -Force -LiteralPath $path -ErrorAction SilentlyContinue) { throw "Refusing pre-existing path: $path" }
}
$regPath = 'SOFTWARE\Google\Chrome\NativeMessagingHosts\com.growthbrain.local'
function Get-NativeRegistrations {
    foreach ($view in [Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64) {
        $root = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
        try {
            $key = $root.OpenSubKey($regPath)
            if ($key) {
                try { [pscustomobject]@{ View = $view.ToString(); Manifest = [string]$key.GetValue('') } }
                finally { $key.Dispose() }
            }
        } finally { $root.Dispose() }
    }
}
if (@(Get-NativeRegistrations).Count) { throw 'Refusing pre-existing native registration.' }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class GrowthBrainSetupDialog {
  private delegate bool EnumProc(IntPtr window, IntPtr unused);
  [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr param);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr window,StringBuilder name,int chars);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr window,StringBuilder text,int chars);
  [DllImport("user32.dll")] private static extern IntPtr GetDlgItem(IntPtr dialog, int id);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageTimeoutW")]
  private static extern IntPtr ReadText(IntPtr h,uint m,IntPtr w,StringBuilder text,uint flags,uint timeout,out UIntPtr result);
  [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
  private static string Class(IntPtr window) {
    var s=new StringBuilder(64); GetClassName(window,s,s.Capacity); return s.ToString();
  }
  public static bool Click(IntPtr h,int pid,string expected,int id) {
    uint actual;
    GetWindowThreadProcessId(h,out actual);
    if(actual != (uint)pid || Class(h)!="#32770") return false;
    var title=new StringBuilder(100); GetWindowText(h,title,title.Capacity);
    if(title.ToString()!="Growth Brain 설치") return false;
    string body="";
    EnumChildWindows(h,delegate(IntPtr child,IntPtr unused) {
      if (Class(child)=="Static") {
        var text=new StringBuilder(2048); UIntPtr result;
        ReadText(child,13,(IntPtr)text.Capacity,text,2,1000,out result);
        body+=text.ToString();
      }
      return true;
    },IntPtr.Zero);
    if(body.Contains("작업을 마치지 못했습니다.")) throw new Exception(body);
    IntPtr button=GetDlgItem(h,id);
    if(!body.Contains(expected) || button==IntPtr.Zero) return false;
    // Send a normal button click only to this process and this exact prompt.
    return PostMessage(button,0x00F5,IntPtr.Zero,IntPtr.Zero);
  }
}
'@

function Click-Setup([Diagnostics.Process]$Process, [string]$Prompt, [int]$Button) {
    $end = [DateTime]::UtcNow.AddSeconds(150)
    do {
        $Process.Refresh()
        if ($Process.HasExited) { throw "Setup exited before the expected prompt: $Prompt" }
        $window = $Process.MainWindowHandle
        if ($window -ne [IntPtr]::Zero -and [GrowthBrainSetupDialog]::Click($window,$Process.Id,$Prompt,$Button)) { return }
        Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $end)
    throw "Setup dialog timed out: $Prompt"
}

function Invoke-Setup([bool]$Remove) {
    $p = Start-Process -FilePath $exe -PassThru
    try {
        if ($Remove) {
            Click-Setup $p '설치하거나 업데이트하려면' 7
            Click-Setup $p '앱을 제거할까요?' 6
            Click-Setup $p '앱을 제거했습니다.' 1
        } else {
            Click-Setup $p '설치하거나 업데이트하려면' 6
            Click-Setup $p '설치가 끝났습니다.' 7
        }
        if (!$p.WaitForExit(30000) -or $p.ExitCode -ne 0) { throw 'Setup failed to exit successfully.' }
    } finally {
        if (!$p.HasExited) { $p.Kill(); $p.WaitForExit() }
        $p.Dispose()
    }
}

function Assert-Installed {
    if (!(Test-Path -LiteralPath $desktop -PathType Leaf) -or !(Test-Path -LiteralPath $link -PathType Leaf)) {
        throw 'App or Start menu shortcut missing.'
    }
    $s = (New-Object -ComObject WScript.Shell).CreateShortcut($link)
    if ($s.TargetPath -ne $desktop -or $s.Arguments -ne '' -or $s.WorkingDirectory -ne $app) {
        throw 'Start menu shortcut does not launch the installed app.'
    }
}
$vault = Join-Path $data vault
$null = New-Item -ItemType Directory -Path $vault -Force
$sentinel = Join-Path $vault ('fixture-' + [guid]::NewGuid().ToString('N') + '.enc')
[IO.File]::WriteAllBytes($sentinel, [Security.Cryptography.RandomNumberGenerator]::GetBytes(64))
$hash = (Get-FileHash -LiteralPath $sentinel).Hash
Invoke-Setup $false
Assert-Installed
& (Join-Path $app NativeHost.exe) --register
if ($LASTEXITCODE -ne 0) { throw 'Synthetic native registration failed.' }
$registrations = @(Get-NativeRegistrations)
if (@($registrations.Manifest) -notcontains (Join-Path $app com.growthbrain.local.json)) { throw 'Owned native registration missing.' }
Invoke-Setup $false
Assert-Installed
if (@(Compare-Object $registrations @(Get-NativeRegistrations) -Property View,Manifest).Count) { throw 'Update changed registration.' }
Invoke-Setup $true
if ((Test-Path -LiteralPath $app) -or (Test-Path -LiteralPath $link) -or @(Get-NativeRegistrations).Count) {
    throw 'Uninstall left an app, shortcut or owned native registration.'
}
if ((Get-FileHash -LiteralPath $sentinel).Hash -ne $hash) { throw 'Uninstall changed the vault fixture.' }
# Leave failed fixtures for inspection. Delete only the known fixture and empty directories.
[IO.File]::Delete($sentinel)
[IO.Directory]::Delete($vault)
[IO.Directory]::Delete($data)
'Normal setup dialogs installed, updated and removed the packaged app and Start menu shortcut; the synthetic vault survived.'
