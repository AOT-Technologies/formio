'use strict';

const util = require('../util/util');
const _ = require('lodash');

/**
 * Middleware function to filter protected fields from a submission response.
 *
 * @param router
 *
 * @returns {Function}
 */
module.exports = function (router) {
  return function (action, getForm) {
    return async function (req, res, next) {
      if (
        !_.get(res, 'resource.item') ||
        router.formio.hook.alter('rawDataAccess', req, next, util.skipHookIfNotExists)
      ) {
        return next();
      }

      /* If the request is for a bundle and a formId is provided in the query parameters,
       use the formId from the query. Otherwise, use the formId obtained from the getForm function. */

      const formId = req.isBundle && req.query.formId ? req.query.formId : getForm(req);

      try {
        const form = await router.formio.cache.loadForm(req, null, formId);

        if (req.isBundle) {
          req.bundledForm = form;
        }

        util.removeProtectedFields(form, action, res.resource.item, req.doNotMinify || req.full || req.query.full, req.token);
        return next();
      } catch (err) {
        return next(err);
      }
    };
  };
};
