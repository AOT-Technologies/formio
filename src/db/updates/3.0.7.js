'use strict';

let async = require('async');
const getLogger = require('../../util/logger');
const logger = {
  findBrokenForms: getLogger('formio:update:3.0.7-findBrokenForms'),
  fixTypes: getLogger('formio:update:3.0.7-fixTypes'),
};

/**
 * Update 3.0.7
 *
 * This update does the following:
 *
 *   1.) finds all forms with invalid types
 *   2.) turns all undefined and invalid types into form
 *
 * @param db
 * @param config
 * @param tools
 * @param done
 */
module.exports = function (db, config, tools, done) {
  let formCollection = db.collection('forms');

  async.waterfall(
    [
      function findBrokenForms(next) {
        formCollection
          .find({
            type: {
              $nin: [
                'form',
                'resource',
              ],
            },
            deleted: { $eq: null },
          })
          .snapshot(true)
          .toArray()
          .then((forms) => {
            logger.findBrokenForms.info('Found forms with invalid types', { count: forms.length });
            return next(null, forms);
          })
          .catch((err) => next(err));
      },
      function fixTypes(forms, next) {
        async.each(
          forms,
          function (form, callback) {
            formCollection
              .updateOne({ _id: tools.util.idToBson(form._id) }, { $set: { type: 'form' } })
              .then(() => {
                logger.fixTypes.debug('Fixed form type', { form_id: form._id });
                return callback();
              })
              .catch((err) => callback(err));
          },
          function (err) {
            if (err) {
              return next(err);
            }

            return next();
          },
        );
      },
    ],
    function (err) {
      if (err) {
        return done(err);
      }

      done();
    },
  );
};
