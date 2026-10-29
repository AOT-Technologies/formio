'use strict';

/**
 * This is the Form.io application server.
 */
const express = require('express');
const nunjucks = require('nunjucks');
const fs = require('fs-extra');
const path = require('path');
require('colors');
const Q = require('q');
const cors = require('cors');
const logging = require('./src/util/logger');
const { requestContext, errorHandler } = require('./src/middleware/requestContext');
const logger = logging('formio:server');
const test = process.env.TEST_SUITE;
const noInstall = Number(process.env.NO_INSTALL) || 0;

/**
 * Print the startup banner. Only used for human-readable (console) output.
 */
const printBanner = function () {
  const rl = require('readline').createInterface({
    input: require('fs').createReadStream('logo.txt'),
  });

  process.stdout.write('\n');
  rl.on('line', function (line) {
    process.stdout.write(
      `${
        line.substring(0, 4) +
        line.substring(4, 30).cyan.bold +
        line.substring(30, 33) +
        line.substring(33, 42).green.bold +
        line.substring(42)
      }\n`,
    );
  });

  rl.on('close', function () {
    // Print the welcome screen.
    process.stdout.write(`\n${fs.readFileSync('welcome.txt').toString().green}\n`);
  });
};

module.exports = function (options) {
  options = options || {};
  const q = Q.defer();

  if (logging.config.format === 'console' && !test) {
    printBanner();
  }
  logger.info('Service starting', { event: 'service_starting' });

  // Use the express application.
  const app = options.app || express();

  // Establish the request context and access log before anything else.
  app.use(requestContext);

  // Use the given config.
  const config = options.config || require('config');

  // Configure nunjucks.
  nunjucks.configure('client', {
    autoescape: true,
    express: app,
  });

  //cors configuration
  if (config.allowedOrigins) {
    app.use(
      cors({
        origin: function (origin, callback) {
          if (!origin) {
            return callback(null, true);
          }
          if (
            config.allowedOrigins.indexOf(origin) === -1 &&
            config.allowedOrigins.indexOf('*') === -1
          ) {
            var msg =
              'The CORS policy for this site does not allow access from the specified Origin.';
            return callback(new Error(msg), false);
          }
          return callback(null, true);
        },
      }),
    );
  }
  // Mount the client application.
  app.use('/', express.static(path.join(__dirname, '/portal/dist')));

  // Load the form.io server.
  const server = options.server || require('./index')(config);
  const hooks = options.hooks || {};

  app.use(server.formio.middleware.restrictRequestTypes);
  server.init(hooks).then(function (formio) {
    // Called when we are ready to start the server.
    const start = function () {
      // Mount the Form.io API platform.
      app.use(options.mount || '/', server);

      // Log unhandled errors and answer with a generic 500.
      app.use(errorHandler);

      // Allow tests access server internals.
      app.formio = formio;

      // Listen on the configured port.
      return q.resolve({
        server: app,
        config: config,
      });
    };

    // Which items should be installed.
    const install = {
      import: false,
      user: false,
    };

    // See if they have any forms available.
    formio.db.collection('forms').estimatedDocumentCount(function(err, numForms) {
      // If there are zero documents, then root user must be installed.
      if (!err && numForms === 0) {
        install.user = true;
      }

      // If there are forms, then go ahead and start the server.
      if ((!err && numForms > 0) || test || noInstall) {
        if (!install.download && !install.extract && !install.user) {
          return start();
        }
      }

      install.import = true;

      // Install.
      require('./install')(formio, install, function (err) {
        if (err) {
          if (err !== 'Installation canceled.') {
            return logger.exception('Installation failed', err, { event: 'install_failed' });
          }
        }

        // Start the server.
        start();
      });
    });
  });

  return q.promise;
};
