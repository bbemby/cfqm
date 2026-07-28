/** 事件类型 */
export type EventType =
  | 'media_added'
  | 'playback_start'
  | 'playback_stop';

/** Emby webhook 解析后的事件 */
export interface EmbyEvent {
  type: EventType;
  title: string;
  userId: string;
  userName: string;
  deviceId: string;
  deviceName: string;
  client: string;
  itemId: string;
  year: string;
  library: string;
  position: string;
  duration: string;
  progress: string;
}

/** 渲染后的通知 */
export interface RenderedNotification {
  title: string;
  content: string;
  imageUrl: string;
}

/** 通知规则 */
export interface Rule {
  enabled: boolean;
  titleTemplate: string;
  bodyTemplate: string;
  image: boolean;
}

/** 渠道配置 */
export interface Channel {
  id: string;
  type: 'telegram' | 'bark' | 'webhook';
  name: string;
  enabled: boolean;
  config: Record<string, string>;
  events: EventType[];
}

/** 完整配置（存 KV） */
export interface AppConfig {
  channels: Channel[];
  rules: Record<string, Rule>;
  embyServerUrl: string;
  embyApiKey: string;
  embybossApiUrl: string;
  whitelistTitle: string;
  tgAdminChatId: string;
}

/** 默认规则 */
export const DEFAULT_RULES: Record<string, Rule> = {
  media_added: {
    enabled: true,
    titleTemplate: '🎬 新片入库',
    bodyTemplate: '{{title}} ({{year}}) 已加入 {{library}}',
    image: true,
  },
  playback_start: {
    enabled: true,
    titleTemplate: '▶️ 播放开始',
    bodyTemplate: '{{title}}\n{{user}}\n设备：{{device}}\n客户端：{{client}}',
    image: true,
  },
  playback_stop: {
    enabled: true,
    titleTemplate: '⏹️ 播放停止',
    bodyTemplate: '{{title}}\n{{user}}\n设备：{{device}}\n客户端：{{client}}\n\n观看时长: {{position}}',
    image: true,
  },
};

