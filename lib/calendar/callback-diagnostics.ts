// Convert runtime exceptions to a fixed vocabulary. Never log raw errors: DNS,
// socket and certificate messages may contain callback destinations or tokens.
export function callbackFailureCategory(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown';
  if (['TimeoutError', 'AbortError'].includes(error.name)) return 'timeout';
  const message = error.message;
  if (message === 'unsafe_destination') return 'unsafe_destination';
  if (/certificate|x509:/i.test(message)) return 'certificate';
  if (/proxy request failed|cannot connect|connection.*(?:failed|closed|refused)|TCP Loop/i.test(message)) return 'connection';
  if (/byte transport failed|EOF|reset by peer/i.test(message)) return 'stream';
  if (/tls:/i.test(message)) return 'tls';
  if (/too large|byte budget|oversized/i.test(message)) return 'byte_limit';
  if (/unsupported response encoding/i.test(message)) return 'response_encoding';
  if (/malformed HTTP|invalid HTTP/i.test(message)) return 'http_parse';
  return 'unknown';
}
