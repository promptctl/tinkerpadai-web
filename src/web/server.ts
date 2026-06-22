import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// THE NODE↔WEB BRIDGE — the one effect of the front door: bind a socket and translate each
// raw Node request into the runtime-agnostic Web `Request` the handler speaks, then write
// its `Response` back out. It knows NOTHING about routes, providers, or pages; it is a pure
// adapter between two request/response representations. The port-binding decision the ticket
// hands p0v.5 lives here and nowhere else. [LAW:effects-at-boundaries] [LAW:decomposition]

export interface RunningServer {
  // The base URL the socket is actually listening on — resolved AFTER bind, so port 0
  // (an ephemeral port for tests) yields the concrete port the OS chose. [LAW:no-silent-failure]
  readonly url: string;
  close(): Promise<void>;
}

export interface ServeConfig {
  readonly handler: (request: Request) => Promise<Response>;
  // 0 lets the OS pick a free port — what tests use so they never collide on a fixed one.
  readonly port: number;
  readonly host?: string;
}

// Collect the raw request body into bytes. GET/HEAD carry no body, so they resolve empty
// and no body is attached to the Request. [LAW:dataflow-not-control-flow]
const readBody = async (req: IncomingMessage): Promise<Uint8Array | undefined> => {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  return body.length > 0 ? body : undefined;
};

const toRequest = async (req: IncomingMessage, origin: string): Promise<Request> => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else if (value !== undefined) headers.set(name, value);
  }
  const body = await readBody(req);
  return new Request(new URL(req.url ?? '/', origin), {
    method: req.method ?? 'GET',
    headers,
    ...(body === undefined ? {} : { body, duplex: 'half' }),
  } as RequestInit);
};

const writeResponse = async (response: Response, res: ServerResponse): Promise<void> => {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
};

export const serve = (config: ServeConfig): Promise<RunningServer> => {
  const host = config.host ?? '127.0.0.1';
  const server = createServer((req, res) => {
    // The bridge must never hang or leak a raw stack to the socket: any failure converting,
    // dispatching, or writing is surfaced as a loud 500, not a dropped connection.
    // [LAW:no-silent-failure]
    void (async () => {
      try {
        const response = await config.handler(await toRequest(req, `http://${host}`));
        await writeResponse(response, res);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
      }
    })();
  });

  return new Promise<RunningServer>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, host, () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://${host}:${address.port}`,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
};
