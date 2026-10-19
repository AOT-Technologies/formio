'use strict';

const path = require('path');

const DEFAULT_SERVICE_NAME = 'forms-flow-forms';
const DEFAULT_FILE_NAME = 'formio.log';
const DEFAULT_MAX_BYTES = 10485760;
const DEFAULT_BACKUP_COUNT = 30;

// Standard level names (and common platform equivalents) mapped to winston levels.
const LEVEL_ALIASES = {
  DEBUG: 'debug',
  TRACE: 'debug',
  INFO: 'info',
  WARNING: 'warning',
  WARN: 'warning',
  ERROR: 'error',
  CRITICAL: 'error',
  FATAL: 'error',
  SEVERE: 'error',
};

const ROTATION_PATTERNS = {
  MIDNIGHT: 'YYYY-MM-DD',
  D: 'YYYY-MM-DD',
  H: 'YYYY-MM-DD-HH',
};

const isTrue = (value) =>
  [
    'true',
    '1',
    'yes',
    'on',
  ].includes(String(value).trim().toLowerCase());

const toInt = (value, fallback) => {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) || parsed < 0 ? fallback : parsed;
};

/**
 * Resolve the logging configuration from environment variables.
 *
 * @param {Object} env - The environment (defaults to process.env).
 * @param {Object} stdout - The stdout stream, used to detect a TTY.
 * @return {Object} The resolved configuration. `warnings` lists invalid values that were replaced.
 */
function resolveConfig(env = process.env, stdout = process.stdout) {
  const warnings = [];

  // Log level. DEBUG (the legacy `debug` module variable) implies DEBUG when LOG_LEVEL is unset.
  const rawLevel = env.LOG_LEVEL ? String(env.LOG_LEVEL).trim() : '';
  let level = 'info';
  if (rawLevel) {
    level = LEVEL_ALIASES[rawLevel.toUpperCase()];
    if (!level) {
      warnings.push({ field: 'LOG_LEVEL', value: rawLevel, fallback: 'INFO' });
      level = 'info';
    }
  } else if (env.DEBUG && String(env.DEBUG).trim()) {
    level = 'debug';
  }

  const environment = String(env.ENVIRONMENT || env.NODE_ENV || 'production')
    .trim()
    .toLowerCase();

  const rawFormat = String(env.LOG_FORMAT || 'auto')
    .trim()
    .toLowerCase();
  let format = rawFormat;
  if (
    ![
      'json',
      'console',
      'auto',
    ].includes(rawFormat)
  ) {
    warnings.push({ field: 'LOG_FORMAT', value: env.LOG_FORMAT, fallback: 'auto' });
    format = 'auto';
  }
  if (format === 'auto') {
    format = environment === 'production' && !(stdout && stdout.isTTY) ? 'json' : 'console';
  }

  // Under the test suite stay silent unless a level is explicitly requested.
  const silent = Boolean(env.TEST_SUITE) && !rawLevel;

  const filePath = env.LOG_FILE_PATH || path.join(env.LOG_FOLDER || './logs', DEFAULT_FILE_NAME);
  const parsedPath = path.parse(filePath);

  const rawWhen = String(env.LOG_FILE_ROTATION_WHEN || 'midnight')
    .trim()
    .toUpperCase();
  let datePattern = ROTATION_PATTERNS[rawWhen];
  if (!datePattern) {
    warnings.push({
      field: 'LOG_FILE_ROTATION_WHEN',
      value: env.LOG_FILE_ROTATION_WHEN,
      fallback: 'midnight',
    });
    datePattern = ROTATION_PATTERNS.MIDNIGHT;
  }

  return {
    level,
    format,
    environment,
    silent,
    service: env.SERVICE_NAME || DEFAULT_SERVICE_NAME,
    file: {
      enabled:
        !silent && (env.LOG_FILE_ENABLED === undefined ? true : isTrue(env.LOG_FILE_ENABLED)),
      dirname: parsedPath.dir || '.',
      filename: `${parsedPath.name}-%DATE%${parsedPath.ext}`,
      archiveDirname: path.join(parsedPath.dir || '.', 'archived'),
      maxBytes: toInt(env.LOG_FILE_MAX_BYTES, DEFAULT_MAX_BYTES),
      backupCount: toInt(env.LOG_FILE_BACKUP_COUNT, DEFAULT_BACKUP_COUNT),
      datePattern,
    },
    warnings,
  };
}

module.exports = { resolveConfig };
