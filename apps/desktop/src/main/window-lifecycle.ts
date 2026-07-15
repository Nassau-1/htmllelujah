export interface DestroyableWindow {
  isDestroyed(): boolean;
  destroy(): void;
}

/** Prevents a failed open/load from leaving an invisible native window behind. */
export const initializeWindowSafely = async <T>(
  window: DestroyableWindow,
  initialize: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> => {
  try {
    return await initialize();
  } catch (error) {
    await cleanup().catch(() => undefined);
    if (!window.isDestroyed()) window.destroy();
    throw error;
  }
};

/**
 * Runs a user-visible window operation without letting a rejected promise escape. The native
 * window is deliberately retained so its session and recovery journal remain actionable.
 */
export const retainWindowOnFailure = async (
  window: DestroyableWindow,
  operation: () => Promise<void>,
  report: () => Promise<void>,
): Promise<boolean> => {
  try {
    await operation();
    return true;
  } catch {
    if (!window.isDestroyed()) await report().catch(() => undefined);
    return false;
  }
};
