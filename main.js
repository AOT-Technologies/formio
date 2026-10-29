'use strict';

const logging = require('./src/util/logger');
const logger = logging('formio:main');

/**
 * Log a fatal process-level failure, flush the transports and exit.
 */
const exitOnFatal = (event, message) => (err) => {
  logger.exception(message, err instanceof Error ? err : new Error(String(err)), { event });
  // Exit even if the flush rejects; an unhandled rejection here would re-enter this handler.
  const exit = () => process.exit(1);
  logging.flush().then(exit, exit);
};

// Route runtime warnings (e.g. deprecations) through the logger instead of plain stderr text.
process.removeAllListeners('warning');
process.on('warning', (warning) =>
  logger.warning(warning.message, {
    event: 'runtime_warning',
    warning_name: warning.name,
    warning_code: warning.code,
  }),
);

process.on('unhandledRejection', exitOnFatal('unhandled_rejection', 'Unhandled promise rejection'));
process.on('uncaughtException', exitOnFatal('uncaught_exception', 'Uncaught exception'));

require('colors');
require('./server')()
  .then(function (state) {
    state.server.listen(state.config.port, () => {
      logger.info('Service started', { event: 'service_started', port: Number(state.config.port) });
    });
  })
  .catch(exitOnFatal('service_start_failed', 'Service failed to start'));
