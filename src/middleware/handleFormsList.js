"use strict";

require('dotenv').config();

/**
 * Middleware function to handle /form route.
 *
 * @param router
 *
 * @returns {Function}
 */
module.exports = function (router) {
  return async function (req, res, next) {
    if (req.path === "/form" && req.method === "GET") {
      try {
        // Handle formIds filter — set directly on modelQuery/countQuery to bypass resourcejs
        if (req.query.formIds) {
          const ids = req.query.formIds.split(",");
          const idFilter = { _id: { $in: ids } };
          req.modelQuery = (req.modelQuery || router.formio.resources.form.model).find(idFilter);
          req.countQuery = (req.countQuery || router.formio.resources.form.model).find(idFilter);
          delete req.query.formIds;
        }

        // Apply role-based access filter for authenticated non-admin users.
        // Admin users see all forms (no filter). Anonymous users see forms they have
        // explicit or no access restriction on (no filter here — permissionHandler handles it).
        if (req.user?.roles && !req.isAdmin) {
          // Include the anonymous (default) role so authenticated users also see
          // forms accessible to unauthenticated users.
          const defaultRole = await router.formio.resources.role.model
            .findOne({ default: true, deleted: { $eq: null } })
            .lean()
            .select('_id')
            .exec();

          const rolesToCheck = [...(req.user.roles || [])];
          if (defaultRole) {
            rolesToCheck.push(defaultRole._id);
          }

          // Show forms where:
          //   (a) the user's effective roles have explicit read_all access, OR
          //   (b) the form has no read_all restriction at all.
          const accessFilter = {
            $or: [
              { access: { $elemMatch: { type: 'read_all', roles: { $in: rolesToCheck } } } },
              { 'access.type': { $nin: ['read_all'] } },
            ],
          };

          req.modelQuery = (req.modelQuery || router.formio.resources.form.model).find(accessFilter);
          req.countQuery = (req.countQuery || router.formio.resources.form.model).find(accessFilter);
        }

        // Multi-tenancy filter: restrict to the user's tenant.
        if (process.env.MULTI_TENANCY_ENABLED == "true" && !req.isAdmin) {
          if (req.token && !req.token.tenantKey) {
            return res.sendStatus(401);
          }
          if (req.token?.tenantKey) {
            req.query.tenantKey = req.token.tenantKey;
          }
        }
      }
      catch (err) {
        return next(err);
      }
    }
    next();
  };
};
