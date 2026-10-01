const http = require('node:http');

const STATUSES = ['pending', 'confirmed', 'cancelled'];
// Tie-break when two events carry the identical sent_at: the further-along status wins.
const STATUS_RANK = { pending: 0, confirmed: 1, cancelled: 2 };

function createStore() {
  return {
    bookings: new Map(), // booking_id -> current state
    processed: new Set(), // dedupe keys of events already handled
    log: [], // one entry per state change actually applied (the "exactly once" side effect)
  };
}

function validate(body) {
  if (!body || typeof body !== 'object') return 'body must be a JSON object';
  for (const field of ['booking_id', 'property_id', 'status', 'sent_at']) {
    if (typeof body[field] !== 'string' || body[field] === '') return `${field} is required`;
  }
  if (!STATUSES.includes(body.status)) return `status must be one of ${STATUSES.join(', ')}`;
  if (Number.isNaN(Date.parse(body.sent_at))) return 'sent_at must be an ISO-8601 timestamp';
  return null;
}

// Returns true if event `a` should supersede event `b`.
function isNewer(a, b) {
  const ta = Date.parse(a.sent_at);
  const tb = Date.parse(b.sent_at);
  if (ta !== tb) return ta > tb;
  return STATUS_RANK[a.status] > STATUS_RANK[b.status];
}

// Core logic, kept free of HTTP so it is easy to reason about.
// Node runs this synchronously on one thread, so check-then-write cannot interleave.
function handleEvent(store, event) {
  const key = `${event.booking_id}|${event.status}|${Date.parse(event.sent_at)}`;
  if (store.processed.has(key)) return { result: 'duplicate' };
  store.processed.add(key);

  const current = store.bookings.get(event.booking_id);
  if (current && !isNewer(event, current)) return { result: 'stale', current };

  const next = {
    booking_id: event.booking_id,
    property_id: event.property_id,
    status: event.status,
    sent_at: event.sent_at,
  };
  store.bookings.set(event.booking_id, next);
  store.log.push({ ...next, previous_status: current ? current.status : null });
  return { result: 'applied', current: next };
}

function send(res, code, payload) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function createServer(store = createStore()) {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/webhooks/bookings') {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          return send(res, 400, { error: 'invalid JSON' });
        }
        const error = validate(body);
        if (error) return send(res, 400, { error });
        // Duplicates and stale events still get 200 so the sender stops retrying.
        send(res, 200, handleEvent(store, body));
      });
      return;
    }

    const match = req.method === 'GET' && req.url.match(/^\/bookings\/([^/]+)$/);
    if (match) {
      const booking = store.bookings.get(decodeURIComponent(match[1]));
      return booking ? send(res, 200, booking) : send(res, 404, { error: 'not found' });
    }

    send(res, 404, { error: 'not found' });
  });
  server.store = store;
  return server;
}

module.exports = { createServer, createStore, handleEvent };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createServer().listen(port, () => console.log(`listening on http://localhost:${port}`));
}
