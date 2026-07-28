/** 配置管理：读写 Cloudflare KV */

import { AppConfig, Channel, Rule, DEFAULT_RULES } from './types';

const CONFIG_KEY = 'app_config';

/** 默认配置 */
function defaultConfig(): AppConfig {
  return {
    channels: [],
    rules: { ...DEFAULT_RULES },
    embyServerUrl: '',
    embyApiKey: '',
    embybossApiUrl: '',
    whitelistTitle: '尊敬的白名单用户',
  };
}

/** 从 KV 读取配置 */
export async function getConfig(kv: KVNamespace): Promise<AppConfig> {
  const raw = await kv.get(CONFIG_KEY);
  if (!raw) return defaultConfig();
  try {
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    const cfg = defaultConfig();
    return { ...cfg, ...parsed };
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
  whitelistTitle: string;
}

export function resolveRuntimeConfig(
  env: {
    TG_ADMIN_BOT_TOKEN?: string;
    TG_WEBHOOK_SECRET?: string;
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
    whitelistTitle: env.WHITELIST_TITLE || cfg.whitelistTitle,
  };
}
