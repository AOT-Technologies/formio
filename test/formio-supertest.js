const supertest = require('supertest');
const use = require('superagent-use');
const captureError = require('supertest-capture-error');

const request = (app) => {
  const _request = use(supertest(app));

  // Enable automatic retries in cases of network flakiness
  _request.use((test) => {
    test.retry(10);
  });

  // Cleaner messages
  _request.use(
    captureError((error, test) => {
      try {
        let body;
        try {
          body = JSON.parse(test.res.text);
        } catch {
          body = test.res.text;
        }
        error.message += '\n\nResponse: ' + JSON.stringify(body, null, 4);
      } catch (err) {
        console.warn(err);
      }

      error.stack = '';
    }),
  );

  return _request;
};

module.exports = request;
