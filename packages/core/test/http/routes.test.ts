import { describe, expect, it } from 'vitest';
import {
  type HttpResponseData,
  isRoutePattern,
  type Route,
  RouteTable,
} from '../../src/http/routes.js';

const respond = async (): Promise<HttpResponseData> => ({ status: 200, headers: {}, body: null });
const route = (overrides: Partial<Route> = {}): Route => ({
  bundle: 'scoreboard',
  method: 'GET',
  pattern: '/score',
  permission: 'bundle:scoreboard:?',
  invoke: respond,
  ...overrides,
});

describe('isRoutePattern', () => {
  it.each([['/'], ['/score'], ['/teams/:id'], ['/a/b-c/d_e.f/:x1']])('accepts %s', (pattern) => {
    expect(isRoutePattern(pattern)).toBe(true);
  });

  it.each([
    [''],
    ['score'],
    ['/score/'],
    ['//score'],
    ['/teams/:'],
    ['/teams/:id/:id'],
    ['/a b'],
    ['/../x'],
    ['/*'],
    [`/${'x'.repeat(300)}`],
  ])('rejects %j', (pattern) => {
    expect(isRoutePattern(pattern)).toBe(false);
  });
});

describe('RouteTable', () => {
  it('finds a route by bundle, method and path', () => {
    const table = new RouteTable();
    const score = route();
    table.add(score);

    expect(table.match('scoreboard', 'GET', '/score')).toEqual({ route: score, params: {} });
    expect(table.match('scoreboard', 'POST', '/score')).toBeUndefined();
    expect(table.match('other', 'GET', '/score')).toBeUndefined();
    expect(table.match('scoreboard', 'GET', '/score/extra')).toBeUndefined();
    expect(table.match('scoreboard', 'GET', '/')).toBeUndefined();
  });

  it('extracts and decodes parameters', () => {
    const table = new RouteTable();
    table.add(route({ pattern: '/teams/:team/players/:id' }));

    expect(table.match('scoreboard', 'GET', '/teams/red%20sox/players/7')?.params).toEqual({
      team: 'red sox',
      id: '7',
    });
    expect(table.match('scoreboard', 'GET', '/teams/%E0%A4%A/players/7')).toBeUndefined();
    expect(table.match('scoreboard', 'GET', '/teams//players/7')).toBeUndefined();
  });

  it('prefers a literal segment over a parameter', () => {
    const table = new RouteTable();
    const byId = route({ pattern: '/teams/:id' });
    const all = route({ pattern: '/teams/all' });
    table.add(byId);
    table.add(all);

    expect(table.match('scoreboard', 'GET', '/teams/all')?.route).toBe(all);
    expect(table.match('scoreboard', 'GET', '/teams/7')?.route).toBe(byId);
  });

  it('matches the root route', () => {
    const table = new RouteTable();
    const root = route({ pattern: '/' });
    table.add(root);
    expect(table.match('scoreboard', 'GET', '/')?.route).toBe(root);
  });

  it('refuses a second route for the same bundle, method and pattern', () => {
    const table = new RouteTable();
    table.add(route());
    expect(() => table.add(route())).toThrow(expect.objectContaining({ code: 'conflict' }));
    expect(() => table.add(route({ method: 'POST' }))).not.toThrow();
    expect(() => table.add(route({ bundle: 'other' }))).not.toThrow();
  });

  it('removes a route with the function add returned, and counts what is left', () => {
    const table = new RouteTable();
    const remove = table.add(route());
    table.add(route({ bundle: 'other' }));
    expect(table.count()).toBe(2);
    expect(table.count('scoreboard')).toBe(1);

    remove();
    remove();

    expect(table.match('scoreboard', 'GET', '/score')).toBeUndefined();
    expect(table.count()).toBe(1);
    expect(() => table.add(route())).not.toThrow();
  });
});
