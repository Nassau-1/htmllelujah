import { StringDecoder } from 'node:string_decoder';

const asError = (reason, fallbackMessage) =>
  reason instanceof Error ? reason : new Error(fallbackMessage, { cause: reason });

export const createMcpResponseRouter = ({ maxBufferedBytes = 1_048_576 } = {}) => {
  let buffered = '';
  let decoderFinished = false;
  let failure;
  const decoder = new StringDecoder('utf8');
  const responses = new Map();
  const waiters = new Map();

  const fail = (reason) => {
    if (failure !== undefined) return failure;

    const source = asError(reason, 'The MCP response stream failed.');
    failure = new Error(source.message, { cause: source });
    failure.code = 'MCP_STDIO_FAILURE';
    for (const waiter of waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(failure);
    }
    waiters.clear();
    responses.clear();
    return failure;
  };

  const push = (chunk) => {
    if (failure !== undefined) return;

    try {
      buffered += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      if (Buffer.byteLength(buffered, 'utf8') > maxBufferedBytes) {
        throw new Error('MCP stdout exceeded the bounded line buffer.');
      }

      for (;;) {
        const newline = buffered.indexOf('\n');
        if (newline < 0) break;
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line === '') continue;

        const message = JSON.parse(line);
        if (message === null || typeof message !== 'object' || Array.isArray(message)) {
          throw new Error('MCP stdout contained a non-object JSON message.');
        }
        if (message.id === undefined) continue;

        const waiter = waiters.get(message.id);
        if (waiter === undefined) {
          if (responses.has(message.id)) {
            throw new Error(`MCP stdout duplicated response ${String(message.id)}.`);
          }
          responses.set(message.id, message);
        } else {
          waiters.delete(message.id);
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        }
      }
    } catch (error) {
      fail(
        new Error('MCP stdout contained invalid JSON-line protocol data.', {
          cause: asError(error, 'Unknown MCP parsing failure.'),
        }),
      );
    }
  };

  const waitForResponse = (id, timeoutMs = 10_000) => {
    if (failure !== undefined) return Promise.reject(failure);
    if (waiters.has(id)) {
      return Promise.reject(new Error(`MCP response ${String(id)} already has a waiter.`));
    }

    const ready = responses.get(id);
    if (ready !== undefined) {
      responses.delete(id);
      return Promise.resolve(ready);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`MCP response ${String(id)} timed out.`));
      }, timeoutMs);
      waiters.set(id, { resolve, reject, timer });
    });
  };

  const finish = () => {
    if (failure !== undefined) return failure;
    if (!decoderFinished) {
      decoderFinished = true;
      buffered += decoder.end();
    }
    if (buffered.trim() !== '') {
      return fail(new Error('MCP stdout ended with an incomplete JSON-line message.'));
    }
    return undefined;
  };

  return {
    fail,
    finish,
    push,
    waitForResponse,
    get failure() {
      return failure;
    },
  };
};
