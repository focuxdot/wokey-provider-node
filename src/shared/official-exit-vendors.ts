export type OfficialExitVendorId =
  | 'openai'
  | 'anthropic'
  | 'qwen'
  | 'zhipu'
  | 'moonshot'
  | 'minimax'
  | 'xiaomi'
  | 'deepseek'
  | 'google'
  | 'xai'
  | 'jimeng'
  | 'cursor'
  | 'volcengine';

export interface OfficialExitVendorConfig {
  id: OfficialExitVendorId;
  displayName: string;
  allowedHosts: readonly string[];
}

export const OFFICIAL_EXIT_VENDOR_CONFIGS: readonly OfficialExitVendorConfig[] = Object.freeze([
  {
    id: 'openai',
    displayName: 'OpenAI / Codex',
    allowedHosts: ['*.openai.com', '*.chatgpt.com'],
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic / Claude',
    allowedHosts: ['*.anthropic.com', '*.claude.com', '*.claude.ai'],
  },
  {
    id: 'qwen',
    displayName: 'Qwen',
    allowedHosts: ['*.aliyuncs.com'],
  },
  {
    id: 'zhipu',
    displayName: 'Zhipu AI',
    allowedHosts: ['*.bigmodel.cn', '*.z.ai'],
  },
  {
    id: 'moonshot',
    displayName: 'Moonshot / Kimi',
    allowedHosts: ['*.kimi.com', '*.moonshot.ai', '*.moonshot.cn'],
  },
  {
    id: 'minimax',
    displayName: 'MiniMax',
    allowedHosts: ['*.minimax.io', '*.minimaxi.com'],
  },
  {
    id: 'xiaomi',
    displayName: 'Xiaomi MiMo',
    allowedHosts: ['*.xiaomimimo.com'],
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    allowedHosts: ['*.deepseek.com'],
  },
  {
    id: 'google',
    displayName: 'Google Gemini',
    allowedHosts: ['generativelanguage.googleapis.com'],
  },
  {
    id: 'xai',
    displayName: 'xAI',
    allowedHosts: ['*.x.ai', '*.grok.com'],
  },
  {
    id: 'jimeng',
    displayName: 'Jimeng / Dreamina',
    // Intentionally keep registrable-domain scope. Jimeng has changed API
    // endpoints before; narrowing these entries would force needless Node
    // rebuilds whenever another official subdomain is introduced. Completed
    // Image uploads apply through imagex under bytedanceapi.com, then send the
    // bytes to upload hosts returned by ImageX under snssdk.com or
    // bytedancevod.com;
    // completed videos use signed vlabvod.com URLs during query_result downloads;
    // Image 4.0 results use signed byteimg.com URLs.
    allowedHosts: ['*.byteimg.com', '*.byted.org', '*.bytedanceapi.com', '*.jianying.com', '*.vlabvod.com', '*.snssdk.com', '*.bytedancevod.com'],
  },
  {
    id: 'cursor',
    displayName: 'Cursor Desktop',
    // Keep the default narrow: these are the two production hosts used by the
    // current Desktop relay for dashboard RPCs and Agent streaming.
    allowedHosts: ['api2.cursor.sh', 'agentn.api5.cursor.sh'],
  },
  {
    id: 'volcengine',
    displayName: 'Volcengine Ark',
    // Two different registrable domains, both required: inference goes to the
    // data plane, while Coding Plan quota can only be read from the control
    // plane with an AccessKey pair (the inference key is rejected there).
    // Kept as exact hosts rather than a domain pattern: Ark serves
    // pay-as-you-go billing from a sibling path on the same origin, and the
    // Platform already hard-asserts this host on the way out — a wider entry
    // here would only remove a check without enabling anything we use.
    allowedHosts: ['ark.cn-beijing.volces.com', 'open.volcengineapi.com'],
  },
]);

export const DEFAULT_OFFICIAL_EXIT_ALLOWED_HOSTS: readonly string[] = Object.freeze([
  ...new Set(OFFICIAL_EXIT_VENDOR_CONFIGS.flatMap((vendor) => vendor.allowedHosts)),
]);
