/* eslint-env mocha */
'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');
const supertest = require('supertest');
const request = require('./formio-supertest');
const logging = require('../src/util/logger');
const { resolveConfig } = require('../src/util/logging/config');
const { requestContext, errorHandler, getClientIp } = require('../src/middleware/requestContext');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CORE_FIELDS = [
  'timestamp',
  'level',
  'logger',
  'service',
  'environment',
  'tenant_id',
  'ip_address',
  'event',
  'message',
];

module.exports = function (app, template) {
  describe('Logging standard', function () {
    let capture;

    before(() => {
      capture = logging.addCaptureTransport();
    });

    beforeEach(() => capture.clear());

    after(() => logging.removeCaptureTransport(capture));

    const records = (predicate) => capture.records.filter(predicate);
    // Earlier suites may finish tests from server code, so make "no request" explicit.
    const outsideRequest = (fn) => logging.context.storage.exit(fn);
    const accessRecords = (requestId) =>
      records(
        (record) =>
          record.logger === 'formio:access' &&
          (requestId === undefined || record.request_id === requestId),
      );

    // A minimal app wired like server.js: request context first, error handler last.
    const testApp = () => {
      const testApp = express();
      testApp.use(requestContext);
      testApp.get('/ok', (req, res) => {
        logging('formio:test').info('Handling request', { item_id: 'abc' });
        res.json({ ok: true });
      });
      testApp.get('/slow', (req, res) => {
        setTimeout(() => {
          logging('formio:test').info('Slow request handled');
          res.json({ ok: true });
        }, 20);
      });
      testApp.get('/health', (req, res) => res.json({ ok: true }));
      testApp.get('/health-report', (req, res) => res.json({ ok: true }));
      testApp.get('/boom', () => {
        throw new Error('Keycloak unreachable');
      });
      testApp.get('/rejected', (req, res, next) => {
        const err = new Error('Not allowed');
        err.status = 403;
        next(err);
      });
      testApp.use(errorHandler);
      return testApp;
    };

    describe('Configuration', () => {
      it('Defaults to INFO, production, json when stdout is not a TTY', () => {
        const config = resolveConfig({}, { isTTY: false });
        assert.equal(config.level, 'info');
        assert.equal(config.environment, 'production');
        assert.equal(config.format, 'json');
        assert.equal(config.service, 'forms-flow-forms');
        assert.equal(config.file.enabled, true);
        assert.equal(config.file.filename, 'formio-%DATE%.log');
        assert.equal(config.file.maxBytes, 10485760);
        assert.equal(config.file.backupCount, 30);
        assert.equal(config.file.datePattern, 'YYYY-MM-DD');
      });

      it('Uses console format on a TTY or outside production', () => {
        assert.equal(resolveConfig({}, { isTTY: true }).format, 'console');
        assert.equal(resolveConfig({ ENVIRONMENT: 'QA' }, { isTTY: false }).format, 'console');
        assert.equal(
          resolveConfig({ ENVIRONMENT: 'QA', LOG_FORMAT: 'json' }, { isTTY: true }).format,
          'json',
        );
      });

      it('Resolves the environment from ENVIRONMENT, then NODE_ENV, lowercased', () => {
        assert.equal(resolveConfig({ ENVIRONMENT: 'Trial', NODE_ENV: 'dev' }).environment, 'trial');
        assert.equal(resolveConfig({ NODE_ENV: 'Development' }).environment, 'development');
      });

      it('Parses LOG_LEVEL case-insensitively and falls back to INFO', () => {
        assert.equal(resolveConfig({ LOG_LEVEL: 'debug' }).level, 'debug');
        assert.equal(resolveConfig({ LOG_LEVEL: 'WARNING' }).level, 'warning');
        assert.equal(resolveConfig({ LOG_LEVEL: 'critical' }).level, 'error');
        const invalid = resolveConfig({ LOG_LEVEL: 'loud' });
        assert.equal(invalid.level, 'info');
        assert.equal(invalid.warnings[0].field, 'LOG_LEVEL');
      });

      it('Treats DEBUG as DEBUG level when LOG_LEVEL is unset', () => {
        assert.equal(resolveConfig({ DEBUG: 'formio:*' }).level, 'debug');
        assert.equal(resolveConfig({ DEBUG: 'formio:*', LOG_LEVEL: 'ERROR' }).level, 'error');
      });

      it('Honors LOG_FOLDER and the LOG_FILE_* variables', () => {
        const legacy = resolveConfig({ LOG_FOLDER: '/var/log/forms' });
        assert.equal(legacy.file.dirname, '/var/log/forms');
        assert.equal(legacy.file.filename, 'formio-%DATE%.log');
        const config = resolveConfig({
          LOG_FILE_PATH: 'out/service.log',
          LOG_FILE_ENABLED: 'false',
          LOG_FILE_MAX_BYTES: '0',
          LOG_FILE_BACKUP_COUNT: '5',
          LOG_FILE_ROTATION_WHEN: 'H',
        });
        assert.equal(config.file.dirname, 'out');
        assert.equal(config.file.filename, 'service-%DATE%.log');
        assert.equal(config.file.enabled, false);
        assert.equal(config.file.maxBytes, 0);
        assert.equal(config.file.backupCount, 5);
        assert.equal(config.file.datePattern, 'YYYY-MM-DD-HH');
      });

      it('Is silent under the test suite unless LOG_LEVEL is set', () => {
        assert.equal(resolveConfig({ TEST_SUITE: '1' }).silent, true);
        assert.equal(resolveConfig({ TEST_SUITE: '1' }).file.enabled, false);
        assert.equal(resolveConfig({ TEST_SUITE: '1', LOG_LEVEL: 'INFO' }).silent, false);
      });
    });

    describe('Record schema', () => {
      it('Emits single-line JSON with every core field', () => {
        logging('formio:test').info('Form submitted successfully', {
          form_id: '123',
          note: 'line one\nline two',
        });
        const [
          record,
        ] = capture.records;
        CORE_FIELDS.forEach((field) => assert(field in record, `Missing ${field}`));
        assert.match(record.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        assert.equal(record.level, 'INFO');
        assert.equal(record.logger, 'formio:test');
        assert.equal(record.service, logging.config.service);
        assert.equal(record.event, 'form_submitted_successfully');
        assert.equal(record.form_id, '123');
        const line = JSON.stringify(record);
        assert(!line.includes('\n'), 'Record must serialize to a single line');
      });

      it('Defaults tenant_id and ip_address outside a request', () => {
        outsideRequest(() => logging('formio:test').info('Background job ran'));
        const [
          record,
        ] = capture.records;
        assert.equal(record.tenant_id, 'default');
        assert.equal(record.ip_address, 'system');
        assert(!('request_id' in record));
      });

      it('Renames reserved keys supplied by the caller', () => {
        logging('formio:test').info('Collision', {
          message: 'caller message',
          level: 'x',
          service: 'y',
          event: 'Not An Event',
        });
        const [
          record,
        ] = capture.records;
        assert.equal(record.message, 'Collision');
        assert.equal(record.message_field, 'caller message');
        assert.equal(record.level_field, 'x');
        assert.equal(record.service_field, 'y');
        assert.equal(record.event_field, 'Not An Event');
        assert.equal(record.level, 'INFO');
      });

      it('Accepts an explicit snake_case event and caller tenant overrides', () => {
        logging('formio:test').info('Custom', { event: 'custom_event', tenant_id: 'abc' });
        const [
          record,
        ] = capture.records;
        assert.equal(record.event, 'custom_event');
        assert.equal(record.tenant_id, 'abc');
      });

      it('Logs stack traces for exceptions and summaries for handled errors', () => {
        const err = new TypeError('Bad value');
        logging('formio:test').exception('Unexpected failure', err);
        logging('formio:test').warning('Expected failure', err);
        const [
          unexpected,
          expected,
        ] = capture.records;
        assert.equal(unexpected.level, 'ERROR');
        assert.equal(unexpected.error, 'TypeError: Bad value');
        assert.match(unexpected.exception, /TypeError: Bad value\n\s+at /);
        assert.equal(expected.level, 'WARNING');
        assert.equal(expected.error, 'TypeError: Bad value');
        assert(!('exception' in expected));
      });

      it('Never logs request objects passed as arguments', () => {
        const req = { method: 'GET', url: '/x', headers: { 'x-jwt-token': 'secret' } };
        logging('formio:test').info('With request', req, 'detail');
        const [
          record,
        ] = capture.records;
        assert.deepEqual(record.args, [
          'detail',
        ]);
        assert(!JSON.stringify(record).includes('secret'));
      });
    });

    describe('Redaction', () => {
      it('Redacts sensitive keys recursively', () => {
        logging('formio:test').info('Sensitive', {
          password: 'p',
          nested: { 'x-jwt-token': 't', Authorization: 'a', client_secret: 's', keep: 'ok' },
          list: [
            { apiKey: 'k' },
          ],
        });
        const [
          record,
        ] = capture.records;
        assert.equal(record.password, '[REDACTED]');
        assert.equal(record.nested['x-jwt-token'], '[REDACTED]');
        assert.equal(record.nested.Authorization, '[REDACTED]');
        assert.equal(record.nested.client_secret, '[REDACTED]');
        assert.equal(record.nested.keep, 'ok');
        assert.equal(record.list[0].apiKey, '[REDACTED]');
      });

      it('Redacts JWTs, auth headers, query secrets and URL credentials in values', () => {
        const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';
        logging('formio:test').info(`Token ${jwt} received`, {
          header: 'Bearer abcdefghijklmnop',
          url: 'https://host/cb?code=xyz&state=1&access_token=abc',
          mongo: 'mongodb://user:pa55word@db:27017/formio',
        });
        const [
          record,
        ] = capture.records;
        assert.equal(record.message, 'Token [REDACTED_JWT] received');
        assert.equal(record.header, 'Bearer [REDACTED]');
        assert.equal(record.url, 'https://host/cb?code=[REDACTED]&state=1&access_token=[REDACTED]');
        assert.equal(record.mongo, 'mongodb://user:[REDACTED]@db:27017/formio');
      });

      it('Truncates deep nesting and large strings', () => {
        let deep = { value: 'leaf' };
        for (let i = 0; i < 10; i++) {
          deep = { child: deep };
        }
        logging('formio:test').info('Deep', { deep, big: 'x'.repeat(9000) });
        const [
          record,
        ] = capture.records;
        assert(JSON.stringify(record.deep).includes('[TRUNCATED]'));
        assert(record.big.endsWith('…[truncated]'));
        assert(Buffer.byteLength(record.big) < 8300);
      });

      it('Masks emails', () => {
        assert.equal(logging.maskEmail('user@example.com'), 'u***@example.com');
      });
    });

    describe('Request context and access log', () => {
      it('Generates a UUIDv4 request id and echoes it once', async () => {
        const res = await supertest(testApp()).get('/ok').expect(200);
        assert.match(res.headers['x-request-id'], UUID_V4);
        assert(!Array.isArray(res.headers['x-request-id']));
        assert.match(res.headers['access-control-expose-headers'], /X-Request-ID/);
      });

      it('Echoes a valid inbound X-Request-ID and replaces an invalid one', async () => {
        const valid = await supertest(testApp()).get('/ok').set('x-request-id', 'abc-123.x:y');
        assert.equal(valid.headers['x-request-id'], 'abc-123.x:y');
        const invalid = await supertest(testApp()).get('/ok').set('X-Request-ID', 'bad id!');
        assert.match(invalid.headers['x-request-id'], UUID_V4);
      });

      it('Binds request fields to records and emits exactly one access record', async () => {
        const res = await supertest(testApp())
          .get('/ok?secret=1')
          .set('X-Forwarded-For', '10.0.0.7, 10.0.0.1')
          .expect(200);
        const requestId = res.headers['x-request-id'];
        const [
          handled,
        ] = records((record) => record.logger === 'formio:test');
        assert.equal(handled.request_id, requestId);
        assert.equal(handled.http_method, 'GET');
        assert.equal(handled.http_path, '/ok');
        assert.equal(handled.ip_address, '10.0.0.7');
        assert.equal(handled.tenant_id, 'default');

        const access = accessRecords(requestId);
        assert.equal(access.length, 1);
        assert.equal(access[0].event, 'http_request_finished');
        assert.equal(access[0].level, 'INFO');
        assert.equal(access[0].status_code, 200);
        assert.equal(typeof access[0].duration_ms, 'number');
      });

      it('Logs health endpoints at DEBUG and similar paths at INFO', async () => {
        const health = await supertest(testApp()).get('/health').expect(200);
        const report = await supertest(testApp()).get('/health-report').expect(200);
        assert.equal(accessRecords(health.headers['x-request-id'])[0].level, 'DEBUG');
        assert.equal(accessRecords(report.headers['x-request-id'])[0].level, 'INFO');
      });

      it('Does not leak context between concurrent requests', async () => {
        const responses = await Promise.all(
          [
            1,
            2,
            3,
            4,
            5,
          ].map((n) => supertest(testApp()).get('/slow').set('X-Request-ID', `req-${n}`)),
        );
        const handled = records((record) => record.message === 'Slow request handled');
        assert.equal(handled.length, 5);
        assert.deepEqual(
          handled.map((record) => record.request_id).sort(),
          responses.map((res) => res.headers['x-request-id']).sort(),
        );
      });

      it('Logs unhandled exceptions and returns a generic 500 echoing X-Request-ID', async () => {
        const res = await supertest(testApp()).get('/boom').set('X-Request-ID', 'boom-1');
        assert.equal(res.status, 500);
        assert.equal(res.headers['x-request-id'], 'boom-1');
        assert.deepEqual(res.body, { message: 'Internal Server Error' });
        assert(!res.text.includes('Keycloak'));

        const [
          unhandled,
        ] = records((record) => record.event === 'unhandled_exception');
        assert.equal(unhandled.level, 'ERROR');
        assert.equal(unhandled.request_id, 'boom-1');
        assert.match(unhandled.exception, /Error: Keycloak unreachable/);

        const access = accessRecords('boom-1');
        assert.equal(access.length, 1);
        assert.equal(access[0].event, 'http_request_failed');
        assert.equal(access[0].level, 'ERROR');
        assert.equal(access[0].status_code, 500);
        assert.equal(access[0].error, 'Error: Keycloak unreachable');
        assert(!('exception' in access[0]));
      });

      it('Keeps client error statuses from the error handler', async () => {
        const res = await supertest(testApp()).get('/rejected').expect(403);
        assert.equal(accessRecords(res.headers['x-request-id'])[0].event, 'http_request_finished');
      });

      it('Extracts the client IP in precedence order', () => {
        const req = (headers, remoteAddress) => ({ headers, socket: { remoteAddress } });
        assert.equal(
          getClientIp(req({ 'x-forwarded-for': ' 1.1.1.1 , 2.2.2.2' }, '3.3.3.3')),
          '1.1.1.1',
        );
        assert.equal(getClientIp(req({ 'x-real-ip': '4.4.4.4' }, '3.3.3.3')), '4.4.4.4');
        assert.equal(getClientIp(req({}, '3.3.3.3')), '3.3.3.3');
        assert.equal(getClientIp(req({})), 'unknown');
      });

      it('Adds the request id to outbound headers inside a request', () => {
        const store = { request_id: 'outbound-1' };
        const headers = logging.context.run(store, () =>
          logging.context.outboundHeaders({ accept: 'application/json' }),
        );
        assert.deepEqual(headers, { accept: 'application/json', 'X-Request-ID': 'outbound-1' });
        assert.deepEqual(
          outsideRequest(() => logging.context.outboundHeaders({})),
          {},
        );
      });
    });

    describe('Server integration', () => {
      it('Echoes X-Request-ID and logs the readiness check at DEBUG', async () => {
        const res = await request(app).get('/checkpoint').set('X-Request-ID', 'checkpoint-1');
        assert.equal(res.headers['x-request-id'], 'checkpoint-1');
        const access = accessRecords('checkpoint-1');
        assert.equal(access.length, 1);
        assert.equal(access[0].level, 'DEBUG');
        assert.equal(access[0].http_path, '/checkpoint');
      });

      it('Exposes both X-Request-ID and x-jwt-token on authenticated responses', async () => {
        const res = await request(app)
          .get('/current')
          .set('x-jwt-token', template.users.admin.token)
          .expect(200);
        const exposed = res.headers['access-control-expose-headers'].toLowerCase();
        assert(exposed.includes('x-request-id'));
        assert(exposed.includes('x-jwt-token'));
        template.users.admin.token = res.headers['x-jwt-token'] || template.users.admin.token;
      });

      it('Logs one access record per business request at INFO', async () => {
        const res = await request(app).get('/form').set('x-jwt-token', template.users.admin.token);
        // The form index is paginated, so it answers 200 or 206.
        assert(
          [
            200,
            206,
          ].includes(res.status),
        );
        const access = accessRecords(res.headers['x-request-id']);
        assert.equal(access.length, 1);
        assert.equal(access[0].level, 'INFO');
        assert.equal(access[0].status_code, res.status);
        assert(!JSON.stringify(capture.records).includes(template.users.admin.token));
      });

      it('Sends X-Request-ID on outbound webhooks', function (done) {
        if (process.env.DOCKER) {
          return this.skip();
        }
        const Helper = require('./helper')(app);
        const helper = new Helper(template.users.admin, template);
        let finished = false;
        const finish = (err) => {
          if (!finished) {
            finished = true;
            server.close();
            done(err);
          }
        };
        const server = http.createServer((req, res) => {
          res.end('{}');
          try {
            assert.equal(req.headers['x-request-id'], 'webhook-1');
            finish();
          } catch (err) {
            finish(err);
          }
        });
        server.listen(0, () => {
          const formName = `logwebhook${Date.now()}`;
          helper
            .form(formName, [
              { type: 'textfield', key: 'name', label: 'Name', input: true },
            ])
            .action({
              title: 'Webhook',
              name: 'webhook',
              handler: [
                'after',
              ],
              method: [
                'create',
              ],
              priority: 1,
              settings: { url: `http://localhost:${server.address().port}/hook`, block: true },
            })
            .execute((err) => {
              if (err) {
                return finish(err);
              }
              request(app)
                .post(`/form/${template.forms[formName]._id}/submission`)
                .set('x-jwt-token', helper.owner.token)
                .set('X-Request-ID', 'webhook-1')
                .send({ data: { name: 'Logging' } })
                .end((err) => err && finish(err));
            });
        });
      });
    });
  });
};
