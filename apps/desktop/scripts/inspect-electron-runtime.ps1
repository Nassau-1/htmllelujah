param(
  [Parameter(Mandatory = $true)]
  [int]$RootProcessId
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class HtmllelujahWindowInspection
{
    private delegate bool EnumWindowsCallback(IntPtr window, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    public static int CountTopLevelWindows(int[] processIds, bool visibleOnly)
    {
        var accepted = new HashSet<uint>();
        foreach (var processId in processIds) {
            if (processId > 0) accepted.Add((uint)processId);
        }

        var count = 0;
        EnumWindows((window, parameter) => {
            if (visibleOnly && !IsWindowVisible(window)) return true;
            uint processId;
            GetWindowThreadProcessId(window, out processId);
            if (accepted.Contains(processId)) count++;
            return true;
        }, IntPtr.Zero);
        return count;
    }
}
'@

$accepted = [System.Collections.Generic.HashSet[int]]::new()
[void]$accepted.Add($RootProcessId)
$processTreeComplete = $true

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
  # Process-tree enumeration can be restricted by local policy. The root process is still sampled.
  $processTreeComplete = $false
}

$liveProcessIds = [System.Collections.Generic.List[int]]::new()
$workingSetBytes = [long]0
$workingSetAvailable = $true
foreach ($processId in $accepted) {
  try {
    $process = Get-Process -Id $processId -ErrorAction Stop
    $liveProcessIds.Add($processId)
    $workingSetBytes += [long]$process.WorkingSet64
  }
  catch [Microsoft.PowerShell.Commands.ProcessCommandException] {
    # A process can exit between tree enumeration and sampling.
  }
  catch {
    $workingSetAvailable = $false
  }
}

$result = [ordered]@{
  schemaVersion = 1
  processCount = $liveProcessIds.Count
  topLevelWindowCount = [HtmllelujahWindowInspection]::CountTopLevelWindows(
    $liveProcessIds.ToArray(),
    $false
  )
  visibleWindowCount = [HtmllelujahWindowInspection]::CountTopLevelWindows(
    $liveProcessIds.ToArray(),
    $true
  )
  processTreeComplete = $processTreeComplete
  workingSetAvailable = $workingSetAvailable -and $liveProcessIds.Count -gt 0
  workingSetBytes = if ($workingSetAvailable -and $liveProcessIds.Count -gt 0) {
    $workingSetBytes
  } else {
    $null
  }
}

$result | ConvertTo-Json -Compress
