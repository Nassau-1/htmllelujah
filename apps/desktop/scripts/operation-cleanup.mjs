export const runWithCleanup = async ({ operation, cleanup, label = 'Operation' }) => {
  let value;
  let cleanupReceipt;
  let operationError;
  let cleanupError;

  try {
    value = await operation();
  } catch (error) {
    operationError = error;
  }

  try {
    cleanupReceipt = await cleanup();
  } catch (error) {
    cleanupError = error;
  }

  if (operationError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [operationError, cleanupError],
      `${label} and its cleanup both failed.`,
    );
  }
  if (operationError !== undefined) throw operationError;
  if (cleanupError !== undefined) throw cleanupError;
  return { value, cleanupReceipt };
};
