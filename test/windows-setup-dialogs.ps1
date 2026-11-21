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
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class GrowthBrainSetupDialog {
  private delegate bool EnumProc(IntPtr window, IntPtr unused);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc callback, IntPtr param);
  [DllImport("user32.dll")] private static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr h);
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
  // A process can have multiple top-level dialogs with different owner windows.
  public static IntPtr[] Windows(int pid) {
    var result = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h,IntPtr unused) {
      uint owner; GetWindowThreadProcessId(h,out owner);
      if(owner==(uint)pid && IsWindowVisible(h)) result.Add(h);
      return true;
    },IntPtr.Zero);
    return result.ToArray();
  }
  private static string ReadBody(IntPtr h,out string ids) {
    var labels=new StringBuilder();
    var buttons=new List<int>();
    EnumChildWindows(h,delegate(IntPtr child,IntPtr unused) {
      string cls=Class(child);
      if(cls=="Static") {
        var text=new StringBuilder(1024); UIntPtr result;
        ReadText(child,13,(IntPtr)text.Capacity,text,2,300,out result);
        labels.Append(text.ToString());
      } else if(cls=="Button") buttons.Add(GetDlgCtrlID(child));
      return true;
    },IntPtr.Zero);
    ids=String.Join(",",buttons);
    return labels.ToString();
  }
  public static bool Click(int pid,string expected,int id,out string observation) {
    var details=new List<string>();
    foreach(IntPtr h in Windows(pid)) {
      string cls=Class(h);
      var title=new StringBuilder(100); GetWindowText(h,title,title.Capacity);
      if(cls!="#32770" || title.ToString()!="Growth Brain 설치") {
        details.Add("class="+cls); continue;
      }
      string ids;
      string body=ReadBody(h,out ids);
      string summary=body.Replace('\r',' ').Replace('\n',' ');
      if(summary.Length>350) summary=summary.Substring(0,350);
      details.Add("class="+cls+" buttons=["+ids+"] text=["+summary+"]");
      if(body.Contains("작업을 마치지 못했습니다.")) throw new InvalidOperationException(summary);
      if(!body.Contains(expected) || !IsWindowEnabled(h)) continue;
      IntPtr button=GetDlgItem(h,id);
      // BN_CLICKED is delivered to the dialog via WM_COMMAND. Sending BM_CLICK
      // to an inactive button can silently do nothing on a noninteractive desktop.
      bool sent = button!=IntPtr.Zero && IsWindowEnabled(button) &&
        PostMessage(h,0x0111,(IntPtr)id,button);
      if(!sent && id==1 && button==IntPtr.Zero && expected=="앱을 제거했습니다.")
        sent=PostMessage(h,0x0010,IntPtr.Zero,IntPtr.Zero);
      if(sent) { observation=details[details.Count-1]; return true; }
    }
    observation=details.Count>0?String.Join("; ",details):"(no visible windows for setup PID)";
    return false;
  }
}
'@

function Click-Setup([Diagnostics.Process]$Process, [string]$Prompt, [int]$Button) {
    $end = [DateTime]::UtcNow.AddSeconds(150)
    $last = ''
    do {
        $Process.Refresh()
        if ($Process.HasExited) { throw "Setup exited before the expected prompt: $Prompt" }
        $observed = ''
        if ([GrowthBrainSetupDialog]::Click($Process.Id,$Prompt,$Button,[ref]$observed)) {
            Write-Host "Setup selected button $Button on $observed"
            return
        }
        if ($observed -ne $last) {
            Write-Host "Waiting for $Prompt. Setup PID $($Process.Id) shows $observed"
            $last = $observed
        }
        Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $end)
    $registrationCount = @(Get-NativeRegistrations).Count
    throw "Setup timed out waiting for $Prompt. Last windows: $last. App exists: $(Test-Path -LiteralPath $app), shortcut exists: $(Test-Path -LiteralPath $link), native registry entries: $registrationCount."
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
