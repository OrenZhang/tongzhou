import { canvasPorts } from '../../shared/canvas-ports';
import { t } from '../../shared/i18n';

/** Keep user-defined split categories intact while translating the built-in port chrome. */
export function uiCanvasPorts(
  ...args: Parameters<typeof canvasPorts>
): ReturnType<typeof canvasPorts> {
  const ports = canvasPorts(...args);
  const customOutputs = Array.isArray(args[0].config?.categories);
  return {
    inputs: ports.inputs.map((port) => ({ ...port, label: t(port.label) })),
    outputs: ports.outputs.map((port) => ({
      ...port,
      label: customOutputs ? port.label : t(port.label),
    })),
  };
}
