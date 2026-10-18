import { t } from '../shared/i18n';

export function errorMessage(error: unknown) {
  return t(
    String(error)
      .replace(/^Error:\s*Error invoking remote method '[^']+':\s*/i, '')
      .replace(/^Error:\s*/i, ''),
  );
}
