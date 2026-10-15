// A loopback port a test holds for its whole life (issue #312). A test that stops a server and then expects its port
// to be dead was asking the machine to keep that port free: any process can take a freed port (another test file's
// dashboard, a live instance's), and the stopped "instance" answered 401 as someone else. Here the port is held by
// the test from start to end; in front of a server it forwards to it, and once that server is stopped it resets
// every connection, so nothing but the test ever answers on it.
import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect, createServer, type AddressInfo, type Socket } from 'node:net';

export interface HeldPort {
  /** The port, on 127.0.0.1, held until close(). */
  port: number;
  /** Forward new connections to this port on 127.0.0.1; null: refuse them all (reset), as a stopped server would. */
  forwardTo: (port: number | null) => void;
  close: () => Promise<void>;
}

export async function heldPort(target: number | null): Promise<HeldPort> {
  let to = target;
  const open = new Set<Socket>();
  const keep = (s: Socket) => {
    open.add(s);
    s.on('close', () => open.delete(s));
  };
  const server = createServer((s) => {
    keep(s);
    if (to === null) return void s.resetAndDestroy();
    const up = connect(to, '127.0.0.1');
    keep(up);
    const drop = () => {
      s.destroy();
      up.destroy();
    };
    for (const x of [s, up]) {
      x.on('error', drop);
      x.on('close', drop);
    }
    s.pipe(up).pipe(s);
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => ok());
  });
  return {
    port: (server.address() as AddressInfo).port,
    forwardTo: (p) => {
      to = p;
      if (p === null) for (const s of open) s.destroy();
    },
    close: () =>
      new Promise<void>((ok) => {
        for (const s of open) s.destroy();
        server.close(() => ok());
      }),
  };
}

/**
 * The first port the OS hands out on its own (connect() and listen(0) pick from there up): Linux's
 * ip_local_port_range, else the IANA dynamic range macOS and Windows use.
 */
export function ephemeralStart(read: (f: string) => string = (f) => readFileSync(f, 'utf8')): number {
  if (process.platform === 'linux') {
    try {
      const lo = Number(read('/proc/sys/net/ipv4/ip_local_port_range').trim().split(/\s+/)[0]);
      if (Number.isInteger(lo) && lo > 1024 && lo <= 65_535) return lo;
    } catch {
      // unreadable: the kernel's default
    }
    return 32_768;
  }
  return 49_152;
}

/**
 * A loopback port where a connection is refused at once (ECONNREFUSED), for as long as it is held. WHY (#312): a port
 * found free and then closed ("nothing listens there") can be taken by any process before it is used: another test's
 * server, a live instance's, or this test's own next listen(0), which the OS may hand the same port.
 *
 * Here the port is the local end of an open connection, bound explicitly: nothing listens on it, so a connection
 * there is refused, and the OS hands it to no listen(0) or connect() until close() (it is outside the range they are
 * given ports from). A program that listens on this exact port on purpose could still take it: Node binds an explicit
 * local port with SO_REUSEADDR, as every Node server does. It is below the ephemeral range on purpose: Linux
 * gives an ephemeral port already in use to another connect() whenever the 4-tuple differs, so a connect to a held
 * ephemeral port can get that same port as its source and connect to itself (TCP simultaneous open): no refusal, and
 * its own request read back as the answer ("fetch failed", not ECONNREFUSED, on a busy release machine). No connect()
 * is ever given a source port outside the range.
 */
export async function refusedPort(o: { below?: number } = {}): Promise<{ port: number; url: string; close: () => Promise<void> }> {
  const accepted = new Set<Socket>();
  const server = createServer((s) => {
    accepted.add(s);
    s.on('error', () => undefined);
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => ok());
  });
  const to = (server.address() as AddressInfo).port;
  const top = o.below ?? ephemeralStart();
  const lo = top > 10_000 ? 10_000 : 1025;
  let client: Socket | null = null;
  // A port someone listens on, or holds, is taken: another is tried.
  for (let i = 0; i < 200 && !client; i++) {
    const c = connect({ port: to, host: '127.0.0.1', localAddress: '127.0.0.1', localPort: lo + randomInt(top - lo) });
    const ok = await new Promise<boolean>((done) => {
      c.once('connect', () => done(true));
      c.once('error', () => done(false));
    });
    if (ok) client = c;
    else c.destroy();
  }
  if (!client) {
    await new Promise<void>((r) => server.close(() => r()));
    throw new Error(`refusedPort: no free loopback port below ${top} to hold`);
  }
  const held = client;
  held.on('error', () => undefined);
  const port = held.localPort!;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((ok) => {
        held.destroy();
        for (const s of accepted) s.destroy();
        server.close(() => ok());
      }),
  };
}
