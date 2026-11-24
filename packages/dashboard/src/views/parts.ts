import { h, type VNode, type VNodeChild } from 'vue';

/** `1 panel`, `3 panels`. */
export const counted = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** What every page starts with: its title, what it is for, and what acts on the whole page. */
export function pageHead(
  title: string,
  options: {
    /** Shown beside the title. */
    readonly badge?: VNode | null | undefined;
    readonly description?: string | undefined;
    /** Filters and the like, at the far end. */
    readonly actions?: VNodeChild;
  } = {},
): VNode {
  return h('header', { class: 'page-head' }, [
    h('div', [
      h('h1', [title, ' ', options.badge ?? null]),
      options.description ? h('p', options.description) : null,
    ]),
    options.actions ? h('div', { class: 'page-actions' }, options.actions) : null,
  ]);
}

export interface Choice<T extends string> {
  readonly value: T;
  readonly label: string;
  /** How many entries the choice shows. */
  readonly count?: number;
}

const STEPS: Readonly<Record<string, (index: number, length: number) => number>> = {
  ArrowRight: (index, length) => (index + 1) % length,
  ArrowDown: (index, length) => (index + 1) % length,
  ArrowLeft: (index, length) => (index - 1 + length) % length,
  ArrowUp: (index, length) => (index - 1 + length) % length,
  Home: () => 0,
  End: (_index, length) => length - 1,
};

/**
 * One choice out of a few, as a row of buttons that is a group of radio buttons to the
 * keyboard and to a screen reader: Tab reaches the chosen one, the arrow keys, Home and End
 * move the choice.
 */
export function segmented<T extends string>(options: {
  /** What is chosen here, for whoever cannot see the page around it. */
  readonly label: string;
  readonly value: T;
  readonly choices: readonly Choice<T>[];
  onChange(value: T): void;
}): VNode {
  const { choices, value } = options;
  const onKeydown = (event: KeyboardEvent, index: number) => {
    // With a modifier the keys are the browser's: Alt and an arrow goes back a page.
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const next = STEPS[event.key]?.(index, choices.length);
    const choice = next === undefined ? undefined : choices[next];
    if (next === undefined || choice === undefined) return;
    event.preventDefault();
    options.onChange(choice.value);
    // The focus goes with the choice, which is the only button of the group Tab stops at.
    const group = (event.currentTarget as HTMLElement).parentElement;
    group?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  };
  return h(
    'div',
    { class: 'seg', role: 'radiogroup', 'aria-label': options.label },
    choices.map((choice, index) =>
      h(
        'button',
        {
          key: choice.value,
          type: 'button',
          role: 'radio',
          'aria-checked': String(choice.value === value),
          tabindex: choice.value === value ? 0 : -1,
          'data-choice': choice.value,
          onClick: () => options.onChange(choice.value),
          onKeydown: (event: KeyboardEvent) => onKeydown(event, index),
        },
        [
          choice.label,
          choice.count === undefined
            ? null
            : [' ', h('span', { class: 'n' }, String(choice.count))],
        ],
      ),
    ),
  );
}

/** A small dot in the colour of a state. */
export const dot = (state?: string) => h('span', { class: ['dot', state] });
