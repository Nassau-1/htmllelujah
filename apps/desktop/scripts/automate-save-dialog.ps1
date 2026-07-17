param(
  [Parameter(Mandatory = $true)]
  [int]$RootProcessId,

  [Parameter(Mandatory = $true)]
  [string]$WindowTitle,

  [Parameter(Mandatory = $true)]
  [string]$TargetPath,

  [ValidateRange(1, 120)]
  [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class HtmllelujahUnicodeInput
{
    private const uint InputKeyboard = 1;
    private const uint KeyUp = 0x0002;
    private const uint Unicode = 0x0004;
    private const ushort VirtualKeyA = 0x41;
    private const ushort VirtualKeyControl = 0x11;

    [StructLayout(LayoutKind.Sequential)]
    private struct Input
    {
        public uint Type;
        public InputUnion Data;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public MouseInput Mouse;
        [FieldOffset(0)] public KeyboardInput Keyboard;
        [FieldOffset(0)] public HardwareInput Hardware;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput
    {
        public int Dx;
        public int Dy;
        public uint MouseData;
        public uint Flags;
        public uint Time;
        public UIntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardInput
    {
        public ushort VirtualKey;
        public ushort ScanCode;
        public uint Flags;
        public uint Time;
        public UIntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct HardwareInput
    {
        public uint Message;
        public ushort ParameterLow;
        public ushort ParameterHigh;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint inputCount, Input[] inputs, int inputSize);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool PostMessage(IntPtr window, uint message, IntPtr word, IntPtr data);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr word, IntPtr data);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr word, string data);

    private static Input VirtualKey(ushort key, bool keyUp)
    {
        return new Input {
            Type = InputKeyboard,
            Data = new InputUnion {
                Keyboard = new KeyboardInput {
                    VirtualKey = key,
                    ScanCode = 0,
                    Flags = keyUp ? KeyUp : 0,
                    Time = 0,
                    ExtraInfo = UIntPtr.Zero
                }
            }
        };
    }

    private static Input UnicodeKey(char value, bool keyUp)
    {
        return new Input {
            Type = InputKeyboard,
            Data = new InputUnion {
                Keyboard = new KeyboardInput {
                    VirtualKey = 0,
                    ScanCode = value,
                    Flags = Unicode | (keyUp ? KeyUp : 0),
                    Time = 0,
                    ExtraInfo = UIntPtr.Zero
                }
            }
        };
    }

    private static void Send(Input[] inputs)
    {
        uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input)));
        if (sent != (uint)inputs.Length) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows did not accept all synthetic keyboard input.");
        }
    }

    public static void ReplaceFocusedText(string value)
    {
        Send(new[] {
            VirtualKey(VirtualKeyControl, false),
            VirtualKey(VirtualKeyA, false),
            VirtualKey(VirtualKeyA, true),
            VirtualKey(VirtualKeyControl, true)
        });
        foreach (char character in value) {
            Send(new[] { UnicodeKey(character, false), UnicodeKey(character, true) });
        }
    }

    public static bool ClickNativeButton(int windowHandle)
    {
        if (windowHandle == 0) return false;
        const uint ButtonClick = 0x00F5;
        return PostMessage(new IntPtr(windowHandle), ButtonClick, IntPtr.Zero, IntPtr.Zero);
    }

    public static bool ReplaceNativeEdit(int windowHandle, string value)
    {
        if (windowHandle == 0) return false;
        const uint EditSelect = 0x00B1;
        const uint EditReplaceSelection = 0x00C2;
        SendMessage(new IntPtr(windowHandle), EditSelect, IntPtr.Zero, new IntPtr(-1));
        SendMessage(new IntPtr(windowHandle), EditReplaceSelection, new IntPtr(1), value);
        return true;
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
    # The standard Windows save dialog normally belongs to the Electron main process.
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
      # A window can disappear while UI Automation enumerates the desktop.
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

function Find-FileNameEditor {
  param([System.Windows.Automation.AutomationElement]$Window)

  $searchRoots = [System.Collections.Generic.List[System.Windows.Automation.AutomationElement]]::new()
  foreach ($automationId in @('FileNameControlHost', '1148', '1001')) {
    $root = $Window.FindFirst(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
        $automationId
      )
    )
    if ($null -ne $root) {
      [void]$searchRoots.Add($root)
    }
  }

  $candidateByRuntimeId = @{}
  $observedControls = [System.Collections.Generic.List[string]]::new()
  foreach ($root in $searchRoots) {
    try {
      $rootCurrent = $root.Current
      [void]$observedControls.Add(
        "root:$($rootCurrent.AutomationId)/$($rootCurrent.ControlType.ProgrammaticName)/$($rootCurrent.ClassName)/offscreen=$($rootCurrent.IsOffscreen)"
      )
      if ($root.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit) {
        $runtimeId = ($root.GetRuntimeId() -join '.')
        $candidateByRuntimeId[$runtimeId] = $root
      }
    }
    catch {
      # A common-dialog element can disappear while its controls are being materialized.
    }

    try {
      $descendants = $root.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.PropertyCondition]::new(
          [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
          [System.Windows.Automation.ControlType]::Edit
        )
      )
      foreach ($candidate in $descendants) {
        $candidateCurrent = $candidate.Current
        [void]$observedControls.Add(
          "edit:$($candidateCurrent.AutomationId)/$($candidateCurrent.ClassName)/offscreen=$($candidateCurrent.IsOffscreen)/enabled=$($candidateCurrent.IsEnabled)"
        )
        $runtimeId = ($candidate.GetRuntimeId() -join '.')
        $candidateByRuntimeId[$runtimeId] = $candidate
      }
    }
    catch {
      # Retry at the call site while the dialog remains inside its bounded initialization window.
    }
  }

  try {
    $windowEdits = $Window.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Edit
      )
    )
    foreach ($candidate in $windowEdits) {
      $current = $candidate.Current
      $hasKnownId = $current.AutomationId -in @('1148', '1001')
      $hasFileName = $current.Name -match '(?i)(file\s*name|nom du fichier|dateiname|nombre de archivo|nome file|bestandsnaam)'
      $hasEditClass = $current.ClassName -match '(?i)(^|\.)edit$'
      if (($hasKnownId -and $hasEditClass) -or $hasFileName) {
        $runtimeId = ($candidate.GetRuntimeId() -join '.')
        $candidateByRuntimeId[$runtimeId] = $candidate
        [void]$observedControls.Add(
          "identified-edit:$($current.AutomationId)/$($current.ClassName)/$($current.Name)/offscreen=$($current.IsOffscreen)"
        )
      }
    }
  }
  catch {
    [void]$observedControls.Add('identified-edit-enumeration-failed')
  }

  $eligible = [System.Collections.Generic.List[object]]::new()
  foreach ($candidate in $candidateByRuntimeId.Values) {
    try {
      $current = $candidate.Current
      $bounds = $current.BoundingRectangle
      if (
        -not $current.IsEnabled -or
        $current.IsOffscreen -or
        $bounds.Width -le 0 -or
        $bounds.Height -le 0
      ) {
        continue
      }

      $classMatches = $current.ClassName -match '(?i)(edit|combo)'
      $nameMatches = $current.Name -match '(?i)(file\s*name|nom du fichier|dateiname|nombre de archivo|nome file|bestandsnaam)'
      if (-not $classMatches -and -not $nameMatches) {
        continue
      }

      $patternObject = $null
      if (
        -not $candidate.TryGetCurrentPattern(
          [System.Windows.Automation.ValuePattern]::Pattern,
          [ref]$patternObject
        )
      ) {
        continue
      }
      $valuePattern = [System.Windows.Automation.ValuePattern]$patternObject
      if ($valuePattern.Current.IsReadOnly) {
        continue
      }

      [void]$eligible.Add([pscustomobject]@{
          Editor = $candidate
          ValuePattern = $valuePattern
          Description = "$($current.AutomationId)/$($current.ClassName)/$($current.Name)"
        })
    }
    catch {
      # Ignore stale or incomplete candidates and retry within the bounded lookup window.
    }
  }

  if ($eligible.Count -eq 1) {
    return [pscustomobject]@{
      Status = 'Found'
      Editor = $eligible[0].Editor
      ValuePattern = $eligible[0].ValuePattern
      Details = $eligible[0].Description
    }
  }
  if ($eligible.Count -gt 1) {
    return [pscustomobject]@{
      Status = 'Ambiguous'
      Editor = $null
      ValuePattern = $null
      Details = (($eligible | ForEach-Object { $_.Description }) -join ' | ')
    }
  }
  return [pscustomobject]@{
    Status = 'Missing'
    Editor = $null
    ValuePattern = $null
    Details = "No visible, writable Edit under the native file-name hosts. Observed: $($observedControls -join ' | ')"
  }
}

function Find-DefaultButton {
  param([System.Windows.Automation.AutomationElement]$Window)

  $byId = $Window.FindFirst(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.AndCondition]::new(
      [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
        '1'
      ),
      [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Button
      )
    )
  )
  if ($null -ne $byId) {
    return $byId
  }

  return $Window.FindFirst(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.AndCondition]::new(
      [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Button
      ),
      [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::IsDefaultButtonProperty,
        $true
      )
    )
  )
}

if (-not [System.IO.Path]::IsPathRooted($TargetPath)) {
  throw 'The requested destination must be an absolute path.'
}

$parentDirectory = [System.IO.Path]::GetDirectoryName($TargetPath)
if ([string]::IsNullOrWhiteSpace($parentDirectory) -or -not [System.IO.Directory]::Exists($parentDirectory)) {
  throw 'The requested destination directory does not exist.'
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
  $candidates = Describe-ProcessWindows -AllowedProcessIds $allowedProcessIds
  $detail = ConvertTo-Json -InputObject ([ordered]@{
    requestedTitle = $WindowTitle
    allowedProcessIds = @($allowedProcessIds)
    processWindows = @($candidates)
  }) -Compress -Depth 4
  throw "The expected Windows save dialog did not appear before the timeout. Diagnostics: $detail"
}

$editorResult = $null
$editorDeadline = [DateTime]::UtcNow.AddSeconds(5)
while ([DateTime]::UtcNow -lt $editorDeadline) {
  $editorResult = Find-FileNameEditor -Window $dialog
  if ($editorResult.Status -eq 'Found') {
    break
  }
  Start-Sleep -Milliseconds 100
}
if ($null -eq $editorResult -or $editorResult.Status -ne 'Found') {
  $status = if ($null -eq $editorResult) { 'Missing' } else { $editorResult.Status }
  $details = if ($null -eq $editorResult) { 'No lookup result.' } else { $editorResult.Details }
  throw "The Windows save dialog file-name editor lookup failed closed ($status): $details"
}
$editor = $editorResult.Editor
$valuePattern = $editorResult.ValuePattern
$editor.SetFocus()
$nativeEdit = [HtmllelujahUnicodeInput]::ReplaceNativeEdit(
  $editor.Current.NativeWindowHandle,
  $TargetPath
)
if (-not $nativeEdit) {
  $valuePattern.SetValue($TargetPath)
  # Direct Unicode keyboard input is a fallback for UI Automation providers without an HWND.
  [HtmllelujahUnicodeInput]::ReplaceFocusedText($TargetPath)
}
Start-Sleep -Milliseconds 100
if ($valuePattern.Current.Value -ne $TargetPath) {
  throw 'The Windows save dialog did not accept the requested file name.'
}

$button = $null
$invokeDeadline = [DateTime]::UtcNow.AddSeconds(5)
while ([DateTime]::UtcNow -lt $invokeDeadline -and $null -eq $button) {
  $dialog = Find-Window -AllowedProcessIds $allowedProcessIds -Title $WindowTitle
  if ($null -ne $dialog) {
    $candidate = Find-DefaultButton -Window $dialog
    if ($null -ne $candidate -and $candidate.Current.IsEnabled) {
      $button = $candidate
    }
  }
  if ($null -eq $button) {
    Start-Sleep -Milliseconds 100
  }
}
if ($null -eq $button) {
  throw 'The Windows save dialog confirmation button did not become available.'
}
$button.SetFocus()
Start-Sleep -Milliseconds 100
$nativeClick = [HtmllelujahUnicodeInput]::ClickNativeButton($button.Current.NativeWindowHandle)
if (-not $nativeClick) {
  try {
    $legacyPattern = $button.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
    if ($null -ne $legacyPattern) {
      $legacyPattern.DoDefaultAction()
    }
    else {
      $invokePattern = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
      if ($null -eq $invokePattern) {
        throw 'The Windows save dialog confirmation button is not invokable.'
      }
      $invokePattern.Invoke()
    }
  }
  catch {
    # Some Windows builds surface a spurious accessibility exception after the native action has
    # already been dispatched. The close check below is authoritative.
  }
}

$dialogCloseDeadline = [DateTime]::UtcNow.AddSeconds(10)
while ([DateTime]::UtcNow -lt $dialogCloseDeadline) {
  Start-Sleep -Milliseconds 100
  $remaining = Find-Window -AllowedProcessIds $allowedProcessIds -Title $WindowTitle
  if ($null -eq $remaining) {
    Write-Output 'Windows save dialog completed.'
    exit 0
  }
}

$buttonName = $button.Current.Name
$buttonId = $button.Current.AutomationId
$buttonHandle = $button.Current.NativeWindowHandle
$editorId = $editor.Current.AutomationId
$editorValueLength = $valuePattern.Current.Value.Length
$textElements = $dialog.FindAll(
  [System.Windows.Automation.TreeScope]::Descendants,
  [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Text
  )
)
$labels = @($textElements | ForEach-Object { $_.Current.Name } | Where-Object {
  -not [string]::IsNullOrWhiteSpace($_) -and -not $TargetPath.Contains($_)
} | Select-Object -First 12) -join ' | '
throw "The Windows save dialog remained open after confirmation (button=$buttonName/$buttonId/$buttonHandle, editor=$editorId, valueLength=$editorValueLength, labels=$labels)."
