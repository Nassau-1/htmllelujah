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

    public sealed class WindowRecord
    {
        public long Handle { get; set; }
        public int ProcessId { get; set; }
        public bool Visible { get; set; }
    }

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    public static WindowRecord[] ListTopLevelWindows(int[] processIds)
    {
        var accepted = new HashSet<uint>();
        foreach (var processId in processIds) {
            if (processId > 0) accepted.Add((uint)processId);
        }

        var records = new List<WindowRecord>();
        EnumWindows((window, parameter) => {
            uint processId;
            GetWindowThreadProcessId(window, out processId);
            if (accepted.Contains(processId)) {
                records.Add(new WindowRecord {
                    Handle = window.ToInt64(),
                    ProcessId = (int)processId,
                    Visible = IsWindowVisible(window)
                });
            }
            return true;
        }, IntPtr.Zero);
        records.Sort((left, right) => left.Handle.CompareTo(right.Handle));
        return records.ToArray();
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

$sortedLiveProcessIds = @($liveProcessIds.ToArray() | Sort-Object)
$windowRecords = @(
  [HtmllelujahWindowInspection]::ListTopLevelWindows($sortedLiveProcessIds) |
    ForEach-Object {
      [ordered]@{
        handle = ([long]$_.Handle).ToString('x16', [System.Globalization.CultureInfo]::InvariantCulture)
        processId = [int]$_.ProcessId
        visible = [bool]$_.Visible
      }
    }
)

$result = [ordered]@{
  schemaVersion = 2
  processCount = $sortedLiveProcessIds.Count
  processIds = $sortedLiveProcessIds
  topLevelWindowCount = $windowRecords.Count
  visibleWindowCount = @($windowRecords | Where-Object { $_.visible }).Count
  topLevelWindows = $windowRecords
  processTreeComplete = $processTreeComplete
  workingSetAvailable = $workingSetAvailable -and $sortedLiveProcessIds.Count -gt 0
  workingSetBytes = if ($workingSetAvailable -and $sortedLiveProcessIds.Count -gt 0) {
    $workingSetBytes
  } else {
    $null
  }
}

$result | ConvertTo-Json -Compress
