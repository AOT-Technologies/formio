'use strict';

const inquirer = require('inquirer').default;
const async = require('async');
const fs = require('fs-extra');
const nunjucks = require('nunjucks');
nunjucks.configure([], { watch: false });
const util = require('./src/util/util');
const logger = require('./src/util/logger')('formio:install');

const path = require('path');

module.exports = function (formio, items, done) {
  // The project that was created.
  let project = {};

  // The directory for the client application.
  const directories = {
    client: path.join(__dirname, 'client'),
    app: path.join(__dirname, 'app')
  };

  let templateFile = '';

  /**
   * Download a zip file.
   *
   * @param url
   * @param zipFile
   * @param dir
   * @param done
   * @returns {*}
   */
  const download = function(url, zipFile, dir, done) {
    // Check to see if the client already exists.
    if (fs.existsSync(zipFile)) {
      logger.info('Download file already exists, skipping download', { directory: dir });
      return done();
    }

    const ProgressBar = require('progress');
    logger.info('Downloading', { directory: dir });

    // Download the project.
    let downloadError = null;
    let tries = 0;
    let bar = null;
    (function downloadProject() {
      util.fetch(url)
        .then(function(res) {
          if (
            !res.headers.has('content-disposition') ||
            !parseInt(res.headers.get('content-length'), 10)
          ) {
            if (tries++ > 3) {
              return done('Unable to download project. Please try again.');
            }

            setTimeout(downloadProject, 200);
            return;
          }

          // Setup the progress bar.
          bar = new ProgressBar('  downloading [:bar] :percent :etas', {
            complete: '=',
            incomplete: ' ',
            width: 50,
            total: parseInt(res.headers.get('content-length'), 10)
          });

          res.body.pipe(fs.createWriteStream(zipFile, {
            flags: 'w'
          }));
          res.body.on('data', function(chunk) {
            if (bar) {
              bar.tick(chunk.length);
            }
          });
          res.body.on('error', function(err) {
            downloadError = err;
          });
          res.body.on('end', function() {
            setTimeout(function() {
              done(downloadError);
            }, 100);
          });
        });
    })();
  };

  /**
   * Extract a download to a folder.
   *
   * @param zipFile
   * @param fromDir
   * @param dir
   * @param done
   * @returns {*}
   */
  const extract = function(zipFile, fromDir, dir, done) {
    // See if we need to extract.
    if (fs.existsSync(directories[dir])) {
      logger.info('Directory already exists, skipping extraction', { directory: dir });
      return done();
    }

    // Unzip the contents.
    const AdmZip = require('adm-zip');
    logger.info('Extracting contents', { directory: dir });
    const zip = new AdmZip(zipFile);
    zip.extractAllTo('', true);
    fs.move(fromDir, directories[dir], function(err) {
      if (err) {
        return done(err);
      }

      // Delete the zip file.
      fs.remove(zipFile);

      // Get the package json file.
      let info = {};
      try {
        info = JSON.parse(fs.readFileSync(path.join(directories[dir], 'package.json')));
      }
      catch (err) {
        return done(err);
      }

      // Set local variable to directory path.
      let directoryPath = directories[dir];

      // Change the document root if we need to.
      if (info.formio && info.formio.docRoot) {
        directoryPath = path.join(directories[dir], info.formio.docRoot);
      }

      if (!fs.existsSync(path.join(directoryPath, 'config.template.js'))) {
        return done('Missing config.template.js file');
      }

      // Change the project configuration.
      const config = fs.readFileSync(path.join(directoryPath, 'config.template.js'));
      const newConfig = nunjucks.renderString(config.toString(), {
        domain: process.env.FORMIO_DOMAIN?process.env.FORMIO_DOMAIN : (formio.config.domain ? formio.config.domain : 'https://form.io')
      });
      fs.writeFileSync(path.join(directoryPath, 'config.js'), newConfig);
      done();
    });
  };

  // All the steps in the installation.
  const steps = {
    /**
     * Download the Form.io admin client.
     *
     * @param done
     * @returns {*}
     */
    downloadClient: function(done) {
      if (!items.download) {
        return done();
      }

      // Download the client.
      download(
        'https://github.com/AOT-Technologies/formio-client/archive/refs/heads/master.zip',
        'client.zip',
        'client',
        done
      );
    },

    /**
     * Extract the client.
     *
     * @param done
     * @returns {*}
     */
    extractClient: function(done) {
      if (!items.extract) {
        return done();
      }

      extract('client.zip', 'formio-client-master', 'client', done);
    },

    /**
     * Select the template to use.
     *
     * @param done
     * @return {*}
     */
    whatTemplate: function (done) {
      if (process.env.ROOT_EMAIL) {
        templateFile = 'formsflow-template.json';
        return done();
      }

      logger.info(
        'Which project template would you like to install? Provide the local file path of the ' +
          'template file, or press ENTER to use the default template.',
        { event: 'install_template_prompt' },
      );
      inquirer
        .prompt([
          {
            name: 'templateFile',
            message: 'Enter a local file path or press Enter for the default template.',
            default: './default-template.json',
            validate: function (input) {
              if (!input) {
                return 'Template file is not specified';
              }
              return true;
            },
          },
        ])
        .then((results) => {
          if (!results.templateFile) {
            return done('Cannot find the template file!'.red);
          }

          templateFile = results.templateFile;
          done();
        })
        .catch((err) => {
          done(err);
        });
    },

    /**
     * Import the template.
     * @param done
     */
    importTemplate: function (done) {
      if (!items.import) {
        return done();
      }

      if (!fs.existsSync(templateFile)) {
        logger.warning('Template file not found', { template_file: templateFile });
        return done('Cannot find the template file!'.red);
      }

      let template = {};
      try {
        template = JSON.parse(fs.readFileSync(templateFile));
      } catch (err) {
        return done(err);
      }

      // Get the form.io service.
      logger.info('Importing template', { template_file: templateFile });
      const importer = require('./src/templates/import')({ formio: formio });
      importer.template(template, function (err, template) {
        if (err) {
          return done(err);
        }

        project = template;
        done(null, template);
      });
    },

    /**
     * Create the root user object.
     *
     * @param done
     */
    createRootUser: function (done) {
      if (!items.user) {
        return done();
      }
      logger.info('Creating root user account');
      inquirer
        .prompt([
          {
            name: 'email',
            message: 'Enter your email address for the root account.',
            when: function () {
              return process.env.ROOT_EMAIL ? false : true;
            },
            validate: function (input) {
              if (!input) {
                return 'Email is not specified';
              }
              const pattern =
                /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*$/;
              if (!pattern.test(input)) {
                return 'Must be a valid email';
              }
              return true;
            },
          },
          {
            name: 'password',
            type: 'password',
            message: 'Enter your password for the root account.',
            when: function () {
              return process.env.ROOT_PASSWORD ? false : true;
            },
            validate: function (input) {
              if (!input) {
                return 'Password is not specified';
              }
              return true;
            },
          },
        ])
        .then(function (result) {
          logger.debug('Encrypting root user password');
          formio.encrypt(result.password || process.env.ROOT_PASSWORD, async function (err, hash) {
            if (err) {
              return done(err);
            }

            // Create the root user submission.
            logger.debug('Saving root user account');
            try {
              await formio.resources.submission.model.create({
                form: project.resources.admin._id,
                data: {
                  email: result.email || process.env.ROOT_EMAIL,
                  password: hash,
                },
                roles: [
                  project.roles.administrator._id,
                ],
              });
              return done();
            } catch (err) {
              return done(err);
            }
          });
        })
        .catch(function (err) {
          done(err);
        });
    },
  };
  logger.info('Installing');
  async.series(
    [
      steps.downloadClient,
      steps.extractClient,
      steps.whatTemplate,
      steps.importTemplate,
      steps.createRootUser,
    ],
    function (err) {
      if (err) {
        return done(err);
      }

      logger.info('Install successful');
      done();
    },
  );
};
