/** 配置管理：读写 Cloudflare KV */

import { AppConfig, Channel, Rule, DEFAULT_RULES } from './types';

const CONFIG_KEY = 'app_config';

/** 深拷贝规则 */
function cloneRules(rules: Record<string, Rule>): Record<string, Rule> {
  const out: Record<string, Rule> = {};
  for (const [k, v] of Object.entries(rules)) {
    out[k] = { ...v };
  }
  return out;
}

/** 默认配置 */
function defaultConfig(): AppConfig {
  return {
    channels: [],
    rules: cloneRules(DEFAULT_RULES),
    embyServerUrl: '',
    embyApiKey: '',
    embybossApiUrl: '',
    whitelistTitle: '尊敬的白名单用户',
    tgAdminChatId: '',
  };
}

/** 深度合并规则：KV 里的规则与默认规则合并 */
function mergeRules(defaultRules: Record<string, Rule>, savedRules?: Record<string, Partial<Rule>>): Record<string, Rule> {
  if (!savedRules || typeof savedRules !== 'object') return cloneRules(defaultRules);
  const out = cloneRules(defaultRules);
  for (const [k, v] of Object.entries(savedRules)) {
    if (!v || typeof v !== 'object') continue;
    out[k] = { ...out[k], ...v };
  }
  return out;
}

/** 从 KV 读取配置 */
export async function getConfig(kv: KVNamespace): Promise<AppConfig> {
  const raw = await kv.get(CONFIG_KEY);
  if (!raw) return defaultConfig();
  try {
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    const cfg = defaultConfig();
    return {
      ...cfg,
      ...parsed,
      rules: mergeRules(DEFAULT_RULES, parsed.rules),
    };
  } catch {
    return defaultConfig();
  }
}

/** 写入配置到 KV */
export async function saveConfig(kv: KVNamespace, config: AppConfig): Promise<void> {
  await kv.put(CONFIG_KEY, JSON.stringify(config));
}

/** 更新配置的便利方法 */
export async function updateConfig(
  kv: KVNamespace,
  mutator: (cfg: AppConfig) => AppConfig
): Promise<AppConfig> {
  const cfg = await getConfig(kv);
  const newCfg = mutator(cfg);
  await saveConfig(kv, newCfg);
  return newCfg;
}

/** 环境变量覆盖 KV 配置 */
export interface RuntimeConfig {
  embyServerUrl: string;
  embyApiKey: string;
  embybossApiUrl: string;
  tgAdminBotToken: string;
  tgAdminChatId: string;
  whitelistTitle: string;
}

export function resolveRuntimeConfig(
  env: {
    TG_ADMIN_BOT_TOKEN?: string;
    TG_WEBHOOK_SECRET?: string;
    TG_ADMIN_CHAT_ID?: string;
    EMBY_SERVER_URL?: string;
    EMBY_API_KEY?: string;
    EMBYBOSS_API_URL?: string;
    WHITELIST_TITLE?: string;
  },
  cfg: AppConfig
): RuntimeConfig {
  return {
    embyServerUrl: env.EMBY_SERVER_URL || cfg.embyServerUrl,
    embyApiKey: env.EMBY_API_KEY || cfg.embyApiKey,
    embybossApiUrl: env.EMBYBOSS_API_URL || cfg.embybossApiUrl,
    tgAdminBotToken: env.TG_ADMIN_BOT_TOKEN || '',
    tgAdminChatId: env.TG_ADMIN_CHAT_ID || cfg.tgAdminChatId || '',
    whitelistTitle: env.WHITELIST_TITLE || cfg.whitelistTitle,
  };
}
