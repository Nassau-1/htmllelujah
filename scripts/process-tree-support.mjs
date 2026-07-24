import { spawnSync } from 'node:child_process';

const PROTECTED_WINDOWS_PROCESS_NAMES = new Set(
  [
    'csrss',
    'dwm',
    'explorer',
    'fontdrvhost',
    'idle',
    'lsaiso',
    'lsass',
    'memory compression',
    'registry',
    'services',
    'sihost',
    'smss',
    'system',
    'taskhostw',
    'wininit',
    'winlogon',
  ].flatMap((name) => [name, `${name}.exe`]),
);

const normalizedProcessName = (name) =>
  String(name ?? '')
    .trim()
    .toLowerCase();

const validCreationTime = (value) => typeof value === 'string' && /^[1-9]\d*$/u.test(value);

const normalizedIdentity = (identity, expectedPid, label) => {
  if (
    identity === null ||
    typeof identity !== 'object' ||
    identity.processId !== expectedPid ||
    !validCreationTime(identity.creationTime) ||
    !Number.isSafeInteger(identity.sessionId) ||
    identity.sessionId < 0 ||
    normalizedProcessName(identity.name).length === 0
  ) {
    throw new Error(`${label} is incomplete or invalid.`);
  }
  return {
    processId: expectedPid,
    creationTime: identity.creationTime,
    sessionId: identity.sessionId,
    name: normalizedProcessName(identity.name),
  };
};

const sameIdentity = (left, right) =>
  left.processId === right.processId &&
  left.creationTime === right.creationTime &&
  left.sessionId === right.sessionId &&
  normalizedProcessName(left.name) === normalizedProcessName(right.name);

export const isProtectedWindowsProcessIdentity = (identity) =>
  identity.processId <= 4 ||
  PROTECTED_WINDOWS_PROCESS_NAMES.has(normalizedProcessName(identity.name));

const normalizedSnapshotRecord = (record) => {
  if (
    record === null ||
    typeof record !== 'object' ||
    !Number.isSafeInteger(record.processId) ||
    record.processId < 1 ||
    !Number.isSafeInteger(record.parentProcessId) ||
    record.parentProcessId < 0 ||
    !Number.isSafeInteger(record.sessionId) ||
    record.sessionId < 0 ||
    normalizedProcessName(record.name).length === 0
  ) {
    throw new Error('Windows process discovery returned an invalid process record.');
  }
  return {
    processId: record.processId,
    parentProcessId: record.parentProcessId,
    creationTime: validCreationTime(record.creationTime) ? record.creationTime : null,
    sessionId: record.sessionId,
    name: normalizedProcessName(record.name),
  };
};

/**
 * Reduces a point-in-time Windows process inventory to descendants whose full parent chain is
 * compatible with the captured root identity. Creation times are part of the authority because
 * Win32_Process.ParentProcessId can continue to reference a PID after that PID has been reused.
 */
export const validateWindowsProcessSnapshot = ({ rootPid, snapshot, authority }) => {
  if (!Number.isSafeInteger(rootPid) || rootPid < 1 || !Array.isArray(snapshot)) {
    throw new Error('Windows process discovery input is invalid.');
  }

  const records = snapshot
    .filter((record) => record?.processId !== 0)
    .map(normalizedSnapshotRecord);
  const recordsByPid = new Map();
  for (const record of records) {
    if (recordsByPid.has(record.processId)) {
      throw new Error(`Windows process discovery returned duplicate PID ${record.processId}.`);
    }
    recordsByPid.set(record.processId, record);
  }

  const rootRecord = recordsByPid.get(rootPid);
  let rootAuthority;
  let rootPresent = false;
  if (authority === undefined) {
    if (rootRecord === undefined || rootRecord.creationTime === null) {
      throw new Error('Windows process-tree root identity is unavailable.');
    }
    rootAuthority = normalizedIdentity(rootRecord, rootPid, 'Windows process-tree root identity');
    rootPresent = true;
  } else {
    rootAuthority = normalizedIdentity(authority, rootPid, 'Windows process-tree root authority');
    if (rootRecord !== undefined) {
      if (rootRecord.creationTime === null) {
        throw new Error('Windows process-tree root identity cannot be revalidated.');
      }
      const currentRootIdentity = normalizedIdentity(
        rootRecord,
        rootPid,
        'Windows process-tree root identity',
      );
      if (!sameIdentity(rootAuthority, currentRootIdentity)) {
        throw new Error('Windows process-tree root PID was reused by a different process.');
      }
      rootPresent = true;
    }
  }

  if (isProtectedWindowsProcessIdentity(rootAuthority)) {
    throw new Error('Refusing to use a protected Windows process as a process-tree root.');
  }

  const accepted = new Map([
    [
      rootPid,
      {
        ...rootAuthority,
        parentProcessId: rootRecord?.parentProcessId ?? 0,
      },
    ],
  ]);
  // Once the captured root is absent, its numeric PID is no longer an authority.
  // Only identities captured while that exact root was present may be handled by
  // terminateProcessTree; never adopt a new PPID match after root exit.
  const pending = new Map(
    rootPresent
      ? records
          .filter((record) => record.processId !== rootPid)
          .map((record) => [record.processId, record])
      : [],
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const [processId, record] of pending) {
      const parent = accepted.get(record.parentProcessId);
      if (parent === undefined) continue;

      // A valid child cannot predate its parent. This is the central PID-reuse guard.
      if (
        record.creationTime === null ||
        BigInt(record.creationTime) < BigInt(parent.creationTime) ||
        record.sessionId !== rootAuthority.sessionId ||
        isProtectedWindowsProcessIdentity(record)
      ) {
        pending.delete(processId);
        changed = true;
        continue;
      }
      accepted.set(processId, record);
      pending.delete(processId);
      changed = true;
    }
  }

  return {
    authority: rootAuthority,
    rootPresent,
    observedProcesses: records,
    processes: [...accepted.values()],
    processIds: [...accepted.keys()],
  };
};

export const processIsAlive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
};

const windowsProcessInventoryScript = [
  '$ErrorActionPreference = "Stop"',
  '$processes = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate,SessionId,Name -ErrorAction Stop | ForEach-Object {',
  '  $creationTime = $null',
  '  if ($null -ne $_.CreationDate) {',
  '    $creationTime = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds().ToString()',
  '  }',
  '  [PSCustomObject]@{',
  '    processId = [int]$_.ProcessId',
  '    parentProcessId = [int]$_.ParentProcessId',
  '    creationTime = $creationTime',
  '    sessionId = [int]$_.SessionId',
  '    name = [string]$_.Name',
  '  }',
  '})',
  'ConvertTo-Json -Compress -InputObject $processes',
].join('\n');

export const discoverWindowsProcessTree = (rootPid, timeoutMs = 15_000, authority) => {
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsProcessInventoryScript],
    {
      encoding: 'utf8',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: Math.max(1, Math.min(timeoutMs, 15_000)),
      windowsHide: true,
    },
  );
  if (result.error !== undefined || result.status !== 0 || result.signal !== null) {
    throw new Error(
      `process-tree discovery failed with ${String(
        result.error?.code ?? result.signal ?? result.status ?? 'unknown status',
      )}`,
    );
  }

  let snapshot;
  try {
    snapshot = JSON.parse(String(result.stdout ?? '').trim());
  } catch (error) {
    throw new Error('process-tree discovery did not return valid JSON', { cause: error });
  }
  return validateWindowsProcessSnapshot({ rootPid, snapshot, authority });
};

/**
 * Kills one already validated process, never an OS-expanded `/T` tree. When an identity is
 * provided, the Process object retains a handle to the exact instance after StartTime validation.
 */
export const killWindowsProcessTree = (rootPid, timeoutMs = 15_000, expectedIdentity) => {
  if (!Number.isSafeInteger(rootPid) || rootPid < 1) {
    throw new Error('Cannot terminate an invalid Windows process PID.');
  }
  if (expectedIdentity === undefined) {
    return spawnSync('taskkill', ['/PID', String(rootPid), '/F'], {
      encoding: 'utf8',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: Math.max(1, Math.min(timeoutMs, 15_000)),
      windowsHide: true,
    });
  }
  const identity = normalizedIdentity(expectedIdentity, rootPid, 'Windows process kill authority');
  if (isProtectedWindowsProcessIdentity(identity)) {
    throw new Error('Refusing to terminate a protected Windows process.');
  }
  const expectedProcessName = normalizedProcessName(identity.name).replace(/\.exe$/u, '');
  const expectedProcessNameBase64 = Buffer.from(expectedProcessName, 'utf8').toString('base64');
  const script = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -TypeDefinition @"',
    'using System.Runtime.InteropServices;',
    'using Microsoft.Win32.SafeHandles;',
    'public static class HtmllelujahNativeProcess {',
    '  [DllImport("kernel32.dll", SetLastError = true)]',
    '  [return: MarshalAs(UnmanagedType.Bool)]',
    '  public static extern bool TerminateProcess(SafeProcessHandle processHandle, uint exitCode);',
    '}',
    '"@',
    `$target = [System.Diagnostics.Process]::GetProcessById(${rootPid})`,
    'try {',
    '  $handle = $target.SafeHandle',
    '  if ($handle.IsInvalid -or $handle.IsClosed) { throw "PID handle is unavailable" }',
    '  $actualCreationTime = ([DateTimeOffset]$target.StartTime).ToUnixTimeMilliseconds().ToString()',
    `  if ($actualCreationTime -ne '${identity.creationTime}') { throw "PID identity changed" }`,
    `  if ($target.SessionId -ne ${identity.sessionId}) { throw "PID session changed" }`,
    `  $expectedName = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${expectedProcessNameBase64}'))`,
    '  if ($target.ProcessName.ToLowerInvariant() -ne $expectedName) { throw "PID name changed" }',
    '  if (-not [HtmllelujahNativeProcess]::TerminateProcess($handle, 1)) {',
    '    throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())',
    '  }',
    '} finally {',
    '  $target.Dispose()',
    '}',
  ].join('\n');
  return spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: Math.max(1, Math.min(timeoutMs, 15_000)),
      windowsHide: true,
    },
  );
};

export const terminateProcessTree = async ({
  pid,
  platform = process.platform,
  discoverTree = discoverWindowsProcessTree,
  killWindowsTree = killWindowsProcessTree,
  isAlive = processIsAlive,
  drainTimeoutMs = 5_000,
  pollIntervalMs = 50,
  rootKnownExited = false,
  rootAuthority,
  capturedDescendantAuthorities,
}) => {
  if (!Number.isSafeInteger(pid) || pid < 1) {
    throw new Error('Cannot terminate an invalid process-tree root PID.');
  }
  if (typeof rootKnownExited !== 'boolean') {
    throw new Error('Process-tree root exit knowledge must be boolean.');
  }

  if (platform !== 'win32') {
    if (rootKnownExited) {
      throw new Error(
        'Cannot safely discover descendants of a known-exited process-tree root on this platform.',
      );
    }
    const processIds = [pid];
    let killResult;
    try {
      process.kill(pid, 'SIGKILL');
      killResult = { status: 0, signal: null, error: undefined };
    } catch (error) {
      killResult = { status: null, signal: null, error };
    }
    const deadline = Date.now() + drainTimeoutMs;
    let remaining = processIds.filter(isAlive);
    while (remaining.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      remaining = processIds.filter(isAlive);
    }
    if (remaining.length > 0) {
      throw new Error(
        `Process-tree termination failed: discovery ok; killer status ${String(
          killResult?.error?.code ?? killResult?.signal ?? killResult?.status ?? 'unknown',
        )}; live PIDs: ${remaining.join(', ')}.`,
      );
    }
    return {
      processIds,
      killerStatus: killResult?.error?.code ?? killResult?.signal ?? killResult?.status ?? null,
    };
  }

  const deadline = Date.now() + Math.max(1, drainTimeoutMs);
  const commandTimeout = () => Math.max(1, Math.min(15_000, deadline - Date.now()));
  const validatedDiscovery = (authority) => {
    const result = discoverTree(pid, commandTimeout(), authority);
    if (
      result === null ||
      typeof result !== 'object' ||
      !Array.isArray(result.processes) ||
      result.authority === undefined
    ) {
      throw new Error('discovery returned an unvalidated process snapshot');
    }
    const validation = validateWindowsProcessSnapshot({
      rootPid: pid,
      snapshot: Array.isArray(result.observedProcesses)
        ? result.observedProcesses
        : result.processes,
      authority,
    });
    if (result.rootPresent === false) validation.rootPresent = false;
    return validation;
  };
  const killerStatus = (result) =>
    result?.error?.code ?? result?.signal ?? result?.status ?? 'unknown';
  const killDescendant = (identity, receipts) => {
    let result;
    try {
      result = killWindowsTree(identity.processId, commandTimeout(), identity);
    } catch (error) {
      result = { status: null, signal: null, error };
    }
    receipts.push({ processId: identity.processId, status: killerStatus(result) });
  };

  if (rootKnownExited && rootAuthority === undefined) {
    throw new Error(
      'Cannot safely discover descendants of a known-exited Windows root without captured root authority.',
    );
  }
  if (rootKnownExited && !Array.isArray(capturedDescendantAuthorities)) {
    throw new Error(
      'Cannot verify descendants of a known-exited Windows root without a captured descendant-authority list.',
    );
  }

  let authority = rootAuthority;
  let rootKillResult;
  const capturedDescendants = new Map();
  const targetedDescendants = new Set();
  const descendantKillerStatuses = [];
  if (!rootKnownExited) {
    const initialDiscovery = validatedDiscovery(authority);
    authority = initialDiscovery.authority;
    for (const identity of initialDiscovery.processes) {
      if (identity.processId !== pid) capturedDescendants.set(identity.processId, identity);
    }
    try {
      rootKillResult = killWindowsTree(pid, commandTimeout(), authority);
    } catch (error) {
      rootKillResult = { status: null, signal: null, error };
    }
  } else {
    authority = normalizedIdentity(rootAuthority, pid, 'Windows process-tree root authority');
    for (const candidate of capturedDescendantAuthorities) {
      if (candidate === null || typeof candidate !== 'object') {
        throw new Error('Captured Windows descendant authority is invalid.');
      }
      const identity = normalizedIdentity(
        candidate,
        candidate.processId,
        'Captured Windows descendant authority',
      );
      if (
        identity.processId === pid ||
        identity.sessionId !== authority.sessionId ||
        BigInt(identity.creationTime) < BigInt(authority.creationTime) ||
        isProtectedWindowsProcessIdentity(identity) ||
        capturedDescendants.has(identity.processId)
      ) {
        throw new Error('Captured Windows descendant authority is invalid.');
      }
      capturedDescendants.set(identity.processId, identity);
    }
  }

  let rootExitObserved = rootKnownExited;
  let stablePasses = 0;
  let discoveryPasses = 0;
  const transientPostDiscoveryErrors = [];
  while (stablePasses < 2 && (discoveryPasses < 2 || Date.now() < deadline)) {
    let discovery;
    try {
      discovery = validatedDiscovery(authority);
    } catch (error) {
      transientPostDiscoveryErrors.push(error);
      stablePasses = 0;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      continue;
    }
    discoveryPasses += 1;
    if (!discovery.rootPresent) rootExitObserved = true;

    const currentDescendants = new Map();
    const observedByPid = new Map(
      discovery.observedProcesses.map((identity) => [identity.processId, identity]),
    );
    const newDescendants = [];
    for (const identity of discovery.processes) {
      if (identity.processId === pid) continue;
      currentDescendants.set(identity.processId, identity);
      const captured = capturedDescendants.get(identity.processId);
      if (captured !== undefined && !sameIdentity(captured, identity)) {
        throw new Error(`Captured descendant PID ${identity.processId} was reused.`);
      }
      if (captured === undefined) {
        capturedDescendants.set(identity.processId, identity);
        newDescendants.push(identity.processId);
      }
    }

    const descendantsToTarget = [...capturedDescendants.values()].filter((identity) => {
      const observed = observedByPid.get(identity.processId);
      return (
        !targetedDescendants.has(identity.processId) &&
        observed !== undefined &&
        sameIdentity(identity, observed) &&
        isAlive(identity.processId)
      );
    });
    for (const identity of descendantsToTarget) {
      targetedDescendants.add(identity.processId);
      killDescendant(identity, descendantKillerStatuses);
    }

    const survivingDescendants = [...capturedDescendants.values()]
      .filter((identity) => {
        const observed = observedByPid.get(identity.processId);
        return (
          observed !== undefined && sameIdentity(identity, observed) && isAlive(identity.processId)
        );
      })
      .map((identity) => identity.processId);
    if (
      newDescendants.length === 0 &&
      descendantsToTarget.length === 0 &&
      rootExitObserved &&
      survivingDescendants.length === 0
    ) {
      stablePasses += 1;
    } else {
      stablePasses = 0;
    }
    if (stablePasses < 2 && (discoveryPasses < 2 || Date.now() < deadline)) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  const lastDiscovery = await (async () => {
    try {
      return validatedDiscovery(authority);
    } catch (error) {
      transientPostDiscoveryErrors.push(error);
      return null;
    }
  })();
  const survivingDescendants =
    lastDiscovery === null
      ? [...capturedDescendants.keys()]
      : [...capturedDescendants.values()]
          .filter((identity) => {
            const observed = lastDiscovery.observedProcesses.find(
              (candidate) => candidate.processId === identity.processId,
            );
            return (
              observed !== undefined &&
              sameIdentity(identity, observed) &&
              isAlive(identity.processId)
            );
          })
          .map((identity) => identity.processId);
  const liveProcessIds = [...(!rootExitObserved ? [pid] : []), ...survivingDescendants];
  const rootStatus = rootKnownExited ? null : killerStatus(rootKillResult);
  const descendantStatusSummary =
    descendantKillerStatuses.length === 0
      ? 'none'
      : descendantKillerStatuses
          .map((receipt) => `${receipt.processId}:${String(receipt.status)}`)
          .join(', ');
  const postDiscoveryErrorSummary =
    transientPostDiscoveryErrors.length === 0
      ? 'none'
      : `${transientPostDiscoveryErrors.length} attempt(s): ${[
          ...new Set(transientPostDiscoveryErrors.map((error) => String(error?.message ?? error))),
        ].join(' | ')}`;
  const causalErrors = [
    ...(rootKillResult?.error === undefined ? [] : [rootKillResult.error]),
    ...transientPostDiscoveryErrors,
  ];
  if (stablePasses < 2 || liveProcessIds.length > 0) {
    const message =
      `Process-tree termination failed${
        rootKnownExited ? ' for known-exited root without targeting the root PID' : ''
      }: discovery ok; ` +
      `killer status ${String(rootStatus)}; descendant killers ${descendantStatusSummary}; ` +
      `post-kill discovery errors ${postDiscoveryErrorSummary}; ` +
      `stable passes ${stablePasses}; live PIDs: ${
        liveProcessIds.length === 0 ? 'none' : liveProcessIds.join(', ')
      }.`;
    if (causalErrors.length > 0) {
      throw new AggregateError(causalErrors, message);
    }
    throw new Error(message);
  }

  const processIds = [...capturedDescendants.keys()];
  if (rootKnownExited) {
    return {
      processIds,
      killerStatus: null,
      descendantKillerStatuses,
      ...(transientPostDiscoveryErrors.length === 0
        ? {}
        : { recoveredPostDiscoveryErrors: transientPostDiscoveryErrors.length }),
    };
  }
  return {
    processIds: [pid, ...processIds],
    killerStatus: rootStatus,
    ...(descendantKillerStatuses.length === 0 ? {} : { descendantKillerStatuses }),
    ...(transientPostDiscoveryErrors.length === 0
      ? {}
      : { recoveredPostDiscoveryErrors: transientPostDiscoveryErrors.length }),
  };
};
