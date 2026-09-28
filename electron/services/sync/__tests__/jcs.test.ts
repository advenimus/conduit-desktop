// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { jcs, jcsFromText, jcsObjectFromEntries } from '../jcs.js';

describe('jcs (RFC 8785)', () => {
  it('sorts object keys recursively by UTF-16 code units', () => {
    expect(jcs({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
    expect(jcs({ '\u20ac': 1, '\r': 2, '\ud83d\ude00': 3, a: 4 })).toBe('{"\\r":2,"a":4,"\u20ac":1,"\ud83d\ude00":3}');
  });

  it('serializes numbers like ECMAScript', () => {
    expect(jcs([1e21, 1e-7, -0, 0.1, 100, 333333333.33333329])).toBe('[1e+21,1e-7,0,0.1,100,333333333.3333333]');
    expect(() => jcs(Number.NaN)).toThrow();
    expect(() => jcs(Number.POSITIVE_INFINITY)).toThrow();
  });

  it('escapes strings per RFC 8785', () => {
    expect(jcs('\u0000\b\t\n\f\r"\\/\u001f\u2028')).toBe('"\\u0000\\b\\t\\n\\f\\r\\"\\\\/\\u001f\u2028"');
  });

  it('drops undefined object members and nulls undefined array items', () => {
    expect(jcs({ a: undefined, b: [undefined] })).toBe('{"b":[null]}');
  });

  it('rejects unsupported values', () => {
    expect(() => jcs(() => 1)).toThrow();
    expect(() => jcs(BigInt(1))).toThrow();
  });

  it('canonicalizes JSON text and reports invalid input as null', () => {
    expect(jcsFromText('{ "b" : [1, 2], "a": true }')).toBe('{"a":true,"b":[1,2]}');
    expect(jcsFromText('{nope')).toBeNull();
  });

  it('builds objects from pre-canonical member texts', () => {
    expect(jcsObjectFromEntries([['b', '1'], ['a', '{"x":2}']])).toBe('{"a":{"x":2},"b":1}');
    expect(jcsObjectFromEntries([])).toBe('{}');
  });
});
