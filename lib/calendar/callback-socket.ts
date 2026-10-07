import { validatedAddress } from './callback-policy.ts';
import { callbackFailureCategory } from './callback-diagnostics.ts';

export interface CallbackSocket {
  opened: Promise<unknown>;
  closed: Promise<unknown>;
  close(): Promise<void>;
}

export async function openCallbackSocket<T extends CallbackSocket>(addresses: string[], signal: AbortSignal, connect: (address: string) => T): Promise<T> {
  validatedAddress(addresses); // Reject the entire answer set before any connection.
  let lastError: unknown;
  let attempt = 0;
  for (const address of new Set(addresses)) {
    signal.throwIfAborted();
    let socket: T | undefined, abort: (() => void) | undefined;
    try {
      socket = connect(address);
      void socket.closed.catch(() => {});
      const stopped = new Promise<never>((_, reject) => {
        abort = () => { reject(signal.reason); };
        signal.addEventListener('abort', abort, { once: true });
      });
      signal.throwIfAborted();
      await Promise.race([socket.opened, stopped]);
      signal.throwIfAborted();
      return socket;
    } catch (error) {
      if (socket) void socket.close().catch(() => {});
      signal.throwIfAborted();
      lastError = error;
      console.info('calendar_callback_socket', { attempt: ++attempt, family: address.includes(':') ? 'ipv6' : 'ipv4', category: callbackFailureCategory(error) });
    } finally {
      if (abort) signal.removeEventListener('abort', abort);
    }
  }
  throw lastError;
}
