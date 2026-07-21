param(
  [Parameter(Mandatory = $true)]
  [int]$RootProcessId,

  [Parameter(Mandatory = $true)]
  [string]$WindowTitle,

  [Parameter(Mandatory = $true)]
  [string]$TargetPath,

  [ValidateRange(1, 30)]
  [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$globalStartedAt = [DateTime]::UtcNow

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class HtmllelujahNativeDialog
{
    private const uint AbortIfHung = 0x0002;
    private const uint ButtonClick = 0x00F5;
    private const uint GetText = 0x000D;
    private const uint GetTextLength = 0x000E;
    private const uint SetText = 0x000C;
    private const uint MessageTimeoutMilliseconds = 1000;

    public delegate bool EnumWindowsProc(IntPtr window, IntPtr data);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr data);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool EnumChildWindows(
        IntPtr parent,
        EnumWindowsProc callback,
        IntPtr data
    );

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int GetWindowText(IntPtr window, StringBuilder text, int capacity);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int GetClassName(IntPtr window, StringBuilder text, int capacity);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern int GetDlgCtrlID(IntPtr window);

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr window);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    public static extern bool IsWindowEnabled(IntPtr window);

    [DllImport("user32.dll")]
    public static extern bool IsChild(IntPtr parent, IntPtr window);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr SendMessageTimeout(
        IntPtr window,
        uint message,
        IntPtr word,
        IntPtr data,
        uint flags,
        uint timeout,
        out IntPtr result
    );

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr SendMessageTimeout(
        IntPtr window,
        uint message,
        IntPtr word,
        string data,
        uint flags,
        uint timeout,
        out IntPtr result
    );

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr SendMessageTimeout(
        IntPtr window,
        uint message,
        IntPtr word,
        StringBuilder data,
        uint flags,
        uint timeout,
        out IntPtr result
    );

    public static IntPtr[] EnumerateTopLevelWindows()
    {
        var windows = new List<IntPtr>();
        bool enumerated = EnumWindows((window, _) => {
            windows.Add(window);
            return true;
        }, IntPtr.Zero);
        if (!enumerated) {
            throw new InvalidOperationException(
                "EnumWindows failed with Win32 error " + Marshal.GetLastWin32Error() + "."
            );
        }
        return windows.ToArray();
    }

    public static IntPtr[] EnumerateDescendantWindows(IntPtr parent)
    {
        var windows = new List<IntPtr>();
        EnumChildWindows(parent, (window, _) => {
            windows.Add(window);
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
    }

    public static int WindowProcessId(IntPtr window)
    {
        uint processId;
        GetWindowThreadProcessId(window, out processId);
        return checked((int)processId);
    }

    public static string WindowTitle(IntPtr window)
    {
        var text = new StringBuilder(1024);
        GetWindowText(window, text, text.Capacity);
        return text.ToString();
    }

    public static string WindowClassName(IntPtr window)
    {
        var text = new StringBuilder(256);
        GetClassName(window, text, text.Capacity);
        return text.ToString();
    }

    public static int WindowControlId(IntPtr window)
    {
        return GetDlgCtrlID(window);
    }

    public static bool SetControlText(IntPtr window, string value)
    {
        IntPtr messageResult;
        IntPtr dispatched = SendMessageTimeout(
            window,
            SetText,
            IntPtr.Zero,
            value,
            AbortIfHung,
            MessageTimeoutMilliseconds,
            out messageResult
        );
        return dispatched != IntPtr.Zero && messageResult != IntPtr.Zero;
    }

    public static string ReadControlText(IntPtr window, int maximumCharacters)
    {
        if (maximumCharacters < 1) {
            throw new ArgumentOutOfRangeException("maximumCharacters");
        }

        IntPtr lengthResult;
        IntPtr lengthDispatched = SendMessageTimeout(
            window,
            GetTextLength,
            IntPtr.Zero,
            IntPtr.Zero,
            AbortIfHung,
            MessageTimeoutMilliseconds,
            out lengthResult
        );
        if (lengthDispatched == IntPtr.Zero) {
            throw new TimeoutException("The exact native edit did not return its text length.");
        }

        long length = lengthResult.ToInt64();
        if (length < 0 || length > maximumCharacters) {
            throw new InvalidOperationException("The exact native edit reported an invalid text length.");
        }

        int capacity = checked((int)length + 1);
        var text = new StringBuilder(capacity);
        IntPtr readResult;
        IntPtr readDispatched = SendMessageTimeout(
            window,
            GetText,
            new IntPtr(capacity),
            text,
            AbortIfHung,
            MessageTimeoutMilliseconds,
            out readResult
        );
        if (readDispatched == IntPtr.Zero) {
            throw new TimeoutException("The exact native edit did not return its text.");
        }
        return text.ToString();
    }

    public static bool ClickNativeButton(IntPtr window)
    {
        if (window == IntPtr.Zero) return false;
        IntPtr messageResult;
        return SendMessageTimeout(
            window,
            ButtonClick,
            IntPtr.Zero,
            IntPtr.Zero,
            AbortIfHung,
            MessageTimeoutMilliseconds,
            out messageResult
        ) != IntPtr.Zero;
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
    # The common dialog normally belongs to the Electron main process. If process
    # enumeration is unavailable, retain the root PID and keep all matching strict.
  }
  return ,$accepted
}

function Find-NativeDialog {
  param(
    [System.Collections.Generic.HashSet[int]]$AllowedProcessIds,
    [string]$Title
  )

  $matches = [System.Collections.Generic.List[object]]::new()
  foreach ($handle in [HtmllelujahNativeDialog]::EnumerateTopLevelWindows()) {
    try {
      if ($handle -eq [IntPtr]::Zero) { continue }
      if (-not [HtmllelujahNativeDialog]::IsWindow($handle)) { continue }
      if (-not [HtmllelujahNativeDialog]::IsWindowVisible($handle)) { continue }

      $processId = [HtmllelujahNativeDialog]::WindowProcessId($handle)
      if ($processId -eq 0 -or -not $AllowedProcessIds.Contains($processId)) { continue }

      $titleValue = [HtmllelujahNativeDialog]::WindowTitle($handle)
      if (-not [string]::Equals($titleValue, $Title, [System.StringComparison]::Ordinal)) {
        continue
      }

      $className = [HtmllelujahNativeDialog]::WindowClassName($handle)
      if (-not [string]::Equals($className, '#32770', [System.StringComparison]::Ordinal)) {
        continue
      }

      $matches.Add([pscustomobject]@{
          Handle = $handle
          HandleValue = $handle.ToInt64()
          ProcessId = $processId
          Title = $titleValue
          ClassName = $className
        })
    }
    catch {
      # A top-level window can disappear while its native metadata is inspected.
    }
  }

  if ($matches.Count -gt 1) {
    $identities = @($matches | Select-Object -First 4 | ForEach-Object {
      "pid=$($_.ProcessId),hwnd=$($_.HandleValue),class=$($_.ClassName),title=$($_.Title)"
    }) -join ' | '
    throw "More than one visible owned #32770 window matched the exact ordinal title '$Title': $identities"
  }
  return $(if ($matches.Count -eq 1) { $matches[0] } else { $null })
}

function Find-NativeChildControl {
  param(
    [object]$DialogIdentity,
    [string]$ExpectedClassName,
    [int[]]$ExpectedControlIds,
    [string]$Role
  )

  $matches = [System.Collections.Generic.List[object]]::new()
  foreach ($handle in [HtmllelujahNativeDialog]::EnumerateDescendantWindows($DialogIdentity.Handle)) {
    try {
      if ($handle -eq [IntPtr]::Zero) { continue }
      if (-not [HtmllelujahNativeDialog]::IsWindow($handle)) { continue }
      if (-not [HtmllelujahNativeDialog]::IsChild($DialogIdentity.Handle, $handle)) { continue }
      if (-not [HtmllelujahNativeDialog]::IsWindowVisible($handle)) { continue }
      if (-not [HtmllelujahNativeDialog]::IsWindowEnabled($handle)) { continue }

      $processId = [HtmllelujahNativeDialog]::WindowProcessId($handle)
      if ($processId -ne $DialogIdentity.ProcessId) { continue }

      $className = [HtmllelujahNativeDialog]::WindowClassName($handle)
      if (-not [string]::Equals(
          $className,
          $ExpectedClassName,
          [System.StringComparison]::Ordinal
        )) {
        continue
      }

      $controlId = [HtmllelujahNativeDialog]::WindowControlId($handle)
      if (-not ($ExpectedControlIds -contains $controlId)) { continue }

      $matches.Add([pscustomobject]@{
          Handle = $handle
          HandleValue = $handle.ToInt64()
          ProcessId = $processId
          ClassName = $className
          ControlId = $controlId
          ParentHandleValue = $DialogIdentity.HandleValue
        })
    }
    catch {
      # A common-dialog child can be replaced while its native metadata is inspected.
    }
  }

  if ($matches.Count -gt 1) {
    $identities = @($matches | Select-Object -First 4 | ForEach-Object {
      "pid=$($_.ProcessId),hwnd=$($_.HandleValue),class=$($_.ClassName),id=$($_.ControlId)"
    }) -join ' | '
    throw "The exact native $Role lookup was ambiguous: $identities"
  }
  return $(if ($matches.Count -eq 1) { $matches[0] } else { $null })
}

function Describe-ProcessWindows {
  param([System.Collections.Generic.HashSet[int]]$AllowedProcessIds)

  $descriptions = [System.Collections.Generic.List[object]]::new()
  foreach ($handle in [HtmllelujahNativeDialog]::EnumerateTopLevelWindows()) {
    if ($descriptions.Count -ge 12) { break }
    try {
      if ($handle -eq [IntPtr]::Zero) { continue }
      $processId = [HtmllelujahNativeDialog]::WindowProcessId($handle)
      if (-not $AllowedProcessIds.Contains($processId)) { continue }
      $descriptions.Add([ordered]@{
          processId = $processId
          nativeWindowHandle = $handle.ToInt64()
          visible = [HtmllelujahNativeDialog]::IsWindowVisible($handle)
          className = [HtmllelujahNativeDialog]::WindowClassName($handle)
          title = [HtmllelujahNativeDialog]::WindowTitle($handle)
        })
    }
    catch {
      # A top-level window can disappear between enumeration and metadata reads.
    }
  }
  return $descriptions
}

function Describe-DialogChildren {
  param([object]$DialogIdentity)

  $descriptions = [System.Collections.Generic.List[object]]::new()
  foreach ($handle in [HtmllelujahNativeDialog]::EnumerateDescendantWindows($DialogIdentity.Handle)) {
    if ($descriptions.Count -ge 16) { break }
    try {
      if ($handle -eq [IntPtr]::Zero) { continue }
      $processId = [HtmllelujahNativeDialog]::WindowProcessId($handle)
      if ($processId -ne $DialogIdentity.ProcessId) { continue }
      $descriptions.Add([ordered]@{
          processId = $processId
          nativeWindowHandle = $handle.ToInt64()
          visible = [HtmllelujahNativeDialog]::IsWindowVisible($handle)
          enabled = [HtmllelujahNativeDialog]::IsWindowEnabled($handle)
          className = [HtmllelujahNativeDialog]::WindowClassName($handle)
          controlId = [HtmllelujahNativeDialog]::WindowControlId($handle)
        })
    }
    catch {
      # A child can disappear while bounded diagnostics are collected.
    }
  }
  return $descriptions
}

function Test-NativeDialogIdentity {
  param([object]$DialogIdentity)

  if (-not [HtmllelujahNativeDialog]::IsWindow($DialogIdentity.Handle)) {
    return $false
  }
  if (-not [HtmllelujahNativeDialog]::IsWindowVisible($DialogIdentity.Handle)) {
    throw 'The acquired native save-dialog HWND became non-visible before confirmation.'
  }

  $processId = [HtmllelujahNativeDialog]::WindowProcessId($DialogIdentity.Handle)
  $title = [HtmllelujahNativeDialog]::WindowTitle($DialogIdentity.Handle)
  $className = [HtmllelujahNativeDialog]::WindowClassName($DialogIdentity.Handle)
  if (
    $processId -ne $DialogIdentity.ProcessId -or
    -not [string]::Equals($title, $DialogIdentity.Title, [System.StringComparison]::Ordinal) -or
    -not [string]::Equals(
      $className,
      $DialogIdentity.ClassName,
      [System.StringComparison]::Ordinal
    )
  ) {
    throw 'The acquired native save-dialog HWND changed identity before confirmation.'
  }
  return $true
}

function Test-NativeChildIdentity {
  param(
    [object]$DialogIdentity,
    [object]$ChildIdentity,
    [string]$Role
  )

  if (-not [HtmllelujahNativeDialog]::IsWindow($ChildIdentity.Handle)) {
    return $false
  }
  if (-not [HtmllelujahNativeDialog]::IsChild(
      $DialogIdentity.Handle,
      $ChildIdentity.Handle
    )) {
    throw "The acquired native $Role HWND is no longer a descendant of the exact dialog."
  }
  if (
    -not [HtmllelujahNativeDialog]::IsWindowVisible($ChildIdentity.Handle) -or
    -not [HtmllelujahNativeDialog]::IsWindowEnabled($ChildIdentity.Handle)
  ) {
    throw "The acquired native $Role HWND became unavailable before action."
  }

  $processId = [HtmllelujahNativeDialog]::WindowProcessId($ChildIdentity.Handle)
  $className = [HtmllelujahNativeDialog]::WindowClassName($ChildIdentity.Handle)
  $controlId = [HtmllelujahNativeDialog]::WindowControlId($ChildIdentity.Handle)
  if (
    $processId -ne $ChildIdentity.ProcessId -or
    -not [string]::Equals(
      $className,
      $ChildIdentity.ClassName,
      [System.StringComparison]::Ordinal
    ) -or
    $controlId -ne $ChildIdentity.ControlId
  ) {
    throw "The acquired native $Role HWND changed identity before action."
  }
  return $true
}

if (-not [System.IO.Path]::IsPathRooted($TargetPath)) {
  throw 'The requested destination must be an absolute path.'
}

$parentDirectory = [System.IO.Path]::GetDirectoryName($TargetPath)
if (
  [string]::IsNullOrWhiteSpace($parentDirectory) -or
  -not [System.IO.Directory]::Exists($parentDirectory)
) {
  throw 'The requested destination directory does not exist.'
}

$deadline = $globalStartedAt.AddSeconds([Math]::Min($TimeoutSeconds, 30))
$dialogIdentity = $null
$editorIdentity = $null
$candidateDialogIdentity = $null
$allowedProcessIds = $null

Write-Output 'phase=acquisition'
while ([DateTime]::UtcNow -lt $deadline -and $null -eq $editorIdentity) {
  $allowedProcessIds = Get-ProcessTreeIds -ProcessId $RootProcessId
  $candidateDialogIdentity = Find-NativeDialog `
    -AllowedProcessIds $allowedProcessIds `
    -Title $WindowTitle
  if ($null -ne $candidateDialogIdentity) {
    $candidateEditorIdentity = Find-NativeChildControl `
      -DialogIdentity $candidateDialogIdentity `
      -ExpectedClassName 'Edit' `
      -ExpectedControlIds @(1148, 1001) `
      -Role 'file-name editor'
    if ($null -ne $candidateEditorIdentity) {
      $dialogIdentity = $candidateDialogIdentity
      $editorIdentity = $candidateEditorIdentity
      break
    }
  }
  Start-Sleep -Milliseconds 100
}

if ($null -eq $editorIdentity) {
  if ($null -eq $allowedProcessIds) {
    $allowedProcessIds = Get-ProcessTreeIds -ProcessId $RootProcessId
  }
  $processWindows = Describe-ProcessWindows -AllowedProcessIds $allowedProcessIds
  $dialogChildren = if (
    $null -ne $candidateDialogIdentity -and
    [HtmllelujahNativeDialog]::IsWindow($candidateDialogIdentity.Handle)
  ) {
    @(Describe-DialogChildren -DialogIdentity $candidateDialogIdentity)
  }
  else {
    @()
  }
  $lookupStatus = if ($null -eq $candidateDialogIdentity) {
    'dialog-absent'
  }
  else {
    'editor-missing'
  }
  $matchedDialog = if ($null -eq $candidateDialogIdentity) {
    $null
  }
  else {
    [ordered]@{
      processId = $candidateDialogIdentity.ProcessId
      nativeWindowHandle = $candidateDialogIdentity.HandleValue
      className = $candidateDialogIdentity.ClassName
      title = $candidateDialogIdentity.Title
    }
  }
  $detail = ConvertTo-Json -InputObject ([ordered]@{
      phase = $lookupStatus
      rootProcessId = $RootProcessId
      requestedTitle = $WindowTitle
      allowedProcessIds = @($allowedProcessIds)
      matchedDialog = $matchedDialog
      processWindows = @($processWindows)
      dialogChildren = @($dialogChildren)
      expectedEditor = [ordered]@{
        className = 'Edit'
        controlIds = @(1148, 1001)
      }
    }) -Compress -Depth 5
  throw "Windows file-dialog automation could not acquire the exact dialog and native file-name editor. Diagnostics: $detail"
}

Write-Output 'phase=editor'
if (-not (Test-NativeDialogIdentity -DialogIdentity $dialogIdentity)) {
  throw 'The exact native save dialog closed before the file name could be set.'
}
if (-not (Test-NativeChildIdentity `
    -DialogIdentity $dialogIdentity `
    -ChildIdentity $editorIdentity `
    -Role 'file-name editor'
  )) {
  throw 'The exact native file-name editor closed before its value could be set.'
}
$editorMetadata = [ordered]@{
  processId = $editorIdentity.ProcessId
  nativeWindowHandle = $editorIdentity.HandleValue
  className = $editorIdentity.ClassName
  controlId = $editorIdentity.ControlId
}

Write-Output 'phase=value'
if (-not [HtmllelujahNativeDialog]::SetControlText($editorIdentity.Handle, $TargetPath)) {
  throw "The exact native file-name editor rejected the requested value (hwnd=$($editorIdentity.HandleValue),class=$($editorIdentity.ClassName),id=$($editorIdentity.ControlId))."
}
$maximumTextLength = [Math]::Min([Math]::Max($TargetPath.Length + 16, 260), 32768)
$editorValue = [HtmllelujahNativeDialog]::ReadControlText(
  $editorIdentity.Handle,
  $maximumTextLength
)
if (-not [string]::Equals(
    $editorValue,
    $TargetPath,
    [System.StringComparison]::Ordinal
  )) {
  throw "The exact native file-name editor did not retain the requested value (hwnd=$($editorIdentity.HandleValue),actualLength=$($editorValue.Length),expectedLength=$($TargetPath.Length))."
}
$editorValueLength = $editorValue.Length

Write-Output 'phase=button'
$buttonIdentity = $null
while ([DateTime]::UtcNow -lt $deadline -and $null -eq $buttonIdentity) {
  if (-not (Test-NativeDialogIdentity -DialogIdentity $dialogIdentity)) {
    throw 'The exact native save dialog closed before its confirmation button became available.'
  }
  $buttonIdentity = Find-NativeChildControl `
    -DialogIdentity $dialogIdentity `
    -ExpectedClassName 'Button' `
    -ExpectedControlIds @(1) `
    -Role 'confirmation button'
  if ($null -eq $buttonIdentity) {
    Start-Sleep -Milliseconds 100
  }
}
if ($null -eq $buttonIdentity) {
  $children = Describe-DialogChildren -DialogIdentity $dialogIdentity
  $detail = ConvertTo-Json -InputObject ([ordered]@{
      phase = 'button-missing'
      dialogHandle = $dialogIdentity.HandleValue
      expectedClassName = 'Button'
      expectedControlIds = @(1)
      dialogChildren = @($children)
    }) -Compress -Depth 4
  throw "The exact native save-dialog confirmation button did not become available before the global deadline. Diagnostics: $detail"
}

if (-not (Test-NativeChildIdentity `
    -DialogIdentity $dialogIdentity `
    -ChildIdentity $buttonIdentity `
    -Role 'confirmation button'
  )) {
  throw 'The exact native save-dialog confirmation button closed before its action could be dispatched.'
}
$buttonMetadata = [ordered]@{
  processId = $buttonIdentity.ProcessId
  nativeWindowHandle = $buttonIdentity.HandleValue
  className = $buttonIdentity.ClassName
  controlId = $buttonIdentity.ControlId
}

Write-Output 'phase=click'
if (-not [HtmllelujahNativeDialog]::ClickNativeButton($buttonIdentity.Handle)) {
  throw "The exact native save-dialog confirmation button rejected its targeted click (hwnd=$($buttonIdentity.HandleValue),class=$($buttonIdentity.ClassName),id=$($buttonIdentity.ControlId))."
}

Write-Output 'phase=wait-close'
$dialogCloseDeadline = [DateTime]::UtcNow.AddSeconds(5)
if ($dialogCloseDeadline -gt $deadline) {
  $dialogCloseDeadline = $deadline
}
while ([DateTime]::UtcNow -lt $dialogCloseDeadline) {
  if (-not [HtmllelujahNativeDialog]::IsWindow($dialogIdentity.Handle)) {
    Write-Output 'Windows save dialog completed.'
    exit 0
  }
  Start-Sleep -Milliseconds 100
}
if (-not [HtmllelujahNativeDialog]::IsWindow($dialogIdentity.Handle)) {
  Write-Output 'Windows save dialog completed.'
  exit 0
}

$detail = ConvertTo-Json -InputObject ([ordered]@{
    phase = 'wait-close-timeout'
    dialog = [ordered]@{
      processId = $dialogIdentity.ProcessId
      nativeWindowHandle = $dialogIdentity.HandleValue
      className = $dialogIdentity.ClassName
      title = $dialogIdentity.Title
    }
    editor = $editorMetadata
    editorValueLength = $editorValueLength
    button = $buttonMetadata
  }) -Compress -Depth 4
throw "The exact Windows save-dialog HWND remained open after confirmation. Diagnostics: $detail"
