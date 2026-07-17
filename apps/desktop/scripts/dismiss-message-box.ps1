param(
  [Parameter(Mandatory = $true)]
  [int]$RootProcessId,

  [Parameter(Mandatory = $true)]
  [string]$WindowTitle,

  [string]$ButtonName = '',

  [ValidateRange(0, 10000)]
  [int]$DelayMilliseconds = 0,

  [string]$ReleasePath = '',

  [ValidateRange(1, 120)]
  [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class HtmllelujahMessageBoxInput
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool PostMessage(IntPtr window, uint message, IntPtr word, IntPtr data);

    public static bool ClickNativeButton(int windowHandle)
    {
        if (windowHandle == 0) return false;
        const uint ButtonClick = 0x00F5;
        return PostMessage(new IntPtr(windowHandle), ButtonClick, IntPtr.Zero, IntPtr.Zero);
    }
}
'@

function Get-ProcessTreeIds {
  param([int]$ProcessId)

  $accepted = [System.Collections.Generic.HashSet[int]]::new()
  [void]$accepted.Add($ProcessId)
  try {
    $processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
    $added = $true
    while ($added) {
      $added = $false
      foreach ($process in $processes) {
        if (
          $accepted.Contains([int]$process.ParentProcessId) -and
          $accepted.Add([int]$process.ProcessId)
        ) {
          $added = $true
        }
      }
    }
  }
  catch {
    # Native Electron message boxes normally belong to the main process.
    # Continue with the root PID if process enumeration is unavailable.
  }
  return $accepted
}

function Find-Window {
  param(
    [System.Collections.Generic.HashSet[int]]$AllowedProcessIds,
    [string]$Title
  )

  $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::NameProperty,
      $Title
    )
  )
  foreach ($window in $windows) {
    try {
      if ($AllowedProcessIds.Contains([int]$window.Current.ProcessId)) {
        return $window
      }
    }
    catch {
      # A native window can close while UI Automation enumerates the desktop.
    }
  }
  return $null
}

function Find-ConfirmationButton {
  param(
    [System.Windows.Automation.AutomationElement]$Window,
    [string]$RequestedName
  )

  $buttons = $Window.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Button
    )
  )
  if (-not [string]::IsNullOrWhiteSpace($RequestedName)) {
    foreach ($button in $buttons) {
      try {
        if ($button.Current.IsEnabled -and $button.Current.Name -eq $RequestedName) {
          return $button
        }
      }
      catch {
        # A button can disappear between discovery and inspection.
      }
    }
    return $null
  }
  foreach ($button in $buttons) {
    try {
      if ($button.Current.IsEnabled -and $button.Current.IsDefaultButton) {
        return $button
      }
    }
    catch {
      # A button can disappear between discovery and inspection.
    }
  }
  foreach ($button in $buttons) {
    try {
      if ($button.Current.IsEnabled -and $button.Current.Name -eq 'OK') {
        return $button
      }
    }
    catch {
      # A button can disappear between discovery and inspection.
    }
  }
  return $null
}

$allowedProcessIds = Get-ProcessTreeIds -ProcessId $RootProcessId
$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
$dialog = $null
while ([DateTime]::UtcNow -lt $deadline -and $null -eq $dialog) {
  $dialog = Find-Window -AllowedProcessIds $allowedProcessIds -Title $WindowTitle
  if ($null -eq $dialog) {
    Start-Sleep -Milliseconds 100
  }
}
if ($null -eq $dialog) {
  throw 'The expected native message box did not appear before the timeout.'
}

$button = Find-ConfirmationButton -Window $dialog -RequestedName $ButtonName
if ($null -eq $button) {
  throw 'The native message box confirmation button was not found.'
}

Write-Output '__HTMLLELUJAH_MESSAGE_BOX_READY__'

if ($DelayMilliseconds -gt 0) {
  Start-Sleep -Milliseconds $DelayMilliseconds
}

if (-not [string]::IsNullOrWhiteSpace($ReleasePath)) {
  $releaseDeadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $releaseDeadline -and -not (Test-Path -LiteralPath $ReleasePath)) {
    Start-Sleep -Milliseconds 50
  }
  if (-not (Test-Path -LiteralPath $ReleasePath)) {
    throw 'The native message box release signal did not appear before the timeout.'
  }
}

$nativeClick = [HtmllelujahMessageBoxInput]::ClickNativeButton(
  $button.Current.NativeWindowHandle
)
if (-not $nativeClick) {
  $invokePattern = $button.GetCurrentPattern(
    [System.Windows.Automation.InvokePattern]::Pattern
  )
  if ($null -eq $invokePattern) {
    throw 'The native message box confirmation button is not invokable.'
  }
  $invokePattern.Invoke()
}

$closeDeadline = [DateTime]::UtcNow.AddSeconds(10)
while ([DateTime]::UtcNow -lt $closeDeadline) {
  Start-Sleep -Milliseconds 100
  $remaining = Find-Window -AllowedProcessIds $allowedProcessIds -Title $WindowTitle
  if ($null -eq $remaining) {
    Write-Output 'Native message box dismissed.'
    exit 0
  }
}

throw 'The native message box remained open after confirmation.'
