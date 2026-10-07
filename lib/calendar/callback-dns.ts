// Workers' node:dns resolve4/resolve6 include CNAME data in their address arrays.
// Use the same resolver with typed records so aliases cannot be mistaken for IPs.
function addressAnswers(value: unknown, type: number): string[] {
  if (!value || typeof value !== 'object') throw new Error('invalid_dns_response');
  const result = value as { Status?: unknown; Answer?: unknown };
  if (result.Status === 3) return []; // NXDOMAIN is not an authorized destination.
  if (result.Status !== 0) throw new Error('dns_query_failed');
  if (result.Answer === undefined) return [];
  if (!Array.isArray(result.Answer) || result.Answer.length > 48) throw new Error('invalid_dns_response');
  const addresses: string[] = [];
  for (const record of result.Answer) {
    if (!record || typeof record !== 'object') throw new Error('invalid_dns_response');
    const answer = record as { type?: unknown; data?: unknown };
    if (typeof answer.data !== 'string' || answer.data.length > 253) throw new Error('invalid_dns_response');
    if (answer.type === type) addresses.push(answer.data);
    else if (answer.type !== 5) throw new Error('invalid_dns_response');
    // CNAMEs are metadata, never socket destinations. All actual addresses are
    // preserved for the caller's fail-closed public-address validation.
  }
  return addresses;
}

export async function resolveCallbackAddresses(host: string, signal: AbortSignal): Promise<string[]> {
  const resolve = async (type: 'A' | 'AAAA') => {
    const url = new URL('https://cloudflare-dns.com/dns-query');
    url.searchParams.set('name', host); url.searchParams.set('type', type);
    const response = await fetch(url, { headers: { Accept: 'application/dns-json' }, redirect: 'manual', signal });
    if (!response.ok || response.redirected) throw new Error('dns_query_failed');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('invalid_dns_response');
    let size = 0, text = ''; const decoder = new TextDecoder();
    try {
      while (true) {
        signal.throwIfAborted();
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength; if (size > 65536) throw new Error('dns_response_too_large');
        text += decoder.decode(next.value, { stream: true });
      }
      text += decoder.decode();
      let result: unknown; try { result = JSON.parse(text); } catch { throw new Error('invalid_dns_response'); }
      return addressAnswers(result, type === 'A' ? 1 : 28);
    } finally { void reader.cancel().catch(() => {}); }
  };
  return (await Promise.all([resolve('A'), resolve('AAAA')])).flat();
}
