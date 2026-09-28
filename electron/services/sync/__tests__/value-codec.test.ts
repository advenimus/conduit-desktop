// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { SyncValue } from '../types.js';
import { decodeValue, encodeValue, valueFromText, valueToText, valuesFromText, valuesToText } from '../value-codec.js';

describe('value-codec', () => {
  it('round-trips every SyncValue form', () => {
    for (const v of [null, 0, -12, 'text', '', Buffer.from([0, 255, 7])]) {
      expect(valueFromText(valueToText(v))).toEqual(v);
      expect(decodeValue(encodeValue(v))).toEqual(v);
    }
  });

  it('encodes bytes as {"$b64": ...} in JCS', () => {
    expect(valueToText(Buffer.from('hi'))).toBe('{"$b64":"aGk="}');
    expect(valuesToText(new Map<string, null | string>([['z', 'a'], ['a', null]]))).toBe('{"a":null,"z":"a"}');
  });

  it('round-trips row_json maps and rejects bad input', () => {
    const m = new Map<string, SyncValue>([
      ['password', Buffer.from([1, 2])],
      ['name', 'n'],
    ]);
    expect(valuesFromText(valuesToText(m))).toEqual(m);
    expect(() => valuesFromText('[1]')).toThrow();
    expect(() => decodeValue({ nope: 1 })).toThrow();
  });
});
