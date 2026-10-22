'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { createLogger, format, transports, Transport } = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const { resolveConfig } = require('./config');
const context = require('./context');
const redact = require('./redact');

const LEVELS = { error: 0, warning: 1, info: 2, debug: 3 };

// Keys owned by the logger. A caller-supplied key with one of these names is renamed to
// `<key>_field` (logging standard §1.4). `event` is the exception: callers may set it, as long as
// it is a snake_case identifier.
const COLLISION_KEYS = new Set([
  'timestamp',
  'level',
  'logger',
  'service',
  'environment',
  'message',
]);
const EVENT_PATTERN = /^[a-z][a-z0-9_]*$/;
const MAX_EVENT_LENGTH = 64;

const config = resolveConfig();

// Set once the transports are being flushed for exit; later records are dropped.
let flushing;

/**
 * Convert free text into a snake_case event identifier.
 */
const snakeCase = (value) => {
  const result = String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_EVENT_LENGTH)
    .replace(/_+$/, '');
  return /^[a-z]/.test(result) ? result : result ? `event_${result}` : 'log_event';
};

const isError = (value) =>
  value instanceof Error ||
  (value !== null &&
    typeof value === 'object' &&
    typeof value.message === 'string' &&
    typeof value.stack === 'string');

// Requests are never logged as data; they only serve as a context source.
const isRequestLike = (value) =>
  value instanceof http.IncomingMessage ||
  value instanceof http.ServerResponse ||
  (value !== null &&
    typeof value === 'object' &&
    typeof value.method === 'string' &&
    typeof value.url === 'string' &&
    typeof value.headers === 'object');

const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * Split the arguments of a log call into fields, an error and a request (context source).
 * Supports the structured form `(message, fields)` as well as legacy positional arguments.
 */
const parseArguments = (message, args) => {
  const fields = {};
  const extra = [];
  let error;
  let req;

  const consume = (arg) => {
    if (arg === undefined) {
      return;
    }
    if (isError(arg)) {
      if (!error) {
        error = arg;
      } else {
        extra.push(arg);
      }
    } else if (isRequestLike(arg)) {
      req = req || arg;
    } else if (isPlainObject(arg)) {
      Object.assign(fields, arg);
    } else {
      extra.push(arg);
    }
  };

  if (typeof message !== 'string') {
    consume(message);
    message = error && !extra.length ? error.message : undefined;
  }
  args.forEach(consume);

  if (extra.length) {
    fields.args = extra;
  }
  return { message, fields, error, req };
};

/**
 * Build a log record.
 *
 * @param {string} level - The winston level.
 * @param {string} name - The logger name.
 * @param {*} rawMessage - The message, or a legacy first argument.
 * @param {Array} args - The remaining arguments.
 * @param {Object} store - An explicit request context (used by the access log).
 * @return {Object} The ordered, sanitized record.
 */
const buildRecord = (level, name, rawMessage, args, store) => {
  const { message, fields, error, req } = parseArguments(rawMessage, args);

  const caller = {};
  let event;
  for (const [
    key,
    value,
  ] of Object.entries(fields)) {
    if (key === 'event' && typeof value === 'string' && EVENT_PATTERN.test(value)) {
      event = value;
    } else if (COLLISION_KEYS.has(key) || key === 'event') {
      caller[`${key}_field`] = value;
    } else {
      caller[key] = value;
    }
  }

  if (error) {
    if (caller.error === undefined) {
      caller.error = redact.describeError(error);
    }
    if (level === 'error' && caller.exception === undefined) {
      caller.exception = error.stack || redact.describeError(error);
    }
  }

  const contextFields = context.getContextFields(
    store || context.getStore() || context.fromRequest(req),
  );
  const text = message || (error && error.message) || event || 'Log event';

  const record = {
    timestamp: new Date().toISOString(),
    level,
    logger: name,
    service: config.service,
    environment: config.environment,
  };
  for (const [
    key,
    value,
  ] of Object.entries(contextFields)) {
    if (value !== undefined) {
      record[key] = value;
    }
  }
  record.event = event || snakeCase(text);
  record.message = text;

  // Explicit tenant_id / ip_address passed by the caller override the context defaults.
  return Object.assign(record, redact.sanitizeFields(caller), {
    message: redact.sanitizeValue(text),
  });
};

// Formats.
const standardLevel = format((info) => {
  info.level = String(info.level).toUpperCase();
  return info;
});

// Keep insertion order so the standard fields lead each record.
const jsonFormat = format.json({ deterministic: false });

const CONSOLE_HIDDEN_KEYS = new Set([
  'timestamp',
  'level',
  'logger',
  'service',
  'environment',
  'message',
  'exception',
]);
const consoleFormat = format.printf((info) => {
  const extras = Object.keys(info)
    .filter((key) => !CONSOLE_HIDDEN_KEYS.has(key) && info[key] !== undefined)
    .map((key) => {
      const value = info[key];
      return `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`;
    });
  const line = `${info.timestamp} ${info.level.padEnd(7)} [${info.logger}] ${info.message}`;
  const details = extras.length ? ` ${extras.join(' ')}` : '';
  return `${line}${details}${info.exception ? `\n${info.exception}` : ''}`;
});

const consoleTransport = new transports.Console({
  level: config.level,
  silent: config.silent,
  format: config.format === 'json' ? jsonFormat : consoleFormat,
});

const root = createLogger({
  levels: LEVELS,
  level: config.level,
  format: standardLevel(),
  transports: [
    consoleTransport,
  ],
  exitOnError: false,
});

/**
 * Move a zipped log file into the archive folder and cap the archive at the backup count.
 */
const archiveFile = async (file) => {
  const { archiveDirname, backupCount } = config.file;
  try {
    await fs.promises.mkdir(archiveDirname, { recursive: true });
    await fs.promises.rename(file, path.join(archiveDirname, path.basename(file)));
    if (backupCount > 0) {
      const archived = (await fs.promises.readdir(archiveDirname)).sort();
      const expired = archived.slice(0, Math.max(0, archived.length - backupCount));
      await Promise.all(expired.map((name) => fs.promises.unlink(path.join(archiveDirname, name))));
    }
  } catch (err) {
    root.log(
      buildRecord('warning', 'formio:logging', 'Failed to archive log file', [
        err,
        { file },
      ]),
    );
  }
};

if (config.file.enabled) {
  const { dirname, filename, datePattern, maxBytes, backupCount } = config.file;
  const fileTransport = new DailyRotateFile({
    dirname,
    filename,
    datePattern,
    zippedArchive: true,
    maxSize: maxBytes > 0 ? `${Math.ceil(maxBytes / 1024)}k` : null,
    maxFiles: backupCount > 0 ? backupCount : null,
    level: config.level,
    format: jsonFormat,
  });
  fileTransport.on('archive', archiveFile);
  root.add(fileTransport);
}

/**
 * A named logger. Every record carries the standard fields plus the active request context.
 */
class Logger {
  constructor(name) {
    this.name = name;
  }

  isLevelEnabled(level) {
    return root.isLevelEnabled(level);
  }

  log(level, message, ...args) {
    this.write(level, message, args);
  }

  debug(message, ...args) {
    this.write('debug', message, args);
  }

  info(message, ...args) {
    this.write('info', message, args);
  }

  warning(message, ...args) {
    this.write('warning', message, args);
  }

  warn(message, ...args) {
    this.write('warning', message, args);
  }

  error(message, ...args) {
    this.write('error', message, args);
  }

  /**
   * Log an unexpected failure at ERROR with its stack trace in `exception`.
   */
  exception(message, err, fields) {
    this.write('error', message, [
      err,
      fields,
    ]);
  }

  /**
   * Write a record. `store` is an explicit request context for records emitted outside the
   * AsyncLocalStorage scope (e.g. the access log on response finish).
   */
  write(level, message, args = [], store) {
    const normalized = LEVELS[level] === undefined ? String(level).toLowerCase() : level;
    if (flushing || LEVELS[normalized] === undefined || !root.isLevelEnabled(normalized)) {
      return;
    }
    root.log(buildRecord(normalized, this.name, message, args, store));
  }
}

const loggers = new Map();

/**
 * Returns the (cached) logger with the given name.
 */
const getLogger = (name = 'formio') => {
  if (!loggers.has(name)) {
    loggers.set(name, new Logger(name));
  }
  return loggers.get(name);
};

config.warnings.forEach(({ field, value, fallback }) =>
  getLogger('formio:logging').warning('Invalid logging configuration value', {
    event: 'logging_config_invalid',
    field: field.toLowerCase(),
    value,
    fallback,
  }),
);

/**
 * Flush all transports, e.g. before the process exits.
 */
const flush = (timeout = 2000) => {
  flushing =
    flushing ||
    new Promise((resolve) => {
      const timer = setTimeout(resolve, timeout);
      root.on('finish', () => {
        clearTimeout(timer);
        setImmediate(resolve);
      });
      root.end();
    });
  return flushing;
};

/**
 * An in-memory transport that captures records (used by the test suite).
 */
class CaptureTransport extends Transport {
  constructor() {
    super({ level: 'debug' });
    this.records = [];
  }

  log(info, callback) {
    this.records.push(JSON.parse(JSON.stringify(info)));
    callback();
  }

  clear() {
    this.records = [];
  }
}

let previousLevel;
const addCaptureTransport = () => {
  const capture = new CaptureTransport();
  previousLevel = previousLevel || root.level;
  root.level = 'debug';
  root.add(capture);
  return capture;
};

const removeCaptureTransport = (capture) => {
  root.remove(capture);
  if (!root.transports.some((transport) => transport instanceof CaptureTransport)) {
    root.level = previousLevel || config.level;
    previousLevel = undefined;
  }
};

module.exports = {
  LEVELS,
  config,
  context,
  redact,
  maskEmail: redact.maskEmail,
  snakeCase,
  buildRecord,
  getLogger,
  flush,
  addCaptureTransport,
  removeCaptureTransport,
};
