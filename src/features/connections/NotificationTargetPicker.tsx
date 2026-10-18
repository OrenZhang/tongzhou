import { t as tr } from '../../shared/i18n';
import type { NotificationTarget } from '../../shared/types';

export function NotificationTargetPicker({
  targets,
  value,
  onChange,
  optional = false,
}: {
  targets: NotificationTarget[];
  value: string;
  onChange(value: string): void;
  optional?: boolean;
}) {
  const selected = targets.find((target) => target.id === value);
  return (
    <>
      <select
        aria-label={tr('通知目标')}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="" disabled={!optional}>
          {optional ? tr('不发送') : tr('请选择通知目标')}
        </option>
        {value && !selected && (
          <option value={value} disabled>
            {tr('已删除通知目标')}
          </option>
        )}
        {targets.map((target) => (
          <option key={target.id} value={target.id} disabled={!target.available}>
            {target.name}
            {!target.available ? tr('（不可用）') : ''}
          </option>
        ))}
      </select>
      {!targets.length && <small>{tr('请先在渠道中添加通知目标')}</small>}
      {selected && !selected.available && (
        <small role="status">
          {selected.reason ? tr(selected.reason) : tr('当前接收人不可用')}
        </small>
      )}
    </>
  );
}
