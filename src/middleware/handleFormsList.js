"use strict";

const { ObjectId } = require('../util/util');

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
    // Only check access for GET requests to /form route
    if (req.path === "/form" && req.method === "GET") {
      const query = {};

      if(!req.user?.roles){
        return res.sendStatus(401);
      }
      // If specific formIds are provided, include them in query
      if (req.query.formIds) {
        query._id = { $in: req.query.formIds.split(",") };
        delete req.query.formIds;
      }
      if(!req.isAdmin){
        // Look up the anonymous (default) role so authenticated users can also see
        // forms that are readable by unauthenticated users.
        const defaultRole = await router.formio.resources.role.model
          .findOne({ default: true, deleted: { $eq: null } })
          .lean()
          .select('_id')
          .exec();

        const rolesToCheck = [...(req.user.roles || [])];
        if (defaultRole) {
          rolesToCheck.push(defaultRole._id);
        }

        // Include forms where the user's effective roles (or anonymous) have
        // explicit read_all access, OR forms with no read_all restriction at all.
        query.$or = [
          { 'access': { $elemMatch: { 'type': 'read_all', 'roles': { $in: rolesToCheck } } } },
          { 'access': { $not: { $elemMatch: { 'type': 'read_all' } } } },
        ];
      }
      
      if(process.env.MULTI_TENANCY_ENABLED == "true" && !req.isAdmin){
        // For anonymous users (no token), skip tenant key check for form submissions
        // Only enforce tenant key for authenticated users
        if(req.token && !req.token.tenantKey){
          return res.sendStatus(401);
        }
        // Only set tenantKey if token exists and has tenantKey
        if(req.token?.tenantKey){
          req.query.tenantKey = req.token.tenantKey
        }
      }
      // Merge any additional query parameters
      req.query = { ...query, ...req.query };
    }
    next();
  };
};
