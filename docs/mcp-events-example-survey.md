# MCP Events implementation survey

Checked 2026-10-07. This is source inspection, not independent execution of the external examples.

## Conclusion

Public implementations exist, including an author-reported real ChatGPT callback success. None inspected demonstrates production-safe outbound MCP Events callbacks from ChatGPT Sites. Our live evidence establishes failure of our selected raw-socket transport; it does not establish that all Site-native transports are impossible.

## Sources and transport comparison

| Source | Evidence | Callback transport and limits |
| --- | --- | --- |
| [OpenAI MCP Events guide](https://developers.openai.com/plugins/build/mcp-events) | Official protocol and ChatGPT lifecycle documentation | Requires persistent subscriptions, outbound HTTPS, signed verification and delivery, connection-time public-address validation and original TLS hostname verification. No Sites-specific egress implementation supplied in this guide. |
| [Rohan Prichard starter](https://github.com/rohanprichard/mcp-events-starter) | TypeScript implementation of discovery, subscriptions, challenge and signed delivery | [urlSafety.ts](https://github.com/rohanprichard/mcp-events-starter/blob/main/src/urlSafety.ts) uses Node HTTPS with a custom DNS lookup returning the validated IP. README explicitly lacks OAuth and a public plugin package; it is not a verified Sites deployment. Inspected file SHA: 7bb94e48aaf43a78184bec2fbd6a33e7dad826e9. |
| [Paperclip](https://github.com/paperclipai/paperclip/blob/master/doc/public-mcp.md) | Task status, comment and document events; persistent subscriptions | [event-webhooks.ts](https://github.com/paperclipai/paperclip/blob/master/server/src/services/public-mcp/event-webhooks.ts) calls [remote-http-fetch.ts](https://github.com/paperclipai/paperclip/blob/master/server/src/services/remote-http-fetch.ts). Standard Node TCP/TLS dials approved addresses, checks peer address and retains original hostname. This is not a Workers-compatible transport. Inspected transport SHA: c6efa3513440ff350a84e23d8a7d20cedf216e0e. |
| [Cloudflare PR #501](https://github.com/cloudflare/mcp-server-cloudflare/pull/501) | Recent draft, open and unmerged at inspection; head 12162accfa5f4f230386269045be914e00179326 | Contract/signing foundation, with safe egress injected and still required before enabling. Documentation explicitly rejects unguarded global fetch as production-safe. No functional registered subscription routes yet. |
| [gbaeke experiment](https://github.com/gbaeke/mcp-events/blob/main/README.md) | Author reports ChatGPT subscription, verification and HTTP 200 delivery followed by unattended tools | Python FastMCP behind a tunnel. README acknowledges DNS validation is not pinned to the connection and permits rebinding. Useful interoperability evidence, not a safe Sites transport. |
| [Agents Chat](https://github.com/sarfata/agents-chat) | Node server supporting draft webhook/poll/stream events | README describes public-IP pinning and verified TLS; deployed on Fly.io, not Sites. Transport implementation not separately audited in this survey. |
| [Serverless earthquake example](https://github.com/clareliguori/mcp-events-serverless-earthquake-agent) | MCP webhook-triggered Strands agent sample | AWS Lambda and a custom host, not ChatGPT Sites or proof of ChatGPT callback acceptance. |
| [watch-pr](https://github.com/pedropaulovc/watch-pr) | Hosted Cloudflare MCP with PR monitoring | README describes resource notifications and SSE monitoring; this is not evidence of ChatGPT MCP Events callback delivery. |

## Plugin directory scan

Searched `events webhook triggers`, `MCP Events`, and `Paperclip`. Directory matches included mail/webhook management and calendar/analytics tools, but returned descriptions did not establish MCP Events capabilities. Paperclip returned no match. Search exposes neither event catalogs, source code nor release dates, so it cannot establish which plugins recently added Events. No plugins installed and no third-party subscriptions created.

## Next discriminating check

Identify a supported Sites outbound transport with connection-time destination enforcement. A tightly scoped, synthetic verification-only experiment against the genuine ChatGPT callback could distinguish ordinary HTTP reachability from raw-socket restrictions, but would not establish production safety by itself. Do not switch production delivery to unguarded fetch on the strength of such a test. If Sites has no documented mechanism, request platform guidance with the redacted reproducer before adding infrastructure.

[Cloudflare documents raw TCP destination restrictions](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/). All four validated addresses in our prior live callback attempt were rejected before TLS. Their exact network ownership was not logged or independently established.
