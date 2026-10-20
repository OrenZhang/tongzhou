import { expect, it } from 'vitest';
import { encodeArguments, decodeArguments } from '../../src/shared/rpc';
it('preserves omitted arguments through JSON without changing explicit null or user object values', () => {
  const args = [undefined, null, { value: 'user data', undefinedArgs: [0] }, false, undefined];
  const wire = JSON.parse(JSON.stringify(encodeArguments(args)));
  expect(decodeArguments(wire.args, wire.undefinedArgs)).toEqual(args);
});
it('rejects invalid argument positions rather than changing another argument', () => {
  for (const invalid of [[-1], [1], ['0'], [0.5], '0'])
    expect(() => decodeArguments([null], invalid)).toThrow('可选参数位置');
});
