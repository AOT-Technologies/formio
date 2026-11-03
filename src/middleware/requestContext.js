'use strict';

const crypto = require('crypto');
const net = require('net');
const proxyaddr = require('proxy-addr');
const logging = require('../util/logger');

const { context } = logging;
// Set by TRUSTED_PROXIES; null keeps the logging standard's header order (§3.2).
const trustedProxies = logging.config.trustedProxies
  ? proxyaddr.compile(logging.config.trustedProxies)
  : null;
const accessLogger = logging.getLogger('formio:access');
const errorLogger = logging.getLogger('formio:error');

// Health and probe endpoints log their access records at DEBUG (logging standard §4).
const HEALTH_PATH = /^\/(?:health(?:\/.*)?|healthz|ping|checkpoint|actuator\/health(?:\/.*)?)\/?$/;

const EXPOSE_HEADERS = 'Access-Control-Expose-Headers';

/**
 * Parse a client address from a header value, dropping a port (`1.2.3.4:80`, `[::1]:443`).
 * Returns undefined when the value is not an IP address.
 */
const parseIp = (value) => {
  let address = String(value || '').trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(address);
  if (bracketed) {
    address = bracketed[1];
  } else if (/^[\d.]+:\d+$/.test(address)) {
    address = address.slice(0, address.lastIndexOf(':'));
  }
  return net.isIP(address) ? address : undefined;
};

/**
 * Resolve the client IP: X-Forwarded-For (first entry), X-Real-IP, then the socket address.
 * Header values are used only when they are valid IP addresses.
 *
 * With trusted proxies, X-Forwarded-For is walked from the socket peer and the nearest untrusted
 * hop wins, so a client cannot choose its own address; X-Real-IP counts only from a trusted peer.
 */
const getClientIp = (req, trust = trustedProxies) => {
  const peer = req.socket && req.socket.remoteAddress;
  if (trust) {
    if (!req.headers['x-forwarded-for'] && peer && trust(peer, 0)) {
      return parseIp(req.headers['x-real-ip']) || peer;
    }
    return parseIp(proxyaddr(req, trust)) || peer || 'unknown';
  }
  const forwarded = req.headers['x-forwarded-for'];
  const first = forwarded && parseIp(String(forwarded).split(',')[0]);
  if (first) {
    return first;
  }
  const realIp = parseIp(req.headers['x-real-ip']);
  if (realIp) {
    return realIp;
  }
  return peer || 'unknown';
};

const getRequestId = (req) => {
  const requestId = req.get(context.REQUEST_ID_HEADER);
  return requestId && context.REQUEST_ID_PATTERN.test(requestId) ? requestId : crypto.randomUUID();
};

/**
 * Add a header name to Access-Control-Expose-Headers without dropping existing entries.
 */
const appendExposeHeaders = (res, value) => {
  const existing = String(res.getHeader(EXPOSE_HEADERS) || '')
    .split(',')
    .map((header) => header.trim())
    .filter(Boolean);
  const additions = String(value || '')
    .split(',')
    .map((header) => header.trim())
    .filter(Boolean);
  const merged = existing.slice();
  additions.forEach((header) => {
    if (!merged.some((current) => current.toLowerCase() === header.toLowerCase())) {
      merged.push(header);
    }
  });
  if (merged.length) {
    res.setHeader(EXPOSE_HEADERS, merged.join(', '));
  }
};

/**
 * Establish the request context (X-Request-ID, client IP, path) and emit exactly one access
 * record per request. Must be the outermost middleware.
 */
const requestContext = (req, res, next) => {
  const start = process.hrtime.bigint();
  const store = {
    request_id: getRequestId(req),
    http_method: String(req.method).toUpperCase(),
    http_path: (req.originalUrl || req.url || '').split('?')[0],
    ip_address: getClientIp(req),
    req,
    failed: null,
  };
  req[context.CONTEXT] = store;

  res.setHeader(context.REQUEST_ID_HEADER, store.request_id);
  appendExposeHeaders(res, context.REQUEST_ID_HEADER);

  let logged = false;
  const logAccess = (closedEarly) => {
    if (logged) {
      return;
    }
    logged = true;
    // A server failure is never reported as a client disconnect, even if the socket was destroyed.
    const clientDisconnected = closedEarly && !store.failed;
    const fields = {
      status_code: clientDisconnected ? 499 : res.statusCode,
      duration_ms: Math.round(Number(process.hrtime.bigint() - start) / 1e4) / 100,
    };
    if (req.route && req.route.path) {
      fields.http_route = String(req.route.path);
    }
    if (clientDisconnected) {
      fields.client_disconnected = true;
    }
    if (store.failed) {
      accessLogger.write(
        'error',
        'HTTP request failed',
        [
          { ...fields, event: 'http_request_failed', status_code: 500, error: store.failed },
        ],
        store,
      );
      return;
    }
    accessLogger.write(
      HEALTH_PATH.test(store.http_path) ? 'debug' : 'info',
      'HTTP request finished',
      [
        { ...fields, event: 'http_request_finished' },
      ],
      store,
    );
  };

  res.on('finish', () => logAccess(false));
  res.on('close', () => logAccess(!res.writableFinished));

  context.run(store, next);
};

/**
 * Re-enter the request context. Stream events (e.g. body parsing) can resume outside the
 * AsyncLocalStorage scope, so this is mounted after the body parsers.
 */
const bindRequestContext = (req, res, next) => {
  const store = context.fromRequest(req);
  if (store && context.getStore() !== store) {
    return context.run(store, next);
  }
  return next();
};

/**
 * Mark the current request as failed with an unhandled exception (logged on the access record).
 */
const markFailed = (req, err) => {
  const store = context.fromRequest(req) || context.getStore();
  if (store) {
    store.failed = logging.redact.describeError(err);
  }
};

/**
 * Final error handler: client errors keep their status, anything else is logged as an unhandled
 * exception and answered with a generic 500 (the X-Request-ID header is already set).
 * Express recognizes error handlers by their four parameters, so the unused `_next` must stay.
 */
const errorHandler = (err, req, res, _next) => {
  const error = err instanceof Error ? err : new Error(String(err));
  if (res.headersSent) {
    markFailed(req, error);
    errorLogger.exception('Unhandled exception', error, { event: 'unhandled_exception' });
    // Close the connection like Express's final handler, without its unredacted stderr stack.
    if (req.socket) {
      req.socket.destroy();
    }
    return;
  }
  const status = Number(err && (err.status || err.statusCode));
  if (status >= 400 && status < 500) {
    errorLogger.warning('Request rejected', {
      event: 'http_request_rejected',
      status_code: status,
      error: logging.redact.describeError(error),
    });
    return res.status(status).json({ message: error.message });
  }
  markFailed(req, error);
  errorLogger.exception('Unhandled exception', error, { event: 'unhandled_exception' });
  return res.status(500).json({ message: 'Internal Server Error' });
};

module.exports = {
  requestContext,
  bindRequestContext,
  errorHandler,
  markFailed,
  appendExposeHeaders,
  getClientIp,
  HEALTH_PATH,
};
