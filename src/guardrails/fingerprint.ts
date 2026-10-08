// Database connection fingerprints. Some platforms give every environment's
// database the same host, port, database name and user; only the password
// differs. So a fingerprint covers every component, password included, and
// only the hash is ever stored or compared.
import { createHash } from 'node:crypto';

const DEFAULT_PORTS: Record<string, string> = {
  postgres: '5432',
  postgresql: '5432',
  mysql: '3306',
  mariadb: '3306',
  mongodb: '27017',
  'mongodb+srv': '',
  redis: '6379',
  rediss: '6379',
};

const URL_RE = /\b(postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?):\/\/[^\s'"`<>]+/gi;

export function fingerprint(connection: string): string | null {
  let u: URL;
  try {
    u = new URL(connection.trim());
  } catch {
    return null;
  }
  const proto = u.protocol.replace(/:$/, '').toLowerCase();
  if (!(proto in DEFAULT_PORTS)) return null;
  const parts = [
    proto.replace(/^postgresql$/, 'postgres'),
    decodeURIComponent(u.username),
    decodeURIComponent(u.password),
    u.hostname.toLowerCase(),
    u.port || DEFAULT_PORTS[proto],
    decodeURIComponent(u.pathname.replace(/^\//, '')),
  ];
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

/** Connection strings appearing literally in text. */
export function findConnections(text: string): string[] {
  return [...text.matchAll(URL_RE)].map((m) => m[0].replace(/[),;]+$/, ''));
}

/** Connection strings a command reaches: literal ones plus $VAR / ${VAR} references resolved from env. */
export function connectionsIn(command: string, env: Record<string, string | undefined>): string[] {
  const found = findConnections(command);
  for (const m of command.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)) {
    const v = env[m[1]!];
    if (v) found.push(...findConnections(v));
  }
  return found;
}
