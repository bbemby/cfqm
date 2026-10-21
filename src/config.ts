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
    embybossBotToken: '',
    whitelistTitle: '尊敬的白名单用户',
    tgAdminChatId: '',
  };
}

/** 深度合并规则：KV 里的规则与默认规则合并 */
/** 规则兜底：手改 KV 导致规则字段缺失时补全，避免详情页崩溃 */
const RULE_FALLBACK: Rule = { enabled: false, titleTemplate: '', bodyTemplate: '', image: false };

/** 只接受正确类型的规则字段，写错类型时保留默认值（否则模板渲染会在数字上调 replaceAll 直接炸） */
function sanitizeRule(v: Partial<Rule>, base: Rule): Rule {
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : base.enabled,
    titleTemplate: typeof v.titleTemplate === 'string' ? v.titleTemplate : base.titleTemplate,
    bodyTemplate: typeof v.bodyTemplate === 'string' ? v.bodyTemplate : base.bodyTemplate,
    image: typeof v.image === 'boolean' ? v.image : base.image,
    skipEpisodes: typeof v.skipEpisodes === 'boolean' ? v.skipEpisodes : base.skipEpisodes,
  };
}

function mergeRules(defaultRules: Record<string, Rule>, savedRules?: Record<string, Partial<Rule>>): Record<string, Rule> {
  if (!savedRules || typeof savedRules !== 'object') return cloneRules(defaultRules);
  const out = cloneRules(defaultRules);
  for (const [k, v] of Object.entries(savedRules)) {
    if (!v || typeof v !== 'object') continue;
    const base = out[k] ?? RULE_FALLBACK;
    out[k] = sanitizeRule(v, base);
  }
  return out;
}

/** 渠道归一化：KV 手写错时不让整站 500——非法项丢弃并记日志，而不是让 .some/.length 抛错 */
function normalizeChannels(raw: unknown): Channel[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) console.error('配置 channels 不是数组，已按空处理:', typeof raw);
    return [];
  }
  const out: Channel[] = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] as Partial<Channel> | null;
    if (!ch || typeof ch !== 'object') {
      console.error(`配置 channels[${i}] 非法，已丢弃`);
      continue;
    }
    if (ch.type !== 'telegram' && ch.type !== 'bark' && ch.type !== 'webhook') {
      console.error(`配置 channels[${i}] 类型非法，已丢弃:`, (ch as any).type);
      continue;
    }
    if (!ch.config || typeof ch.config !== 'object') {
      console.error(`配置 channels[${i}] 缺少 config，已丢弃`);
      continue;
    }
    out.push({
      ...ch,
      // 老的手写配置可能没 id：按下标派生稳定 id，保证回调定位不漂移
      id: typeof ch.id === 'string' && ch.id ? ch.id : `ch_idx_${i}`,
      name: typeof ch.name === 'string' ? ch.name : '',
      enabled: ch.enabled === true,
      events: Array.isArray(ch.events) ? ch.events : [],
    } as Channel);
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
      channels: normalizeChannels(parsed.channels),
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
  embybossBotToken: string;
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
    EMBYBOSS_BOT_TOKEN?: string;
    WHITELIST_TITLE?: string;
  },
  cfg: AppConfig
): RuntimeConfig {
  return {
    embyServerUrl: env.EMBY_SERVER_URL || cfg.embyServerUrl,
    embyApiKey: env.EMBY_API_KEY || cfg.embyApiKey,
    embybossApiUrl: env.EMBYBOSS_API_URL || cfg.embybossApiUrl,
    embybossBotToken: env.EMBYBOSS_BOT_TOKEN || cfg.embybossBotToken || '',
    tgAdminBotToken: env.TG_ADMIN_BOT_TOKEN || '',
    tgAdminChatId: env.TG_ADMIN_CHAT_ID || cfg.tgAdminChatId || '',
    whitelistTitle: env.WHITELIST_TITLE || cfg.whitelistTitle,
  };
}
