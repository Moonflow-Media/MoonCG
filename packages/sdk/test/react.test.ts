// @vitest-environment happy-dom
import type { ReplicantHandle } from '@mooncg/core';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { useReplicant } from '../src/react/index.js';
import { NAME, type Score, setup, tick, withScore } from './fake-socket.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const unmounts: (() => void)[] = [];
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
});

interface ProbeProps {
  readonly handle: ReplicantHandle<Score>;
  readonly renders: (Score | undefined)[];
}

/** Uses the hook and records what every render saw. */
function Probe({ handle, renders }: ProbeProps) {
  const value = useReplicant(handle);
  renders.push(value);
  return createElement('output', null, value ? `${value.home}:${value.away}` : 'loading');
}

function mount(handle: ReplicantHandle<Score>) {
  const renders: (Score | undefined)[] = [];
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => root.render(createElement(Probe, { handle, renders })));
  const unmount = () => act(() => root.unmount());
  unmounts.push(unmount);
  return { renders, container, unmount };
}

const patchHome = (value: number, rev: number) =>
  ({
    t: 'rep.patch',
    name: NAME,
    rev,
    patches: [{ op: 'replace', path: '/home', value }],
  }) as const;

describe('useReplicant (React)', () => {
  it('renders the current value and re-renders when it changes', async () => {
    const { socket, score } = await withScore();
    const { renders, container } = mount(score);
    expect(container.textContent).toBe('0:0');

    act(() => socket().receive(patchHome(3, 1)));

    expect(container.textContent).toBe('3:0');
    expect(renders.at(-1)).toBe(score.value);
  });

  it('renders undefined until the first value arrives', async () => {
    const { client, socket } = setup();
    socket().welcome();
    const score = client.replicant<Score>('score');
    const { renders, container } = mount(score);
    expect(container.textContent).toBe('loading');
    expect(renders).toEqual([undefined]);

    act(() =>
      socket().receive({
        t: 'rep.snap',
        id: socket().last('rep.sub').id,
        name: NAME,
        rev: 0,
        value: { home: 1, away: 2 },
        epoch: 'e1',
      }),
    );

    expect(container.textContent).toBe('1:2');
  });

  it('keeps the snapshot identity, so nothing re-renders without a change', async () => {
    const context = await withScore();
    const { renders } = mount(context.score);
    const before = renders.length;

    // A reconnect that the server answers with "you are current" changes nothing.
    await act(async () => {
      context.socket().close();
      await tick();
      context.socket().welcome();
      context.socket().receive({ t: 'ack', id: context.socket().last('rep.sub').id, rev: 0 });
    });

    expect(renders).toHaveLength(before);
  });

  it('unsubscribes when the component unmounts', async () => {
    const { socket, score } = await withScore();
    const { renders, unmount } = mount(score);
    const before = renders.length;

    unmount();
    socket().receive(patchHome(5, 1));

    expect(score.value).toEqual({ home: 5, away: 0 });
    expect(renders).toHaveLength(before);
  });
});

describe('useReplicant (React) with an optimistic replicant', () => {
  it('renders a write before the server confirmed it', async () => {
    const { client, socket } = setup();
    socket().welcome();
    const score = client.replicant<Score>('score', { optimistic: true });
    socket().receive({
      t: 'rep.snap',
      id: socket().last('rep.sub').id,
      name: NAME,
      rev: 0,
      value: { home: 0, away: 0 },
      epoch: 'e1',
    });
    await score.ready;
    const { container } = mount(score);

    await act(async () => {
      void score.update((draft) => {
        draft.home = 7;
      });
      await tick();
    });

    expect(container.textContent).toBe('7:0');
    expect(socket().last('rep.op')).toMatchObject({ baseRev: 0 });
  });
});
