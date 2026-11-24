import { spawn } from 'node:child_process';
import { randomBytes, X509Certificate } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createInterface as promptInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';

const env = process.env;
const tokenFile = '.tesla-tokens.json';
const destinationStateFile = env.STATE_FILE || '.destination-state.json';
const tokenUrl = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
const scope = 'openid offline_access vehicle_device_data vehicle_location';
const configPath = '/api/1/vehicles/fleet_telemetry_config';

function required(name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Set ${name} in .env.`);
  return value;
}

function fleetUrl() {
  const region = env.TESLA_REGION || 'na';
  if (!['na', 'eu'].includes(region)) throw new Error('TESLA_REGION must be na or eu.');
  return `https://fleet-api.prd.${region}.vn.cloud.tesla.com`;
}

function vehicleVin() {
  const vin = required('TESLA_VIN').toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) throw new Error('TESLA_VIN must be a 17-character VIN.');
  return vin;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function saveJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
  await rename(temporary, file);
}

function request(url, options = {}) {
  return fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000), ...options });
}

async function exchangeToken(params) {
  const response = await request(tokenUrl, {
    method: 'POST',
    body: new URLSearchParams({ client_id: required('TESLA_CLIENT_ID'), ...params }),
  });
  const token = await response.json().catch(() => ({}));
  if (!response.ok || !token.access_token) {
    if (response.status === 401 || token.error === 'invalid_grant') {
      throw new Error('Tesla rejected authentication. Check your app credentials and run npm run tesla -- auth again.');
    }
    const code = /^[a-z_]+$/.test(token.error) ? ` ${token.error}` : '';
    throw new Error(`Tesla token exchange failed (HTTP ${response.status}${code}).`);
  }
  return token;
}

async function saveToken(token) {
  if (!token.refresh_token || !Number.isFinite(token.expires_in)) {
    throw new Error('Tesla did not return a refresh token and expiry. Run auth again with all requested scopes.');
  }
  const saved = { ...token, expiresAt: Date.now() + token.expires_in * 1000 };
  await saveJson(tokenFile, saved);
  return saved.access_token;
}

async function authorize() {
  const redirect = new URL(required('TESLA_REDIRECT_URI'));
  if (redirect.protocol !== 'https:' || redirect.search || redirect.hash) {
    throw new Error('Use a registered HTTPS redirect URI without a query or fragment.');
  }
  const state = randomBytes(32).toString('hex');
  const url = new URL('https://auth.tesla.com/oauth2/v3/authorize');
  url.search = new URLSearchParams({
    client_id: required('TESLA_CLIENT_ID'),
    redirect_uri: redirect.href,
    response_type: 'code',
    scope,
    state,
    prompt_missing_scopes: 'true',
    require_requested_scopes: 'true',
  });
  console.log(`Open this URL in your browser:\n${url.href}\n`);
  const prompt = promptInterface({ input: process.stdin, output: process.stdout });
  try {
    const callback = new URL((await prompt.question('Paste the full redirected URL: ')).trim());
    if (callback.origin !== redirect.origin || callback.pathname !== redirect.pathname ||
        callback.searchParams.get('state') !== state) {
      throw new Error('OAuth callback URL or state did not match. Run auth again.');
    }
    const code = callback.searchParams.get('code');
    if (!code) throw new Error('Tesla did not return an authorization code. Approve all requested scopes.');
    await saveToken(await exchangeToken({
      grant_type: 'authorization_code',
      client_secret: required('TESLA_CLIENT_SECRET'),
      audience: fleetUrl(),
      redirect_uri: redirect.href,
      code,
    }));
    console.log('Tesla authorization saved.');
  } finally {
    prompt.close();
  }
}

async function accessToken(forceRefresh) {
  const saved = await readJson(tokenFile, null);
  if (!saved?.refresh_token) throw new Error('Run npm run tesla -- auth first.');
  if (!forceRefresh && saved.expiresAt > Date.now() + 60_000) return saved.access_token;
  return saveToken(await exchangeToken({
    grant_type: 'refresh_token',
    refresh_token: saved.refresh_token,
  }));
}

async function fleetRequest(url, body) {
  const send = async (refresh) => request(url, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${await accessToken(refresh)}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  let response = await send(false);
  if (response.status === 401) {
    await response.body?.cancel();
    response = await send(true);
  }
  if (response.status === 401) throw new Error('Tesla rejected the refreshed token. Run npm run tesla -- auth again.');
  return response;
}

async function register() {
  const domain = required('TESLA_APP_DOMAIN');
  const token = await exchangeToken({
    grant_type: 'client_credentials',
    client_secret: required('TESLA_CLIENT_SECRET'),
    audience: fleetUrl(),
  });
  const response = await request(`${fleetUrl()}/api/1/partner_accounts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain }),
  });
  if (!response.ok) throw new Error(`Tesla registration failed (HTTP ${response.status}). Check the app domain and hosted public key.`);
  await response.body?.cancel();
  console.log('Tesla app registered for this region.');
}

async function configure() {
  const port = Number(env.TELEMETRY_PORT || 443);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid TELEMETRY_PORT.');
  const certificates = (await readFile(required('TELEMETRY_CA_FILE'), 'utf8'))
    .match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
  const roots = certificates.filter((pem) => {
    const certificate = new X509Certificate(pem);
    return certificate.ca && certificate.subject === certificate.issuer;
  });
  if (!roots.length) throw new Error('TELEMETRY_CA_FILE must contain the self-signed root CA.');
  const response = await fleetRequest(`https://localhost:4443${configPath}`, {
    vins: [vehicleVin()],
    config: {
      hostname: required('TELEMETRY_HOST'),
      port,
      delivery_policy: 'latest',
      ca: roots.join('\n') + '\n',
      fields: {
        DestinationLocation: { interval_seconds: 1 },
        DestinationName: { interval_seconds: 1 },
      },
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Tesla configuration failed (HTTP ${response.status}). ${data.error || 'Check the proxy and Fleet API setup.'}`);
  }
  const result = data.response;
  if (result?.updated_vehicles !== 1) {
    throw new Error(`Tesla did not confirm one updated vehicle. Response: ${JSON.stringify(result)}`);
  }
  console.log('Telemetry configuration submitted. Run npm run tesla -- status to check sync.');
}

async function status() {
  const response = await fleetRequest(`${fleetUrl()}/api/1/vehicles/${vehicleVin()}/fleet_telemetry_config`);
  if (!response.ok) throw new Error(`Tesla configuration status failed (HTTP ${response.status}).`);
  console.log(JSON.stringify((await response.json()).response, null, 2));
}

function validPoint(point) {
  return Number.isFinite(point?.latitude) && Math.abs(point.latitude) <= 90 &&
    Number.isFinite(point.longitude) && Math.abs(point.longitude) <= 180;
}

function distanceMiles(a, b) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const h = Math.sin(radians(b.latitude - a.latitude) / 2) ** 2 +
    Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) *
    Math.sin(radians(b.longitude - a.longitude) / 2) ** 2;
  return 3958.76 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}

function ntfyTopic() {
  const topic = required('NTFY_TOPIC');
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(topic)) throw new Error('Invalid NTFY_TOPIC.');
  return topic;
}

async function publish(topic, { body, map }, signal) {
  const headers = { Title: 'Tesla Alert', Tags: 'car' };
  if (map) headers.Click = map;
  const timeout = AbortSignal.timeout(15000);
  const response = await request(`https://ntfy.sh/${topic}`, {
    method: 'POST', headers, body,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  await response.body?.cancel();
  if (!response.ok) {
    const error = new Error(`ntfy returned HTTP ${response.status}.`);
    error.retryable = response.status === 429 || response.status >= 500;
    throw error;
  }
}

async function createMonitor({ vin, topic, stateFile, signal }) {
  const target = {
    latitude: Number(env.TARGET_LATITUDE || 33.7720257),
    longitude: Number(env.TARGET_LONGITUDE || -84.2530775),
  };
  const radius = Number(env.RADIUS_MILES || 2);
  const name = env.TARGET_NAME || 'Kensington station';
  const nameMatches = (env.DESTINATION_NAME_MATCH ?? 'kensington,flat shoals,cedar crest')
    .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (!validPoint(target) || !Number.isFinite(radius) || radius < 0) {
    throw new Error('Set valid target coordinates and a nonnegative RADIUS_MILES.');
  }
  const saved = stateFile ? await readJson(stateFile, {}) : {};
  let state = saved.vin === vin ? saved : { vin };
  const persist = async (next) => {
    if (stateFile) await saveJson(stateFile, next);
    state = next;
  };

  async function deliverPending() {
    if (!state.pending) return;
    if (topic) {
      let wait = 2000;
      for (;;) {
        try {
          await publish(topic, state.pending, signal);
          break;
        } catch (error) {
          if (signal?.aborted || error.retryable === false || !stateFile) throw error;
          console.warn(`Notification failed (${error.message}). Retrying in ${wait / 1000}s.`);
          await delay(wait, undefined, { signal });
          wait = Math.min(wait * 2, 60_000);
        }
      }
      console.log('Notification sent.');
    } else {
      console.log(`[dry run]\n${state.pending.body}`);
    }
    const { pending, ...delivered } = state;
    await persist(delivered);
  }

  await deliverPending();
  return async (record) => {
    if (record?.msg !== 'record_payload' || record.vin !== vin) return;
    const data = record.data;
    if (typeof data?.Status === 'string') console.log(`Telemetry connectivity: ${data.Status}`);
    const destination = data?.DestinationLocation ?? state.destination;
    const timestamp = Date.parse(data?.CreatedAt);
    if (!Number.isFinite(timestamp) || timestamp < state.timestamp) return;

    if (destination === '<invalid>') {
      if (state.active !== false) console.log('Navigation destination cleared.');
      await persist({ ...state, timestamp, active: false, destination: null, milesRemaining: null, minutesRemaining: null, awaitingEstimate: false });
      return;
    }
    if (!validPoint(destination)) return;

    const { latitude, longitude } = destination;
    const key = `${latitude.toFixed(5)},${longitude.toFixed(5)}`;
    const destinationName = typeof data.DestinationName === 'string' && data.DestinationName !== '<invalid>'
      ? data.DestinationName : key === state.key ? state.destinationName : undefined;
    const sameDestination = key === state.key && (destinationName || '').toLowerCase() === (state.destinationName || '').toLowerCase();
    const next = { ...state, timestamp, active: true, key, destination, destinationName };
    if (sameDestination) {
      console.log('Repeated destination skipped.');
      await persist(next);
      return;
    }

    const distance = distanceMiles(target, destination);
    const when = new Date(timestamp).toISOString();
    console.log(`${when} Destination ${destinationName || key} is ${distance.toFixed(2)} miles from ${name}.`);
    const matchesName = nameMatches.some((value) => destinationName?.toLowerCase().includes(value));
    if (matchesName || distance <= radius) {
      const coordinates = `${latitude},${longitude}`;
      const map = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(coordinates)}`;
      const body = destinationName || 'Navigation destination';
      next.pending = { body, map };
    }
    await persist(next);
    await deliverPending();
  };
}

async function monitor() {
  const vin = vehicleVin();
  const topic = ntfyTopic();
  const binary = env.TELEMETRY_BIN || 'fleet-telemetry';
  const config = env.TELEMETRY_CONFIG || 'telemetry-server.json';
  if (!env.TELEMETRY_CONTAINER && !env.TELEMETRY_LOG_FILE) await readFile(config);
  const stop = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop.abort());
  const handleRecord = await createMonitor({ vin, topic, stateFile: destinationStateFile, signal: stop.signal });

  let wait = 2000;
  while (!stop.signal.aborted) {
    const started = Date.now();
    const checkpoint = await readJson(destinationStateFile, {});
    const since = checkpoint.vin === vin && Number.isFinite(checkpoint.timestamp)
      ? new Date(checkpoint.timestamp - 1000).toISOString() : new Date(Date.now() - 1000).toISOString();
    const command = env.TELEMETRY_LOG_FILE ? 'tail' : env.TELEMETRY_CONTAINER ? 'docker' : binary;
    const args = env.TELEMETRY_LOG_FILE
      ? ['-n', '+1', '-F', required('TELEMETRY_LOG_FILE')]
      : env.TELEMETRY_CONTAINER
      ? ['logs', '--follow', '--since', since, env.TELEMETRY_CONTAINER] : [`-config=${config}`];
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: stop.signal,
    });
    const closed = new Promise((resolve) => child.once('close', resolve));
    let failure;
    child.on('error', (error) => { failure ??= error; });

    // Read both streams because the receiver's logging destination can vary.
    let queue = Promise.resolve();
    for (const input of [child.stdout, child.stderr]) {
      const lines = createInterface({ input, crlfDelay: Infinity });
      lines.on('line', (line) => {
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          console.error(line);
          return;
        }
        if (record?.msg !== 'record_payload') {
          if (record?.msg) console.error(line);
          return;
        }
        queue = queue.then(async () => {
          if (!failure && !stop.signal.aborted) await handleRecord(record);
        }).catch((error) => {
          failure = error;
          child.kill();
        });
      });
    }

    console.log('Waiting for Tesla Fleet Telemetry.');
    const code = await closed;
    await queue;
    if (stop.signal.aborted) return;
    if (failure) throw failure;
    if (Date.now() - started > 60_000) wait = 2000;
    console.warn(`Fleet Telemetry exited (${code}). Restarting in ${wait / 1000}s.`);
    await delay(wait, undefined, { signal: stop.signal });
    wait = Math.min(wait * 2, 60_000);
  }
}

async function simulate(send) {
  const vin = 'SIMULATED';
  const handleRecord = await createMonitor({ vin, topic: send ? ntfyTopic() : null });
  const near = { latitude: 33.7720257, longitude: -84.2530775 };
  const far = { latitude: 32.08, longitude: -81.09 };
  for (const destination of [near, near, '<invalid>', near, far, near]) {
    await handleRecord({
      msg: 'record_payload',
      vin,
      data: { DestinationLocation: destination, DestinationName: 'Simulated destination', MilesToArrival: 12.3, MinutesToArrival: 19, CreatedAt: new Date().toISOString() },
    });
  }
}

async function main() {
  const [, , command = 'monitor', option] = process.argv;
  switch (command) {
    case 'monitor': return monitor();
    case 'simulate': return simulate(option === '--send');
    case 'test-ntfy':
      await publish(ntfyTopic(), { body: 'Test notification from Tesla Alert.' });
      console.log('Test notification sent.');
      return;
    case 'topic': console.log(`tesla-nav-${randomBytes(24).toString('hex')}`); return;
    case 'register': return register();
    case 'auth': return authorize();
    case 'configure': return configure();
    case 'status': return status();
    default: throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  if (error.name === 'AbortError') return;
  console.error(error.message);
  process.exitCode = 1;
});
