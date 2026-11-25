# forms-flow Logging Standard

This specification defines the machine-parseable logging contract, correlation lifecycle, redaction rules, and recipes required for all forms-flow services.

---

## 1. Record Schema Contract

Every log record MUST be a single-line UTF-8 JSON object terminated by `\n`. Multi-line strings (e.g. stack traces) MUST have newlines escaped inside JSON strings.

### 1.1 Required Fields (Present on Every Record)

| Field | Type | Description & Format Rules |
|---|---|---|
| `timestamp` | string | ISO-8601 UTC with `Z` suffix and microsecond/millisecond precision. E.g. `2026-06-12T08:15:30Z` or `2026-09-24T04:42:27.883857Z`. |
| `level` | string | Uppercase standard: `INFO`, `WARNING`, `ERROR`, `DEBUG`. Platforms map equivalents (`TRACE`→`DEBUG`, `SEVERE`/`FATAL`→`ERROR`). Ingestion pipelines accept lowercase for backward compatibility. |
| `service` | string | Canonical service generating the log (e.g. `forms-flow-api`, `forms-flow-process-gateway`, `forms-flow-bpm`). |
| `environment` | string | Deployment environment: `Development`, `QA`, `Trial`, `Production` (case-insensitive in config). |
| `tenant_id` | string | Tenant associated with the event, or `"default"` if unauthenticated, single-tenant, or outside a request. |
| `message` | string | **Human-readable description** in plain English explaining the event. E.g. `"Form submitted successfully"`, `"HTTP request finished"`, `"Retrying connection to document service"`. |
| `event` | string | **Machine-parseable identifier** in `snake_case` representing the event type. E.g. `form_submitted`, `http_request_finished`, `service_starting`, `document_upload_failed`, `unhandled_exception`. Auto-derived if omitted. |

### 1.2 Request-Scoped Fields (Present During HTTP Requests)

| Field | Type | Rules |
|---|---|---|
| `request_id` | string | Correlation UUID or validated client id (see §3). |
| `http_method` | string | Uppercase HTTP verb (`GET`, `POST`, etc.). |
| `http_path` | string | URL path without query string. |
| `user_name` | string | Authenticated principal (`preferred_username` claim). Omit for anonymous requests. |

### 1.3 Optional & Conditional Fields

| Field | Type | Usage |
|---|---|---|
| `exception` | string | Escaped multi-line stack trace for unexpected errors. |
| `error` | string | Short summary string (`str(exc)`) for handled/expected errors. |
| `status_code` | integer | HTTP status code on access records and outbound responses. |
| `duration_ms` | float | Execution duration in milliseconds rounded to 2 decimal places. |
| `http_route` | string | Framework route template (e.g. `/api/v1/task/{task_id}`) when available. |
| `job_id`, `job_name` | string | Identifiers for scheduled jobs or message consumers. |
| `trace_id`, `span_id` | string | OpenTelemetry W3C trace/span identifiers in lowercase hex when enabled. |
| *custom keys* | any | Contextual event kwargs (`task_id`, `form_id`, etc.) in `snake_case`. |

### 1.4 Schema Constraints

1. **Key Naming:** All keys MUST be `snake_case`.
2. **Reserved Key Collisions:** If a call site supplies a reserved key (`timestamp`, `level`, `logger`, `service`, `environment`, `message`, `event`), append `_field` to the caller key (e.g. `message_field`). Never drop records or crash.
3. **Call-site Override:** Explicit kwargs for `tenant_id`, `user_name`, or `ip_address` override context defaults.
4. **Payload Limits:** String values exceeding 8 KiB (16 KiB for `exception`) SHOULD be truncated with `…[truncated]`. Never log full request/response bodies.

### 1.5 JSON Record Examples

**HTTP Access Record:**
```json
{"status_code": 200, "duration_ms": 183.5, "http_method": "GET", "ip_address": "127.0.0.1", "user_name": "service.user", "request_id": "d3d0f20b-f014-4697-9bf0-f57a064da5c7", "tenant_id": "h75o5", "http_path": "/api/v1/process-definition", "level": "INFO", "logger": "gateway.access", "timestamp": "2026-09-24T04:42:27.883857Z", "service": "forms-flow-process-gateway", "environment": "production", "event": "http_request_finished", "message": "HTTP request finished"}
```

**Startup / Background Job:**
```json
{"level": "INFO", "logger": "gateway.main", "timestamp": "2026-09-24T04:36:19.746646Z", "service": "forms-flow-process-gateway", "environment": "development", "tenant_id": "default", "ip_address": "system", "event": "service_starting", "message": "Service starting"}
```

**Unhandled Error:**
```json
{"request_id": "9b1c7d2e-f014-4697-9bf0-f57a064da5c7", "http_method": "GET", "http_path": "/api/v1/task/1", "ip_address": "10.0.0.7", "tenant_id": "h75o5", "user_name": "jdoe", "error": "Keycloak unreachable", "level": "ERROR", "logger": "gateway.main", "timestamp": "2026-09-18T03:25:20.483342Z", "service": "forms-flow-process-gateway", "environment": "production", "exception": "Traceback (most recent call last):\n  ...\nRuntimeError: Keycloak unreachable", "event": "unhandled_exception", "message": "unhandled exception"}
```

---

## 2. Configuration & Environment Variables

| Variable | Default | Rules |
|---|---|---|
| `LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARNING`, `ERROR`, `CRITICAL` (case-insensitive). Fall back to `INFO` on invalid values. Set on root and handlers. |
| `LOG_FORMAT` | `auto` | `json`, `console`, or `auto`. In `auto` mode: emit `json` when `ENVIRONMENT == production` and stdout is not a TTY; emit `console` otherwise. Non-production deployments (staging, dev) must explicitly set `LOG_FORMAT=json`. |
| `LOG_FILE_ENABLED` | Existing service default / `false` | When true, write JSON logs to rotating file. |
| `LOG_FILE_PATH` | `logs/<service>.log` | File path relative to working directory. |
| `LOG_FILE_MAX_BYTES` | `10485760` (10 MB) | Size threshold for rotation (0 to disable). |
| `LOG_FILE_BACKUP_COUNT`| `30` | Number of rotated backups to keep. |
| `LOG_FILE_ROTATION_WHEN`| `midnight` | Timed rotation interval unit (`midnight`, `D`, `H`). |
| `SERVICE_NAME` | Service canonical name | Injected into `service` field. Python also accepts `PROJECT_NAME`. |
| `ENVIRONMENT` | `production` | Resolved once from `ENVIRONMENT`, then framework variables (`FASTAPI_ENV`, `FLASK_ENV`, `NODE_ENV`, Spring profile), defaulting to `production`. |

---

## 3. Correlation (`X-Request-ID`) & Context Lifecycle

### 3.1 Inbound Handling
1. **Header:** Match `X-Request-ID` case-insensitively.
2. **Validation:** If value matches `^[A-Za-z0-9._:\-]{1,128}$`, use it; otherwise generate a new **UUIDv4**.
3. **Response Echo:** Overwrite and set `X-Request-ID` on every response (including 500 error responses). Never duplicate headers.
4. **CORS:** Include `X-Request-ID` in `Access-Control-Allow-Headers` and `Access-Control-Expose-Headers`.

### 3.2 Client IP Extraction
Extract client IP in strict precedence order:
1. First comma-separated entry of `X-Forwarded-For` (trimmed).
2. `X-Real-IP`.
3. Transport socket remote peer address.
4. Fall back to `"unknown"`.

### 3.3 Outbound Propagation
- Inject `X-Request-ID` from the current request context into all outbound HTTP calls via client interceptors/hooks (httpx, requests, WebClient, axios).
- In message queues or background jobs, propagate `request_id` in message metadata/headers (not the business payload).
- For async threads or executors, explicitly clone and bind context across thread boundaries (`contextvars.copy_context().run()` in Python; `TaskDecorator` in Spring).

### 3.4 Request Lifecycle & Cleanup
- **ASGI:** Clear and re-bind context at the start of each request. Do not clear in middleware `finally` (Starlette error middleware logs unhandled errors outside user middleware).
- **Flask:** Bind in `before_request`, clear in `teardown_request`.
- **Spring/Servlet:** Bind before filter chain, clear in outermost filter's `finally` block (`MDC.clear()`).

---

## 4. Access Logging Contract

Each HTTP request MUST produce exactly one access record emitted by the outermost filter/middleware:

| Condition | Level | `event` | Required Extra Fields |
|---|---|---|---|
| Standard response (2xx, 3xx, 4xx, 5xx) | `INFO` | `http_request_finished` | `status_code`, `duration_ms` |
| Unhandled exception escaped to server | `ERROR` | `http_request_failed` | `status_code: 500`, `duration_ms`, `error: "<type>: <msg>"` (no stack trace) |
| Client disconnected early | `INFO` | `http_request_finished` | `status_code: 499`, `duration_ms`, `client_disconnected: true` |
| Health / Probe endpoints | `DEBUG` | `http_request_finished` | `status_code`, `duration_ms` |

### Rules:
- **Health Paths:** Match path segments exactly: `/health`, `/health/*`, `/healthz`, `/ping`, `/actuator/health/**`. Non-health endpoints (e.g. `/health-report`, `/metrics`) log at `info`.
- **Duration:** Measure with monotonic clock (`perf_counter` / `System.nanoTime`) across the full request lifecycle.
- **Server Access Logs:** Disable built-in server access logs (uvicorn.access, gunicorn.access, Tomcat access valve) to prevent duplicates.

---

## 5. Redaction Specification

Sanitize log fields recursively before serialization. Never redact reserved fields (`timestamp`, `level`, `logger`, `service`, `environment`, `request_id`, `tenant_id`).

### 5.1 Key-based Redaction
Replace the value with `"[REDACTED]"` if the key (lowercased, `-` replaced with `_`) contains any of:
```
password, passwd, secret, token, authorization, cookie, api_key, apikey, private_key, credential
```

### 5.2 Value-based Pattern Redaction
Apply regex replacement across all string values:
- **JWTs:** `eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*` ➔ `[REDACTED_JWT]`
- **Auth Headers:** `(?i)\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,}=*` ➔ `<scheme> [REDACTED]`
- **Query Params:** `(?i)([?&](?:access_?token|id_?token|refresh_?token|token|code|password|secret|client_secret|api_?key)=)[^&\s"']+` ➔ `\1[REDACTED]`
- **URL Credentials:** `(?i)(\b[a-z][a-z0-9+.-]*://[^/\s:@]+:)[^@\s/]+@` ➔ `\1[REDACTED]@`

### 5.3 Depth & Size Bounds
- Recursion depth limit: 8 levels. Replace values nested beyond depth 8 with `"[TRUNCATED]"`.
- Call-site helpers: use `mask_email("user@example.com")` ➔ `u***@example.com`. Never log request/response payload bodies.

---

## 6. Exceptions, Levels & Third-Party Loggers

### 6.1 Exception Logging

| Scenario | Level | Call Pattern | Extra Fields |
|---|---|---|---|
| Caught unexpected failure | `ERROR` | `logger.exception("message", ...)` | Full stack trace in `exception` |
| Handled/expected error | `WARNING` | `logger.warning("message", error=str(e), ...)` | No stack trace |
| Unhandled exception at gateway/framework | `ERROR` | Global exception handler logs `unhandled_exception` | Stack trace in `exception`; response echoes `X-Request-ID` |
| Re-raising an exception | — | Do not log and re-raise. Log only at the boundary handling it. | — |

### 6.2 Third-Party Logger Normalization

Configure all third-party and runtime loggers to route into the root JSON pipeline and quiet noisy loggers:

| Target Loggers | Required Treatment |
|---|---|
| `uvicorn`, `gunicorn`, Tomcat, Netty | Remove custom handlers, propagate to root. |
| `uvicorn.access`, `gunicorn.access`, Tomcat access log | Disable or set level to `WARNING`. |
| `httpx`, `httpcore`, `urllib3`, `requests` | Set level to `WARNING` (prevents URL leaks and duplicate logs). |
| `sqlalchemy.engine`, `org.hibernate.SQL` | Set level to `WARNING` (unless debugging SQL). |
| Java JUL / Log4j / Commons Logging | Bridge to SLF4J (`jul-to-slf4j`) on runtime classpath. |

---



## 7. Conformance & Verification Checklist

Each service implementation MUST pass these verification criteria:

- [ ] **JSON Format:** With `LOG_FORMAT=json`, stdout produces strictly single-line valid JSON.
- [ ] **Core Fields:** Every record includes `timestamp` (UTC `Z`), `level`, `logger`, `service`, `environment`, `tenant_id`, `ip_address`, `event` and `message`.

- [ ] **Collision Protection:** Providing a `message` key in event kwargs renames the kwarg to `message_field`.
- [ ] **Defaults Outside Requests:** Background tasks default to `tenant_id="default"` and `ip_address="system"`.
- [ ] **Correlation Echo:** Inbound `X-Request-ID` is echoed in response; missing/invalid IDs are replaced with UUIDv4.
- [ ] **Outbound Propagation:** Outbound HTTP requests carry `X-Request-ID`.
- [ ] **Context Isolation:** Context does not leak between concurrent or sequential requests.
- [ ] **Access Record:** Exactly one `http_request_finished` access log per request with numeric `status_code` and `duration_ms`.
- [ ] **Health Log Level:** `/health`, `/health/*`, `/healthz`, `/ping` access records log at `debug`; business endpoints log at `info`.
- [ ] **Redaction:** Sensitive keys and regex patterns (JWT, Bearer, tokens, passwords) render as `[REDACTED]`.
- [ ] **Error Handling:** Unhandled exceptions produce stack trace in `exception` field and return generic 500 echoing `X-Request-ID`.
