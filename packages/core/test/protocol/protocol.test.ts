import { describe, expect, it } from 'vitest';
import {
  type ClientMessage,
  decodeClientMessage,
  decodeServerMessage,
  encodeMessage,
  PROTOCOL_VERSION,
  type ServerMessage,
} from '../../src/protocol/protocol.js';

const clientMessages: ClientMessage[] = [
  { t: 'hello', v: PROTOCOL_VERSION, bundle: 'scoreboard' },
  { t: 'rep.sub', id: 1, name: 'score' },
  { t: 'rep.sub', id: 2, name: 'other-bundle:score' },
  { t: 'rep.op', id: 3, name: 'score', patches: [{ op: 'replace', path: '', value: null }] },
  {
    t: 'rep.op',
    id: 4,
    name: 'score',
    baseRev: 0,
    patches: [
      { op: 'add', path: '/a', value: { nested: [1] } },
      { op: 'remove', path: '/b' },
    ],
  },
];

const serverMessages: ServerMessage[] = [
  { t: 'welcome', v: PROTOCOL_VERSION },
  { t: 'rep.snap', id: 1, name: 'scoreboard:score', rev: 0, value: { home: 0 }, epoch: 'e' },
  { t: 'rep.snap', id: 1, name: 'scoreboard:score', rev: 0, value: null, epoch: 'e' },
  {
    t: 'rep.patch',
    name: 'scoreboard:score',
    rev: 1,
    patches: [{ op: 'replace', path: '/home', value: 1 }],
  },
  { t: 'ack', id: 3, rev: 1 },
  { t: 'err', id: 3, code: 'conflict', message: 'stale' },
  { t: 'err', code: 'bad_request', message: 'what' },
];

describe('protocol', () => {
  it('has a version', () => {
    expect(PROTOCOL_VERSION).toBe(7);
  });

  it.each(clientMessages)('round-trips client message $t', (msg) => {
    expect(decodeClientMessage(encodeMessage(msg))).toEqual({ ok: true, msg });
  });

  it.each(serverMessages)('round-trips server message $t', (msg) => {
    expect(decodeServerMessage(encodeMessage(msg))).toEqual({ ok: true, msg });
  });

  it.each([
    ['text that is not JSON', '{nope'],
    ['a non-object', '42'],
    ['null', 'null'],
    ['an unknown type', '{"t":"rep.declare","id":1,"name":"x"}'],
    ['a missing type', '{"id":1}'],
    ['hello without version', '{"t":"hello","bundle":"a"}'],
    ['hello with an invalid bundle name', '{"t":"hello","v":1,"bundle":"../x"}'],
    ['rep.sub without id', '{"t":"rep.sub","name":"score"}'],
    ['rep.sub with a fractional id', '{"t":"rep.sub","id":1.5,"name":"score"}'],
    ['rep.sub with an empty name', '{"t":"rep.sub","id":1,"name":""}'],
    ['rep.op without patches', '{"t":"rep.op","id":1,"name":"score"}'],
    [
      'rep.op with a negative baseRev',
      '{"t":"rep.op","id":1,"name":"s","baseRev":-1,"patches":[]}',
    ],
    [
      'rep.op with an unsupported patch op',
      '{"t":"rep.op","id":1,"name":"s","patches":[{"op":"move","path":"/a","from":"/b"}]}',
    ],
    [
      'rep.op with a patch missing its value',
      '{"t":"rep.op","id":1,"name":"s","patches":[{"op":"add","path":"/a"}]}',
    ],
    [
      'rep.op with a non-string path',
      '{"t":"rep.op","id":1,"name":"s","patches":[{"op":"remove","path":["a"]}]}',
    ],
  ])('turns %s into a bad_request error instead of throwing', (_label, text) => {
    const result = decodeClientMessage(text);
    expect(result).toMatchObject({ ok: false, error: { t: 'err', code: 'bad_request' } });
  });

  it('keeps the request id on a decode error when it is usable', () => {
    const result = decodeClientMessage('{"t":"rep.sub","id":7}');
    expect(result).toMatchObject({ ok: false, error: { id: 7 } });
  });

  it.each([
    ['text that is not JSON', 'nope'],
    ['an unknown type', '{"t":"rep.sub","id":1,"name":"x"}'],
    ['welcome without version', '{"t":"welcome"}'],
    ['rep.snap without value', '{"t":"rep.snap","id":1,"name":"a:b","rev":0}'],
    ['rep.patch without rev', '{"t":"rep.patch","name":"a:b","patches":[]}'],
    ['ack without rev', '{"t":"ack","id":1}'],
    ['err with an unknown code', '{"t":"err","code":"teapot","message":"x"}'],
  ])('rejects server message: %s', (_label, text) => {
    expect(decodeServerMessage(text)).toMatchObject({ ok: false });
  });
});
