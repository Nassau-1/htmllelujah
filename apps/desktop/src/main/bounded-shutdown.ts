export interface NamedShutdownTask {
  readonly name: string;
  readonly run: () => void | Promise<void>;
}

export interface ShutdownInterception {
  preventDefault(): void;
}

/** Prevents every quit request while admitting final cleanup exactly once. */
export class BoundedShutdownAdmission {
  #started = false;

  public intercept(event: ShutdownInterception): boolean {
    event.preventDefault();
    if (this.#started) return false;
    this.#started = true;
    return true;
  }
}

export type ShutdownTaskResult =
  | Readonly<{ name: string; status: 'fulfilled' }>
  | Readonly<{ name: string; status: 'rejected'; reason: unknown }>
  | Readonly<{ name: string; status: 'timed-out' }>;

export interface ShutdownTaskReport {
  readonly ok: boolean;
  readonly tasks: readonly ShutdownTaskResult[];
}

type MutableShutdownTaskResult =
  | { name: string; status: 'pending' }
  | { name: string; status: 'fulfilled' }
  | { name: string; status: 'rejected'; reason: unknown }
  | { name: string; status: 'timed-out' };

const validatedTimeout = (timeoutMs: number): number => {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new RangeError('Shutdown timeout must be an integer between 1 and 60000 milliseconds.');
  }
  return timeoutMs;
};

const validatedTasks = (tasks: readonly NamedShutdownTask[]): readonly NamedShutdownTask[] => {
  const names = new Set<string>();
  for (const task of tasks) {
    if (task.name.trim() === '') throw new TypeError('Shutdown task names must not be empty.');
    if (names.has(task.name)) throw new TypeError(`Duplicate shutdown task name: ${task.name}.`);
    names.add(task.name);
  }
  return tasks;
};

/**
 * Settles best-effort process shutdown work without allowing an invisible Electron process to
 * remain alive forever. Every rejection is observed immediately; work that outlives the deadline
 * keeps its rejection handler but is reported as timed out.
 */
export const settleShutdownTasks = async (
  tasks: readonly NamedShutdownTask[],
  timeoutMs: number,
): Promise<ShutdownTaskReport> => {
  const boundedTimeoutMs = validatedTimeout(timeoutMs);
  const acceptedTasks = validatedTasks(tasks);
  const states: MutableShutdownTaskResult[] = acceptedTasks.map((task) => ({
    name: task.name,
    status: 'pending',
  }));
  const completions = acceptedTasks.map((task, index) =>
    Promise.resolve()
      .then(task.run)
      .then(
        () => {
          const state = states[index];
          if (state?.status === 'pending') states[index] = { name: task.name, status: 'fulfilled' };
        },
        (reason: unknown) => {
          const state = states[index];
          if (state?.status === 'pending') {
            states[index] = { name: task.name, status: 'rejected', reason };
          }
        },
      ),
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(completions),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, boundedTimeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  const settled = states.map((state): ShutdownTaskResult =>
    Object.freeze(
      state.status === 'pending' ? { name: state.name, status: 'timed-out' as const } : state,
    ),
  );
  return Object.freeze({
    ok: settled.every((result) => result.status === 'fulfilled'),
    tasks: Object.freeze(settled),
  });
};
