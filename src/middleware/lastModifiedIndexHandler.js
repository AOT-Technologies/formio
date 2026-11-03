'use strict';
const _ = require('lodash');
const logger = require('../util/logger')('formio:middleware:lastModifiedIndexHandler');

/**
 * Middleware function to set the lastModified in the response header.
 *
 * @param req
 * @param res
 * @param next
 * @returns {*}
 */
module.exports = function (router) {
  return async function lastModifiedIndexHandler(req, res, next) {
    if (req.method !== 'GET' || req.formId || _.get(req, '__rMethod', 'get') !== 'index') {
      return next();
    }

    try {
      const { deleted, ...matchObj } = req.modelQuery._conditions ?? {};
      if (matchObj.hasOwnProperty('tags') && typeof matchObj.tags === 'string') {
        matchObj.tags = { $in: matchObj.tags.split(',') };
      }
      const aggregationStart = Date.now();
      const result = await router.formio.resources.form.model.aggregate([
        {
          $match: matchObj,
        },
        {
          $project: {
            lastModified: {
              $cond: {
                if: {
                  $ne: [
                    '$deleted',
                    null,
                  ],
                },
                then: {
                  $max: [
                    '$modified',
                    { $toDate: '$deleted' },
                  ],
                },
                else: '$modified',
              },
            },
          },
        },
        {
          $sort: { lastModified: -1 },
        },
        {
          $limit: 1,
        },
      ]);
      if (process.env.PERFORMANCE_TIMER) {
        logger.debug('Last modified aggregation finished', {
          duration_ms: Date.now() - aggregationStart,
        });
      }
      if (result.length) {
        res.setHeader('Last-Modified', result[0].lastModified.toUTCString());
      }
    } catch (err) {
      logger.warning('Failed to compute last modified date', err);
      return next();
    }

    next();
  };
};
