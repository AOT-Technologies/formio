'use strict';

const util = require('../util/util');

/**
 * Middleware function to alter current submission with previous submission data.
 *
 * @param router
 *
 * @returns {Function}
 */
module.exports = function(router) {
    return async function(req, res, next) {
      try {
        const form = await router.formio.cache.loadForm(req, null, req.formId);
        const previousSubmission = req.previousSubmission?.data;
        util.eachComponent(form.components, (component) => {
          if (component.properties?.displayForRole) {
            if (!req.body?.data?.[component.key]) {
              req.body.data[component.key] = previousSubmission?.[component.key];
            }
          }
        });
        next();
      } catch (err) {
        next(err);
      }
    };
};
