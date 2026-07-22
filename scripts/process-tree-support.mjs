import { spawnSync } from 'node:child_process';

export const processIsAlive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
};

export const discoverWindowsProcessTree = (rootPid, timeoutMs = 15_000) => {
  const script = [
    `$rootId = ${rootPid}`,
    '$processes = @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId, ParentProcessId)',
    '$accepted = [System.Collections.Generic.HashSet[int]]::new()',
    '[void]$accepted.Add($rootId)',
    'do {',
    '  $added = $false',
    '  foreach ($entry in $processes) {',
    '    if ($accepted.Contains([int]$entry.ParentProcessId) -and $accepted.Add([int]$entry.ProcessId)) { $added = $true }',
    '  }',
    '} while ($added)',
    "[string]::Join(',', @($accepted | Sort-Object))",
  ].join('; ');
  const result = spawnSync(
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
  if (result.error !== undefined || result.status !== 0 || result.signal !== null) {
    throw new Error(
      `process-tree discovery failed with ${String(
        result.error?.code ?? result.signal ?? result.status ?? 'unknown status',
      )}`,
    );
  }
  const processIds = String(result.stdout ?? '')
    .trim()
    .split(',')
    .filter(Boolean)
    .map(Number);
  if (
    processIds.length < 1 ||
    processIds.some((pid) => !Number.isSafeInteger(pid) || pid < 1) ||
    !processIds.includes(rootPid)
  ) {
    throw new Error('process-tree discovery returned an invalid or incomplete PID set');
  }
  return [...new Set(processIds)];
};

export const killWindowsProcessTree = (rootPid, timeoutMs = 15_000) =>
  spawnSync('taskkill', ['/PID', String(rootPid), '/T', '/F'], {
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: Math.max(1, Math.min(timeoutMs, 15_000)),
    windowsHide: true,
  });

export const terminateProcessTree = async ({
  pid,
  platform = process.platform,
  discoverTree = discoverWindowsProcessTree,
  killWindowsTree = killWindowsProcessTree,
  isAlive = processIsAlive,
  drainTimeoutMs = 5_000,
  pollIntervalMs = 50,
  rootKnownExited = false,
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
  const validatedDiscovery = () => {
    const discoveredProcessIds = discoverTree(pid, commandTimeout());
    if (
      !Array.isArray(discoveredProcessIds) ||
      discoveredProcessIds.some((processId) => !Number.isSafeInteger(processId) || processId < 1) ||
      !discoveredProcessIds.includes(pid)
    ) {
      throw new Error('discovery returned an invalid or incomplete PID set');
    }
    return [...new Set(discoveredProcessIds)];
  };
  const killerStatus = (result) =>
    result?.error?.code ?? result?.signal ?? result?.status ?? 'unknown';
  const killDescendant = (processId, receipts) => {
    let result;
    try {
      result = killWindowsTree(processId, commandTimeout());
    } catch (error) {
      result = { status: null, signal: null, error };
    }
    receipts.push({ processId, status: killerStatus(result) });
  };

  let initialDiscoveryError;
  let rootKillResult;
  const capturedDescendants = new Set();
  const targetedDescendants = new Set();
  const descendantKillerStatuses = [];
  if (!rootKnownExited) {
    try {
      for (const processId of validatedDiscovery()) {
        if (processId !== pid) capturedDescendants.add(processId);
      }
    } catch (error) {
      initialDiscoveryError = error;
    }
    try {
      rootKillResult = killWindowsTree(pid, commandTimeout());
    } catch (error) {
      rootKillResult = { status: null, signal: null, error };
    }
  }

  let rootExitObserved = rootKnownExited;
  let stablePasses = 0;
  let discoveryPasses = 0;
  const transientPostDiscoveryErrors = [];
  while (stablePasses < 2 && (discoveryPasses < 2 || Date.now() < deadline)) {
    let discoveredProcessIds;
    try {
      discoveredProcessIds = validatedDiscovery();
    } catch (error) {
      transientPostDiscoveryErrors.push(error);
      stablePasses = 0;
      if (!rootExitObserved && !isAlive(pid)) rootExitObserved = true;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      continue;
    }
    discoveryPasses += 1;

    const newDescendants = [];
    for (const processId of discoveredProcessIds) {
      if (processId === pid || capturedDescendants.has(processId)) continue;
      capturedDescendants.add(processId);
      newDescendants.push(processId);
    }
    const descendantsToTarget = [...capturedDescendants].filter(
      (processId) => !targetedDescendants.has(processId) && isAlive(processId),
    );
    for (const processId of descendantsToTarget) {
      targetedDescendants.add(processId);
      killDescendant(processId, descendantKillerStatuses);
    }

    if (!rootExitObserved && !isAlive(pid)) rootExitObserved = true;
    const survivingDescendants = [...capturedDescendants].filter(isAlive);
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

  const survivingDescendants = [...capturedDescendants].filter(isAlive);
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
    ...(initialDiscoveryError === undefined ? [] : [initialDiscoveryError]),
    ...(rootKillResult?.error === undefined ? [] : [rootKillResult.error]),
    ...transientPostDiscoveryErrors,
  ];
  if (stablePasses < 2 || liveProcessIds.length > 0) {
    const message =
      `Process-tree termination failed${
        rootKnownExited ? ' for known-exited root without targeting the root PID' : ''
      }: discovery ${String(initialDiscoveryError?.message ?? 'ok')}; ` +
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
  if (initialDiscoveryError !== undefined) {
    throw new AggregateError(
      causalErrors,
      `Process-tree termination failed: discovery ${String(
        initialDiscoveryError.message ?? initialDiscoveryError,
      )}; killer status ${String(rootStatus)}; live PIDs: none.`,
    );
  }

  const processIds = [...capturedDescendants];
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
