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
  | 'jimeng';

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
    allowedHosts: ['*.byted.org', '*.jianying.com'],
  },
]);

export const DEFAULT_OFFICIAL_EXIT_ALLOWED_HOSTS: readonly string[] = Object.freeze([
  ...new Set(OFFICIAL_EXIT_VENDOR_CONFIGS.flatMap((vendor) => vendor.allowedHosts)),
]);
