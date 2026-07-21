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
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class HtmllelujahMessageBoxInput
{
    private delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr parameter);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int GetWindowTextLength(IntPtr window);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int GetWindowText(IntPtr window, StringBuilder text, int maximumCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int GetClassName(IntPtr window, StringBuilder className, int maximumCount);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

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

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool IsWindow(IntPtr window);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool IsWindowEnabled(IntPtr window);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool IsChild(IntPtr parent, IntPtr child);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern int GetWindowLong(IntPtr window, int index);

    public static IntPtr[] EnumerateTopLevelWindows()
    {
        var windows = new List<IntPtr>();
        EnumWindows(delegate (IntPtr window, IntPtr parameter)
        {
            if (window != IntPtr.Zero) windows.Add(window);
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
    }

    public static IntPtr[] EnumerateChildWindowHandles(IntPtr parent)
    {
        var windows = new List<IntPtr>();
        EnumChildWindows(parent, delegate (IntPtr window, IntPtr parameter)
        {
            if (window != IntPtr.Zero) windows.Add(window);
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
    }

    public static int WindowProcessId(IntPtr window)
    {
        uint processId;
        GetWindowThreadProcessId(window, out processId);
        return unchecked((int)processId);
    }

    public static string WindowTitle(IntPtr window)
    {
        int length = GetWindowTextLength(window);
        if (length <= 0) return String.Empty;
        var text = new StringBuilder(length + 1);
        GetWindowText(window, text, text.Capacity);
        return text.ToString();
    }

    public static string WindowClassName(IntPtr window)
    {
        var className = new StringBuilder(256);
        GetClassName(window, className, className.Capacity);
        return className.ToString();
    }

    public static bool ClickNativeButton(IntPtr window)
    {
        if (window == IntPtr.Zero || !IsWindow(window)) return false;
        const uint ButtonClick = 0x00F5;
        const uint AbortIfHung = 0x0002;
        IntPtr messageResult;
        return SendMessageTimeout(
            window,
            ButtonClick,
            IntPtr.Zero,
            IntPtr.Zero,
            AbortIfHung,
            1000,
            out messageResult
        ) != IntPtr.Zero;
    }

    public static bool IsDefaultPushButton(IntPtr window)
    {
        const int WindowStyle = -16;
        const int ButtonTypeMask = 0x0000000F;
        const int DefaultPushButton = 0x00000001;
        return (GetWindowLong(window, WindowStyle) & ButtonTypeMask) == DefaultPushButton;
    }
}
'@

function Limit-Text {
  param(
    [AllowNull()]
    [string]$Value,
    [int]$MaximumLength = 160
  )

  if ($null -eq $Value) { return '' }
  if ($Value.Length -le $MaximumLength) { return $Value }
  return $Value.Substring(0, $MaximumLength) + '...'
}

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
  return ,$accepted
}

function Get-ExactNativeDialog {
  param(
    [System.Collections.Generic.HashSet[int]]$AllowedProcessIds,
    [string]$Title
  )

  $match = $null
  foreach ($handle in [HtmllelujahMessageBoxInput]::EnumerateTopLevelWindows()) {
    if (
      $handle -eq [IntPtr]::Zero -or
      -not [HtmllelujahMessageBoxInput]::IsWindow($handle) -or
      -not [HtmllelujahMessageBoxInput]::IsWindowVisible($handle)
    ) {
      continue
    }
    $processId = [HtmllelujahMessageBoxInput]::WindowProcessId($handle)
    if (-not $AllowedProcessIds.Contains($processId)) { continue }
    $nativeTitle = [HtmllelujahMessageBoxInput]::WindowTitle($handle)
    if (-not [string]::Equals($nativeTitle, $Title, [StringComparison]::Ordinal)) { continue }
    $className = [HtmllelujahMessageBoxInput]::WindowClassName($handle)
    if (-not [string]::Equals($className, '#32770', [StringComparison]::Ordinal)) { continue }

    if ($null -ne $match) {
      $safeTitle = Limit-Text -Value $Title
      throw "More than one visible owned #32770 dialog matched the exact ordinal title '$safeTitle'."
    }
    $match = [pscustomobject]@{
      Handle = [IntPtr]$handle
      ProcessId = $processId
      Title = $nativeTitle
      ClassName = $className
    }
  }
  return $match
}

function ConvertTo-UiaDialog {
  param([object]$NativeDialog)

  if ($null -eq $NativeDialog) { return $null }
  $dialog = [System.Windows.Automation.AutomationElement]::FromHandle(
    [IntPtr]$NativeDialog.Handle
  )
  if ($null -eq $dialog) { return $null }
  $uiaHandleBits = ([int64][int]$dialog.Current.NativeWindowHandle) -band 0xFFFFFFFFL
  $nativeHandleBits = ([int64][IntPtr]$NativeDialog.Handle) -band 0xFFFFFFFFL
  if (
    $uiaHandleBits -ne $nativeHandleBits -or
    [int]$dialog.Current.ProcessId -ne [int]$NativeDialog.ProcessId
  ) {
    throw 'UI Automation returned an element that did not preserve the acquired dialog identity.'
  }
  return $dialog
}

function Find-ConfirmationButton {
  param(
    [object]$NativeDialog,
    [string]$RequestedName
  )

  $matches = [System.Collections.Generic.List[object]]::new()
  $eligible = [System.Collections.Generic.List[object]]::new()
  foreach (
    $handle in [HtmllelujahMessageBoxInput]::EnumerateChildWindowHandles(
      [IntPtr]$NativeDialog.Handle
    )
  ) {
    if (
      $handle -eq [IntPtr]::Zero -or
      -not [HtmllelujahMessageBoxInput]::IsWindow($handle) -or
      -not [HtmllelujahMessageBoxInput]::IsWindowVisible($handle) -or
      -not [HtmllelujahMessageBoxInput]::IsWindowEnabled($handle) -or
      [HtmllelujahMessageBoxInput]::WindowProcessId($handle) -ne [int]$NativeDialog.ProcessId -or
      -not [string]::Equals(
        [HtmllelujahMessageBoxInput]::WindowClassName($handle),
        'Button',
        [StringComparison]::Ordinal
      )
    ) {
      continue
    }
    $eligible.Add([pscustomobject]@{
      Handle = [IntPtr]$handle
      ProcessId = [HtmllelujahMessageBoxInput]::WindowProcessId($handle)
      Name = [HtmllelujahMessageBoxInput]::WindowTitle($handle)
      ClassName = [HtmllelujahMessageBoxInput]::WindowClassName($handle)
      IsDefault = [HtmllelujahMessageBoxInput]::IsDefaultPushButton($handle)
    })
  }

  if (-not [string]::IsNullOrWhiteSpace($RequestedName)) {
    foreach ($button in $eligible) {
      if (
        [string]::Equals(
          [string]$button.Name,
          $RequestedName,
          [StringComparison]::Ordinal
        )
      ) {
        $matches.Add($button)
      }
    }
    if ($matches.Count -gt 1) {
      $safeName = Limit-Text -Value $RequestedName
      throw "More than one visible enabled native button matched the exact ordinal name '$safeName'."
    }
    return $(if ($matches.Count -eq 1) { $matches[0] } else { $null })
  }

  foreach ($button in $eligible) {
    if ($button.IsDefault) { $matches.Add($button) }
  }
  if ($matches.Count -gt 1) {
    throw 'More than one visible enabled native message-box button was marked as default.'
  }
  if ($matches.Count -eq 1) { return $matches[0] }

  foreach ($button in $eligible) {
    if (
      [string]::Equals(
        [string]$button.Name,
        'OK',
        [StringComparison]::Ordinal
      )
    ) {
      $matches.Add($button)
    }
  }
  if ($matches.Count -gt 1) {
    throw 'More than one visible enabled native message-box button matched the exact ordinal name OK.'
  }
  return $(if ($matches.Count -eq 1) { $matches[0] } else { $null })
}

function Describe-NativeProcessWindows {
  param([System.Collections.Generic.HashSet[int]]$AllowedProcessIds)

  $descriptions = [System.Collections.Generic.List[object]]::new()
  foreach ($handle in [HtmllelujahMessageBoxInput]::EnumerateTopLevelWindows()) {
    if ($descriptions.Count -ge 12) { break }
    try {
      if (
        $handle -eq [IntPtr]::Zero -or
        -not [HtmllelujahMessageBoxInput]::IsWindow($handle) -or
        -not [HtmllelujahMessageBoxInput]::IsWindowVisible($handle)
      ) {
        continue
      }
      $processId = [HtmllelujahMessageBoxInput]::WindowProcessId($handle)
      if (-not $AllowedProcessIds.Contains($processId)) { continue }
      $descriptions.Add([ordered]@{
        processId = $processId
        nativeWindowHandle = [int64]$handle
        title = Limit-Text -Value ([HtmllelujahMessageBoxInput]::WindowTitle($handle))
        className = Limit-Text -Value ([HtmllelujahMessageBoxInput]::WindowClassName($handle)) -MaximumLength 80
      })
    }
    catch {
      # A top-level window can disappear while its metadata is inspected.
    }
  }
  return $descriptions
}

function Describe-Buttons {
  param([object]$NativeDialog)

  if ($null -eq $NativeDialog) { return @() }
  $descriptions = [System.Collections.Generic.List[object]]::new()
  foreach (
    $handle in [HtmllelujahMessageBoxInput]::EnumerateChildWindowHandles(
      [IntPtr]$NativeDialog.Handle
    )
  ) {
    if ($descriptions.Count -ge 12) { break }
    try {
      if (
        $handle -eq [IntPtr]::Zero -or
        -not [HtmllelujahMessageBoxInput]::IsWindow($handle) -or
        -not [string]::Equals(
          [HtmllelujahMessageBoxInput]::WindowClassName($handle),
          'Button',
          [StringComparison]::Ordinal
        )
      ) {
        continue
      }
      $descriptions.Add([ordered]@{
        name = Limit-Text -Value ([HtmllelujahMessageBoxInput]::WindowTitle($handle))
        enabled = [HtmllelujahMessageBoxInput]::IsWindowEnabled($handle)
        visible = [HtmllelujahMessageBoxInput]::IsWindowVisible($handle)
        default = [HtmllelujahMessageBoxInput]::IsDefaultPushButton($handle)
        nativeWindowHandle = [int64]$handle
      })
    }
    catch {
      # A native button can disappear while diagnostics are collected.
    }
  }
  return $descriptions
}

function Get-DialogGenerationFingerprint {
  param([object]$NativeDialog)

  $children = [System.Collections.Generic.List[object]]::new()
  foreach (
    $handle in [HtmllelujahMessageBoxInput]::EnumerateChildWindowHandles(
      [IntPtr]$NativeDialog.Handle
    )
  ) {
    try {
      if (
        $handle -eq [IntPtr]::Zero -or
        -not [HtmllelujahMessageBoxInput]::IsWindow($handle) -or
        [HtmllelujahMessageBoxInput]::WindowProcessId($handle) -ne [int]$NativeDialog.ProcessId
      ) {
        continue
      }
      $children.Add([ordered]@{
        nativeWindowHandle = [int64]$handle
        className = [HtmllelujahMessageBoxInput]::WindowClassName($handle)
        title = [HtmllelujahMessageBoxInput]::WindowTitle($handle)
        visible = [HtmllelujahMessageBoxInput]::IsWindowVisible($handle)
        enabled = [HtmllelujahMessageBoxInput]::IsWindowEnabled($handle)
      })
    }
    catch {
      throw 'The native message-box control generation changed while it was being acquired.'
    }
  }
  return ConvertTo-Json -InputObject @(
    $children | Sort-Object nativeWindowHandle
  ) -Compress -Depth 3
}

function Test-DialogIdentity {
  param(
    [object]$Identity,
    [string]$ExpectedGenerationFingerprint
  )

  $handle = [IntPtr]$Identity.Handle
  if (-not [HtmllelujahMessageBoxInput]::IsWindow($handle)) { return $false }
  if (-not [HtmllelujahMessageBoxInput]::IsWindowVisible($handle)) { return $false }
  if ([HtmllelujahMessageBoxInput]::WindowProcessId($handle) -ne [int]$Identity.ProcessId) {
    return $false
  }
  if (
    -not [string]::Equals(
      [HtmllelujahMessageBoxInput]::WindowTitle($handle),
      [string]$Identity.Title,
      [StringComparison]::Ordinal
    )
  ) {
    return $false
  }
  if (-not [string]::Equals(
      [HtmllelujahMessageBoxInput]::WindowClassName($handle),
      [string]$Identity.ClassName,
      [StringComparison]::Ordinal
    )) {
    return $false
  }
  $currentGenerationFingerprint = Get-DialogGenerationFingerprint -NativeDialog $Identity
  return [string]::Equals(
    $currentGenerationFingerprint,
    $ExpectedGenerationFingerprint,
    [StringComparison]::Ordinal
  )
}

$operationTimeoutSeconds = [Math]::Min($TimeoutSeconds, 30)
$deadline = [DateTime]::UtcNow.AddSeconds($operationTimeoutSeconds)
$nativeDialog = $null
$button = $null
Write-Output '__HTMLLELUJAH_MESSAGE_BOX_PHASE__:acquiring'
$allowedProcessIds = Get-ProcessTreeIds -ProcessId $RootProcessId
$lastNativeDialog = $null

while ([DateTime]::UtcNow -lt $deadline -and $null -eq $button) {
  $candidateNativeDialog = Get-ExactNativeDialog `
    -AllowedProcessIds $allowedProcessIds `
    -Title $WindowTitle
  if ($null -ne $candidateNativeDialog) {
    $lastNativeDialog = $candidateNativeDialog
    $candidateDialog = ConvertTo-UiaDialog -NativeDialog $candidateNativeDialog
    if ($null -ne $candidateDialog) {
      $candidateButton = Find-ConfirmationButton `
        -NativeDialog $candidateNativeDialog `
        -RequestedName $ButtonName
      if ($null -ne $candidateButton) {
        $nativeDialog = $candidateNativeDialog
        $button = $candidateButton
        break
      }
    }
  }
  Start-Sleep -Milliseconds 100
}

if ($null -eq $button) {
  $processWindows = Describe-NativeProcessWindows -AllowedProcessIds $allowedProcessIds
  $observedButtons = Describe-Buttons -NativeDialog $lastNativeDialog
  $phase = if ($null -eq $lastNativeDialog) { 'dialog-absent' } else { 'button-absent' }
  $detail = ConvertTo-Json -InputObject ([ordered]@{
    phase = $phase
    rootProcessId = $RootProcessId
    requestedTitle = Limit-Text -Value $WindowTitle
    requestedButton = Limit-Text -Value $ButtonName
    allowedProcessIds = @($allowedProcessIds | Sort-Object | Select-Object -First 32)
    processWindows = @($processWindows)
    observedButtons = @($observedButtons)
  }) -Compress -Depth 4
  throw "Native message-box automation could not acquire the requested dialog and button. Diagnostics: $detail"
}

$dialogHandle = [IntPtr]$nativeDialog.Handle
$buttonHandle = [IntPtr]$button.Handle
$dialogGenerationFingerprint = Get-DialogGenerationFingerprint -NativeDialog $nativeDialog
$buttonNameIdentity = [string]$button.Name
$buttonClassIdentity = [string]$button.ClassName
$buttonIdentity = [ordered]@{
  processId = [int]$button.ProcessId
  name = Limit-Text -Value $buttonNameIdentity
  className = Limit-Text -Value $buttonClassIdentity -MaximumLength 80
  default = [bool]$button.IsDefault
  nativeWindowHandle = [int64]$buttonHandle
}
$dialogIdentity = [ordered]@{
  processId = [int]$nativeDialog.ProcessId
  nativeWindowHandle = [int64]$dialogHandle
  title = Limit-Text -Value ([string]$nativeDialog.Title)
  className = [string]$nativeDialog.ClassName
}

Write-Output '__HTMLLELUJAH_MESSAGE_BOX_PHASE__:ready'
Write-Output '__HTMLLELUJAH_MESSAGE_BOX_READY__'

if ($DelayMilliseconds -gt 0) {
  Write-Output '__HTMLLELUJAH_MESSAGE_BOX_PHASE__:delay'
  if ([DateTime]::UtcNow.AddMilliseconds($DelayMilliseconds) -gt $deadline) {
    throw 'The configured message-box delay would exceed the bounded automation deadline.'
  }
  Start-Sleep -Milliseconds $DelayMilliseconds
}

if (-not [string]::IsNullOrWhiteSpace($ReleasePath)) {
  Write-Output '__HTMLLELUJAH_MESSAGE_BOX_PHASE__:waiting-release'
  while ([DateTime]::UtcNow -lt $deadline -and -not (Test-Path -LiteralPath $ReleasePath)) {
    Start-Sleep -Milliseconds 50
  }
  if (-not (Test-Path -LiteralPath $ReleasePath)) {
    throw 'The native message box release signal did not appear before the bounded automation deadline.'
  }
}

if (-not (Test-DialogIdentity `
    -Identity $nativeDialog `
    -ExpectedGenerationFingerprint $dialogGenerationFingerprint
  )) {
  $detail = ConvertTo-Json -InputObject ([ordered]@{
    phase = 'identity-changed-before-click'
    dialog = $dialogIdentity
    button = $buttonIdentity
  }) -Compress -Depth 3
  throw "The acquired native message-box identity changed before confirmation. Diagnostics: $detail"
}
if (
  -not [HtmllelujahMessageBoxInput]::IsWindow($buttonHandle) -or
  -not [HtmllelujahMessageBoxInput]::IsWindowVisible($buttonHandle) -or
  -not [HtmllelujahMessageBoxInput]::IsWindowEnabled($buttonHandle) -or
  -not [HtmllelujahMessageBoxInput]::IsChild($dialogHandle, $buttonHandle) -or
  [HtmllelujahMessageBoxInput]::WindowProcessId($buttonHandle) -ne [int]$buttonIdentity.processId -or
  -not [string]::Equals(
    [HtmllelujahMessageBoxInput]::WindowTitle($buttonHandle),
    $buttonNameIdentity,
    [StringComparison]::Ordinal
  ) -or
  -not [string]::Equals(
    [HtmllelujahMessageBoxInput]::WindowClassName($buttonHandle),
    $buttonClassIdentity,
    [StringComparison]::Ordinal
  )
) {
  $detail = ConvertTo-Json -InputObject ([ordered]@{
    phase = 'button-identity-changed-before-click'
    dialog = $dialogIdentity
    button = $buttonIdentity
  }) -Compress -Depth 3
  throw "The acquired native message-box button identity changed before confirmation. Diagnostics: $detail"
}

Write-Output '__HTMLLELUJAH_MESSAGE_BOX_PHASE__:clicking'
$nativeClick = [HtmllelujahMessageBoxInput]::ClickNativeButton($buttonHandle)
if (-not $nativeClick) {
  throw 'Windows rejected activation of the exact native message-box button HWND.'
}

Write-Output '__HTMLLELUJAH_MESSAGE_BOX_PHASE__:waiting-close'
$closeDeadline = [DateTime]::UtcNow.AddSeconds(5)
if ($closeDeadline -gt $deadline) { $closeDeadline = $deadline }
while ([DateTime]::UtcNow -lt $closeDeadline) {
  if (-not [HtmllelujahMessageBoxInput]::IsWindow($dialogHandle)) {
    Write-Output 'Native message box dismissed.'
    exit 0
  }
  Start-Sleep -Milliseconds 50
}
if (-not [HtmllelujahMessageBoxInput]::IsWindow($dialogHandle)) {
  Write-Output 'Native message box dismissed.'
  exit 0
}

$detail = ConvertTo-Json -InputObject ([ordered]@{
  phase = 'dialog-still-open'
  dialog = $dialogIdentity
  button = $buttonIdentity
}) -Compress -Depth 3
throw "The exact native message-box HWND remained open after confirmation. Diagnostics: $detail"
