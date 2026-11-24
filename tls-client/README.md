# Direct standard TLS client

This package compiles Go 1.27.1's standard `crypto/tls`, `crypto/x509`, and `net/http` to WebAssembly. JavaScript connects a raw TCP stream to a validated literal public IP; Go supplies SNI, certificate-chain/validity/hostname verification, TLS 1.2/1.3, and HTTP response parsing. Application bytes are withheld until the handshake succeeds.

`main.go` is the stream bridge. `wasm-exec.cjs` and `GO-LICENSE` are verbatim from the checksum-verified official Go distribution (Linux amd64 archive SHA-256 `63d339f0da5ab53635a56f2490a7984dfe12dfcff22ad749f63edaf590168445`).

The checked-in binary allows ordinary builds without installing Go. Rebuild with `bash scripts/build-tls.sh /path/to/go1.27.1/bin/go`, then run `npm test`. Keep the runtime shim and binary on the same toolchain release. This adds about 7.5 MiB uncompressed / 2.1 MiB gzip to deployment. Go TLS is established software; this WASM integration is not an independent security audit.

`roots.pem` is public CA material extracted from Node v24.14.0's bundled `node:tls.rootCertificates` (SHA-256 `1ce54871c3e0e16c534d4cf464847113d55412fe48c3d5d881c600dd6932debd`). Review trust-store and Go security updates together. Test roots are passed only to the isolated TLS test harness; production always uses this fixed bundle.

Bounds: one attempt has ten seconds including DNS, TLS, and read; request body at most 256 KiB plus at most 8 KiB HTTP overhead; encrypted response/handshake at most 128 KiB; one transport chunk at most 64 KiB; decoded verification response at most 4 KiB. Delivery requests status-only responses and closes after headers without reading any body, allowing prompt 2xx acknowledgement and terminal 410/413 classification. Compressed verification bodies fail closed. No session cache, 0-RTT, connection reuse, or callback-IP caching is enabled.

DNS uses bounded, typed JSON responses over DNS-over-HTTPS. CNAME records remain alias metadata; all A/AAAA addresses are validated on each attempt and a literal address is passed to `cloudflare:sockets` with native TLS disabled. Unsupported address families and non-public ranges fail closed. Before TLS or application bytes, failed socket connections fail over across the deduplicated validated address set within the same ten-second deadline. TLS or HTTP failures do not trigger address failover. Cloudflare Workers raw sockets may refuse some public destinations, including Cloudflare-proxied IPs; re-validate callback transport against the target runtime and evolving MCP Events specification rather than weakening validation.
