'use strict';

const async = require('async');
const MongoClient = require('mongodb').MongoClient;
const semver = require('semver');
const _ = require('lodash');
const fs = require('fs');
const logger = {
  db: require('../util/logger')('formio:db'),
  sanity: require('../util/logger')('formio:sanityCheck'),
};
const path = require('path');
const { customAlphabet } = require('nanoid/non-secure');
const { sanitizeMongoConnectionString } = require('./util');

// Random string generator HOF
const nanoid = customAlphabet('1234567890abcdef', 10);

// The mongo database connection.
let db = null;
let schema = null;
let tools = null;

// The lock that contains the most recent version in mongo.
let currentLock = null;

// The updates available to this codebase, listed in chronological order.
let updates = null;

/**
 * The Form.io update script.
 *
 * Compares the version defined within this script and in the database and retroactively applies the updates.
 *
 * @param formio {Object}
 *   The Formio router.
 */
module.exports = function (formio) {
  let config = formio.config;

  // Allow anyone to hook the current config.
  config = formio.hook.alter('updateConfig', config);

  // Current codebase version.
  if (!config.schema && !process.env.TEST_SUITE) {
    throw new Error(
      'No database schema version defined in the config, terminating process to ensure db schemas are not incorrectly' +
        ' manipulated.',
    );
  }

  // The last time a sanity check occurred for GET use only (cache non-manipulative operations).
  let now = new Date().getTime();

  // The simplex schema cache item.
  const cache = {
    // The cache full schema sanity check.
    full: {
      last: 0,
      isValid: true,
      error: 'The codebase and database schema versions do not match.',
    },

    // The cache the partial schema sanity check.
    partial: {
      last: 0,
      isValid: true,
      error: 'The codebase and database schema major versions do not match.',
    },
  };

  /**
   *
   * @param {object} lock - The lock object to sanitize.
   * @returns {object|undefined} - The sanitized lock object.
   */
  const sanitizeLock = function (lock) {
    if (!lock) {
      return;
    }
    if (typeof lock !== 'object') {
      throw new Error('Invalid lock object');
    }
    const validLock = {
      key: lock.key,
      isLocked: lock.isLocked,
      version: lock.version,
    };
    return validLock;
  };

  /**
   * Unlock the formio lock.
   *
   *   The next function to invoke after this function has finished.
   */
  const unlock = async function () {
    if (!currentLock) {
      throw new Error('Could not find the formio lock to unlock..');
    }

    currentLock.isLocked = false;
    await schema.updateOne({ key: 'formio' }, { $set: { isLocked: currentLock.isLocked } });
    const result = await schema.findOne({ key: 'formio' });
    currentLock = sanitizeLock(result);
    logger.db.debug('Lock unlocked');
  };
  /**
   * Fetch the SA certificate.
   *
   * @return {*}
   */
  const getCA = function () {
    // Handle reverse compatability.
    const CA = config.mongoSA || config.mongoCA;
    if (!CA) {
      return;
    }

    config.mongoSA = config.mongoCA = CA;
  };

  /**
   * Fetch the SSL certificates from local dir.
   *
   * @return {*}
   */
  const getSSL = function () {
    if (!config.mongoSSL) {
      return;
    }

    logger.db.info('Loading Mongo TLS certificates');

    const certs = {
      tls: true,
      tlsAllowInvalidCertificates: !config.mongoSSLValidate,
    };

    if (config.mongoSSLPassword) {
      certs.tlsCertificateKeyFilePassword = config.mongoSSLPassword;
    }

    const files = {
      ca: 'ca.pem',
      cert: 'cert.pem',
      crl: 'crl.pem',
      key: 'key.pem',
    };

    Object.keys(files).forEach((key) => {
      const file = files[key];
      const filePath = path.join(config.mongoSSL, file);

      if (fs.existsSync(filePath)) {
        logger.db.info('Reading Mongo TLS certificate file', { file_path: filePath });
        const data = fs.readFileSync(filePath);

        if (key === 'ca') {
          // 'ca' can be an array if multiple CAs need to be trusted
          certs.ca = [
            data,
          ];
        } else if (key === 'crl') {
          certs.crl = data;
        } else if (key === 'cert') {
          certs.cert = data;
        } else if (key === 'key') {
          certs.key = data;
        }
      } else {
        logger.db.info('Mongo TLS certificate file not found, skipping', { file_path: filePath });
      }
    });

    config.mongoSSL = certs;
  };

  /**
   * Initialize the Mongo Connections for queries.
   *
   *
   * @returns {*}
   */
  const connection = async function () {
    // If a connection exists, skip the initialization.
    if (db) {
      logger.db.debug('Connection exists');
      return;
    }

    // Get a connection to mongo, using the config settings.
    const dbUrl = typeof config.mongo === 'string' ? config.mongo : config.mongo[0];

    const sanitizedDbUrl = sanitizeMongoConnectionString(dbUrl);
    logger.db.info('Opening new Mongo connection', { mongo_url: sanitizedDbUrl });
    let mongoConfig = config.mongoConfig ? JSON.parse(config.mongoConfig) : {};
    if (!mongoConfig.hasOwnProperty('connectTimeoutMS')) {
      mongoConfig.connectTimeoutMS = 300000;
    }
    if (!mongoConfig.hasOwnProperty('socketTimeoutMS')) {
      mongoConfig.socketTimeoutMS = 300000;
    }
    if (config.mongoSA || config.mongoCA) {
      mongoConfig.tls = true;
      mongoConfig.tlsCAFile = config.mongoSA || config.mongoCA;
    }
    if (config.mongoSSL) {
      mongoConfig = {
        ...mongoConfig,
        ...config.mongoSSL,
      };
    }

    // Establish a connection and continue with execution.
    const client = new MongoClient(dbUrl, mongoConfig);

    async function connectMongo() {
      try {
        await client.connect();
        db = client.db(client.s.options.dbName);
        logger.db.info('Mongo connection established');
        const collection = db.collection('schema');
        logger.db.debug('Schema collection opened');
        schema = collection;
        // Load the tools available to help manage updates.
        tools = require('./tools')(db, schema);
      } catch (err) {
        logger.db.exception('Mongo connection failed', err, { mongo_url: sanitizedDbUrl });
        await unlock();
        throw new Error(
          `Could not connect to the given Database for server updates: ${sanitizedDbUrl}.`,
        );
      }
    }

    // Establish a connection and continue with execution.
    await connectMongo();
  };

  /**
   * Test to see if the application has been installed. Install if not.
   */
  const checkSetup = async function () {
    logger.db.info('Checking for database setup');
    const collections = await db.listCollections().toArray();
    logger.db.debug('Collections found', { count: collections.length });
    // 3 is an arbitrary length. We just want a general idea that things have been installed.
    if (collections.length < 3) {
      logger.db.info('No collections found, starting new setup');
      await require(path.join(__dirname, '/install'))(db, config);
      logger.db.info('Database setup complete');
    } else {
      logger.db.info('Database setup complete');
    }
  };

  const checkEncryption = function () {
    formio.hook.alter('checkEncryption', formio, db);
  };

  /**
   * Check for certain mongodb features.
   */
  const checkFeatures = async function () {
    logger.db.info('Determining MongoDB compatibility');
    try {
      config.mongoFeatures = formio.mongoFeatures = {
        collation: true,
        compoundIndexWithNestedPath: true,
      };
      // Assign a random string to collection name to avoid multi-instance race conditions
      const randomString = nanoid();
      const featuresTest = db.collection(randomString);
      // Test for collation support
      try {
        await featuresTest.createIndex(
          { test: 1 },
          { collation: { locale: 'en_US', strength: 1 } },
        );
        logger.db.info('Collation indexes are supported');
      } catch (ignoreErr) {
        logger.db.info('Collation indexes are not supported');
        config.mongoFeatures.collation = formio.mongoFeatures.collation = false;
      }

      // Test for support for compound indexes that contain nested paths
      try {
        await featuresTest.createIndex({ test: 1, 'nested.test': 1 });
        logger.db.info('Compound indexes that contain nested paths are supported');
      } catch (ignoreErr) {
        logger.db.info('Compound indexes that contain nested paths are not supported');
        config.mongoFeatures.compoundIndexWithNestedPath =
          formio.mongoFeatures.compoundIndexWithNestedPath = false;
      }

      // check CosmosDB indexes
      try {
        // Checking whether indexes need to be created for CosmosDB to function
        await featuresTest.dropIndexes();
        await featuresTest.insertOne({ title: 'Test Title', nested: { test: 'value' } });
        await featuresTest.find().sort({ title: 1 }).limit(1).toArray();
      } catch (ignoreErr) {
        // Create indexes if they don't exist
        const collections = await db.listCollections().toArray();

        for (const { name } of collections) {
          const collection = db.collection(name);
          const indexes = await collection.indexes();

          const hasWildcard = indexes.some((idx) => idx.key && idx.key['$**'] === 1);

          if (!hasWildcard) {
            await collection.createIndex({ '$**': 1 });
          }
        }
      }
      await featuresTest.drop();
    } catch (err) {
      logger.db.warning('Could not determine MongoDB compatibility', err);
    }
  };

  /**
   * The sanity check middleware to determine version delta between codebase and database.
   *
   * @param req
   * @param res
   * @param next
   * @returns {*}
   */
  const sanityCheck = async function sanityCheck(req, res, next) {
    // Determine if a response is expected by the request path.
    const response = req.path === '/health';
    const { verboseHealth } = req;

    // Skip functionality if testing.
    if (process.env.TEST_SUITE) {
      logger.sanity.debug('Skipping sanity check for test suite');

      if (response && verboseHealth) {
        res.status(200);
        return next();
      }

      return response ? res.sendStatus(200) : next();
    }

    /**
     * Send a response or pass through to the next middleware, depending on if a response was expected.
     *
     * @param err
     *   The error to be sent in a response if any.
     *
     * @returns {*}
     */
    const handleResponse = function (err) {
      if (response && verboseHealth) {
        if (err) {
          res.status(400);
        } else {
          res.status(200);
        }
        return next();
      }

      if (err) {
        return res.status(400).send(err);
      }

      return response ? res.sendStatus(200) : next();
    };

    // After connecting, perform the sanity check.
    await connection();
    // Skip update if request was a get and update was less than 10 seconds ago (in ms).
    if (req.method === 'GET') {
      logger.sanity.debug('Checking GET request');
      now = new Date().getTime();

      // Do a full sanity check when expecting a response.
      if (response) {
        if (cache.full.last + 10000 > now) {
          logger.sanity.debug('Using cached full sanity check result');
          return cache.full.isValid ? handleResponse() : handleResponse(cache.full.error);
        } else {
          logger.sanity.debug('Cached full sanity check result expired');
          // Update the last check time.
          cache.full.last = now;
        }
      }
      // Do a partial sanity check when expecting a response.
      else {
        if (cache.partial.last + 10000 > now) {
          logger.sanity.debug('Using cached partial sanity check result');
          return cache.partial.isValid ? handleResponse() : handleResponse(cache.partial.error);
        } else {
          logger.sanity.debug('Cached partial sanity check result expired');
          // Update the last check time.
          cache.partial.last = now;
        }
      }
    }

    logger.sanity.debug('Checking formio schema');
    // A cached response was not viable here, query and update the cache.

    const updateCache = async () => {
      try {
        const document = await schema.findOne({ key: 'formio' });
        if (!document) {
          cache.full.isValid = false;
          cache.partial.isValid = false;

          throw new Error('The formio lock was not found..');
        }
        logger.sanity.debug('Schema lock found');

        // When sending a response, a direct query was performed, check for different versions.
        if (response) {
          // Update the valid cache for following GET requests.
          cache.full.isValid = semver.neq(document.version, config.schema) ? false : true;

          logger.sanity.debug('Full sanity check complete', { is_valid: cache.full.isValid });
          return cache.full.isValid ? handleResponse() : handleResponse(cache.full.error);
        }
        // This is just a request sanity check, only puke if there are major differences.
        else {
          // Update the valid cache for following GET requests.
          cache.partial.isValid = semver.major(document.version) === semver.major(config.schema);

          logger.sanity.debug('Partial sanity check complete', { is_valid: cache.partial.isValid });
          return cache.partial.isValid ? handleResponse() : handleResponse(cache.partial.error);
        }
      } catch (ignoreErr) {
        cache.full.isValid = false;
        cache.partial.isValid = false;

        throw new Error('The formio lock was not found..');
      }
    };
    await updateCache();
  };

  /**
   * Get a list of available update files.
   *
   * @param next {Function}
   *   The next function to invoke after this function has finished.
   */
  const getUpdates = async function () {
    let files = await fs.promises.readdir(path.join(__dirname, '/updates'));
    files = files.map(function (name) {
      logger.db.debug('Update found', { update: name });
      return name.split('.js')[0];
    });

    // Allow anyone to hook the update system.
    formio.hook.alter('getUpdates', files, function (err, files) {
      updates = files.sort(semver.compare);
      logger.db.debug('Update list finalized', { count: updates.length });
    });
  };

  /**
   * Lock the formio lock.
   *
   * @param next
   *   The next function to invoke after this function has finished.
   *
   * @returns {*}
   */
  const lock = async function () {
    if (!schema) {
      throw new Error('No Schema collection was found..');
    }

    const document = await schema.find({ key: 'formio' }).toArray();
    // Engage the lock.
    if (!document || document.length === 0) {
      // Create a new lock, because one was not present.
      logger.db.debug('Lock not found, creating a new lock');
      const document = {
        key: 'formio',
        isLocked: new Date().getTime(),
        version: config.schema,
      };
      const insertionResult = await schema.insertOne(document);
      if (!insertionResult.acknowledged || !insertionResult.insertedId) {
        throw new Error('Could not create a lock for the formio schema.');
      }
      const lock = await schema.findOne(
        { _id: insertionResult.insertedId },
        { readPreference: 'primary' },
      );
      currentLock = sanitizeLock(lock);
      logger.db.debug('Created a new lock');
    } else if (document.length > 1) {
      throw 'More than one lock was found, terminating updates.';
    } else {
      currentLock = document[0];
      logger.db.debug('Lock found', { version: currentLock.version });

      if (currentLock.isLocked) {
        logger.db.warning('Database is already locked for updating');
      } else {
        // Lock
        await schema.updateOne({ key: 'formio' }, { $set: { isLocked: new Date().getTime() } });
        const result = await schema.findOne({ key: 'formio' });
        currentLock = sanitizeLock(result);
        logger.db.debug('Lock engaged');
      }
    }
  };

  /**
   * Determine if there are pending updates to be applied.
   *
   * @param code
   *   The schema version in code.
   * @param database
   *   The schema version in the database.
   *
   * @returns {boolean}
   *   If pending updates are available.
   */
  const pendingUpdates = async function (code, database) {
    // Check the validity of the the code and database version numbers.
    if (
      !code ||
      typeof code !== 'string' ||
      !semver.valid(code) ||
      !database ||
      typeof database !== 'string' ||
      !semver.valid(database)
    ) {
      await unlock();
      throw new Error(
        `${
          'The provided versions given for comparison, do not match the semantic versioning format; ' +
          'code: '
        }${code}, database: ${database}`,
      );
    }

    // Versions are the same, skip updates.
    if (semver.eq(code, database)) {
      logger.db.debug('Database and code schema versions are the same', {
        database_version: database,
        code_version: code,
      });
      return false;
    } else if (
      semver.gt(database, code) &&
      [
        'patch',
        'prepatch',
        'prerelease',
        'minor',
      ].indexOf(semver.diff(database, code)) === -1
    ) {
      await unlock();
      throw new Error(
        'The provided codebase version is more recent than the database schema version. Update the codebase and ' +
          'restart.',
      );
    } else {
      // The code has a higher version than the database, lock the database and update the schemas.
      return true;
    }
  };

  /**
   * Update the database schema, from the current version, to the latest defined.
   *
   */
  const doUpdates = async function () {
    logger.db.info('Checking for database schema updates');

    // Skip updates if there are no pending updates to apply.
    if (!(await pendingUpdates(config.schema, currentLock.version))) {
      logger.db.info('No database schema updates found');
      return;
    }

    // Store original version to prevent intermediate vesion updates
    const originalVersion = currentLock.version;

    // Determine the pending updates, by filtering the searchable updates.
    const pending = _.filter(updates, function (potential) {
      // An update is only applicable if it has not been applied to the db yet, and it is lower than the current.
      const applicable =
        semver.gt(potential, originalVersion) && semver.lte(potential, config.schema);

      // Display progress.
      if (applicable) {
        logger.db.info('Pending schema update', { version: potential });
      }

      return applicable;
    });

    // Only take action if outstanding updates exist.
    logger.db.debug('Pending updates determined', { count: pending.length });
    if (pending.length > 0) {
      async.eachSeries(
        pending,
        function (pendingVersion, callback) {
          logger.db.info('Starting schema update', { version: pendingVersion });

          // Load the update then update the schema lock version.
          let _update = null;

          // Attempt to load the the pending update.
          // Allow anyone to hook the pending updates location.
          try {
            _update = formio.hook.alter('updateLocation', pendingVersion);
          } catch (e) {
            logger.db.exception('Update location hook failed', e, { version: pendingVersion });
          }

          // No private update was found, check the public location.
          logger.db.debug('Update location resolved', {
            version: pendingVersion,
            hooked: typeof _update === 'function',
          });
          if (typeof _update !== 'function') {
            try {
              _update = require(path.join(__dirname, `/updates/${pendingVersion}`));
            } catch (e) {
              logger.db.exception('Could not load update file', e, { version: pendingVersion });
              return callback(`Could not load update: ${pendingVersion}`);
            }
          }

          // Attempt to resolve the update.
          try {
            if (typeof _update !== 'function') {
              return callback(`Could not resolve the path for update: ${pendingVersion}`);
            }

            _update(db, config, tools, function (err) {
              if (err) {
                logger.db.error('Schema update failed', {
                  version: pendingVersion,
                  error: String(err),
                });
                return callback(err);
              }

              // Update pendingVersion done() called, proceeding to next update, if exist
              // don't update lock version here - just proceed to next update
              callback();
            });
          } catch (e) {
            logger.db.exception('Schema update failed', e, { version: pendingVersion });
            return callback(e);
          }
        },
        function (err) {
          if (err) {
            throw err;
          }

          // Update lock version to the FINAL version only after ALL updates are started
          const finalVersion = pending[pending.length - 1];
          tools.updateLockVersion(finalVersion, function (lockErr) {
            if (lockErr) {
              throw lockErr;
            }

            logger.db.info('Done applying pending schema updates', { version: finalVersion });
          });
        },
      );
    } else {
      logger.db.info('No pending schema updates are available', {
        code_version: config.schema,
        schema_version: currentLock.version,
        latest_available: updates[updates.length - 1],
      });
    }
  };

  /**
   * Update the default configuration forms, from the current version, to the version required by the server.
   *
   * @param next
   *   The next function to invoke after this function has finished.
   */
  const doConfigFormsUpdates = function () {
    logger.db.info('Checking for config forms updates');

    let configFormsUpdates = {};
    configFormsUpdates = formio.hook.alter('getConfigFormsUpdates', configFormsUpdates);
    const updates = Object.keys(configFormsUpdates);

    // Skip updates if there are no  updates to apply.
    if (!updates.length) {
      logger.db.info('No config forms updates found');
      return;
    }
    // Only take action if updates exist.
    logger.db.debug('Pending config forms updates', { count: updates.length });
    async.eachSeries(
      updates,
      function (update, callback) {
        logger.db.info('Starting config forms update', { update });

        // Load the update then update the schema lock version.
        let _update = null;

        // Attempt to load the the pending update.
        // Allow anyone to hook the pending updates location.
        try {
          _update = configFormsUpdates[update];
        } catch (e) {
          logger.db.exception('Could not load config forms update', e, { update });
        }
        // Attempt to resolve the update.
        try {
          if (typeof _update !== 'function') {
            return callback(`Could not resolve the path for config form update: ${update}`);
          }

          _update(db, config, tools, function (err) {
            if (err) {
              return callback(err);
            }
            return callback();
          });
        } catch (e) {
          logger.db.exception('Config forms update failed', e, { update });
          return callback(e);
        }
      },
      function (err) {
        if (err) {
          throw err;
        }

        logger.db.info('Done applying pending config forms updates');
      },
    );
  };
  /**
   * Initialized the update script.
   */
  const initialize = async function () {
    if (process.env.TEST_SUITE) {
      await connection();
      await checkFeatures();
      return db;
    }

    try {
      getCA();
      getSSL();
      await connection();
      await checkSetup();
      checkEncryption();
      await checkFeatures();
      await getUpdates();
      await lock();
      doConfigFormsUpdates();
      await doUpdates();
      await unlock();
      return db;
    } catch (err) {
      try {
        await unlock();
        logger.db.exception('Database initialization failed', err);
        return db;
      } catch (ignoreErr) {
        throw err;
      }
    }
  };

  /**
   * Expose the update internals for outside use.
   */
  return {
    db: db,
    version: config.schema,
    initialize: initialize,
    sanityCheck: sanityCheck,
  };
};
