# Run with a packaged desktop on an interactive Windows CI desktop.
# All vault files are created below a unique private test directory.
param([Parameter(Mandatory = $true)][string]$App)
$ErrorActionPreference = 'Stop'
$desktop = (Resolve-Path -LiteralPath $App).Path
$originalLocalAppData = $env:LOCALAPPDATA
$fixture = Join-Path $env:LOCALAPPDATA ('GrowthBrain-GUI-Test-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $fixture
$env:LOCALAPPDATA = $fixture
$passphrase = [guid]::NewGuid().ToString('N')
$process = $null
$passed = $false
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DesktopSmoke {
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr parent,int id);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetLastActivePopup(IntPtr owner);
  [DllImport("user32.dll",EntryPoint="PostMessageW")] public static extern bool Post(IntPtr hwnd, uint message, IntPtr w, IntPtr l);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowLong(IntPtr hwnd,int index);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageTimeoutW")]
  private static extern IntPtr SetText(IntPtr hwnd,uint message,IntPtr w,string text,uint flags,uint timeout,out UIntPtr result);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageTimeoutW")]
  private static extern IntPtr Message(IntPtr hwnd,uint message,IntPtr w,IntPtr l,uint flags,uint timeout,out UIntPtr result);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageTimeoutW")]
  private static extern IntPtr Read(IntPtr hwnd,uint message,IntPtr w,StringBuilder text,uint flags,uint timeout,out UIntPtr result);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern IntPtr FindWindowEx(IntPtr parent,IntPtr after,string cls,string caption);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint processId);
  public static string Text(IntPtr hwnd) {
    var txt=new StringBuilder(4096);UIntPtr result;
    if(Read(hwnd,13,(IntPtr)txt.Capacity,txt,2,3000,out result)==IntPtr.Zero)throw new Exception("GUI result unavailable");
    return txt.ToString();
  }
  public static void NotifySession(int processId,int state) {
    IntPtr h=IntPtr.Zero;uint pid;UIntPtr result;
    while((h=FindWindowEx(IntPtr.Zero,h,"GrowthBrainSessionObserver",null))!=IntPtr.Zero) {
      GetWindowThreadProcessId(h,out pid);
      if(pid==processId && Message(h,0x2b1,(IntPtr)state,IntPtr.Zero,2,3000,out result)!=IntPtr.Zero)return;
    }
    throw new Exception("Session monitor not found");
  }
  public static void Enter(IntPtr hwnd,string value) {
    UIntPtr r;
    if(SetText(hwnd,12,IntPtr.Zero,value,2,3000,out r)==IntPtr.Zero || r==UIntPtr.Zero) throw new Exception("GUI input failed");
  }
  public static void Select(IntPtr parent, int id, int index) {
    UIntPtr result;
    var child = GetDlgItem(parent,id);
    if(Message(child,0x14e,(IntPtr)index,IntPtr.Zero,2,3000,out result)==IntPtr.Zero ||
       Message(parent,0x111,(IntPtr)(0x10000 | id),child,2,3000,out result)==IntPtr.Zero)
      throw new Exception("GUI selection failed");
  }
  public static void Click(IntPtr hwnd) {
    UIntPtr r;
    if(Message(hwnd,0xf5,IntPtr.Zero,IntPtr.Zero,2,3000,out r)==IntPtr.Zero) throw new Exception("GUI click failed");
  }
}
'@
function Wait-For([scriptblock]$Test, [string]$Description) {
    $end = (Get-Date).AddSeconds(45)
    do {
        if ($process.HasExited) { throw "Desktop exited while waiting for $Description" }
        $result = & $Test
        if ($result) { return $result }
        Start-Sleep -Milliseconds 100
    } while ((Get-Date) -lt $end)
    throw "Desktop timeout waiting for $Description"
}
function Start-Desktop {
    $script:process = Start-Process -FilePath $desktop -PassThru
    $script:window = Wait-For {
        $process.Refresh()
        if ($process.MainWindowHandle -ne [IntPtr]::Zero) { $process.MainWindowHandle }
    } 'main window'
}
function Control([int]$Id) {
    [DesktopSmoke]::GetDlgItem($window, $Id)
}
function Ready-Control([int]$Id) {
    Wait-For {
        $handle = Control $Id
        if ($handle -ne [IntPtr]::Zero -and [DesktopSmoke]::IsWindowVisible($handle) -and [DesktopSmoke]::IsWindowEnabled($handle)) { $handle }
    } "control $Id"
}
function Close-Desktop {
    if (!$process.CloseMainWindow() -or !$process.WaitForExit(20000)) { throw 'Desktop did not exit after closing' }
    if ($process.ExitCode -ne 0) { throw 'Desktop exited with an error' }
}

try {
    Start-Desktop
    $null = Ready-Control 211
    if (![DesktopSmoke]::IsWindowVisible((Control 201)) -or ![DesktopSmoke]::IsWindowVisible((Control 207))) { throw 'Default launch did not show account login' }
    if (([DesktopSmoke]::GetWindowLong((Control 203),-16) -band 0x20) -eq 0) { throw 'Account password input is not masked' }
    foreach ($id in @(103,106,110,114,143,145,149,151)) {
        if ([DesktopSmoke]::IsWindowVisible((Control $id))) { throw "Technical control $id on default login" }
    }
    [DesktopSmoke]::Click((Ready-Control 211))
    $null = Ready-Control 143
    [DesktopSmoke]::Select($window,143,2) # recovery using a backup and recovery file
    $null = Ready-Control 144
    $null = Ready-Control 146
    $null = Ready-Control 105
    [DesktopSmoke]::Select($window,143,0) # create a new synthetic vault
    $pw = Ready-Control 103
    $confirm = Ready-Control 105
    foreach ($field in @($pw,$confirm)) {
        if (([DesktopSmoke]::GetWindowLong($field,-16) -band 0x20) -eq 0) { throw 'Password control is not masked' }
        [DesktopSmoke]::Enter($field,$passphrase)
    }
    [DesktopSmoke]::Click((Ready-Control 106))
    $null = Ready-Control 109
    [DesktopSmoke]::Select($window,108,4) # backup and recovery key
    $null = Ready-Control 149
    $recheck = Ready-Control 151
    if (([DesktopSmoke]::GetWindowLong($recheck,-16) -band 0x20) -eq 0) { throw 'Recovery reauthentication is not masked' }
    $vaultFile = Join-Path $fixture 'GrowthBrain/vault/vault.json'
    if (!(Test-Path -LiteralPath $vaultFile -PathType Leaf)) { throw 'Expected scoped vault file was not created' }
    [DesktopSmoke]::Click((Ready-Control 109))
    $null = Ready-Control 103
    if ([DesktopSmoke]::IsWindowVisible((Control 143))) { throw 'Restore must not target an existing Windows vault' }
    if ([DesktopSmoke]::IsWindowVisible((Control 105))) { throw 'Creation confirmation still visible for existing vault' }
    Close-Desktop

    Start-Desktop
    [DesktopSmoke]::Click((Ready-Control 211))
    [DesktopSmoke]::Enter((Ready-Control 103),$passphrase)
    [DesktopSmoke]::Click((Ready-Control 106))
    $null = Ready-Control 109
    Close-Desktop
    # Drive the original native GUI against a labelled synthetic child in a
    # separate staging folder. Leave the packaged controller and real app untouched.
    $staging = Join-Path $fixture 'presentation-test'
    $null = New-Item -ItemType Directory -Path (Join-Path $staging 'dist') -Force
    Copy-Item -LiteralPath $desktop -Destination (Join-Path $staging 'GrowthBrain.exe')
    Copy-Item -LiteralPath (Join-Path (Split-Path $desktop) 'node.exe') -Destination $staging
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'support/windows-account-ui-controller.cjs') -Destination (Join-Path $staging 'dist/desktop-controller.js')
    $desktop = Join-Path $staging 'GrowthBrain.exe'
    Start-Desktop
    [DesktopSmoke]::Enter((Ready-Control 201),'win-ui@example.invalid')
    [DesktopSmoke]::Enter((Ready-Control 203),$passphrase)
    [DesktopSmoke]::Click((Ready-Control 206))
    [DesktopSmoke]::Click((Ready-Control 207))
    $null = Wait-For { if ([DesktopSmoke]::Text((Control 218)) -like '*COMMON-FORMAT*') { $true } } 'approved common preferences on login'
    $beforePid = Get-Content -LiteralPath (Join-Path $staging 'child.pid') -Raw
    $beforeResume = @(Get-Content -LiteralPath (Join-Path $staging 'test-operations.txt') | Where-Object { $_ -eq 'accountResume' }).Count
    $second = Start-Process -FilePath $desktop -PassThru
    if (!$second.WaitForExit(5000)) { $second.Kill(); throw 'Second desktop acquired the same profile' }
    $afterResume = @(Get-Content -LiteralPath (Join-Path $staging 'test-operations.txt') | Where-Object { $_ -eq 'accountResume' }).Count
    if ($beforeResume -ne $afterResume -or $beforePid -ne (Get-Content -LiteralPath (Join-Path $staging 'child.pid') -Raw)) { throw 'Second instance touched trusted credentials' }
    [DesktopSmoke]::Select($window,217,1)
    $null = Wait-For { if ([DesktopSmoke]::Text((Control 218)) -like '*PROJECT-FORMAT*') { $true } } 'approved project decision'
    [DesktopSmoke]::Select($window,108,2)
    $null = Ready-Control 219
    $null = Ready-Control 220
    if ([DesktopSmoke]::IsWindowVisible((Control 114))) { throw 'Endpoint requested before choosing a service' }

    [DesktopSmoke]::Select($window,108,0)
    [DesktopSmoke]::Select($window,108,1)
    [DesktopSmoke]::Enter((Ready-Control 121),'OFFLINE-PROJECT')
    [DesktopSmoke]::Click((Ready-Control 122))
    $null = Wait-For { if ([DesktopSmoke]::Text((Control 100)) -like '*연결되면 자동 동기화*' -and [DesktopSmoke]::Text((Control 101)) -like '*이 기기에 저장*') { $true } } 'local save receipt with remote sync pending'
    [DesktopSmoke]::Select($window,108,0)
    [DesktopSmoke]::Click((Ready-Control 216))
    $null = Ready-Control 261
    if ([DesktopSmoke]::IsWindowVisible((Control 218)) -or [DesktopSmoke]::IsWindowVisible((Control 264))) { throw 'Review exposed the regular preview or showed alternatives before inspection' }
    [DesktopSmoke]::Click((Ready-Control 261))
    $null = Ready-Control 268
    if ([DesktopSmoke]::Text((Control 264)) -ne 'LOCAL-format' -or [DesktopSmoke]::Text((Control 266)) -ne 'REMOTE-format') { throw 'Both competing values must be visible' }
    [DesktopSmoke]::Click((Ready-Control 268))
    if ([DesktopSmoke]::IsWindowVisible((Control 271))) { throw 'Partial conflict choices cannot be applied' }
    [DesktopSmoke]::Select($window,262,1)
    if ([DesktopSmoke]::Text((Control 264)) -ne 'LOCAL-channel') { throw 'Review did not switch to selected item' }
    [DesktopSmoke]::Click((Ready-Control 267))
    if (![DesktopSmoke]::Post((Ready-Control 271),0xf5,[IntPtr]::Zero,[IntPtr]::Zero)) { throw 'Could not open final confirmation' }
    $yes = Wait-For {
        $popup = [DesktopSmoke]::GetLastActivePopup($window)
        if ($popup -ne $window -and $popup -ne [IntPtr]::Zero) {
            $button=[DesktopSmoke]::GetDlgItem($popup,6)
            if ($button -ne [IntPtr]::Zero -and [DesktopSmoke]::IsWindowVisible($button)) { $button }
        }
    } 'explicit final confirmation'
    [DesktopSmoke]::Click($yes)
    $null = Ready-Control 216
    if ([DesktopSmoke]::IsWindowVisible((Control 264)) -or [DesktopSmoke]::Text((Control 264)) -ne '') { throw 'Resolved alternatives still visible or retained in the window' }
    $originalChild = Get-Process -Id ([int](Get-Content -LiteralPath (Join-Path $staging 'child.pid') -Raw))
    [DesktopSmoke]::Click((Ready-Control 216))
    $null = Wait-For { if (@(Get-Content -LiteralPath (Join-Path $staging 'test-operations.txt') | Where-Object { $_ -eq 'accountSync' }).Count -ge 2) { $true } } 'in-flight sync'
    [DesktopSmoke]::NotifySession($process.Id,7)
    if (!$originalChild.WaitForExit(5000)) { throw 'Windows lock left a blocked controller alive' }
    $null = Wait-For { if (![DesktopSmoke]::IsWindowVisible((Control 218))) { $true } } 'private preview removed after OS lock'
    [DesktopSmoke]::NotifySession($process.Id,8)
    $null = Wait-For { if ([DesktopSmoke]::Text((Control 218)) -like '*COMMON-FORMAT*') { $true } } 'trusted resume after synthetic OS unlock'
    [DesktopSmoke]::Select($window,108,5)
    [DesktopSmoke]::Click((Ready-Control 214))
    $null = Ready-Control 207
    Close-Desktop
    Start-Desktop
    $null = Ready-Control 207
    if ([DesktopSmoke]::IsWindowVisible((Control 218))) { throw 'Explicit logout was bypassed on next start' }
    Close-Desktop
    $ops = Get-Content -LiteralPath (Join-Path $staging 'test-operations.txt')
    foreach ($legacyOp in @('create','restore','recover','unlock','startWeb')) {
        if ($ops -contains $legacyOp) { throw "Unexpected setup operation in account flow: $legacyOp" }
    }
    'Synthetic account UI: login to recalled preferences, scoped review, offline save, per-item conflict resolution, deferred service choice, lock during stalled sync, trusted resume and logout verified.'
    $passed = $true
    'Packaged native desktop created, locked, reopened and closed a synthetic vault.'
} finally {
    $env:LOCALAPPDATA = $originalLocalAppData
    if ($process -and !$process.HasExited) {
        $null = $process.CloseMainWindow()
        if (!$process.WaitForExit(15000)) { $process.Kill(); $process.WaitForExit() }
    }
    # Keep any failure fixture for investigation; never remove another user's vault.
    if ($passed -and (Test-Path -LiteralPath $fixture -PathType Container)) { Remove-Item -LiteralPath $fixture -Recurse -Force }
}
