import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** What a route of the fixture answers. */
export type Handler = (request: IncomingMessage, response: ServerResponse) => void;

export interface HttpFixture {
  /** `http://127.0.0.1:<port>`, without a slash at the end. */
  readonly url: string;
  /** The routes by path; change them while the server runs. */
  readonly routes: Map<string, Handler>;
  /** Every request that arrived, in order. */
  readonly requests: IncomingMessage[];
  close(): Promise<void>;
}

/** A small HTTP server on a free port of this machine, for tests that fetch over the network. */
export async function startHttpFixture(routes: Record<string, Handler> = {}): Promise<HttpFixture> {
  const table = new Map(Object.entries(routes));
  const requests: IncomingMessage[] = [];
  const server = createServer((request, response) => {
    requests.push(request);
    const handler = table.get((request.url ?? '/').split('?')[0] ?? '/');
    if (!handler) {
      response.writeHead(404).end();
      return;
    }
    handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    routes: table,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Answers with JSON, with whatever headers are given besides. */
export const json =
  (value: unknown, headers: Record<string, string> = {}): Handler =>
  (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json', ...headers });
    response.end(typeof value === 'string' ? value : JSON.stringify(value));
  };

/** Answers with these bytes as an archive. */
export const bytes =
  (body: Buffer, type = 'application/zip'): Handler =>
  (_request, response) => {
    response.writeHead(200, { 'content-type': type, 'content-length': String(body.length) });
    response.end(body);
  };

export const redirect =
  (location: string, status = 302): Handler =>
  (_request, response) => {
    response.writeHead(status, { location }).end();
  };
