'use strict';
let async = require('async');
const logger = require('../../util/logger')('formio:update:3.0.9');
module.exports = function (db, config, tools, done) {
  let dropIndex = function (collection, index, next) {
    logger.info('Dropping index', { collection, index });
    db.collection(collection)
      .dropIndex(index)
      .then(() => {
        logger.info('Dropped index', { collection, index });
        next();
      })
      .catch((err) => {
        logger.warning('Could not drop index', err, { collection, index });
        next();
      });
  };

  async.series(
    [
      async.apply(dropIndex, 'roles', 'machineName_1'),
      async.apply(dropIndex, 'forms', 'machineName_1'),
      async.apply(dropIndex, 'submissions', 'machineName_1'),
      async.apply(dropIndex, 'actions', 'machineName_1'),
    ],
    () => done(),
  );
};
