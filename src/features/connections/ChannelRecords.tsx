import type { Snapshot } from '../../shared/types';

export function ChannelRecords({
  data,
  targetIds,
  connectionId,
}: {
  data: Snapshot;
  targetIds?: string[];
  connectionId?: string;
}) {
  const deliveries = (data.deliveries ?? []).filter(
    (d) => !targetIds || targetIds.includes(d.channelId),
  );
  const auth = [...(data.authEvents ?? [])]
    .reverse()
    .filter((e) => !connectionId || e.providerId === connectionId)
    .slice(0, 100);
  return (
    <section className="channel-records" aria-label="连接记录">
      <h3>发送记录</h3>
      {!deliveries.length && <p className="empty-record">暂无发送记录</p>}
      {deliveries.map((d) => (
        <div className="channel-record" key={d.id}>
          <span>{new Date(d.time).toLocaleString()}</span>
          <span>
            {data.notificationTargets?.find((t) => t.id === d.channelId)?.name ??
              data.channels?.find((c) => c.id === d.channelId)?.name ??
              '已移除的接收人'}
          </span>
          <strong data-status={d.status}>
            {
              {
                sent: '已发送',
                failed: '发送失败',
                sending: '发送中',
                unknown: '结果未知，未重发',
              }[d.status]
            }
          </strong>
          {d.error && <p role="status">{d.error}</p>}
        </div>
      ))}
      <h3>认证记录</h3>
      {!auth.length && <p className="empty-record">暂无认证记录</p>}
      {auth.map((e) => (
        <div className="channel-record" key={e.id}>
          <span>{new Date(e.time).toLocaleString()}</span>
          <span>
            {data.bots?.find((b) => b.id === e.providerId)?.name ??
              data.connectors?.find((c) => c.id === e.providerId)?.name ??
              data.providers.find((p) => p.id === e.providerId)?.name ??
              e.providerId}
          </span>
          <span>{e.phase}</span>
        </div>
      ))}
    </section>
  );
}
