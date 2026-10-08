export async function boundedProbe<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
 signal.throwIfAborted();
 let abort!: () => void;
 const stopped = new Promise<never>((_, reject) => {
  abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
 });
 try { return await Promise.race([work, stopped]); }
 finally { signal.removeEventListener('abort', abort); }
}
