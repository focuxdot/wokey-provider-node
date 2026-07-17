# Official Exit Verification

Provider Node's official-exit role is network egress, not request execution.

## Request Path

```text
Wokey Platform -> outbound WebSocket -> Provider Node -> TCP socket -> vendor host
```

Provider Node opens a TCP socket to the requested vendor host and port. Wokey Platform performs TLS through that socket and sends the HTTPS request. Because TLS terminates on Platform, Provider Node cannot inspect model prompts, model responses, or vendor authorization headers.

## What Provider Node Sees

Provider Node can observe:

- target host and port;
- connection/session lifecycle;
- byte counts;
- socket errors and timing.

Provider Node must not log raw tunneled bytes.

## Restricting Egress

Each official-exit request names the `targetHost`/`targetPort` to dial. By default Provider Node only opens outbound TCP connections to official vendor domains for currently supported official-exit vendors:

- OpenAI / Codex: `*.openai.com`, `*.chatgpt.com`
- Anthropic / Claude: `*.anthropic.com`, `*.claude.com`
- Qwen: `dashscope.aliyuncs.com`, `dashscope-us.aliyuncs.com`
- Zhipu AI: `*.bigmodel.cn`, `*.z.ai`
- Moonshot / Kimi: `*.kimi.com`, `*.moonshot.ai`, `*.moonshot.cn`
- MiniMax: `*.minimax.io`, `*.minimaxi.com`
- Xiaomi MiMo: `*.xiaomimimo.com`
- DeepSeek: `*.deepseek.com`
- Google Gemini: `generativelanguage.googleapis.com`
- xAI / Grok: `*.x.ai`, exact host `cli-chat-proxy.grok.com` (OAuth subscription lookup at
  `/v1/user?include=subscription`)

Operators can narrow or extend that local egress allowlist:

```bash
PROVIDER_OFFICIAL_EXIT_ALLOWED_HOSTS=*.openai.com,*.chatgpt.com,*.anthropic.com,*.claude.com
```

The node refuses (`official_exit_vendor_not_allowed`) any official-exit open request whose target host is not on the list, before opening a socket. Entries beginning with `.` or `*.` match a domain and its subdomains; others match exactly. The allowlist is read only from the node's local environment, so Platform cannot widen or disable it. Wildcard `*` is not supported; use explicit hosts or domain patterns such as `.example.com` / `*.example.com`.

## What Vendor Sees

The vendor sees the Provider Node machine's outbound public IP address. It does not see the requesting user's IP address and does not see Wokey Platform's IP address for the final vendor TCP connection.

## Compatibility Contract

Platform and Provider Node exchange versioned protocol messages defined in `src/shared/protocol.ts`. Platform remains authoritative for routing, billing, credential storage, and request construction.
