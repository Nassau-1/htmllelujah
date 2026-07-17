param(
  [Parameter(Mandatory = $true)]
  [int]$RootProcessId,

  [ValidateRange(1, 30)]
  [int]$TimeoutSeconds = 10
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class HtmllelujahWindowCloseInput
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool PostMessage(IntPtr window, uint message, IntPtr word, IntPtr data);

    public static bool RequestClose(int windowHandle)
    {
        if (windowHandle == 0) return false;
        const uint WindowClose = 0x0010;
        return PostMessage(new IntPtr(windowHandle), WindowClose, IntPtr.Zero, IntPtr.Zero);
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
    # The editor window normally belongs to the Electron main process.
    # Continue with the root PID if process enumeration is unavailable.
  }
  return $accepted
}

function Find-EditorWindow {
  param([System.Collections.Generic.HashSet[int]]$AllowedProcessIds)

  $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  foreach ($window in $windows) {
    try {
      $name = $window.Current.Name
      if (
        $AllowedProcessIds.Contains([int]$window.Current.ProcessId) -and
        $window.Current.ControlType -eq [System.Windows.Automation.ControlType]::Window -and
        $window.Current.NativeWindowHandle -ne 0 -and
        -not [string]::IsNullOrWhiteSpace($name) -and
        $name.EndsWith('HTMLlelujah', [System.StringComparison]::Ordinal)
      ) {
        return $window
      }
    }
    catch {
      # A top-level window can disappear while UI Automation enumerates it.
    }
  }
  return $null
}

function Describe-ProcessWindows {
  param([System.Collections.Generic.HashSet[int]]$AllowedProcessIds)

  $descriptions = [System.Collections.Generic.List[object]]::new()
  $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  foreach ($window in $windows) {
    try {
      if ($AllowedProcessIds.Contains([int]$window.Current.ProcessId)) {
        $descriptions.Add([ordered]@{
          processId = [int]$window.Current.ProcessId
          name = [string]$window.Current.Name
          className = [string]$window.Current.ClassName
          controlType = [string]$window.Current.ControlType.ProgrammaticName
          nativeWindowHandle = [int]$window.Current.NativeWindowHandle
        })
      }
    }
    catch {
      # A top-level window can disappear while its metadata is inspected.
    }
  }
  return $descriptions
}

$allowedProcessIds = Get-ProcessTreeIds -ProcessId $RootProcessId
$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
$editorWindow = $null
while ([DateTime]::UtcNow -lt $deadline -and $null -eq $editorWindow) {
  $editorWindow = Find-EditorWindow -AllowedProcessIds $allowedProcessIds
  if ($null -eq $editorWindow) {
    Start-Sleep -Milliseconds 100
  }
}
if ($null -eq $editorWindow) {
  $candidates = Describe-ProcessWindows -AllowedProcessIds $allowedProcessIds
  $detail = ConvertTo-Json -InputObject ([ordered]@{
    allowedProcessIds = @($allowedProcessIds)
    processWindows = @($candidates)
  }) -Compress -Depth 4
  throw "The HTMLlelujah editor window was not found before the timeout. Diagnostics: $detail"
}

if (-not [HtmllelujahWindowCloseInput]::RequestClose($editorWindow.Current.NativeWindowHandle)) {
  throw 'Windows rejected the native close request.'
}

Write-Output '__HTMLLELUJAH_NATIVE_CLOSE_REQUESTED__'
$processTree = ConvertTo-Json -InputObject @($allowedProcessIds) -Compress
Write-Output "__HTMLLELUJAH_PROCESS_TREE__$processTree"
