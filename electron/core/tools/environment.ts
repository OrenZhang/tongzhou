import os from 'node:os';
import { z } from 'zod';
import type { ToolScope } from './extensions';

/** Lightweight, read-only core tools; no MCP child process or plugin switch. */
export function attachEnvironmentTools(scope: Pick<ToolScope, 'add'>) {
  const parameters = { type: 'object', properties: {}, additionalProperties: false };
  scope.add(
    {
      name: 'current_time',
      description: '查询当前 UTC 时间、本地时间、系统时区和 UTC 偏移。',
      parameters,
    },
    '查询当前时间',
    async (args) => {
      z.object({}).strict().parse(args);
      const now = new Date();
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return {
        text: JSON.stringify({
          utc: now.toISOString(),
          local: new Intl.DateTimeFormat('sv-SE', {
            dateStyle: 'short',
            timeStyle: 'long',
            timeZone,
          }).format(now),
          timeZone,
          utcOffsetMinutes: -now.getTimezoneOffset(),
          unixMilliseconds: now.getTime(),
        }),
      };
    },
    false,
  );
  scope.add(
    {
      name: 'system_info',
      description:
        '查询本机操作系统、架构、CPU、内存和时区。不读取环境变量、账号或凭据；项目依赖请使用项目工具查询。',
      parameters,
    },
    '查询系统信息',
    async (args) => {
      z.object({}).strict().parse(args);
      return {
        text: JSON.stringify({
          platform: process.platform,
          os: { name: os.type(), release: os.release(), version: os.version(), arch: os.arch() },
          cpu: { model: os.cpus()[0]?.model ?? '', logicalCores: os.cpus().length },
          memory: { totalBytes: os.totalmem(), freeBytes: os.freemem() },
          uptimeSeconds: os.uptime(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          locale: Intl.DateTimeFormat().resolvedOptions().locale,
        }),
      };
    },
    false,
  );
}
