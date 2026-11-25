'use strict';

/**
 * Update 3.1.1
 *
 * Run this using "node ./src/db/manual/3.1.1
 *
 * @param db
 * @param config
 * @param tools
 * @param done
 */
const util = require('../../util/util');
const config = require('config');
const async = require('async');
const mongodb = require('mongodb');
const MongoClient = mongodb.MongoClient;
const { sanitizeMongoConnectionString } = require('../util');
const logger = require('../../util/logger')('formio:update:3.1.1');

(async () => {
  try {
    const client = await MongoClient.connect(config.mongo);
    const db = client.db(client.s.options.dbName);
    const formCollection = db.collection('forms');
    const submissionCollection = db.collection('submissions');
    const setDateField = (field, data) => {
      if (!data) {
        return false;
      }
      const parts = field.split('.');
      const value = data[parts[0]];
      // Handle Datagrids
      if (Array.isArray(value)) {
        return value.reduce((changed, row) => {
          return setDateField(parts.slice(1).join('.'), row) || changed;
        }, false);
      }
      // Handle Containers
      if (parts.length > 1) {
        return setDateField(parts.slice(1).join('.'), value);
      }
      if (value && !(value instanceof Date)) {
        data[parts[0]] = new Date(value);
        return true;
      } else {
        return false;
      }
    };

    const getNext = function (cursor, next) {
      cursor.hasNext().then((hasNext) => {
        if (hasNext) {
          return cursor.next().then(next);
        } else {
          return next();
        }
      });
    };

    let hasNextForm = true;
    const formCursor = formCollection.find({ deleted: { $eq: null } });
    async.doWhilst(
      (nextForm) => {
        getNext(formCursor, (form) => {
          if (!form) {
            hasNextForm = false;
            return nextForm();
          }
          const fields = [];
          util.FormioUtils.eachComponent(
            form.components,
            function (component, path) {
              // We only care about non-layout components, which are not unique, and have not been blacklisted.
              if (component.type === 'datetime') {
                fields.push(path);
              }
            },
            true,
          );

          if (!fields.length) {
            return nextForm();
          }

          const submissionCursor = submissionCollection.find({
            form: form._id,
            deleted: { $eq: null },
          });

          let hasNextSubmission = true;
          async.doWhilst(
            (nextSubmission) => {
              getNext(submissionCursor, (submission) => {
                if (!submission) {
                  hasNextSubmission = false;
                  return nextSubmission();
                }
                const changed = fields.reduce((changed, field) => {
                  return setDateField(field, submission.data) || changed;
                }, false);
                if (changed) {
                  logger.info('Updating date fields for submission', {
                    submission_id: submission._id,
                  });

                  submissionCollection.updateOne(
                    {
                      _id: submission._id,
                    },
                    {
                      $set: {
                        data: submission.data,
                      },
                    },
                    {
                      upsert: false,
                    },
                    (err) => {
                      if (err) {
                        return nextSubmission(err);
                      }
                      return nextSubmission();
                    },
                  );
                } else {
                  return nextSubmission();
                }
              });
            },
            () => {
              return hasNextSubmission;
            },
            (err) => {
              if (err) {
                return nextForm(err);
              }
              return nextForm();
            },
          );
        });
      },
      () => {
        return hasNextForm;
      },
      (err) => {
        if (err) {
          return logger.exception('Date fields update failed', err);
        }

        logger.info('Date fields update complete');
      },
    );
  } catch (err) {
    return logger.exception('Could not connect to database', err, {
      mongo_url: sanitizeMongoConnectionString(String(config.mongo)),
    });
  }
})();
