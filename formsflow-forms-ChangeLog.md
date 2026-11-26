# Change Log

>All significant changes to formsflow-forms will be clearly documented in this file. The following labels are used to categorize the changes:

- `Added`: New features, enhancements, or functionalities added to the project.
- `Changed`: Modifications, improvements, or updates made to existing features or behaviors.
- `Fixed`: Resolved issues, bug fixes, or error corrections.
- `Removed`: Elimination of features, functionalities, or components from the project.
- `Untested Features`: Newly introduced features or components that are yet to be thoroughly tested.
- `Upcoming Features`: Planned features or enhancements that will be available in future releases.
- `Known Issues`: Existing issues or problems that are acknowledged and will be addressed in subsequent updates.
# Version 8.4.0
### Added
- Added structured logging based on the forms-flow logging standard (`docs/logging-standard.md`). Every record carries standard fields such as `timestamp`, `level`, `service`, `environment`, `tenant_id`, `event` and `message`, plus the request ID, HTTP method, path and client IP during requests [FWF-6544].
- Added request correlation through the `X-Request-ID` header. A valid incoming ID is reused, otherwise a new UUID is generated. The ID is returned on every response, exposed through CORS, and sent on outbound webhook and custom email transport calls [FWF-6544].
- Added one access log record per HTTP request with `status_code` and `duration_ms`. Health checks, including `/checkpoint`, are logged at `DEBUG` [FWF-6544].
- Added redaction of sensitive values in logs, including passwords, tokens, secrets, cookies, JWTs, Bearer/Basic credentials, secrets in query strings and credentials in URLs. Email addresses are masked [FWF-6544].
- Added logging environment variables: `LOG_LEVEL`, `LOG_FORMAT` (`json`, `console` or `auto`), `ENVIRONMENT`, `SERVICE_NAME`, `LOG_FILE_ENABLED`, `LOG_FILE_PATH`, `LOG_FILE_MAX_BYTES`, `LOG_FILE_BACKUP_COUNT` and `LOG_FILE_ROTATION_WHEN`. Invalid values fall back to defaults with a warning [FWF-6544].
- Added the optional `TRUSTED_PROXIES` environment variable (comma-separated IPs, CIDRs, or `loopback`/`linklocal`/`uniquelocal`). When set, `X-Forwarded-For` and `X-Real-IP` are trusted only from these proxies when recording the client IP [FWF-6544].
### Changed
- Logs are now single-line JSON by default in containers. With the default `LOG_FORMAT=auto`, JSON is used when the environment is `production` (the default when `ENVIRONMENT` and `NODE_ENV` are unset) and output is not a terminal. Otherwise logs are readable console text, and the startup banner is printed only in console format [FWF-6544].
- The default log level is `INFO`. Per-request details such as cache hits moved from `INFO` to `DEBUG` [FWF-6544].
- File logging stays on by default in `LOG_FOLDER` (`formio-<date>.log`). Rotation now defaults to 10 MB per file, 30 backups and a daily rotation at midnight [FWF-6544].
- Error responses are now JSON. Unexpected errors return `500` with `{"message": "Internal Server Error"}` instead of Express's HTML error page, and 4xx errors keep their status with a `{"message": ...}` body [FWF-6544].
- CORS origin rejections (`allowedOrigins`) now return `403` with a JSON message instead of a `500` error page [FWF-6544].
- Request body errors other than malformed JSON and oversized payloads, such as `415` for an unsupported charset, are now rejected with their own status. Previously they were ignored and the request continued with an empty body [FWF-6544].
- Unhandled promise rejections and uncaught exceptions are now logged as structured errors before the process exits with code 1 [FWF-6544].
- Updated dependencies: `cors` 2.8.6, `jsonwebtoken` 9.0.3 (now uses `jws` 4.0.1), `resourcejs` 2.6.2, `resolve` 1.22.13 and `xss` 1.0.17, plus test and build dependencies in `portal`.
- Pinned `inputmask` to 5.0.9 and excluded 5.0.10 from automatic updates, because 5.0.10 crashes the service at startup with `ReferenceError: matchMedia is not defined`.
### Fixed
- Updated `express` to 4.22.3, which includes `path-to-regexp` 0.1.13 for CVE-2026-4867, and `proxy-addr` to 2.0.8 for CVE-2026-90711.
- `/checkpoint` now returns `500` when the readiness database query fails. Previously the request hung [FWF-6544].
- The Login action now returns `400 Misconfigured Login Action.` when its settings are missing, instead of failing with a `TypeError` [FWF-6544].
### Removed
- Removed the `debug` package. `DEBUG` namespaces such as `DEBUG=formio:*` no longer filter log output. Any non-empty `DEBUG` value now sets the log level to `DEBUG` when `LOG_LEVEL` is not set [FWF-6544].
# Version 8.3.2
### Fixed
- Rebuilt the Docker image on Node.js 24.22.1 to address the Node.js security release of 21 October 2026 (10 CVEs, 4 high). This includes CVE-2026-111497, an out-of-bounds write in the Brotli decoder that is reachable through `Content-Encoding: br` request bodies before authentication [FWF-6795].
### Changed
- Pinned the Docker base image to `node:24.22.1-alpine` instead of the floating `node:24-alpine` tag so that builds are reproducible [FWF-6795].
### Known Issues
- Node.js 24.22.1 removes the eMudhra root certificates (emSign Root CA - C1, emSign ECC Root CA - G3, emSign ECC Root CA - C3) from its trust store. SMTP, webhook or MongoDB TLS endpoints whose certificates chain to these roots will fail with a certificate error. These roots must not be added back.
# Version 7.3.0
### Fixed
- Fixed tenant key handling for authenticated vs anonymous users [FWF-5328].
# Version 7.1.0
### Added
- Added FORMIO_JWT_EXPIRE env for handling token expire time
- Added tenant_key in logger
- Added New /submissions POST API Allows listing submissions by passing submissionIds in the request body. Ensures access control by verifying form access before returning submissions.

# Version 7.0.0
### Added
- Added the formIds query parameter in the /form endpoint to retrieve form components, accessible only to admin users.
- Added a custom property displayForRole to display specific data based on the assigned role.
- Added a new endpoint `forms/search` for listing forms based on their path, name, or title.

### Fixed
- Fixed the authorization logic for fetching bundle submission data. Now, only the data of the currently viewed form in a bundle is returned, instead of sending all form data.

### Changed
- Disabled role mapping for all form access permissions when a new role is created.
 
# Version 6.0.0

### Added
- Added new endpoint `/form/formid/metadata` to retrieve form metadata.
- Added logs into formio to support ELK
### Changed
- Formsflow-forms version upgrade
- formio version upgraded to 2.4.1 to 3.2.0
# Version 5.3.0
### Changed
- Formsflow-forms version upgrade

# Version 5.2.2
### Fixed
- Fixed most of the vulnerabilities.

## Version 5.2.1
### Fixed
- Fixed most of the vulnerabilities.

# Version 5.2.0
### Added
- The `skip-sanitize` option added to the header, allowing the skipping of form submission sanitization.

### Fixed
- Corrected the data type of the `NO_INSTALL` value from string to boolean.

### Changed
- The Client.zip file is now included in the repository rather than being downloaded.

# Version 5.1.1
### Removed
- Deprecated the use of the `FORMIO_CLIENT_UI` environment variable. Instead, use the `NO_INSTALL` environment variable.

# Version 5.1.0
### Added
- Introduced a new environment variable, `FORMIO_CLIENT_UI`, providing additional configuration options.
- Implemented a Health Check API endpoint at `/checkpoint` for improved system health monitoring.

# Version 5.0.0
### Added
- Enabled multi-tenancy support, allowing the application to serve multiple tenants simultaneously.

By following this revised format, the change log provides clear and concise information about each version's changes and helps users and developers understand the updates made to formsflow-forms easily.
