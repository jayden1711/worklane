// A loopback port a test holds for its whole life (issue #312). A test that stops a server and then expects its port
// to be dead was asking the machine to keep that port free: any process can take a freed port (another test file's
// dashboard, a live instance's), and the stopped "instance" answered 401 as someone else. Here the port is held by
// the test from start to end; in front of a server it forwards to it, and once that server is stopped it resets
// every connection, so nothing but the test ever answers on it.
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
