'use strict';
const _ = require('lodash');

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
     * Async function to add the new role to the read_all access of each form.
     *
     * @param _role
     */
    const updateForms = async function (_role) {
      const query = hook.alter('roleQuery', { deleted: { $eq: null } }, req);

      // Query the forms collection, to build the updated form access list.
      const forms = await router.formio.resources.form.model.find(query).exec();
      if (!forms || forms.length === 0) {
        return;
      }

      for (const form of forms) {
        // Add the new roleId to the access list for read_all (form).
        form.access = form.access || [];

        // Skip forms with no access defined — they have no pre-existing permissions
        // to inherit the new role into, so leave them untouched.
        if (form.access.length === 0) {
          continue;
        }

        let found = false;
        for (let a = 0; a < form.access.length; a++) {
          if (form.access[a].type === 'read_all') {
            form.access[a].roles = form.access[a].roles || [];
            form.access[a].roles.push(_role);
            form.access[a].roles = _.uniq(form.access[a].roles);
            found = true;
          }
        }

        // The read_all permission type was not previously added.
        if (!found) {
          form.access.push({
            type: 'read_all',
            roles: [_role],
          });
        }

        // Save the updated permissions.
        await router.formio.resources.form.model.updateOne(
          { _id: form._id },
          { $set: { access: form.access } },
        );
      }
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
