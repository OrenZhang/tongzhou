import { Building2, Mail, MessageCircle, Send, Zap } from 'lucide-react';
import type { BotConfig, Channel, NotificationTarget, Snapshot } from '../../shared/types';

export const channelPlatforms = {
  weixin: { name: '微信', icon: MessageCircle, description: 'ClawBot 私聊与消息通知' },
  feishu: { name: '飞书', icon: Send, description: '应用机器人与消息通知' },
  wecom: { name: '企业微信', icon: Building2, description: '智能机器人与群通知' },
  dingtalk: { name: '钉钉', icon: Zap, description: '应用机器人与群通知' },
  email: { name: '邮件', icon: Mail, description: 'SMTP 邮件通知' },
} as const;

export type ChannelEntry =
  | { key: string; source: 'bot'; value: BotConfig }
  | { key: string; source: 'notification'; value: Channel };

export function channelEntries(data: Pick<Snapshot, 'bots' | 'channels'>): ChannelEntry[] {
  return [
    ...(data.bots ?? []).map((value) => ({
      key: `bot:${value.id}`,
      source: 'bot' as const,
      value,
    })),
    ...(data.channels ?? []).map((value) => ({
      key: `notification:${value.id}`,
      source: 'notification' as const,
      value,
    })),
  ];
}

export function channelStatus(entry: ChannelEntry) {
  if (entry.source === 'bot') {
    const status = entry.value.status ?? 'connecting';
    return {
      status,
      label: { connected: '已连接', listening: '已连接', connecting: '连接中', error: '连接失败' }[
        status
      ],
    };
  }
  if (!entry.value.enabled) return { status: 'disabled', label: '已停用' };
  const status = entry.value.status ?? 'configured';
  return {
    status,
    label: { connected: '发送已验证', authorized: '授权已验证', configured: '待验证' }[status],
  };
}

export function channelTargets(
  entry: ChannelEntry,
  targets: NotificationTarget[],
): NotificationTarget[] {
  if (entry.source === 'bot') return targets.filter((t) => t.botId === entry.value.id);
  return [
    {
      id: entry.value.id,
      name: entry.value.name,
      kind: entry.value.kind,
      available: entry.value.enabled,
      ...(!entry.value.enabled ? { reason: '此通知连接已停用，请先恢复连接。' } : {}),
    },
  ];
}

// Only show capabilities backed by the current adapters, never infer them from a platform name.
export function supportsNotifications(entry: ChannelEntry) {
  return entry.source === 'notification' || ['feishu', 'weixin'].includes(entry.value.kind);
}
