# The dashboard

A local web page over a coordinator's event log: issues and their status, decisions waiting on you, agent runs, estimated spend, the land queue, deploys and reports. It listens on `127.0.0.1` only and every API call needs the dashboard's token, which is in the URL it prints.

## For a project checkout

```bash
worklane dashboard            # from inside the checkout, or with --root <dir>
```

It reads the checkout's own log and opens the browser on port 4317.

## For an instance on an always-on machine

An instance's log lives in its coordinator user's home, which only that user can read. So the dashboard runs as that user, on the machine where the instance runs:

```bash
bash scripts/setup/dashboard.sh <name> [<your GitHub login>]
```

- It starts `worklane dashboard --instance <name> --no-open` as `wl-<name>`, in the foreground (Ctrl+C stops it).
- The port is fixed by the instance's name (4400-4899), so a tunnel set up once keeps working. `--port` on the CLI overrides it.
- Your GitHub login decides which decisions you may answer (yours, or any if you're one of the project's writers). Without it, the dashboard acts as the project's default owner.
- Answers are recorded in that instance's log, as its coordinator user, like `decide` on the command line.

### From another machine: an ssh tunnel

The dashboard never listens on the network. To open it from your laptop, forward the same port over ssh:

```bash
ssh -N -L <port>:127.0.0.1:<port> <you>@<always-on-host>
```

Then open the URL `dashboard.sh` printed (`http://127.0.0.1:<port>/?t=<token>`) on the laptop. The page moves the token out of the address bar on load. The token is stored in the instance's state directory, so it stays the same across restarts; delete `dashboard-token` there to issue a new one.

Each instance has its own port and token: run one `dashboard.sh` and one tunnel per instance.

## The web UI

The engine install (`scripts/setup/engine.sh`) builds the UI into `dist/web`. In a source checkout, run `npm run build:web`. Without it the page says the UI isn't built.
