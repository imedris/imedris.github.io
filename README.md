# Tesla Alert

A small Node.js script with zero npm dependencies. It alerts through ntfy when the coordinates of a Tesla's active navigation destination fall within 2 straight-line miles of Kensington station at 33.7720257, -84.2530775, or whose name contains Kensington, Flat Shoals, or Cedar Crest (case-insensitive).

Tesla Fleet Telemetry documents `DestinationLocation` as the active route's destination coordinates. Tesla sends the signal when it changes, subject to the configured interval, and can also send an initial value on startup. This app subscribes to DestinationLocation and DestinationName, using a one-second interval for destination changes. The car pushes data directly to Tesla's official self-hosted receiver, which this app runs as a child process and reads through the built-in JSON logger. There are zero periodic Fleet API requests or vehicle wake requests. Tesla bills for streamed signals according to its Fleet API pricing. [Available data](https://developer.tesla.com/docs/fleet-api/fleet-telemetry/available-data) · [Streaming behavior](https://developer.tesla.com/docs/fleet-api/fleet-telemetry#system-behavior) · [Billing](https://developer.tesla.com/docs/fleet-api/billing-and-limits)

## Try it locally

Use Node.js 22.9 or newer. Run the commands from this directory. No `npm install` is needed.

```sh
npm run simulate           # Local dry run with sample destinations
npm run test:ntfy          # Sends a test message without contacting Tesla
npm run simulate -- --send # Sends sample alerts using the real ntfy topic
```

With the defaults, the simulation prints two qualifying alerts, skips repeated coordinates and a cleared route, and logs one out-of-range destination. It uses in-memory state.

Subscribe in the ntfy phone app to the topic in `.env` on `https://ntfy.sh`. To create a fresh topic, run `npm run tesla -- topic` and paste the generated value into `NTFY_TOPIC`. If starting from a clean checkout, create a local `.env` with `NTFY_TOPIC` first and run `chmod 600 .env`. Anyone who knows the topic can subscribe or publish, so keep it private. Alerts include precise destination coordinates. [ntfy publishing and topic privacy](https://docs.ntfy.sh/publish/#public-topics)

| Setting | Default or value |
| --- | --- |
| `NTFY_TOPIC` | Generated with 192 bits of randomness |
| `TARGET_NAME` | Kensington station |
| `TARGET_LATITUDE` | 33.7720257 |
| `TARGET_LONGITUDE` | -84.2530775 |
| `RADIUS_MILES` | 2 |
| `DESTINATION_NAME_MATCH` | `kensington,flat shoals,cedar crest`, comma-separated case-insensitive substrings. Empty disables name matching. |
| `TESLA_CLIENT_ID`, `TESLA_CLIENT_SECRET` | Tesla developer application credentials |
| `TESLA_REDIRECT_URI` | The exact HTTPS OAuth redirect URI registered for your app |
| `TESLA_APP_DOMAIN` | Registered app domain, hostname only |
| `TESLA_VIN` | Your car's 17-character VIN |
| `TESLA_REGION` | `na` for North America and Asia-Pacific excluding China, or `eu` for Europe |
| `TELEMETRY_HOST`, `TELEMETRY_PORT` | Public receiver hostname and port, with port 443 by default |
| `TELEMETRY_CA_FILE` | PEM trust chain for the receiver certificate, as described in Tesla's server setup |
| `TELEMETRY_BIN`, `TELEMETRY_CONFIG` | `fleet-telemetry` on PATH and `telemetry-server.json` in this directory |

## Connect your Tesla

1. Create a Tesla developer application with **Authorization Code and Machine-to-Machine** enabled. Set up billing, an HTTPS redirect URI you control, and the app domain. Fill in the Tesla settings in `.env`. Generate the app's signing key and publish its public key at `https://<app-domain>/.well-known/appspecific/com.tesla.3p.public-key.pem`. Follow Tesla's [receiver setup](https://github.com/teslamotors/fleet-telemetry#setup-steps) and [registration endpoint](https://developer.tesla.com/docs/fleet-api/endpoints/partner-endpoints#register).

   ```sh
   umask 077
   openssl ecparam -name prime256v1 -genkey -noout -out fleet-key.pem
   openssl ec -in fleet-key.pem -pubout -out fleet-public-key.pem
   npm run tesla -- register  # Run after hosting the public key
   npm run tesla -- auth
   ```

   Open the printed Tesla sign-in URL, grant the requested scopes, and paste the full redirected URL back into the terminal. A static HTTPS callback page on your domain is sufficient. The script validates the callback and OAuth state, then stores the returned tokens in `.tesla-tokens.json`. It automatically refreshes before setup/status requests as needed, saves the rotated refresh token, and retries an API 401 once. If Tesla expires or revokes the refresh token, rerun `auth`. Live telemetry does not use the OAuth token. [Tesla third-party OAuth](https://developer.tesla.com/docs/fleet-api/authentication/third-party-tokens)

2. Pair the key from the Tesla app via `https://tesla.com/_ak/<app-domain>`. Use a supported car on current firmware. Tesla documents firmware 2024.26 or later for signed setup and 2025.20 or later for Intel Atom Model S/X. This app expects typed coordinates, which current Fleet Telemetry clients send by default. Older unsupported vehicles and shared vehicles whose owner hides private data cannot use this destination stream. [Tesla prerequisites and scopes](https://developer.tesla.com/docs/fleet-api/fleet-telemetry#prerequisites)

3. Install Tesla's [Fleet Telemetry receiver](https://github.com/teslamotors/fleet-telemetry#install-steps) on the Mac, Raspberry Pi, or server that will run Node. Use the official source build for your platform and put the resulting executable on PATH, or point `TELEMETRY_BIN` at it. Provide a publicly reachable DNS name and TCP port, and a TLS certificate matching the name. Let the receiver terminate mutual TLS directly. Set `TELEMETRY_HOST`, `TELEMETRY_PORT`, and `TELEMETRY_CA_FILE` in `.env`. Save this as `telemetry-server.json` with your certificate paths. The example uses local port 8443 so the process can run unprivileged. Forward your public port to that port or use 8443 for both.

   ```json
   {
     "host": "0.0.0.0",
     "port": 8443,
     "log_level": "info",
     "json_log_enable": true,
     "logger": { "verbose": false },
     "records": { "V": ["logger"], "connectivity": ["logger"] },
     "tls": {
       "server_cert": "/absolute/path/to/fullchain.pem",
       "server_key": "/absolute/path/to/private-key.pem"
     }
   }
   ```

4. Install Tesla's [Vehicle Command Proxy](https://github.com/teslamotors/vehicle-command#installation-and-configuration) and generate its local TLS key and certificate using Tesla's instructions. The proxy certificate must be valid for `localhost`. Run the proxy in one terminal, submit the configuration from another, then stop the proxy.

   ```sh
   umask 077
   openssl req -x509 -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
     -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost' \
     -keyout proxy-key.pem -out proxy-cert.pem -days 365
   tesla-http-proxy -host localhost -port 4443 -cert proxy-cert.pem -tls-key proxy-key.pem -key-file fleet-key.pem
   ```

   ```sh
   NODE_EXTRA_CA_CERTS="$PWD/proxy-cert.pem" npm run tesla -- configure
   npm run tesla -- status
   npm start
   ```

   The setup command submits the documented configuration through the signing proxy. `status` reports whether the vehicle adopted it. If `synced` is false, wait for the car to come online normally before checking again. Once running, set a new destination in the car and look for a terminal log and, if in range, a phone notification. [Tesla vehicle endpoints](https://developer.tesla.com/docs/fleet-api/endpoints/vehicle-endpoints#fleet_telemetry_config-create)

## Continuous operation

Run one monitor per directory. Node restarts the receiver with backoff if it exits. The car reconnects on its own after sleep or network loss. Brief interruptions can delay delivery, and rapid changes within the one-second interval can be coalesced. The timestamp in each alert comes from the vehicle telemetry record.

The app atomically saves the most recent valid destination in `.destination-state.json`, including destinations outside the radius. It treats coordinates rounded to five decimal places as identical. Clearing navigation preserves the last destination for deduplication. A different destination can be followed by a return to an earlier one. The first valid destination received can trigger an alert. The app saves the alert it's currently sending and retries it after transient ntfy failures or a restart. A crash after ntfy accepts a POST but before the local state is updated can repeat an alert. The receiver's logger is a lightweight handoff and does not provide durable end-to-end acknowledgements.

## Oracle deployment

The deployed monitor reads a host-managed log feed using `TELEMETRY_LOG_FILE=/telemetry/events.jsonl`. It reconnects to Docker logs after interruptions and resumes from the timestamp saved in `.destination-state.json`. Names are included in terminal logs and alerts when supplied by the car. Name-only updates at identical coordinates do not generate another alert.

`Dockerfile.monitor` supplies Node. The deployed container runs as an unprivileged user with all capabilities dropped and a read-only root filesystem. Application settings and the bounded telemetry log feed are mounted read-only. Only `/state` is writable for saved destination state. A host systemd service forwards receiver logs without giving the notification container access to Docker. Only the VIN, ntfy topic, target coordinates, radius, and receiver container name are needed on the server.

Alerts contain only the destination name and are sent once per matching destination change. Tap the notification to open Google Maps.

## Automatic server updates

Oracle checks the public GitHub repository's `main` branch every minute using `citydetect-update.timer`. Commit and push `index.js` and `Dockerfile.monitor` to deploy. Changes to these files trigger an image build, syntax and simulation checks, and a monitor replacement. If the replacement fails its startup check, the previous container and source are restored. The server keeps `.env` and `.destination-state.json` locally. Documentation-only pushes do not restart the monitor.

Check deployment results on Oracle with `sudo journalctl -u citydetect-update.service -n 50`. Check the schedule with `systemctl list-timers citydetect-update.timer`. Pause deployments with `sudo systemctl stop citydetect-update.timer` and resume with `sudo systemctl start citydetect-update.timer`.

The installed updater is `/usr/local/sbin/citydetect-update`, supplied by `deploy/update-monitor.sh`. Changes to the updater or its systemd units require reinstalling those files. Tesla telemetry field changes also require running the local `configure` command through the signing proxy.

## Security

Keep `.env`, tokens, private keys, and destination state outside Git. The public key under `.well-known` is intentionally public. The ntfy topic acts as a secret on the free service. GitHub Pages publishes tracked files, so commit only intended public files.

Automatic deployment trusts pushes to `main`, which execute code on the server. Restrict repository write access and enable two-factor authentication on GitHub. The updater is installed separately from the source it deploys.

The log feed is bounded by `/etc/logrotate.d/citydetect`; logs and saved destination state contain private route data and remain on Oracle.

The configure command uses Tesla’s `latest` delivery policy, independent fields, and a self-signed root CA from `TELEMETRY_CA_FILE`. The receiver presents its leaf and intermediate chain. Only destination coordinates and names are subscribed.
