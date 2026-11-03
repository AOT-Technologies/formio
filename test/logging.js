/* eslint-env mocha */
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const cors = require('cors');
const express = require('express');
const proxyaddr = require('proxy-addr');
const supertest = require('supertest');
const request = require('./formio-supertest');
const logging = require('../src/util/logger');
const util = require('../src/util/util');
const { corsOrigin } = require('../server');
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
      // Fails after the response started, like a streamed export whose cursor errors.
      testApp.get('/stream-fail', (req, res, next) => {
        res.write('partial');
        next(new Error('Cursor failed'));
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

      it('Keeps only valid TRUSTED_PROXIES entries and warns about the rest', () => {
        assert.equal(resolveConfig({}).trustedProxies, null);
        const config = resolveConfig({ TRUSTED_PROXIES: 'loopback, 10.0.0.0/8, bogus' });
        assert.deepEqual(config.trustedProxies, [
          'loopback',
          '10.0.0.0/8',
        ]);
        assert.deepEqual(config.warnings, [
          { field: 'TRUSTED_PROXIES', value: 'bogus', fallback: 'ignored' },
        ]);
        // Set but entirely invalid: trust no proxy rather than every header.
        assert.deepEqual(resolveConfig({ TRUSTED_PROXIES: 'bogus' }).trustedProxies, []);
      });

      it('Matches only the archives of the configured log file', () => {
        const { archivePattern } = resolveConfig({ LOG_FILE_PATH: 'out/service.log' }).file;
        [
          'service-2026-11-03.log.gz',
          'service-2026-11-03-05.log.1.gz',
        ].forEach((name) => assert(archivePattern.test(name), name));
        [
          'service-2026-11-03.log',
          'formio-2026-11-03.log.gz',
          'service-a-2026-11-03.log.gz',
          'README',
        ].forEach((name) => assert(!archivePattern.test(name), name));
      });

      it('Caps only its own archives in a shared archive folder', async () => {
        const dirname = fs.mkdtempSync(path.join(os.tmpdir(), 'formio-logs-'));
        try {
          const { archiveDirname, archivePattern } = resolveConfig({
            LOG_FILE_PATH: path.join(dirname, 'formio.log'),
          }).file;
          fs.mkdirSync(archiveDirname);
          [
            'formio-2026-11-01.log.gz',
            'formio-2026-11-02.log.gz',
            'formio-2026-11-02.log.1.gz',
            'formio-2026-11-02.log.2.gz',
            'formio-a-2026-10-01.log.gz',
            'other-2026-10-01.log.gz',
            'README',
          ].forEach((name) => fs.writeFileSync(path.join(archiveDirname, name), ''));
          const rotated = path.join(dirname, 'formio-2026-11-03.log.gz');
          fs.writeFileSync(rotated, '');

          await logging.archiveFile(rotated, { archiveDirname, backupCount: 2, archivePattern });

          // Keeps the two newest by date and chunk, not by name (`.log.gz` is the oldest chunk).
          assert.deepEqual(fs.readdirSync(archiveDirname).sort(), [
            'README',
            'formio-2026-11-02.log.2.gz',
            'formio-2026-11-03.log.gz',
            'formio-a-2026-10-01.log.gz',
            'other-2026-10-01.log.gz',
          ]);
        } finally {
          fs.rmSync(dirname, { recursive: true, force: true });
        }
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

      it('Uses fixed events for the legacy util.log and util.error adapters', () => {
        util.log('Loaded 12 forms for tenant x9');
        util.log({ forms: 12 });
        util.error(new Error('E11000 duplicate key error collection: formio.submissions'));
        const [
          text,
          object,
          error,
        ] = records((record) => record.logger === 'formio:util');
        assert.equal(text.event, 'legacy_log');
        assert.equal(text.message, 'Loaded 12 forms for tenant x9');
        assert.equal(object.event, 'legacy_log');
        assert.equal(error.event, 'legacy_error');
        assert.equal(error.level, 'ERROR');
        assert.match(error.error, /^Error: E11000 duplicate key/);
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

      it('Escapes line breaks in console output', () => {
        const record = logging.buildRecord('info', 'formio:test', 'Form cache hit', [
          { form_id: 'abc\r\n2026-01-01T00:00:00.000Z INFO    [formio:test] forged' },
        ]);
        record.level = 'INFO';
        const line = logging.consoleFormat.transform(record)[Symbol.for('message')];
        assert(!/[\r\n]/.test(line), 'Console output must stay on one line');
        assert(line.includes('form_id=abc\\r\\n2026'));
      });

      it('Reports transport failures on stderr instead of exiting', () => {
        const failing = logging.addCaptureTransport();
        const write = process.stderr.write;
        const lines = [];
        process.stderr.write = (chunk) => lines.push(String(chunk)) > 0;
        try {
          const err = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
          failing.emit('error', err);
        } finally {
          process.stderr.write = write;
          logging.removeCaptureTransport(failing);
        }
        assert.equal(lines.length, 1);
        const record = JSON.parse(lines[0]);
        assert.equal(record.level, 'ERROR');
        assert.equal(record.logger, 'formio:logging');
        assert.equal(record.event, 'logging_transport_failed');
        assert.equal(record.error, 'Error: ENOSPC: no space left on device');
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

      it('Redacts camelCase and upper-case key variants', () => {
        logging('formio:test').info('Keys', {
          privateKey: 'k1',
          PRIVATEKEY: 'k2',
          'private-key': 'k3',
          clientSecret: 's',
        });
        const [
          record,
        ] = capture.records;
        assert.equal(record.privateKey, '[REDACTED]');
        assert.equal(record.PRIVATEKEY, '[REDACTED]');
        assert.equal(record['private-key'], '[REDACTED]');
        assert.equal(record.clientSecret, '[REDACTED]');
      });

      it('Masks emails in free text', () => {
        logging('formio:test').warning(
          'Send failed',
          new Error('550 5.1.1 <jane@example.org>: Recipient address rejected'),
          { recipient: logging.maskEmail('john@example.org') },
        );
        const [
          record,
        ] = capture.records;
        assert.equal(
          record.error,
          'Error: 550 5.1.1 <j***@example.org>: Recipient address rejected',
        );
        assert.equal(record.recipient, 'j***@example.org');
        assert(!JSON.stringify(record).includes('jane@'));
      });

      it('Logs shared references in full and only cycles as [CIRCULAR]', () => {
        const shared = { v: 1 };
        const loop = { name: 'loop' };
        loop.self = loop;
        logging('formio:test').info('References', { a: shared, b: shared, loop });
        const [
          record,
        ] = capture.records;
        assert.deepEqual(record.a, { v: 1 });
        assert.deepEqual(record.b, { v: 1 });
        assert.equal(record.loop.self, '[CIRCULAR]');
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
        assert.equal(record.event, 'token_redacted_jwt_received');
        assert.equal(record.header, 'Bearer [REDACTED]');
        assert.equal(record.url, 'https://host/cb?code=[REDACTED]&state=1&access_token=[REDACTED]');
        assert.equal(record.mongo, 'mongodb://user:[REDACTED]@db:27017/formio');
      });

      it('Derives automatic events from the redacted text', () => {
        logging('formio:test').warning(new Error('connect mongodb://user:pa55word@db/formio failed'));
        const [
          record,
        ] = capture.records;
        assert.equal(record.event, 'connect_mongodb_user_redacted_db_formio_failed');
        assert(!JSON.stringify(record).includes('pa55word'));
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

      it('Redacts secrets in the request path, including unmatched routes', async () => {
        const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';
        const res = await supertest(testApp()).get(`/files/${jwt}`).expect(404);
        const access = accessRecords(res.headers['x-request-id']);
        assert.equal(access.length, 1);
        assert.equal(access[0].http_path, '/files/[REDACTED_JWT]');
        assert(!JSON.stringify(access).includes(jwt));
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

      it('Rejects disallowed CORS origins with a 403 JSON body', async () => {
        const corsApp = express();
        corsApp.use(requestContext);
        corsApp.use(
          cors({
            origin: corsOrigin([
              'http://allowed.example',
            ]),
          }),
        );
        corsApp.get('/ok', (req, res) => res.json({ ok: true }));
        corsApp.use(errorHandler);

        const allowed = await supertest(corsApp)
          .get('/ok')
          .set('Origin', 'http://allowed.example')
          .expect(200);
        assert.equal(allowed.headers['access-control-allow-origin'], 'http://allowed.example');

        const res = await supertest(corsApp)
          .get('/ok')
          .set('Origin', 'http://evil.example')
          .set('X-Request-ID', 'cors-1')
          .expect(403);
        assert.deepEqual(res.body, {
          message: 'The CORS policy for this site does not allow access from the specified Origin.',
        });
        assert(!('access-control-allow-origin' in res.headers));
        const rejected = records(
          (record) => record.event === 'http_request_rejected' && record.request_id === 'cors-1',
        );
        assert.equal(rejected.length, 1);
        assert.equal(rejected[0].level, 'WARNING');
        assert.equal(rejected[0].status_code, 403);
        const access = accessRecords('cors-1');
        assert.equal(access.length, 1);
        assert.equal(access[0].status_code, 403);
      });

      it('Logs failures after the response started as failed, not disconnected', async () => {
        // The handler closes the connection, so the client sees a socket hang-up.
        await supertest(testApp())
          .get('/stream-fail')
          .set('X-Request-ID', 'stream-1')
          .catch(() => {});
        await new Promise((resolve) => setImmediate(resolve));

        const unhandled = records(
          (record) => record.event === 'unhandled_exception' && record.request_id === 'stream-1',
        );
        assert.equal(unhandled.length, 1);
        assert.match(unhandled[0].exception, /Error: Cursor failed/);

        const access = accessRecords('stream-1');
        assert.equal(access.length, 1);
        assert.equal(access[0].event, 'http_request_failed');
        assert.equal(access[0].status_code, 500);
        assert.equal(access[0].error, 'Error: Cursor failed');
        assert(!('client_disconnected' in access[0]));
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

      it('Uses forwarded addresses only when they are valid IPs', () => {
        const req = (headers, remoteAddress) => ({ headers, socket: { remoteAddress } });
        assert.equal(
          getClientIp(
            req({ 'x-forwarded-for': 'not-an-ip, 2.2.2.2', 'x-real-ip': '4.4.4.4' }, '3.3.3.3'),
          ),
          '4.4.4.4',
        );
        assert.equal(
          getClientIp(
            req({ 'x-forwarded-for': 'x'.repeat(16000), 'x-real-ip': '<script>' }, '3.3.3.3'),
          ),
          '3.3.3.3',
        );
        assert.equal(getClientIp(req({ 'x-forwarded-for': '1.2.3.4:5678' })), '1.2.3.4');
        assert.equal(getClientIp(req({ 'x-forwarded-for': '[2001:db8::1]:443' })), '2001:db8::1');
        assert.equal(getClientIp(req({ 'x-forwarded-for': '2001:db8::1' })), '2001:db8::1');
      });

      it('Believes forwarded headers only from trusted proxies when configured', () => {
        const req = (headers, remoteAddress) => ({ headers, socket: { remoteAddress } });
        const trust = proxyaddr.compile('10.0.0.0/8');
        // The client sent the first entry; the trusted proxy appended the real address.
        const spoofed = { 'x-forwarded-for': '198.51.100.1, 203.0.113.5' };
        assert.equal(getClientIp(req(spoofed, '10.0.0.2'), trust), '203.0.113.5');
        assert.equal(
          getClientIp(
            req({ 'x-forwarded-for': '198.51.100.1, 203.0.113.5, 10.0.0.9' }, '10.0.0.2'),
            trust,
          ),
          '203.0.113.5',
        );
        // Headers from an untrusted peer are ignored.
        assert.equal(getClientIp(req(spoofed, '192.0.2.7'), trust), '192.0.2.7');
        assert.equal(getClientIp(req({ 'x-real-ip': '4.4.4.4' }, '10.0.0.2'), trust), '4.4.4.4');
        assert.equal(getClientIp(req({ 'x-real-ip': '4.4.4.4' }, '192.0.2.7'), trust), '192.0.2.7');
        // A malformed hop falls back to the peer, and an empty trust list believes no header.
        assert.equal(
          getClientIp(req({ 'x-forwarded-for': '<script>' }, '10.0.0.2'), trust),
          '10.0.0.2',
        );
        assert.equal(getClientIp(req(spoofed, '10.0.0.2'), proxyaddr.compile([])), '10.0.0.2');
        assert.equal(getClientIp(req(spoofed), trust), 'unknown');
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

      it('Logs routine token and user events at DEBUG', async () => {
        const res = await request(app)
          .get('/current')
          .set('x-jwt-token', template.users.admin.token)
          .expect(200);
        template.users.admin.token = res.headers['x-jwt-token'] || template.users.admin.token;
        const requestRecords = records(
          (record) => record.request_id === res.headers['x-request-id'],
        );
        const routine = requestRecords.filter((record) =>
          [
            'token',
            'user',
          ].includes(record.event),
        );
        assert(routine.length > 0, 'Missing routine token records');
        routine.forEach((record) => assert.equal(record.level, 'DEBUG'));
        assert.equal(accessRecords(res.headers['x-request-id'])[0].level, 'INFO');
      });

      it('Masks user names in audit events', () => {
        const formio = app.formio;
        const audit = formio.config.audit;
        formio.config.audit = true;
        try {
          outsideRequest(() => {
            formio.audit('EAUTH_PASSWORD', {}, 'jdoe');
            formio.audit('EAUTH_NOUSER', {}, 'jane@example.org');
          });
        } finally {
          formio.config.audit = audit;
        }
        const audits = records((record) => record.audit === true);
        assert.deepEqual(
          audits.map((record) => [
            record.event,
            record.details,
          ]),
          [
            [
              'eauth_password',
              [
                'j***',
              ],
            ],
            [
              'eauth_nouser',
              [
                'j***@example.org',
              ],
            ],
          ],
        );
      });

      it('Passes other router errors to the error handler', async () => {
        // body-parser rejects a non-UTF charset with a 415, which used to be ignored.
        const res = await request(app)
          .post('/form')
          .set('Content-Type', 'application/json; charset=latin1')
          .send('{}')
          .expect(415);
        assert.equal(Object.keys(res.body).length, 1);
        assert.match(res.body.message, /unsupported charset/i);
        const requestId = res.headers['x-request-id'];
        const rejected = records(
          (record) => record.event === 'http_request_rejected' && record.request_id === requestId,
        );
        assert.equal(rejected.length, 1);
        assert.equal(rejected[0].level, 'WARNING');
        assert.equal(rejected[0].status_code, 415);
        const access = accessRecords(requestId);
        assert.equal(access.length, 1);
        assert.equal(access[0].event, 'http_request_finished');
        assert.equal(access[0].status_code, 415);
      });

      it('Answers malformed JSON with a 400, as before', async () => {
        const res = await request(app)
          .post('/form')
          .set('Content-Type', 'application/json')
          .send('{bad')
          .expect(400);
        const access = accessRecords(res.headers['x-request-id']);
        assert.equal(access.length, 1);
        assert.equal(access[0].status_code, 400);
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

      it('Logs webhook failures without the URL or response', function (done) {
        if (process.env.DOCKER) {
          return this.skip();
        }
        const Helper = require('./helper')(app);
        const helper = new Helper(template.users.admin, template);
        // Reserve a port, then close it so the webhook is refused.
        const server = http.createServer();
        server.listen(0, () => {
          const port = server.address().port;
          server.close(() => {
            const formName = `logwebhookfail${Date.now()}`;
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
                settings: { url: `http://localhost:${port}/hook?name={{name}}`, block: true },
              })
              .execute((err) => {
                if (err) {
                  return done(err);
                }
                request(app)
                  .post(`/form/${template.forms[formName]._id}/submission`)
                  .set('x-jwt-token', helper.owner.token)
                  .send({ data: { name: 'Sensitive' } })
                  .end((err, res) => {
                    try {
                      const [
                        failure,
                      ] = records((record) => record.event === 'webhook_request_failed');
                      assert(failure, 'Missing webhook failure record');
                      assert.equal(failure.level, 'WARNING');
                      assert.equal(failure.error_code, 'ECONNREFUSED');
                      assert(!('reason' in failure));
                      // The blocking failure also reaches the actions log and the response.
                      assert.equal(res.status, 400);
                      assert.match(res.body.message, /^request to \[URL\] failed/);
                      assert(!res.text.includes('Sensitive'));
                      assert(!JSON.stringify(capture.records).includes('Sensitive'));
                      done();
                    } catch (err) {
                      done(err);
                    }
                  });
              });
          });
        });
      });
    });
  });
};
