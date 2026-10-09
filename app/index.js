const express = require('express');
const { Pool } = require('pg');
const { createClient } = require('redis');
const client = require('prom-client');

const PORT = process.env.PORT || 3000;
const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://app:app@localhost:5432/app';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const CACHE_TTL = Number(process.env.CACHE_TTL || 30); // seconds

const pool = new Pool({ connectionString: DATABASE_URL });
const redis = createClient({ url: REDIS_URL });
redis.on('error', (err) => console.error('redis error:', err.message));

// State used by the probes
let started = false; // set to true when init (DB + Redis + migration) is done
let shuttingDown = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const withTimeout = (promise, ms = 2000) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), ms)
    ),
  ]);

const app = express();
app.use(express.json());

// ---------- Metrics (Prometheus) ----------

const register = new client.Registry();
client.collectDefaultMetrics({ register }); // CPU, memory, event loop lag, GC...

const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

const cacheHits = new client.Counter({
  name: 'cache_hits_total',
  help: 'Number of Redis cache hits',
  registers: [register],
});

const cacheMisses = new client.Counter({
  name: 'cache_misses_total',
  help: 'Number of Redis cache misses',
  registers: [register],
});

new client.Gauge({
  name: 'app_started',
  help: '1 if initialization (DB, Redis, migration) is complete',
  registers: [register],
  collect() {
    this.set(started ? 1 : 0);
  },
});

// Measure every request; `route` is the matched pattern (low cardinality)
app.use((req, res, next) => {
  const end = httpDuration.startTimer();
  res.on('finish', () => {
    end({
      method: req.method,
      route: req.route ? req.route.path : 'unmatched',
      status_code: res.statusCode,
    });
  });
  next();
});

app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (e) {
    console.error(e);
    res.status(500).end();
  }
});

// ---------- Probes ----------

// Startup: 200 only after initialization finished.
// k8s doesn't run liveness/readiness until this succeeds.
app.get('/healthz/startup', (req, res) => {
  if (started) return res.status(200).json({ status: 'started' });
  res.status(503).json({ status: 'starting' });
});

// Liveness: the process is alive and the event loop responds.
// Deliberately does NOT check dependencies (otherwise a DB outage
// would restart all pods for no reason).
app.get('/healthz/live', (req, res) => {
  res.status(200).json({ status: 'alive' });
});

// Readiness: can we serve traffic right now? Checks Postgres and Redis.
app.get('/healthz/ready', async (req, res) => {
  if (shuttingDown) return res.status(503).json({ status: 'shutting_down' });
  if (!started) return res.status(503).json({ status: 'starting' });

  const checks = { postgres: 'ok', redis: 'ok' };
  await Promise.all([
    withTimeout(pool.query('SELECT 1')).catch(() => (checks.postgres = 'fail')),
    withTimeout(redis.ping()).catch(() => (checks.redis = 'fail')),
  ]);

  const ready = Object.values(checks).every((v) => v === 'ok');
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', checks });
});

// ---------- Business logic ----------

app.get('/', (req, res) => {
  res.json({ message: 'Hello from devops-pet-app', time: new Date().toISOString() });
});

// List todos (cached in Redis)
app.get('/todos', async (req, res) => {
  try {
    try {
      const cached = await redis.get('todos');
      if (cached) {
        cacheHits.inc();
        res.set('X-Cache', 'HIT');
        return res.json(JSON.parse(cached));
      }
    } catch (e) {
      console.error('cache read failed:', e.message); // cache is optional
    }

    const { rows } = await pool.query(
      'SELECT id, title, done, created_at FROM todos ORDER BY id DESC'
    );

    try {
      await redis.set('todos', JSON.stringify(rows), { EX: CACHE_TTL });
    } catch (e) {
      console.error('cache write failed:', e.message);
    }

    cacheMisses.inc();
    res.set('X-Cache', 'MISS');
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal error' });
  }
});

// Create todo (invalidates cache)
app.post('/todos', async (req, res) => {
  const title = (req.body && req.body.title || '').toString().trim();
  if (!title) return res.status(400).json({ error: 'title is required' });

  try {
    const { rows } = await pool.query(
      'INSERT INTO todos (title) VALUES ($1) RETURNING id, title, done, created_at',
      [title]
    );
    await redis.del('todos').catch(() => {});
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal error' });
  }
});

// ---------- Init & lifecycle ----------

async function init() {
  // Retry: in k8s/compose dependencies may come up after the app
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      await redis.connect();
      await pool.query(`
        CREATE TABLE IF NOT EXISTS todos (
          id SERIAL PRIMARY KEY,
          title TEXT NOT NULL,
          done BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      started = true;
      console.log('initialization complete');
      return;
    } catch (e) {
      console.error(`init attempt ${attempt} failed: ${e.message}`);
      if (attempt >= 30) {
        console.error('giving up');
        process.exit(1);
      }
      await sleep(2000);
    }
  }
}

const server = app.listen(PORT, () => {
  console.log(`listening on :${PORT}`);
  init();
});

async function shutdown(signal) {
  if (shuttingDown) return;
  console.log(`${signal} received, shutting down`);
  shuttingDown = true; // readiness starts returning 503
  await sleep(Number(process.env.SHUTDOWN_DELAY_MS || 3000)); // let LB drain
  server.close(async () => {
    await Promise.allSettled([pool.end(), redis.quit()]);
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
