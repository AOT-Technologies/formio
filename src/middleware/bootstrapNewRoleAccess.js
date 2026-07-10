'use strict';

const debug = (...args)=> {
  require('debug')('formio:middleware:bootstrapNewRoleAccess')(...args);
  require('../util/logger')('formio:middleware:bootstrapNewRoleAccess').error(...args);
};

/**
 * Middleware to bootstrap forms when a new role is created.
 *
 * Update the associated resources with the new role to allow access, then iterate all the existing
 * forms, and add the new role to read_all access.
 *
 * @param req
 * @param res
 * @param next
 * @returns {*}
 */
module.exports = function (router) {
  return async function bootstrapNewRoleAccess(req, res, next) {
    const hook = require('../util/hook')(router.formio);

    // Only bootstrap existing form access on Role creation.
    if (req.method !== 'POST' || !res || !res.hasOwnProperty('resource') || !res.resource.item) {
      return next();
    }

    const roleId = res.resource.item._id.toString();

    /**
     * Adds the new role to the read_all access of all existing forms using two
     * bulk updateMany operations — O(1) MongoDB round-trips regardless of form count.
     *
     * Previously this iterated every form and issued a sequential updateOne per document,
     * blocking the POST /role response for O(N) time. With large form collections (production
     * multi-tenant deployments) that caused tenant creation to time out.
     *
     * @param _role {string} - the new role's _id as a string
     */
    const updateForms = async function (_role) {
      const query = hook.alter('roleQuery', { deleted: { $eq: null } }, req);
      const FormModel = router.formio.resources.form.model;

      // Case 1: forms that already have a read_all entry — add the role atomically.
      await FormModel.updateMany(
        { ...query, access: { $elemMatch: { type: 'read_all' } } },
        { $addToSet: { 'access.$[elem].roles': _role } },
        { arrayFilters: [{ 'elem.type': 'read_all' }] },
      );

      // Case 2: forms with non-empty access but no read_all entry — create one.
      await FormModel.updateMany(
        {
          ...query,
          'access.0': { $exists: true },
          access: { $not: { $elemMatch: { type: 'read_all' } } },
        },
        { $push: { access: { type: 'read_all', roles: [_role] } } },
      );
    };

    try {
      const fns = await hook.alter('newRoleAccess', [updateForms], req);
      for (const f of fns) {
        await f(roleId);
      }
      return next();
    } catch (err) {
      debug(err);
      return next(err);
    }
  };
};
