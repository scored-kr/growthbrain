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
public static class DesktopSmoke {
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr parent,int id);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hwnd);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowLong(IntPtr hwnd,int index);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageTimeoutW")]
  private static extern IntPtr SetText(IntPtr hwnd,uint message,IntPtr w,string text,uint flags,uint timeout,out UIntPtr result);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageTimeoutW")]
  private static extern IntPtr Message(IntPtr hwnd,uint message,IntPtr w,IntPtr l,uint flags,uint timeout,out UIntPtr result);
  public static void Enter(IntPtr hwnd,string value) {
    UIntPtr r;
    if(SetText(hwnd,12,IntPtr.Zero,value,2,3000,out r)==IntPtr.Zero || r==UIntPtr.Zero) throw new Exception("GUI input failed");
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
    $pw = Ready-Control 103
    $confirm = Ready-Control 105
    foreach ($field in @($pw,$confirm)) {
        if (([DesktopSmoke]::GetWindowLong($field,-16) -band 0x20) -eq 0) { throw 'Password control is not masked' }
        [DesktopSmoke]::Enter($field,$passphrase)
    }
    [DesktopSmoke]::Click((Ready-Control 106))
    $null = Ready-Control 109
    $vaultFile = Join-Path $fixture 'GrowthBrain/vault/vault.json'
    if (!(Test-Path -LiteralPath $vaultFile -PathType Leaf)) { throw 'Expected scoped vault file was not created' }
    [DesktopSmoke]::Click((Ready-Control 109))
    $null = Ready-Control 103
    if ([DesktopSmoke]::IsWindowVisible((Control 105))) { throw 'Creation confirmation still visible for existing vault' }
    Close-Desktop

    Start-Desktop
    [DesktopSmoke]::Enter((Ready-Control 103),$passphrase)
    [DesktopSmoke]::Click((Ready-Control 106))
    $null = Ready-Control 109
    Close-Desktop
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
