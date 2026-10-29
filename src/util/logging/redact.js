'use strict';

const REDACTED = '[REDACTED]';
const TRUNCATED = '[TRUNCATED]';
const TRUNCATION_SUFFIX = '…[truncated]';
const MAX_DEPTH = 8;
const MAX_STRING_BYTES = 8 * 1024;
const MAX_EXCEPTION_BYTES = 16 * 1024;

// Fields that are never redacted (logging standard §5).
const RESERVED_KEYS = new Set([
  'timestamp',
  'level',
  'logger',
  'service',
  'environment',
  'request_id',
  'tenant_id',
]);

const SENSITIVE_KEY_PARTS = [
  'password',
  'passwd',
  'secret',
  'token',
  'authorization',
  'cookie',
  'api_key',
  'apikey',
  'private_key',
  'credential',
];

const VALUE_PATTERNS = [
  [
    /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
    '[REDACTED_JWT]',
  ],
  [
    /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
    '$1 [REDACTED]',
  ],
  [
    /([?&](?:access_?token|id_?token|refresh_?token|token|code|password|secret|client_secret|api_?key)=)[^&\s"']+/gi,
    '$1[REDACTED]',
  ],
  [
    /(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^@\s/]+@/gi,
    '$1[REDACTED]@',
  ],
];

const isSensitiveKey = (key) => {
  const normalized = String(key).toLowerCase().replace(/-/g, '_');
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
};

/**
 * Truncate a string that exceeds a byte limit.
 */
const truncate = (value, maxBytes = MAX_STRING_BYTES) => {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
    return value;
  }
  const cut = Buffer.from(value, 'utf8').subarray(0, maxBytes).toString('utf8');
  return `${cut.replace(/�+$/, '')}${TRUNCATION_SUFFIX}`;
};

/**
 * Apply the value-based redaction patterns to a string.
 */
const redactString = (value) =>
  VALUE_PATTERNS.reduce(
    (
      result,
      [
        pattern,
        replacement,
      ],
    ) => result.replace(pattern, replacement),
    value,
  );

const describeError = (err) => `${err.name || 'Error'}: ${err.message}`;

/**
 * Recursively sanitize a value for logging.
 *
 * @param {*} value - The value to sanitize.
 * @param {number} depth - The current nesting depth.
 * @param {WeakSet} seen - Objects already visited (cycle protection).
 * @param {number} maxBytes - The string size limit for this value.
 * @return {*} A JSON-safe, redacted copy of the value.
 */
const sanitizeValue = (value, depth = 0, seen = new WeakSet(), maxBytes = MAX_STRING_BYTES) => {
  if (value === null || value === undefined) {
    return value;
  }
  if (depth > MAX_DEPTH) {
    return TRUNCATED;
  }
  if (typeof value === 'string') {
    return truncate(redactString(value), maxBytes);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (value instanceof Error) {
    return sanitizeValue(describeError(value), depth, seen, maxBytes);
  }
  if (Buffer.isBuffer(value)) {
    return `[Buffer ${value.length} bytes]`;
  }
  if (seen.has(value)) {
    return '[CIRCULAR]';
  }
  // Mongoose documents, ObjectIds and other objects that know how to serialize themselves.
  if (typeof value.toJSON === 'function' && !Array.isArray(value)) {
    const json = value.toJSON();
    if (json !== value) {
      return sanitizeValue(json, depth, seen, maxBytes);
    }
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1, seen));
  }
  if (value instanceof Map || value instanceof Set) {
    return sanitizeValue(Array.from(value), depth, seen);
  }
  return sanitizeFields(value, depth + 1, seen);
};

/**
 * Sanitize the keys of an object: redact sensitive keys and sanitize all other values.
 */
const sanitizeFields = (fields, depth = 1, seen = new WeakSet()) => {
  const result = {};
  for (const [
    key,
    value,
  ] of Object.entries(fields)) {
    if (RESERVED_KEYS.has(key)) {
      result[key] = value;
    } else if (isSensitiveKey(key)) {
      result[key] = value === undefined || value === null ? value : REDACTED;
    } else {
      const maxBytes = key === 'exception' ? MAX_EXCEPTION_BYTES : MAX_STRING_BYTES;
      const sanitized = sanitizeValue(value, depth, seen, maxBytes);
      if (sanitized !== undefined) {
        result[key] = sanitized;
      }
    }
  }
  return result;
};

/**
 * Mask an email address for logging, e.g. user@example.com -> u***@example.com.
 */
const maskEmail = (email) => {
  if (typeof email !== 'string' || !email.includes('@')) {
    return email ? '***' : email;
  }
  const [
    local,
    domain,
  ] = [
    email.slice(0, email.lastIndexOf('@')),
    email.slice(email.lastIndexOf('@') + 1),
  ];
  return `${local.charAt(0)}***@${domain}`;
};

module.exports = {
  REDACTED,
  TRUNCATED,
  MAX_DEPTH,
  RESERVED_KEYS,
  isSensitiveKey,
  redactString,
  sanitizeValue,
  sanitizeFields,
  describeError,
  maskEmail,
};
