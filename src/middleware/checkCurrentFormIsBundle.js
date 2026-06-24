"use strict";

/**
 * Middleware function to check the current form is bundle or not.
 *
 * @param router
 *
 * @returns {Function}
 */
module.exports = function (router) {
  return async function (req, res, next) {
    try {
      const form = await router.formio.cache.loadForm(
        req,
        null,
        router.formio.cache.getCurrentFormId(req)
      );
      req.isBundle = form && form.isBundle;
      next();
    } catch (err) {
      next(err);
    }
  };
};
