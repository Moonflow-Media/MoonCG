// @vitest-environment happy-dom
import type { ReplicantHandle } from '@mooncg/core';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { useReplicant, useReplicantError } from '../src/react/index.js';
import { NAME, type Score, tick, withScore } from './fake-socket.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const unmounts: (() => void)[] = [];
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
});

interface ProbeProps {
  readonly handle: ReplicantHandle<Score>;
  readonly renders: unknown[];
}

function ValueProbe({ handle, renders }: ProbeProps) {
  const value = useReplicant(handle);
  renders.push(value);
  return createElement('output', null, value ? `${value.home}:${value.away}` : 'loading');
}

function ErrorProbe({ handle, renders }: ProbeProps) {
  const error = useReplicantError(handle);
  renders.push(error);
  return createElement('output', null, error ? error.code : 'ok');
}

function mount(component: typeof ValueProbe, handle: ReplicantHandle<Score>) {
  const renders: unknown[] = [];
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => root.render(createElement(component, { handle, renders })));
  const unmount = () => act(() => root.unmount());
  unmounts.push(unmount);
  return { renders, container, unmount };
}

describe('useReplicant (React) snapshot identity', () => {
  it('does not re-render for a snapshot that carries the value already shown', async () => {
    const context = await withScore();
    const { renders, container } = mount(ValueProbe, context.score);
    const before = renders.length;

    // A restarted server answers with a snapshot: new epoch and revision, the same value.
    await act(async () => {
      context.socket().close();
      await tick();
      context.socket().welcome();
      context.socket().receive({
        t: 'rep.snap',
        id: context.socket().last('rep.sub').id,
        name: NAME,
        rev: 12,
        value: { home: 0, away: 0 },
        epoch: 'e2',
      });
    });

    expect(renders).toHaveLength(before);
    expect(container.textContent).toBe('0:0');
  });
});

describe('useReplicantError (React)', () => {
  it('returns undefined while the replicant is fine and the error once it is gone', async () => {
    const { socket, score } = await withScore();
    const { container, renders } = mount(ErrorProbe, score);
    expect(container.textContent).toBe('ok');

    act(() => socket().receive({ t: 'rep.gone', name: NAME, message: 'removed' }));

    expect(container.textContent).toBe('not_found');
    expect(renders.at(-1)).toBe(score.error);
  });

  it('does not re-render when the value changes but the error does not', async () => {
    const { socket, score } = await withScore();
    const { renders } = mount(ErrorProbe, score);
    const before = renders.length;

    act(() =>
      socket().receive({
        t: 'rep.patch',
        name: NAME,
        rev: 1,
        patches: [{ op: 'replace', path: '/home', value: 1 }],
      }),
    );

    expect(renders).toHaveLength(before);
  });

  it('stops listening when the component unmounts', async () => {
    const { socket, score } = await withScore();
    const { renders, unmount } = mount(ErrorProbe, score);
    const before = renders.length;

    unmount();
    socket().receive({ t: 'rep.gone', name: NAME, message: 'removed' });

    expect(renders).toHaveLength(before);
  });
});
