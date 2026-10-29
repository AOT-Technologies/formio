'use strict';

const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

// The request context is also attached to the request object so it can be recovered when an
// async boundary (stream events, driver callbacks) loses the AsyncLocalStorage store.
const CONTEXT = Symbol.for('formsflow.logging.context');

const REQUEST_ID_HEADER = 'X-Request-ID';
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

const getStore = () => storage.getStore();

/**
 * Run a function within the given request context.
 */
const run = (store, fn) => storage.run(store, fn);

/**
 * Returns the context store attached to a request, if any.
 */
const fromRequest = (req) => (req && req[CONTEXT]) || undefined;

/**
 * Resolve the context fields for a log record.
 *
 * @param {Object} store - An explicit context store; defaults to the active one.
 * @return {Object} The request-scoped fields, or the background defaults outside a request.
 */
const getContextFields = (store = getStore()) => {
  if (!store) {
    return { tenant_id: 'default', ip_address: 'system' };
  }
  const token = store.req && store.req.token;
  return {
    tenant_id: (token && token.tenantKey) || 'default',
    ip_address: store.ip_address,
    request_id: store.request_id,
    http_method: store.http_method,
    http_path: store.http_path,
  };
};

/**
 * Add the current request id to a set of outbound HTTP headers.
 *
 * @param {Object} headers - The outbound headers.
 * @return {Object} The headers, with X-Request-ID set when a request context is active.
 */
const outboundHeaders = (headers = {}) => {
  const store = getStore();
  if (store && store.request_id) {
    headers[REQUEST_ID_HEADER] = store.request_id;
  }
  return headers;
};

module.exports = {
  CONTEXT,
  REQUEST_ID_HEADER,
  REQUEST_ID_PATTERN,
  storage,
  getStore,
  run,
  fromRequest,
  getContextFields,
  outboundHeaders,
};
