'use strict';

/**
 * Structured logging entry point (see docs/logging-standard.md).
 *
 *   const logger = require('../util/logger')('formio:cache');
 *   logger.info('Form loaded', { form_id: formId });
 *   logger.exception('Failed to load form', err, { form_id: formId });
 *
 * Loggers are cached per name; records are single-line JSON (or console text) carrying the
 * standard fields and the active request context.
 */
const logging = require('./logging');

const logger = (name) => logging.getLogger(name);

module.exports = Object.assign(logger, logging);
