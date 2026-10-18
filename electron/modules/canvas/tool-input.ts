/** Some models serialize numeric tool fields as strings. Only normalize known canvas fields;
 * the ordinary schema still enforces bounds, integers, required fields and resource access.
 */
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function number(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value.trim())
  )
    return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : value;
}

function fields(value: Record<string, unknown>, keys: string[]) {
  const result = { ...value };
  for (const key of keys) if (key in result) result[key] = number(result[key]);
  return result;
}

export function canvasToolInput(name: string, raw: unknown): unknown {
  if (!object(raw) || !['canvas_apply', 'canvas_execute'].includes(name)) return raw;
  const result = fields(raw, ['version']);
  if (name === 'canvas_apply' && Array.isArray(raw.ops))
    result.ops = raw.ops.map((op) => {
      if (!object(op) || op.type !== 'put_node' || !object(op.node)) return op;
      const node = fields(op.node, ['x', 'y', 'width', 'height']);
      if (object(node.media)) node.media = fields(node.media, ['count', 'duration', 'speed']);
      return { ...op, node };
    });
  if (name === 'canvas_execute' && object(raw.regenerate) && Array.isArray(raw.regenerate.indices))
    result.regenerate = { ...raw.regenerate, indices: raw.regenerate.indices.map(number) };
  return result;
}
