// `<cli> mcp-connect <instance> <server>`: the stdio MCP server an agent's claude starts (the run's --mcp-config names
// this exact command, and allowedMcpServers admits nothing else). It holds no credential: it opens the instance's
// broker socket, says which run it is (the ticket the coordinator registered, from the run's environment) and which
// approved server it wants, then passes lines both ways. The broker decides everything.
import { connect } from 'node:net';
import { BRAND } from '../brand.js';
import { mcpRunPath } from '../os/system-paths.js';
/** The run's ticket: set by the runner for this one run, never a credential to any server. */
export const TICKET_VAR = `${BRAND.envPrefix}_MCP_TICKET`;
export const BROKER_SOCKET = 'broker.sock';
export const CONTROL_SOCKET = 'control.sock';
/** The command line claude starts for one approved server: the engine's own cli.js, by absolute path. */
export const connectorArgv = (node, engineCli, instance, server) => [node, engineCli, 'mcp-connect', instance, server];
export function runConnector(instance, server, env = process.env) {
    const ticket = env[TICKET_VAR];
    return new Promise((resolve) => {
        if (!ticket || !/^[0-9a-f]{64}$/.test(ticket)) {
            process.stderr.write(`${TICKET_VAR} is not set: an MCP server is reached only from an agent run\n`);
            return resolve(2);
        }
        const sock = connect(mcpRunPath(instance, BROKER_SOCKET));
        sock.on('connect', () => {
            sock.write(`${JSON.stringify({ hello: { ticket, server } })}\n`);
            process.stdin.pipe(sock);
            sock.pipe(process.stdout);
        });
        sock.on('error', (e) => {
            process.stderr.write(`the MCP broker for ${instance} isn't reachable: ${e.message}\n`);
            resolve(1);
        });
        sock.on('close', () => resolve(0));
        process.stdin.on('end', () => sock.end());
    });
}
//# sourceMappingURL=connector.js.map