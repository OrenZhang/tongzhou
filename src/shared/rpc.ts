/** JSON has no undefined value. Keep its argument positions distinct from an explicit null. */
export function encodeArguments(args: unknown[]) {
  return {
    args: args.map((value) => (value === undefined ? null : value)),
    undefinedArgs: args.flatMap((value, index) => (value === undefined ? [index] : [])),
  };
}
export function decodeArguments(args: unknown[], undefinedArgs: unknown = []): unknown[] {
  if (
    !Array.isArray(undefinedArgs) ||
    undefinedArgs.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= args.length)
  )
    throw new Error('无效的可选参数位置');
  const result = [...args];
  for (const index of undefinedArgs) result[index] = undefined;
  return result;
}
