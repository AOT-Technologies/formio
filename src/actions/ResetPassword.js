'use strict';

const util = require('../util/util');
const jwt = require('jsonwebtoken');
const _ = require('lodash');
const logger = require('../util/logger')('formio:action:passrest');

// Default allows for LONG passphrases, but not DoS big
// Refrence: next line is ~70 characters
const MAX_PASSWORD_LENGTH = process.env.MAX_PASSWORD_LENGTH || 200;

module.exports = (router) => {
  const Action = router.formio.Action;
  const hook = require('../util/hook')(router.formio);
  const emailer = require('../util/email')(router.formio);
  const ecode = router.formio.util.errorCodes;

  /**
   * ResetPasswordAction class.
   *   This class is used to implement Forgot Password.
   */
  class ResetPasswordAction extends Action {
    static info(req, res, next) {
      next(null, {
        name: 'resetpass',
        title: 'Reset Password',
        description: 'Provides a way to reset a password field.',
        defaults: {
          handler: [
            'after',
            'before',
          ],
          method: [
            'form',
            'create',
          ],
        },
        access: {
          handler: false,
          method: false,
        },
      });
    }

    static async settingsForm(req, res, next) {
      try {
        // Get the available email transports.
        const availableTransports = await emailer.availableTransports(req);

        const basePath = hook.alter('path', '/form', req);
        const dataSrc = `${basePath}/${req.params.formId}/components`;

        // Return the reset password information.
        return next(null, [
          {
            type: 'select',
            input: true,
            label: 'Resources',
            key: 'resources',
            placeholder: 'Select the resources we should reset password against.',
            dataSrc: 'url',
            data: { url: `${basePath}?type=resource` },
            authenticate: true,
            valueProperty: '_id',
            template: '<span>{{ item.title }}</span>',
            multiple: true,
            validate: {
              required: true,
            },
          },
          {
            type: 'select',
            input: true,
            label: 'Username Field',
            key: 'username',
            placeholder: 'Select the username field',
            template: '<span>{{ item.label || item.key }}</span>',
            dataSrc: 'url',
            data: { url: dataSrc },
            valueProperty: 'key',
            multiple: false,
            validate: {
              required: true,
            },
          },
          {
            type: 'select',
            input: true,
            label: 'Password Field',
            key: 'password',
            placeholder: 'Select the password field',
            template: '<span>{{ item.label || item.key }}</span>',
            dataSrc: 'url',
            data: { url: dataSrc },
            valueProperty: 'key',
            multiple: false,
            validate: {
              required: true,
            },
          },
          {
            label: 'Reset Link URL',
            key: 'url',
            inputType: 'text',
            defaultValue: '',
            input: true,
            placeholder: 'Enter the URL they should go to reset their password.',
            type: 'textfield',
            multiple: false,
            validate: {
              required: true,
            },
          },
          {
            label: 'Reset Password Button Label',
            key: 'label',
            inputType: 'text',
            defaultValue: 'Email Reset Password Link',
            input: true,
            placeholder: '',
            type: 'textfield',
            multiple: false,
          },
          {
            type: 'select',
            input: true,
            label: 'Transport',
            key: 'transport',
            placeholder: 'Select the email transport.',
            template: '<span>{{ item.title }}</span>',
            defaultValue: 'default',
            dataSrc: 'json',
            data: {
              json: JSON.stringify(availableTransports),
            },
            valueProperty: 'transport',
            multiple: false,
            validate: {
              required: true,
            },
          },
          {
            label: 'From:',
            key: 'from',
            inputType: 'email',
            defaultValue: router.formio.config.defaultEmailSource,
            input: true,
            placeholder: 'Send the email from the following address',
            type: 'textfield',
            multiple: false,
          },
          {
            label: 'Subject',
            key: 'subject',
            inputType: 'text',
            defaultValue: 'You requested a password reset',
            input: true,
            placeholder: '',
            type: 'textfield',
            multiple: false,
          },
          {
            label: 'Message',
            key: 'message',
            type: 'textarea',
            defaultValue:
              '<p>Forgot your password? No problem.</p><p><a href="{{ resetlink }}">' +
              'Click here to reset your password</a></p> ',
            multiple: false,
            rows: 3,
            suffix: '',
            prefix: '',
            placeholder: '',
            input: true,
          },
        ]);
      } catch (err) {
        logger.warning(ecode.emailer.ENOTRANSP, err, { error_code: 'ENOTRANSP' });
        return next(err);
      }
    }

    /**
     * Return a submission based on the token.
     *
     * @param req
     * @param token
     * @param next
     */
    async getSubmission(req, token, next) {
      // Only continue if the resources are provided.
      if (!token.resources || !token.resources.length) {
        return;
      }

      // Set the name of the key for the mongo query.
      const usernamekey = `data.${this.settings.username}`;

      // Create the query.
      const query = {
        deleted: { $eq: null },
      };

      query[usernamekey] = {
        $regex: new RegExp(`^${util.escapeRegExp(token.username)}$`),
        $options: 'i',
      };
      query.form = { $in: _.map(token.resources) };

      // Perform a mongo query to find the submission.
      const submissionModel = req.submissionModel || router.formio.resources.submission.model;
      try {
        const submission = await submissionModel.findOne(hook.alter('submissionQuery', query, req));
        if (!submission) {
          logger.debug(ecode.submission.ENOSUB, {
            error_code: 'ENOSUB',
            resource_count: token.resources.length,
          });
          return next(ecode.submission.ENOSUB);
        }

        // Submission found.
        return next(null, submission);
      } catch (err) {
        logger.exception(ecode.submission.ENOSUB, err, { error_code: 'ENOSUB' });
        return next(ecode.submission.ENOSUB);
      }
    }

    /**
     * Update a submission for the password.
     *
     * @param req
     * @param token
     * @param password
     * @param next
     */
    updatePassword(req, token, password, next) {
      // Validate password matches length restrictions
      // FIO-4741
      if ((password || '').length > MAX_PASSWORD_LENGTH) {
        return next(ecode.auth.EPASSLENGTH);
      }

      // Get the submission.
      this.getSubmission(req, token, (err, submission) => {
        // Make sure we found the user.
        if (err || !submission) {
          logger.warning(ecode.user.ENOUSER, { error_code: 'ENOUSER' });
          return next(ecode.user.ENOUSER);
        }

        // Get the name of the password field.
        if (!this.settings.password) {
          logger.error(ecode.auth.EPASSFIELD, { error_code: 'EPASSFIELD', form_id: req.formId });
          return next(ecode.auth.EPASSFIELD);
        }

        // Manually encrypt and update the password.
        router.formio.encrypt(password, async (err, hash) => {
          if (err) {
            logger.exception(ecode.auth.EPASSRESET, err, {
              error_code: 'EPASSRESET',
              submission_id: submission._id,
            });
            return next(ecode.auth.EPASSRESET);
          }

          const setValue = {
            [`data.${this.settings.password}`]: hash,
          };

          // Update the password.
          const submissionModel = req.submissionModel || router.formio.resources.submission.model;
          try {
            await submissionModel.updateOne({ _id: submission._id }, { $set: setValue });

            // The submission was saved!
            return next(null, submission);
          } catch (err) {
            logger.exception(ecode.auth.EPASSRESET, err, {
              error_code: 'EPASSRESET',
              submission_id: submission._id,
            });
            return next(ecode.auth.EPASSRESET);
          }
        });
      });
    }

    /**
     * Initialize the action.
     */
    async initialize(method, req, res, next) {
      // See if we have a reset password token.
      const hasResetToken = Boolean(req.tempToken && req.tempToken.type === 'resetpass');
      if (!hasResetToken && method === 'create') {
        // Figure out the username data.
        const username = _.get(req.body.data, this.settings.username);

        // Make sure they have a username.
        if (!username) {
          logger.warning(ecode.user.ENONAMEP, { error_code: 'ENONAMEP', form_id: req.formId });
          return res.status(400).send('You must provide a username to reset your password.');
        }

        // Create a token.
        const token = {
          username,
          form: req.formId,
          resources: this.settings.resources,
          temp: true,
          type: 'resetpass',
        };

        // Load the form for this request.
        try {
          const form = await router.formio.cache.loadCurrentForm(req);
          // Look up the user.
          this.getSubmission(req, token, async (err, submission) => {
            if (err || !submission) {
              logger.warning(ecode.user.ENOUSER, { error_code: 'ENOUSER', form_id: req.formId });
              return next(ecode.user.ENOUSER);
            }

            // Generate a temporary token for resetting their password.
            const resetToken = jwt.sign(token,  process.env.FORMIO_JWT_SECRET||router.formio.config.jwt.secret , {
              expiresIn: 5 * 60,
            });

            // Create the reset link and add it to the email parameters.
            const params = {
              resetlink: `${this.settings.url}?x-jwt-token=${resetToken}`,
            };

            const { transport, from, subject, message } = this.settings;

            // Now send them an email.
            try {
              await emailer.send(
                req,
                res,
                {
                  transport,
                  from,
                  emails: username,
                  subject,
                  message,
                },
                _.assign(params, req.body, { form }),
              );
              // Let them know an email is on its way.
              res.status(200).json({
                message: 'Password reset email was sent.',
              });
            } catch (err) {
              logger.exception(ecode.emailer.ESENDMAIL, err, {
                error_code: 'ESENDMAIL',
                form_id: req.formId,
                submission_id: submission._id,
              });
            }
          });
        } catch (err) {
          logger.warning(ecode.cache.EFORMLOAD, err, { error_code: 'EFORMLOAD', form_id: req.formId });
          return next(err);
        }
      } else {
        // Set the username for validation purposes.
        if (req.tempToken && req.tempToken.type === 'resetpass') {
          _.set(req.body.data, this.settings.username, req.tempToken.username);
        }

        return next();
      }
    }

    /**
     * Perform a forgot password implementation.
     *
     * @param handler
     * @param method
     * @param req
     *   The Express request object.
     * @param res
     *   The Express response object.
     * @param next
     *   The callback function to execute upon completion.
     *
     * @returns {*}
     */
    resolve(handler, method, req, res, next) {
      // See if we have a reset password token.
      const hasResetToken = Boolean(req.tempToken && req.tempToken.type === 'resetpass');

      // Only show the reset password username field on form get.
      if (
        handler === 'after' &&
        method === 'form' &&
        req.query.hasOwnProperty('live') &&
        parseInt(req.query.live, 10) === 1 &&
        res.hasOwnProperty('resource') &&
        res.resource.hasOwnProperty('item') &&
        res.resource.item._id
      ) {
        // Modify the form based on if there is a reset token or not.
        util.eachComponent(res.resource.item.components, (component) => {
          if (!hasResetToken && component.type === 'button' && component.action === 'submit') {
            component.label = this.settings.label;
          } else if (
            (!hasResetToken && component.key !== this.settings.username) ||
            (hasResetToken && component.key === this.settings.username)
          ) {
            component.type = 'hidden';
            if (component.validate) {
              component.validate.required = false;
            }
          }
        });

        return next();
      }

      // Handle the request after they have come back.
      else if (hasResetToken && handler === 'before' && method === 'create') {
        if (!req.tempToken.username || !req.tempToken.form) {
          logger.warning(ecode.auth.ERESETTOKEN, { error_code: 'ERESETTOKEN' });
          return res.status(400).send(ecode.auth.ERESETTOKEN);
        }

        // Get the password
        const password = _.get(req.submission.data, this.settings.password);
        if (!password) {
          logger.warning(ecode.auth.ENOPASSP, { error_code: 'ENOPASSP' });
          return next(ecode.auth.ENOPASSP);
        }

        // Update the password.
        this.updatePassword(req, req.tempToken, password, function (err) {
          if (err) {
            logger.warning(ecode.auth.EPASSRESET, {
              error_code: 'EPASSRESET',
              reason: err.message || err,
            });
            return res.status(400).send('Unable to update the password. Please try again.');
          }
          res.status(200).send({
            message: 'Password was successfully updated.',
          });
        });
      } else {
        return next();
      }
    }
  }

  ResetPasswordAction.access = {
    handler: false,
    method: false,
  };

  // Return the ResetPasswordAction.
  return ResetPasswordAction;
};
