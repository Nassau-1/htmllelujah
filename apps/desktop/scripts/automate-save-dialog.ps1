param(
  [Parameter(Mandatory = $true)]
  [int]$RootProcessId,

  [Parameter(Mandatory = $true)]
  [string]$WindowTitle,

  [Parameter(Mandatory = $true)]
  [string]$TargetPath,

  [Parameter(Mandatory = $true)]
  [ValidateSet('Open', 'Save')]
  [string]$DialogKind,

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
    private const uint DialogGetDefaultId = 0x0400;
    private const uint DialogGetFolderPath = 0x0466;
    private const int DialogHasDefaultId = 0x534B;
    private const int DefaultButtonControlId = 1;
    private const uint ButtonClick = 0x00F5;
    private const uint EditSetSelection = 0x00B1;
    private const uint ClearSelection = 0x0303;
    private const uint CharacterInput = 0x0102;
    private const uint GetText = 0x000D;
    private const uint GetTextLength = 0x000E;
    private const uint MessageTimeoutMilliseconds = 1000;
    private const int IdentityRecheckIntervalCharacters = 16;

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

    [DllImport("user32.dll")]
    private static extern IntPtr GetParent(IntPtr window);

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

    public static IntPtr WindowParent(IntPtr window)
    {
        return GetParent(window);
    }

    private static uint RemainingMessageTimeout(long deadlineUtcTicks, string operation)
    {
        long remainingTicks = deadlineUtcTicks - DateTime.UtcNow.Ticks;
        if (remainingTicks <= 0) {
            throw new TimeoutException(
                "The exact native dialog reached the global deadline before " + operation + "."
            );
        }
        long remainingMilliseconds = Math.Max(
            1,
            (remainingTicks + TimeSpan.TicksPerMillisecond - 1) /
                TimeSpan.TicksPerMillisecond
        );
        return (uint)Math.Min(MessageTimeoutMilliseconds, remainingMilliseconds);
    }

    private static void DispatchRequired(
        IntPtr window,
        uint message,
        IntPtr word,
        IntPtr data,
        string operation,
        long deadlineUtcTicks
    )
    {
        uint messageTimeout = RemainingMessageTimeout(deadlineUtcTicks, operation);
        IntPtr messageResult;
        IntPtr dispatched = SendMessageTimeout(
            window,
            message,
            word,
            data,
            AbortIfHung,
            messageTimeout,
            out messageResult
        );
        if (dispatched == IntPtr.Zero) {
            throw new TimeoutException(
                "The exact native editor did not accept " + operation + "."
            );
        }
    }

    private static void AssertExactEditorIdentity(
        IntPtr dialog,
        IntPtr editor,
        int expectedDialogProcessId,
        string expectedDialogTitle,
        string expectedDialogClassName,
        int expectedEditorProcessId,
        string expectedEditorClassName,
        int expectedEditorControlId
    )
    {
        if (
            dialog == IntPtr.Zero ||
            editor == IntPtr.Zero ||
            !IsWindow(dialog) ||
            !IsWindowVisible(dialog) ||
            WindowProcessId(dialog) != expectedDialogProcessId ||
            !string.Equals(
                WindowTitle(dialog),
                expectedDialogTitle,
                StringComparison.Ordinal
            ) ||
            !string.Equals(
                WindowClassName(dialog),
                expectedDialogClassName,
                StringComparison.Ordinal
            ) ||
            !IsWindow(editor) ||
            !IsChild(dialog, editor) ||
            !IsWindowVisible(editor) ||
            !IsWindowEnabled(editor) ||
            WindowProcessId(editor) != expectedEditorProcessId ||
            !string.Equals(
                WindowClassName(editor),
                expectedEditorClassName,
                StringComparison.Ordinal
            ) ||
            WindowControlId(editor) != expectedEditorControlId
        ) {
            throw new InvalidOperationException(
                "The exact native file-name editor changed identity during bounded input."
            );
        }
    }

    public static void TypeControlText(
        IntPtr dialog,
        IntPtr editor,
        string value,
        long deadlineUtcTicks,
        int expectedDialogProcessId,
        string expectedDialogTitle,
        string expectedDialogClassName,
        int expectedEditorProcessId,
        string expectedEditorClassName,
        int expectedEditorControlId
    )
    {
        if (value == null) throw new ArgumentNullException("value");
        AssertExactEditorIdentity(
            dialog,
            editor,
            expectedDialogProcessId,
            expectedDialogTitle,
            expectedDialogClassName,
            expectedEditorProcessId,
            expectedEditorClassName,
            expectedEditorControlId
        );
        DispatchRequired(
            editor,
            EditSetSelection,
            IntPtr.Zero,
            new IntPtr(-1),
            "select-all",
            deadlineUtcTicks
        );
        DispatchRequired(
            editor,
            ClearSelection,
            IntPtr.Zero,
            IntPtr.Zero,
            "selection clearing",
            deadlineUtcTicks
        );
        AssertExactEditorIdentity(
            dialog,
            editor,
            expectedDialogProcessId,
            expectedDialogTitle,
            expectedDialogClassName,
            expectedEditorProcessId,
            expectedEditorClassName,
            expectedEditorControlId
        );
        for (int index = 0; index < value.Length; index++) {
            if (index % IdentityRecheckIntervalCharacters == 0) {
                AssertExactEditorIdentity(
                    dialog,
                    editor,
                    expectedDialogProcessId,
                    expectedDialogTitle,
                    expectedDialogClassName,
                    expectedEditorProcessId,
                    expectedEditorClassName,
                    expectedEditorControlId
                );
            }
            DispatchRequired(
                editor,
                CharacterInput,
                new IntPtr(value[index]),
                new IntPtr(1),
                "character input",
                deadlineUtcTicks
            );
        }
        AssertExactEditorIdentity(
            dialog,
            editor,
            expectedDialogProcessId,
            expectedDialogTitle,
            expectedDialogClassName,
            expectedEditorProcessId,
            expectedEditorClassName,
            expectedEditorControlId
        );
    }

    public static string ReadControlText(
        IntPtr window,
        int maximumCharacters,
        long deadlineUtcTicks
    )
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
            RemainingMessageTimeout(deadlineUtcTicks, "text-length read"),
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
            RemainingMessageTimeout(deadlineUtcTicks, "text read"),
            out readResult
        );
        if (readDispatched == IntPtr.Zero) {
            throw new TimeoutException("The exact native edit did not return its text.");
        }
        return text.ToString();
    }

    public static string ReadDialogFolderPath(
        IntPtr dialog,
        int maximumCharacters,
        long deadlineUtcTicks
    )
    {
        if (maximumCharacters < 2) {
            throw new ArgumentOutOfRangeException("maximumCharacters");
        }
        var folder = new StringBuilder(maximumCharacters);
        IntPtr messageResult;
        IntPtr dispatched = SendMessageTimeout(
            dialog,
            DialogGetFolderPath,
            new IntPtr(maximumCharacters),
            folder,
            AbortIfHung,
            RemainingMessageTimeout(deadlineUtcTicks, "folder-path read"),
            out messageResult
        );
        if (dispatched == IntPtr.Zero) {
            throw new TimeoutException("The exact native dialog did not return its current folder.");
        }
        long length = messageResult.ToInt64();
        if (length < 0 || length >= maximumCharacters) {
            throw new InvalidOperationException(
                "The exact native dialog returned an invalid current-folder length."
            );
        }
        return folder.ToString();
    }

    private static IntPtr ExactDefaultButtonParent(IntPtr dialog, IntPtr button)
    {
        if (dialog == IntPtr.Zero || button == IntPtr.Zero) {
            throw new InvalidOperationException("The exact native dialog button identity was empty.");
        }

        uint dialogProcessId;
        uint buttonProcessId;
        uint dialogThreadId = GetWindowThreadProcessId(dialog, out dialogProcessId);
        uint buttonThreadId = GetWindowThreadProcessId(button, out buttonProcessId);
        IntPtr buttonParent = GetParent(button);
        uint parentProcessId;
        uint parentThreadId = GetWindowThreadProcessId(buttonParent, out parentProcessId);
        if (
            dialogThreadId == 0 ||
            buttonThreadId != dialogThreadId ||
            parentThreadId != dialogThreadId ||
            dialogProcessId == 0 ||
            buttonProcessId != dialogProcessId ||
            parentProcessId != dialogProcessId ||
            GetDlgCtrlID(button) != DefaultButtonControlId ||
            (buttonParent != dialog && !IsChild(dialog, buttonParent))
        ) {
            throw new InvalidOperationException(
                "The exact native default button no longer shared the dialog's strict process, " +
                "thread, control ID, and parent hierarchy."
            );
        }
        return buttonParent;
    }

    public static bool IsExactDefaultButtonReady(
        IntPtr dialog,
        IntPtr button,
        long deadlineUtcTicks
    )
    {
        ExactDefaultButtonParent(dialog, button);

        IntPtr defaultIdResult;
        IntPtr defaultIdDispatched = SendMessageTimeout(
            dialog,
            DialogGetDefaultId,
            IntPtr.Zero,
            IntPtr.Zero,
            AbortIfHung,
            RemainingMessageTimeout(deadlineUtcTicks, "default-button validation"),
            out defaultIdResult
        );
        if (defaultIdDispatched == IntPtr.Zero) {
            return false;
        }

        long defaultId = defaultIdResult.ToInt64();
        int defaultControlId = (int)(defaultId & 0xFFFFL);
        int defaultMarker = (int)((defaultId >> 16) & 0xFFFFL);
        if (
            defaultMarker != DialogHasDefaultId ||
            defaultControlId != DefaultButtonControlId
        ) {
            throw new InvalidOperationException(
                "The exact native dialog did not identify control 1 as its default button " +
                "(marker=" + defaultMarker + ",controlId=" + defaultControlId + ")."
            );
        }
        return true;
    }

    public static void ClickExactDefaultButton(
        IntPtr dialog,
        IntPtr button,
        long deadlineUtcTicks
    )
    {
        if (!IsExactDefaultButtonReady(dialog, button, deadlineUtcTicks)) {
            throw new InvalidOperationException(
                "The exact native default button was not ready for bounded confirmation."
            );
        }
        DispatchRequired(
            button,
            ButtonClick,
            IntPtr.Zero,
            IntPtr.Zero,
            "default-button confirmation",
            deadlineUtcTicks
        );
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

function Find-SecondaryNativeDialogs {
  param(
    [System.Collections.Generic.HashSet[int]]$AllowedProcessIds,
    [int64]$ExcludedHandle
  )

  $matches = [System.Collections.Generic.List[object]]::new()
  foreach ($handle in [HtmllelujahNativeDialog]::EnumerateTopLevelWindows()) {
    try {
      if ($handle -eq [IntPtr]::Zero -or $handle.ToInt64() -eq $ExcludedHandle) { continue }
      if (-not [HtmllelujahNativeDialog]::IsWindow($handle)) { continue }
      if (-not [HtmllelujahNativeDialog]::IsWindowVisible($handle)) { continue }
      $processId = [HtmllelujahNativeDialog]::WindowProcessId($handle)
      if (-not $AllowedProcessIds.Contains($processId)) { continue }
      $className = [HtmllelujahNativeDialog]::WindowClassName($handle)
      if (-not [string]::Equals($className, '#32770', [System.StringComparison]::Ordinal)) {
        continue
      }
      $matches.Add([ordered]@{
          processId = $processId
          nativeWindowHandle = $handle.ToInt64()
          title = [HtmllelujahNativeDialog]::WindowTitle($handle)
        })
    }
    catch {
      # A secondary top-level window can disappear during the bounded inspection.
    }
  }
  return @($matches)
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
          title = [HtmllelujahNativeDialog]::WindowTitle($handle)
        })
    }
    catch {
      # A child can disappear while bounded diagnostics are collected.
    }
  }
  return $descriptions
}

function Describe-DialogVisibleText {
  param([object]$DialogIdentity)

  $descriptions = [System.Collections.Generic.List[object]]::new()
  foreach ($handle in [HtmllelujahNativeDialog]::EnumerateDescendantWindows($DialogIdentity.Handle)) {
    if ($descriptions.Count -ge 12) { break }
    try {
      if ($handle -eq [IntPtr]::Zero) { continue }
      if (-not [HtmllelujahNativeDialog]::IsWindowVisible($handle)) { continue }
      $processId = [HtmllelujahNativeDialog]::WindowProcessId($handle)
      if ($processId -ne $DialogIdentity.ProcessId) { continue }
      $title = [HtmllelujahNativeDialog]::WindowTitle($handle)
      if ([string]::IsNullOrWhiteSpace($title)) { continue }
      $descriptions.Add([ordered]@{
          nativeWindowHandle = $handle.ToInt64()
          className = [HtmllelujahNativeDialog]::WindowClassName($handle)
          controlId = [HtmllelujahNativeDialog]::WindowControlId($handle)
          title = $title
        })
    }
    catch {
      # The diagnostic child can disappear while its exact text is read.
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

function Test-NativeMessageTimeoutException {
  param([System.Exception]$Exception)

  $current = $Exception
  while ($null -ne $current) {
    if ($current -is [System.TimeoutException]) {
      return $true
    }
    $current = $current.InnerException
  }
  return $false
}

function Read-ExactNativeEditorText {
  param(
    [object]$DialogIdentity,
    [object]$EditorIdentity,
    [int]$MaximumCharacters,
    [DateTime]$Deadline
  )

  $attempts = 0
  $lastTimeout = 'none'
  while ([DateTime]::UtcNow -lt $Deadline) {
    if (-not (Test-NativeDialogIdentity -DialogIdentity $DialogIdentity)) {
      throw 'The exact native save dialog closed while its file-name value was being verified.'
    }
    if (-not (Test-NativeChildIdentity `
        -DialogIdentity $DialogIdentity `
        -ChildIdentity $EditorIdentity `
        -Role 'file-name editor'
      )) {
      throw 'The exact native file-name editor closed while its value was being verified.'
    }

    $attempts += 1
    try {
      return [HtmllelujahNativeDialog]::ReadControlText(
        $EditorIdentity.Handle,
        $MaximumCharacters,
        $Deadline.Ticks
      )
    }
    catch {
      if (-not (Test-NativeMessageTimeoutException -Exception $_.Exception)) {
        throw
      }
      $lastTimeout = $_.Exception.GetBaseException().Message
    }

    if ([DateTime]::UtcNow -lt $Deadline) {
      Start-Sleep -Milliseconds 100
    }
  }

  throw "The exact native file-name editor did not return its text before the global deadline (attempts=$attempts,lastTimeout=$lastTimeout)."
}

function Set-StableNativeEditorValue {
  param(
    [object]$DialogIdentity,
    [object]$EditorIdentity,
    [object]$ButtonIdentity,
    [string]$Value,
    [DateTime]$Deadline
  )

  $maximumTextLength = [Math]::Min([Math]::Max($Value.Length + 16, 260), 32768)
  $attempts = 0
  $observedValue = ''
  $stable = $false
  while ([DateTime]::UtcNow -lt $Deadline -and -not $stable) {
    if (-not (Test-NativeDialogIdentity -DialogIdentity $DialogIdentity)) {
      throw 'The exact native save dialog closed while its file-name value was being stabilized.'
    }
    if (-not (Test-NativeChildIdentity `
        -DialogIdentity $DialogIdentity `
        -ChildIdentity $EditorIdentity `
        -Role 'file-name editor'
      )) {
      throw 'The exact native file-name editor closed while its value was being stabilized.'
    }
    if (-not (Test-NativeChildIdentity `
        -DialogIdentity $DialogIdentity `
        -ChildIdentity $ButtonIdentity `
        -Role 'confirmation button'
      )) {
      throw 'The exact native save-dialog confirmation button changed during value stabilization.'
    }

    $attempts += 1
    [HtmllelujahNativeDialog]::TypeControlText(
      $DialogIdentity.Handle,
      $EditorIdentity.Handle,
      $Value,
      $Deadline.Ticks,
      $DialogIdentity.ProcessId,
      $DialogIdentity.Title,
      $DialogIdentity.ClassName,
      $EditorIdentity.ProcessId,
      $EditorIdentity.ClassName,
      $EditorIdentity.ControlId
    )
    if (-not (Test-NativeDialogIdentity -DialogIdentity $DialogIdentity)) {
      throw 'The exact native save dialog changed immediately after bounded input.'
    }
    if (-not (Test-NativeChildIdentity `
        -DialogIdentity $DialogIdentity `
        -ChildIdentity $EditorIdentity `
        -Role 'file-name editor'
      )) {
      throw 'The exact native file-name editor changed immediately after bounded input.'
    }
    $firstValue = Read-ExactNativeEditorText `
      -DialogIdentity $DialogIdentity `
      -EditorIdentity $EditorIdentity `
      -MaximumCharacters $maximumTextLength `
      -Deadline $Deadline
    if (-not [string]::Equals(
        $firstValue,
        $Value,
        [System.StringComparison]::Ordinal
      )) {
      $observedValue = $firstValue
      if ([DateTime]::UtcNow -lt $Deadline) {
        Start-Sleep -Milliseconds 100
      }
      continue
    }

    Start-Sleep -Milliseconds 150
    $secondValue = Read-ExactNativeEditorText `
      -DialogIdentity $DialogIdentity `
      -EditorIdentity $EditorIdentity `
      -MaximumCharacters $maximumTextLength `
      -Deadline $Deadline
    $observedValue = $secondValue
    $stable = [string]::Equals(
      $secondValue,
      $Value,
      [System.StringComparison]::Ordinal
    )
  }
  if (-not $stable) {
    throw "The exact native file-name editor did not retain a stable requested value before the global deadline (hwnd=$($EditorIdentity.HandleValue),actualLength=$($observedValue.Length),expectedLength=$($Value.Length),attempts=$attempts)."
  }
  return [pscustomobject]@{
    Value = $observedValue
    Length = $observedValue.Length
    MaximumTextLength = $maximumTextLength
    Attempts = $attempts
  }
}

function Test-WindowsDeviceNamespacePath {
  param([string]$PathValue)

  if ([string]::IsNullOrEmpty($PathValue)) { return $false }
  return (
    $PathValue.StartsWith('\\?\', [System.StringComparison]::OrdinalIgnoreCase) -or
    $PathValue.StartsWith('\\.\', [System.StringComparison]::OrdinalIgnoreCase) -or
    $PathValue.StartsWith('\\?/', [System.StringComparison]::OrdinalIgnoreCase) -or
    $PathValue.StartsWith('\\./', [System.StringComparison]::OrdinalIgnoreCase)
  )
}

function Assert-SafeWindowsPathComponent {
  param(
    [string]$Component,
    [string]$Role
  )

  if (
    [string]::IsNullOrWhiteSpace($Component) -or
    [string]::Equals($Component, '.', [System.StringComparison]::Ordinal) -or
    [string]::Equals($Component, '..', [System.StringComparison]::Ordinal)
  ) {
    throw "The requested destination contains an empty or relative $Role."
  }
  foreach ($character in $Component.ToCharArray()) {
    if ([char]::IsControl($character)) {
      throw "The requested destination contains a control character in its $Role."
    }
  }
  if ($Component.IndexOfAny([System.IO.Path]::GetInvalidFileNameChars()) -ge 0) {
    throw "The requested destination contains an invalid Windows character in its $Role."
  }
  if ($Component.EndsWith(' ', [System.StringComparison]::Ordinal) -or
      $Component.EndsWith('.', [System.StringComparison]::Ordinal)) {
    throw "The requested destination contains a $Role ending in a space or period."
  }

  $deviceStem = (($Component -split '\.', 2)[0]).TrimEnd([char[]]@(' ', '.'))
  if ([System.Text.RegularExpressions.Regex]::IsMatch(
      $deviceStem,
      '^(?i:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM(?:[1-9]|\u00B9|\u00B2|\u00B3)|LPT(?:[1-9]|\u00B9|\u00B2|\u00B3))$'
    )) {
    throw "The requested destination contains a reserved Windows device name in its $Role."
  }
}

foreach ($character in $TargetPath.ToCharArray()) {
  if ([char]::IsControl($character)) {
    throw 'The requested destination contains a control character.'
  }
}
if (Test-WindowsDeviceNamespacePath -PathValue $TargetPath) {
  throw 'Windows device-namespace destinations are not supported.'
}
$driveAbsolute = [System.Text.RegularExpressions.Regex]::IsMatch(
  $TargetPath,
  '^[A-Za-z]:[\\/]'
)
$uncAbsolute = [System.Text.RegularExpressions.Regex]::IsMatch(
  $TargetPath,
  '^\\\\[^\\/]+[\\/][^\\/]+'
)
if (-not $driveAbsolute -and -not $uncAbsolute) {
  throw 'The requested destination must be a fully qualified local or UNC path.'
}
if (
  ($driveAbsolute -and $TargetPath.Substring(2).Contains(':')) -or
  ($uncAbsolute -and $TargetPath.Contains(':'))
) {
  throw 'Windows alternate data stream destinations are not supported.'
}
$TargetPath = [System.IO.Path]::GetFullPath($TargetPath)
if (Test-WindowsDeviceNamespacePath -PathValue $TargetPath) {
  throw 'Windows device-namespace destinations are not supported.'
}
if ($TargetPath.Length -gt 32767) {
  throw 'The requested destination exceeds the supported Windows path bound.'
}

$pathRoot = [System.IO.Path]::GetPathRoot($TargetPath)
if ([string]::IsNullOrWhiteSpace($pathRoot)) {
  throw 'The requested destination has no valid Windows path root.'
}
if ($driveAbsolute) {
  if ($TargetPath.Substring(2).Contains(':')) {
    throw 'Windows alternate data stream destinations are not supported.'
  }
}
else {
  if ($TargetPath.Contains(':')) {
    throw 'Windows alternate data stream destinations are not supported.'
  }
  $uncRootComponents = @(
    $pathRoot.TrimStart([char[]]@('\', '/')).TrimEnd([char[]]@('\', '/')) -split '[\\/]'
  )
  if ($uncRootComponents.Count -lt 2) {
    throw 'The requested UNC destination must include a server and share.'
  }
  $uncServer = $uncRootComponents[0]
  if (
    [string]::Equals($uncServer, '?', [System.StringComparison]::Ordinal) -or
    [string]::Equals($uncServer, '.', [System.StringComparison]::Ordinal)
  ) {
    throw 'UNC server names cannot use Windows device-namespace markers.'
  }
  Assert-SafeWindowsPathComponent -Component $uncServer -Role 'UNC server name'
  Assert-SafeWindowsPathComponent -Component $uncRootComponents[1] -Role 'UNC share name'
}

$relativePath = $TargetPath.Substring($pathRoot.Length)
$pathComponents = @($relativePath -split '[\\/]' | Where-Object { $_.Length -gt 0 })
if ($pathComponents.Count -eq 0) {
  throw 'The requested destination must identify a file below its Windows path root.'
}
foreach ($component in $pathComponents) {
  Assert-SafeWindowsPathComponent -Component $component -Role 'path component'
}

$parentDirectory = [System.IO.Path]::GetDirectoryName($TargetPath)
if (
  [string]::IsNullOrWhiteSpace($parentDirectory) -or
  -not [System.IO.Directory]::Exists($parentDirectory)
) {
  throw 'The requested destination directory does not exist.'
}
$targetExistedAtStart = [System.IO.File]::Exists($TargetPath)
if ([System.IO.Directory]::Exists($TargetPath)) {
  throw 'The requested destination identifies an existing directory.'
}
if ($DialogKind -eq 'Save' -and $targetExistedAtStart) {
  throw 'The release smoke refuses to overwrite an existing save destination.'
}
if ($DialogKind -eq 'Open' -and -not $targetExistedAtStart) {
  throw 'The requested open target does not exist.'
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
  immediateParentHandle = ([HtmllelujahNativeDialog]::WindowParent(
      $buttonIdentity.Handle
    )).ToInt64()
}

Write-Output 'phase=value'
$defaultReadyAttempts = 0
$defaultButtonReady = $false
while ([DateTime]::UtcNow -lt $deadline -and -not $defaultButtonReady) {
  if (-not (Test-NativeDialogIdentity -DialogIdentity $dialogIdentity)) {
    throw 'The exact native save dialog closed before its default button was validated.'
  }
  if (-not (Test-NativeChildIdentity `
      -DialogIdentity $dialogIdentity `
      -ChildIdentity $buttonIdentity `
      -Role 'confirmation button'
    )) {
    throw 'The exact native save-dialog confirmation button closed before validation.'
  }
  $defaultReadyAttempts += 1
  $defaultButtonReady = [HtmllelujahNativeDialog]::IsExactDefaultButtonReady(
    $dialogIdentity.Handle,
    $buttonIdentity.Handle,
    $deadline.Ticks
  )
  if (-not $defaultButtonReady -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 100
  }
}
if (-not $defaultButtonReady) {
  throw "The exact native save dialog did not expose control 1 as its default button before the global deadline (attempts=$defaultReadyAttempts)."
}

$expectedEditorValue = $TargetPath
if ([string]::IsNullOrWhiteSpace($expectedEditorValue) -or $expectedEditorValue.Length -gt 32767) {
  throw 'The requested native file-name value is empty or exceeds the supported bound.'
}
$valueState = Set-StableNativeEditorValue `
  -DialogIdentity $dialogIdentity `
  -EditorIdentity $editorIdentity `
  -ButtonIdentity $buttonIdentity `
  -Value $expectedEditorValue `
  -Deadline $deadline
$maximumTextLength = $valueState.MaximumTextLength
$editorValueLength = $valueState.Length

Write-Output 'phase=click'
if (-not (Test-NativeDialogIdentity -DialogIdentity $dialogIdentity)) {
  throw 'The exact native save dialog closed before accessibility confirmation.'
}
if (-not (Test-NativeChildIdentity `
    -DialogIdentity $dialogIdentity `
    -ChildIdentity $buttonIdentity `
    -Role 'confirmation button'
  )) {
  throw 'The exact native save-dialog confirmation button changed before accessibility confirmation.'
}
$currentEditorValue = Read-ExactNativeEditorText `
  -DialogIdentity $dialogIdentity `
  -EditorIdentity $editorIdentity `
  -MaximumCharacters $maximumTextLength `
  -Deadline $deadline
if (-not [string]::Equals(
    $currentEditorValue,
    $expectedEditorValue,
    [System.StringComparison]::Ordinal
  )) {
  throw "The exact native file-name editor changed after stabilization (hwnd=$($editorIdentity.HandleValue),actualLength=$($currentEditorValue.Length),expectedLength=$($expectedEditorValue.Length))."
}
if (-not [HtmllelujahNativeDialog]::IsExactDefaultButtonReady(
    $dialogIdentity.Handle,
    $buttonIdentity.Handle,
    $deadline.Ticks
  )) {
  throw 'The exact native save dialog stopped reporting control 1 as ready before confirmation.'
}
if ($DialogKind -eq 'Save' -and [System.IO.File]::Exists($TargetPath)) {
  throw 'The exact save destination appeared concurrently before confirmation; overwrite was refused.'
}
$secondaryDialogsBeforeAction = @(Find-SecondaryNativeDialogs `
  -AllowedProcessIds $allowedProcessIds `
  -ExcludedHandle $dialogIdentity.HandleValue)
if ($secondaryDialogsBeforeAction.Count -gt 0) {
  throw 'An unexpected secondary native dialog was already open before confirmation.'
}
$dialogFolderBeforeAction = [HtmllelujahNativeDialog]::ReadDialogFolderPath(
  $dialogIdentity.Handle,
  32768,
  $deadline.Ticks
)

$confirmationMetadata = [ordered]@{
  nativeWindowHandle = $buttonIdentity.HandleValue
  processId = $buttonIdentity.ProcessId
  controlId = $buttonIdentity.ControlId
  message = 'BM_CLICK'
}
$confirmationAction = 'BM_CLICK via SendMessageTimeout'
$commandAttempted = $false
$clickAccepted = $false
$confirmationError = 'none'
$commandAttempted = $true
try {
  [HtmllelujahNativeDialog]::ClickExactDefaultButton(
    $dialogIdentity.Handle,
    $buttonIdentity.Handle,
    $deadline.Ticks
  )
  $clickAccepted = $true
}
catch {
  # A bounded native message may report a timeout after dispatch. The one-shot HWND
  # close check below remains authoritative and never retries the confirmation.
  $confirmationError = $_.Exception.GetBaseException().Message
}

Write-Output 'phase=wait-close'
$dialogCloseDeadline = $deadline
while ([DateTime]::UtcNow -lt $dialogCloseDeadline) {
  if (-not [HtmllelujahNativeDialog]::IsWindow($dialogIdentity.Handle)) {
    break
  }
  Start-Sleep -Milliseconds 100
}
if (-not [HtmllelujahNativeDialog]::IsWindow($dialogIdentity.Handle)) {
  $secondaryDialogsAfterAction = @(Find-SecondaryNativeDialogs `
    -AllowedProcessIds $allowedProcessIds `
    -ExcludedHandle $dialogIdentity.HandleValue)
  if ($secondaryDialogsAfterAction.Count -gt 0) {
    throw 'The native file dialog closed but an unexpected secondary dialog remained.'
  }
  if ($DialogKind -eq 'Save') {
    $savePostconditionDeadline = $deadline
    $savedFileReady = $false
    while (-not $savedFileReady) {
      if ([System.IO.File]::Exists($TargetPath)) {
        $savedFileReady = [System.IO.FileInfo]::new($TargetPath).Length -gt 0
      }
      if ($savedFileReady) { break }
      $remainingPostconditionMilliseconds = [Math]::Floor(
        ($savePostconditionDeadline - [DateTime]::UtcNow).TotalMilliseconds
      )
      if ($remainingPostconditionMilliseconds -le 0) { break }
      Start-Sleep -Milliseconds ([int][Math]::Min(100, $remainingPostconditionMilliseconds))
    }
    if (-not $savedFileReady) {
      throw 'The native save dialog closed without creating the exact non-empty destination.'
    }
  }
  Write-Output 'Windows file dialog completed.'
  exit 0
}

$remainingProcessWindows = Describe-ProcessWindows -AllowedProcessIds $allowedProcessIds
$remainingDialogChildren = Describe-DialogChildren -DialogIdentity $dialogIdentity
$dialogFolderAfterAction = if ([DateTime]::UtcNow -lt $deadline) {
  [HtmllelujahNativeDialog]::ReadDialogFolderPath(
    $dialogIdentity.Handle,
    32768,
    $deadline.Ticks
  )
}
else {
  '<global deadline reached>'
}
$secondaryDialogs = [System.Collections.Generic.List[object]]::new()
foreach ($window in $remainingProcessWindows) {
  if (
    $window.visible -and
    [string]::Equals($window.className, '#32770', [System.StringComparison]::Ordinal) -and
    [int64]$window.nativeWindowHandle -ne $dialogIdentity.HandleValue
  ) {
    $secondaryIdentity = [pscustomobject]@{
      Handle = [IntPtr]::new([int64]$window.nativeWindowHandle)
      HandleValue = [int64]$window.nativeWindowHandle
      ProcessId = [int]$window.processId
    }
    $secondaryDialogs.Add([ordered]@{
        processId = [int]$window.processId
        nativeWindowHandle = [int64]$window.nativeWindowHandle
        title = [string]$window.title
        visibleText = @(Describe-DialogVisibleText -DialogIdentity $secondaryIdentity)
      })
  }
}
$targetExistsNow = [System.IO.File]::Exists($TargetPath)
$targetSizeNow = if ($targetExistsNow) {
  [System.IO.FileInfo]::new($TargetPath).Length
}
else {
  $null
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
    confirmationCommandAttempted = $commandAttempted
    confirmationCommandDispatched = $clickAccepted
    confirmation = $confirmationMetadata
    confirmationAction = $confirmationAction
    confirmationError = $confirmationError
    dialogChildren = @($remainingDialogChildren)
    processWindows = @($remainingProcessWindows)
    secondaryDialogs = @($secondaryDialogs)
    targetState = [ordered]@{
      existedAtStart = $targetExistedAtStart
      existsNow = $targetExistsNow
      sizeNow = $targetSizeNow
    }
    dialogFolderBeforeAction = $dialogFolderBeforeAction
    dialogFolderAfterAction = $dialogFolderAfterAction
  }) -Compress -Depth 4
throw "The exact Windows save-dialog HWND remained open after confirmation. Diagnostics: $detail"
