# Ciphertext callback relay

This optional Node 24 process supplies a literal-public-IP TCP stream to the Site's existing Go TLS implementation. It addresses the hosted raw-socket destination restriction without moving calendar payloads or signing secrets out of the Site. Deployment is pending explicit infrastructure authorization and an approved host; it is not current production evidence.

The Site resolves every callback's A/AAAA records for each attempt, rejects the entire set if any address is non-public, and authenticates one literal address on a fixed `/tunnel` WebSocket endpoint. The relay independently rejects non-public and non-literal addresses and opens TCP to that exact address on port 443. It never performs callback DNS resolution. Go TLS remains in the Site, authenticates the original callback hostname and certificate, and encrypts the HTTP headers and exact signed body before they enter the tunnel. The same transport serves verification and delivery.

The relay sees IP/connection timing, TLS handshake metadata including the public hostname, and encrypted records. It holds one tunnel authentication key, no Google credential, calendar identifier, event text or callback signing key. Its application emits no request/content logs and has no database. Hosting access logs must omit request headers and bodies. Treat the configured relay operator as trusted for networking; authenticated HTTPS/WSS ingress is required. Do not run this process on Cloudflare Workers: its restricted TCP policy is the reason for this fallback.

## Package and run

From the repository root:

```sh
npm ci --prefix egress
docker build -f egress/Dockerfile -t calendar-ciphertext-egress .
```

The build context allowlist includes only this package and two shared policy/protocol sources. Supply a canonical base64 32-byte `CALLBACK_TUNNEL_KEY` through the chosen host's secret mechanism, never a command argument or checked-in file. The container listens on port 8080; publish it through that host's managed HTTPS/WebSocket ingress. `/health` returns 204 and reveals no configuration. The local non-container process defaults to loopback and requires Node 24.

Each authentication signature binds protocol version, exact address, port, timestamp and random nonce. Requests expire within ten seconds; reused nonces are rejected. At most 16 pending/active connections, 64 KiB per WebSocket frame, 384 KiB per direction and ten seconds per tunnel are allowed. Compression, browser-origin requests and non-binary messages are rejected. The relay uses backpressure in both directions. Nonces live in bounded memory; runtime restart clears them, so ingress must remain authenticated and this is a short-window replay defense rather than durable exactly-once transport. It grants no callback identity or authority, which remain guarded by the Site's subscription/outbox.

## Activate only after hosted verification

1. Approve the runtime/host and deploy the relay with the key. Verify managed HTTPS/WSS and header/body log redaction.
2. Set Site secrets/configuration `CALLBACK_TUNNEL_ORIGIN` (an HTTPS origin only), `CALLBACK_TUNNEL_KEY` (matching secret), and `MCP_CALLBACK_TRANSPORT=pinned-tunnel`. Use the normal Site publication flow; no migration or dispatcher change is needed.
3. Prove the final Site-to-relay-to-real-OpenAI signed challenge, then a disposable Google event and actual useful Work Cloud response. Record redacted pinning/hostname/runtime evidence, timing, cleanup and CI before closing #4, #6 and #1.
4. On rollback, restore the prior explicitly authorized transport configuration and redeploy the Site. Dispose of the relay only with the host owner's approval. Do not make native fetch an automatic fallback for a failed tunnel.

Local integration uses the actual Workers/Go WASM, a real WebSocket relay and a real TLS receiver. A test-only dial maps an authenticated public literal to a loopback fixture; no production flag permits private destinations. Tests cover literal-address pinning, fresh/altered authentication, private and mixed DNS answers, hostname rejection before application data, replay, oversized frames, terminal/redirect status, stalled body and abort. Local fixtures remap only the fixed outer relay origin to HTTP; they do not claim hosted outer HTTPS or real ChatGPT acceptance.

Source constraints: [OpenAI MCP Events callback contract](https://developers.openai.com/plugins/build/mcp-events#verify-the-callback), [Workers TCP restrictions](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/#considerations), [Workers WebSocket clients](https://developers.cloudflare.com/workers/examples/websockets/#write-a-websocket-client).
