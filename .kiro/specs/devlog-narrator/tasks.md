# Implementation Plan: Devlog Narrator

## Overview

Implementation is TypeScript on Node.js 22 (arm64) throughout — CDK app, three Lambda handlers,
the Author_Console bundle, and the pure core — per the design's *Language and runtime
justification*. Tests are Vitest with `fast-check` for the 27 correctness properties and
`aws-cdk-lib/assertions` for the infrastructure obligations.

Task order follows the design's *Sequencing risk* section, which is the binding constraint on this
plan. Requirement 16 needs at least 7 Published_Entries across at least 5 distinct session dates,
all generated through the **deployed** System, and Requirement 14 cites 3 of them. With today at
2026-09-19 and the deadline at 2026-10-02, the stack must be deployed and publishing by roughly day
four. So: pure core first (no AWS needed to test it), then the Infrastructure_Stack skeleton with
the health route to clear the Requirement 1 ship gate early, then the authenticated write path, then
the public read path, then presentation, observability, and the hackathon deliverables.

Starting state: git repo at the workspace root pushed to `main`, holding only `README.md`,
`.gitignore`, `LICENSE` (MIT), and the `.kiro/specs/devlog-narrator/` documents. No `package.json`,
no source, no CDK app, no deployed AWS resources.

Design tradeoffs are settled. Where the design flagged one (async generation, Lambda-rendered
public HTML, DynamoDB token bucket instead of WAF, scheduled probe instead of Synthetics, no
frontend framework, numbered pagination by over-fetching, single GSI partition, character-based
token budget, opaque `authorDate`, no reconciliation sweep, `USER_PASSWORD_AUTH` sign-in proxy,
AWS-issued hostname), the decision stands and the tasks below implement it as written.

## Tasks

- [x] 1. Project scaffold and toolchain
  - [x] 1.1 Initialize the Node project and TypeScript configuration
    - Create `package.json` (private, ESM, Node 22 engine) with exact-pinned dependencies:
      `aws-cdk-lib`, `constructs`, `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`,
      `@aws-sdk/client-bedrock-runtime`, `@aws-sdk/client-cognito-identity-provider`,
      `@aws-sdk/client-cloudfront`, `@aws-lambda-powertools/logger`, `markdown-it`, `ulid`,
      `aws-jwt-verify`
    - Create `tsconfig.json` (strict, `target: es2023`, `moduleResolution: bundler`) and a linter
      and formatter config
    - _Design: Language and runtime justification; Requirements: 12.1_
  - [x] 1.2 Configure the test runner and property-testing library
    - Create `vitest.config.ts` with separate `unit`, `property`, `infra`, and `integration`
      projects so `npm test` runs everything except `integration`
    - Add `fast-check` at an **exact** version (no `^`, no `~`) and a CI fixed-seed configuration so
      a failure is reproducible locally from the printed counterexample and seed
    - Add npm scripts: `test`, `test:unit`, `test:property`, `test:infra`, `test:integration`
    - _Design: Property test conventions; Requirements: 12.1_
  - [x] 1.3 Create the repository layout and the deterministic esbuild bundler script
    - Create `src/{api,site,generator,console,core}/`, `test/{unit,property,infra,integration}/`,
      `infra/`, `scripts/`, `docs/`
    - Write `scripts/build.ts` bundling each Lambda entry point and the console bundle with esbuild
      at a pinned version, with banner and build-timestamp footer disabled so identical input
      produces identical output
    - _Design: Repository layout, Determinism (Req 12.8); Requirements: 12.1, 12.8_
  - [x] 1.4 Create the CDK v2 app skeleton with one stack and deploy-time context
    - Write `cdk.json`, `infra/bin/app.ts`, `infra/lib/devlog-stack.ts` with a single empty stack
    - Read `versionId`, `authorEmail`, `authorUsername`, and `environment` from CDK context and fail
      synthesis with a named error when any is absent
    - Apply `Tags.of(app).add('project', 'devlog-narrator')` and `Tags.of(app).add('environment', …)`
    - Organize resources as construct modules (`storage.ts`, `compute.ts`, `edge.ts`, `identity.ts`,
      `observability.ts`) composed by the one stack, so later tasks touch separate files
    - _Design: Infrastructure_Stack; Requirements: 12.1, 10.7_

- [x] 2. Core domain types and test harness
  - [x] 2.1 Define the shared core types module
    - `src/core/types.ts`: `CommitRecord`, `ParseError`, `ParseResult`, `PrintError`, `PrintResult`,
      `EntryStatus`, `Entry`, `EntrySummary`, `EncodeError`, `DecodeError`, `HttpResponse`,
      `SessionInputPayload`, `SubmitAccepted`, `SessionStatus`, `EntryPatch`
    - Add a code-point utility module (`codePointLength`, `truncateAtCodePoint`,
      `hasNonWhitespaceCodePoint` using the Unicode `White_Space` property) used by every length rule
    - _Design: Components and Interfaces, Unicode handling (Req 8.4); Requirements: 8.4, 3.2_
  - [x] 2.2 Build the shared fast-check generator module
    - `test/generators.ts`: `arbCommitRecord`, `arbCommitLogText`, `arbMalformedCommitLogText`,
      `arbEntry`, `arbEntrySet`, `arbMarkdownBody`, `arbNoteText`, `arbRequestArrivalSequence`,
      `arbModelOutcome`, `arbCredential`
    - Default string generator is `fc.fullUnicodeString` so astral-plane code points, combining
      marks, CRLF sequences, and prompt-injection phrasings appear without being remembered
    - _Design: Correctness Properties (shared generators); Requirements: 4.2, 8.4_
  - [x] 2.3 Build the test doubles
    - In-memory Entry_Store fake implementing the same repository interface, with key-scoped
      condition-expression semantics and last-write-wins single-item atomicity
    - Injectable clock (frozen and virtual modes), capturing logger transport, and a Bedrock stub
      driven by generated `arbModelOutcome` sequences
    - _Design: Property test conventions; Requirements: 8.5, 8.9_

- [x] 3. Commit_Log_Parser
  - [x] 3.1 Implement `parseCommitLog` against the design grammar
    - `src/core/commit-log-parser.ts`: single line split retaining 1-based indices, then a
      line-oriented recursive-descent scan with an explicit cursor; errors returned as values, never
      thrown
    - Implement the three resolved ambiguities exactly: a whitespace-only line terminates a body
      section; a lone CR is an ordinary character; trailing whitespace inside a body line is
      significant
    - Empty or whitespace-only input yields an empty record list with no error; the 501st `commit`
      line yields `TOO_MANY_COMMITS` with that line number
    - _Design: Commit_Log_Parser; Requirements: 4.1, 4.2, 4.3, 4.4, 4.8, 4.9, 4.10_
  - [x] 3.2 Write the property test for parser totality and determinism
    - **Property 2: Commit log parsing is total and deterministic**
    - **Validates: Requirements 4.4, 4.10**
  - [x] 3.3 Write the property test for line-ending and non-ASCII equivalence
    - **Property 3: Line endings and non-ASCII author names do not change the result**
    - **Validates: Requirements 4.2**
  - [x] 3.4 Write the model-based property test for subject extraction
    - **Property 4: Subject extraction follows the body-line rule**
    - **Validates: Requirements 4.1, 4.3, 4.8, 4.9**
  - [x] 3.5 Write the parser unit tests for intent-carrying examples
    - One well-formed multi-commit `git log`, one merge commit, one entry with no body lines, one
      entry with three body lines, one malformed input asserting the reported line number
    - Keep thin: the properties carry coverage, these carry readability
    - _Design: Testing Strategy (Layers); Requirements: 4.1, 4.3, 4.4, 4.9_

- [x] 4. Commit_Log_Printer
  - [x] 4.1 Implement `printCommitLog`
    - `src/core/commit-log-printer.ts`: LF line endings only, fixed placeholder email, no `Merge`
      line ever emitted, one four-space-indented body line when the subject is non-empty
    - Implement the partiality rules: reject invalid hash, empty or CR/LF/`<`/`>`-bearing author
      name, empty or CR/LF-bearing author date, CR/LF or whitespace-only non-empty subject, and
      lists over 500 records
    - _Design: Commit_Log_Printer; Requirements: 4.5_
  - [x] 4.2 Write the round-trip property test for the parser and printer pair
    - **Property 1: Commit log round trip**
    - **Validates: Requirements 4.5, 4.6**

- [x] 5. Entry_Serializer
  - [x] 5.1 Implement `encode` and `decode`
    - `src/core/entry-serializer.ts`: no optional attributes (`generationFailed` always a `BOOL`),
      one canonical form per value (24-character UTC instants, 10-character session date, closed
      status union, literal `schemaVersion: 1`), derived `PK`, `SK`, `GSI1PK`, `GSI1SK`
    - `decode` never throws and never returns a partially populated Entry; every anomaly is a
      `DecodeError` naming the attribute
    - _Design: Entry_Serializer, Entry_Serializer mapping; Requirements: 8.2, 8.3, 8.4_
  - [x] 5.2 Implement `encodedSizeBytes` and `canonicalBytes`
    - `encodedSizeBytes` implements DynamoDB's own accounting: summed UTF-8 byte lengths of
      attribute names and values
    - `canonicalBytes` emits UTF-8 JSON with recursively sorted attribute names, which is the
      artifact the determinism property compares
    - _Design: Entry_Serializer; Requirements: 8.7, 8.8_
  - [x] 5.3 Write the round-trip property test for serialization
    - **Property 5: Entry serialization round trip is total and Unicode-preserving**
    - **Validates: Requirements 8.2, 8.3, 8.4**
  - [x] 5.4 Write the canonical-form property test
    - **Property 6: Entry serialization is canonical and deterministic**
    - **Validates: Requirements 8.7**

- [x] 6. Entry_Ordering
  - [x] 6.1 Implement `buildOrderingKey`, `invert`, and `compareEntries`
    - `src/core/entry-ordering.ts`: `GSI1SK = sessionDate#createdAt#invert(entryId)` with all three
      components fixed-length, and the Crockford base32 alphabet complement for the identifier so a
      descending scan yields ascending identifiers
    - `compareEntries` is the reference comparator: session date descending, creation timestamp
      descending, entry identifier ascending
    - _Design: Ordering key and the total order of Req 7.2; Requirements: 6.6, 7.1, 7.2_
  - [x] 6.2 Write the model-based property test for the total order
    - **Property 9: Entry ordering is a deterministic total order**
    - **Validates: Requirements 6.6, 7.1, 7.2**

- [ ] 7. Markdown_Renderer
  - [x] 7.1 Configure the restricted `markdown-it` instance
    - `src/core/markdown-renderer.ts` with `html: false`, `linkify: false`, `typographer: false`,
      enabled rules narrowed to headings, `strong`/`em`, ordered and unordered lists, links, inline
      code, fenced code blocks, and block quotes
    - Every other construct (tables, footnotes, definition lists, raw HTML) renders as literal
      source text
    - _Design: Public_Site / Markdown_Renderer; Requirements: 7.3, 7.5_
  - [x] 7.2 Implement the two token-stream post-processing steps
    - Heading demotion h1→h2 … h5→h6, h6→h6 so the page carries exactly one h1 (the Entry title)
      and heading levels stay sequential
    - Accessible link naming: use link text when present and non-empty, otherwise render the href as
      the visible text
    - _Design: Public_Site / Markdown_Renderer; Requirements: 7.3, 7.7_
  - [ ] 7.3 Write the property test for inert rendered markup
    - **Property 12: Markdown rendering never emits active markup**
    - **Validates: Requirements 7.5**
  - [x] 7.4 Write the property test for heading structure
    - **Property 13: Rendered heading structure is single-rooted and sequential**
    - **Validates: Requirements 7.3, 7.7**

- [ ] 8. Checkpoint - pure core complete
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 9. Entry_Store table and access layer
  - [x] 9.1 Define the DynamoDB table in CDK
    - `infra/lib/storage.ts`: single table, `PAY_PER_REQUEST`, SSE, point-in-time recovery,
      `ttl` attribute enabled, `removalPolicy: RETAIN`, GSI1 `status-order-index` with the narrow
      `INCLUDE` projection (`entryId`, `title`, `sessionDate`, `createdAt`, `updatedAt`,
      `generationFailed`)
    - Add the table resource-based policy allowing only the three function roles and the deploying
      principal, with an explicit deny on every other principal
    - _Design: Entry_Store, Single-table design, Entry_Store isolation; Requirements: 8.1, 8.6,
      9.5, 10.1, 12.7_
  - [ ] 9.2 Implement the repository module over the single table
    - `src/core/entry-repository.ts`: `getEntry`, `queryTimeline`, `queryByStatus`, `putEntry`,
      `updateEntryStatus` (condition on current status), `patchEntry`, `deleteDraft` (condition
      `status = draft`), `getSession`, `putSession`, `updateSessionState`
    - Reject a write whose `encodedSizeBytes` exceeds 393216 with an error naming the storage size
      limit, before any call to DynamoDB
    - All item-type key builders (`ENTRY#`, `SESSION#`, `AUTHSESSION#`, `AUTHFAIL#`, `RATE#`,
      `IPB#`) live here with their TTL rules
    - _Design: Item types, Access patterns, Write semantics; Requirements: 8.5, 8.8, 8.9, 6.8, 6.9_
  - [ ] 9.3 Write the property test for write idempotence and atomicity
    - **Property 7: Entry writes are idempotent and atomic**
    - **Validates: Requirements 8.5, 8.9**
  - [ ] 9.4 Write the property test for oversized-entry rejection
    - **Property 8: Oversized entries are rejected without a write**
    - **Validates: Requirements 8.8**
  - [ ] 9.5 Write CDK template assertions for the Entry_Store
    - `PointInTimeRecoverySpecification` enabled and `SSESpecification` present; billing mode is
      `PAY_PER_REQUEST` and no resource in the template declares provisioned capacity;
      `DeletionPolicy` and `UpdateReplacePolicy` are `Retain`; the table resource policy names only
      the three accessing function roles; no IAM statement carries a wildcard action or a wildcard
      resource on the table
    - _Design: Infrastructure assertions; Requirements: 8.1, 8.6, 9.4, 9.5, 10.1, 12.7_

- [ ] 10. Devlog_API spine: middleware, logging, health route
  - [ ] 10.1 Implement the middleware pipeline in its fixed order
    - `src/api/pipeline.ts`: assign a 26-character ULID correlation identifier and bind the
      request-scoped logger; reject `Content-Length` over 262144 with 413 **before** reading or
      parsing the body; rate-limit hook; authenticate hook; authorize hook; submission-quota hook;
      schema and bounds validation; dispatch; exactly one completion log record; single sanitizing
      error boundary mapping any thrown error to the error response shape
    - Implement the status code map and the fixed error body
      (`{ error: { code, message, field?, correlationId } }`) with no other keys ever added
    - _Design: Devlog_API (Middleware pipeline), Error Handling; Requirements: 9.3, 9.6, 11.1,
      11.2, 11.7_
  - [x] 10.2 Implement the redacting logger wrapper
    - `src/api/logger.ts` over Powertools `Logger`, accepting only an allow-listed field set with no
      method taking an arbitrary object; note text and commit log text have no representation, only
      `noteTextCharCount`, `commitLogCharCount`, and `commitRecordCount`
    - _Design: Structured logging; Requirements: 11.3_
  - [ ] 10.3 Implement the health route
    - `GET /api/health` returns 200 with `{"version": "<DEPLOYED_VERSION>"}` and nothing else, with
      no dependency calls on the path
    - _Design: Devlog_API (Health route), Deployed version identifier; Requirements: 11.6, 12.4_
  - [ ] 10.4 Write the property test for error-response sanitization
    - **Property 23: Error responses disclose nothing internal**
    - **Validates: Requirements 9.6, 11.2, 11.6**
  - [ ] 10.5 Write the property test for log redaction
    - **Property 24: Logs never carry submitted content or credentials**
    - **Validates: Requirements 11.3**
  - [ ] 10.6 Write the property test for correlation identifiers
    - **Property 25: Correlation identifiers are assigned and propagated**
    - **Validates: Requirements 11.1, 11.7**

- [ ] 11. Infrastructure_Stack edge and first deploy (ship gate)
  - [ ] 11.1 Define the API Gateway HTTP API and the `api` Lambda function
    - `infra/lib/compute.ts`: Node.js 22, arm64, 512 MB, 15 s timeout, reserved concurrency 20,
      explicit `LogGroup` with `RetentionDays.TWO_WEEKS`, bundled by `scripts/build.ts`
    - HTTP API with stage-level throttling at 50 requests per second sustained; route table wired
      per the design's route map; `DEPLOYED_VERSION` and `AUTHOR_USERNAME` environment variables
    - Least-privilege IAM for `api` exactly as the design's table specifies
    - _Design: Route map, Devlog_API, Least-privilege IAM; Requirements: 9.1, 9.4, 10.4, 10.5_
  - [ ] 11.2 Define the S3 bucket and the CloudFront distribution
    - `infra/lib/edge.ts`: private versioned bucket with public access blocked and Origin Access
      Control only; distribution with `redirect-to-https` on every behaviour
    - Per-route cache policies: `s-maxage=30` on public HTML and the feed with an explicit
      query-string allowlist (`page` on the timeline route, nothing elsewhere), one-year immutable
      on `/assets/*`, caching disabled on `/api/author/*` and `/api/health`
    - Response headers policy setting CSP, HSTS, `X-Content-Type-Options`, and `Referrer-Policy`,
      with a separate policy for `/console/*`
    - _Design: Public read path, Route map, Content security; Requirements: 1.4, 6.3, 6.4, 7.5_
  - [ ] 11.3 Wire the stack outputs and the deploy script
    - `CfnOutput`s `PublicUrl` and `DeployedVersionIdentifier`, both fed from the one
      context-supplied `versionId` that also becomes `DEPLOYED_VERSION` on the `api` function
    - `npm run deploy` wrapping `cdk deploy -c versionId=$(git rev-parse --short HEAD) -c
      authorEmail=… -c authorUsername=… -c environment=…`, preserving the CLI exit status and
      keeping default rollback behaviour
    - _Design: Infrastructure_Stack (Outputs, Rollback, Credentials); Requirements: 12.2, 12.4,
      12.5, 12.6_
  - [ ] 11.4 Write CDK template assertions for compute, edge, and tagging
    - Every Lambda declares `ReservedConcurrentExecutions` (public-facing 10–50); every
      `AWS::Logs::LogGroup` declares `RetentionInDays` of 30 or fewer and no function lacks an
      explicit group; every taggable resource carries the project and environment tags; every
      distribution behaviour uses `redirect-to-https`; public HTML behaviours use a cache policy
      with `DefaultTTL` of 30 seconds and no unknown query strings in the cache key
    - _Design: Infrastructure assertions; Requirements: 1.4, 6.3, 6.4, 10.4, 10.5, 10.7_
  - [ ] 11.5 Write the property test for synthesis determinism
    - **Property 27: Synthesis is deterministic across deploy-time configuration**
    - **Validates: Requirements 12.8**
  - [ ] 11.6 Run the documented deploy command and verify the ship gate
    - Execute `npm run deploy` against the target account, then assert the health route returns 200
      over HTTPS at the Public_URL and that its version identifier equals the
      `DeployedVersionIdentifier` output (integration check 5)
    - Record the Public_URL for the later stability check
    - _Design: Ship-gate verification checklist rows 1–4; Requirements: 1.1, 11.6, 12.2, 12.4_

- [ ] 12. Auth_Service
  - [ ] 12.1 Define the Cognito user pool, client, and single user in CDK
    - `infra/lib/identity.ts`: `selfSignUpEnabled: false`, access token validity exactly 12 hours,
      refresh token validity 12 hours, app client with `USER_PASSWORD_AUTH` and no client secret,
      one `CfnUserPoolUser` whose username comes from the `authorUsername` context value
    - _Design: Auth_Service; Requirements: 2.5, 2.6_
  - [ ] 12.2 Set the Author's initial password out of band
    - Run `aws cognito-idp admin-set-user-password --permanent` for the created user after the first
      deploy, and document it in `README.md` as the one manual post-deploy step, stating that CDK
      never receives the password
    - _Design: Secrets; Requirements: 12.5_
  - [ ] 12.3 Implement the token validation module
    - `src/api/auth.ts`: cached JWKS, then checks in order — signature, `iss`, `client_id`,
      `token_use === 'access'`, `exp`, `jti` absent from `AUTHSESSION#` (uncached `GetItem` on every
      request), `cognito:username` equal to `AUTHOR_USERNAME`
    - First six failures yield 401; the username mismatch yields 403; reading a Draft overrides to
      404
    - _Design: Auth_Service (Token validation); Requirements: 2.1, 2.2, 2.3, 2.4, 2.7, 2.9_
  - [ ] 12.4 Implement the sign-in proxy with per-address lockout
    - `POST /api/author/session`: read `AUTHFAIL#<sha256(ip)>`; if `lockedUntil` is in the future
      return the generic failure without calling Cognito; otherwise `InitiateAuth`; on failure
      increment within the rolling 15-minute window and set `lockedUntil = now + 15 min` at the
      fifth failure; on success clear the counter and return the tokens
    - Every failure path returns an identical body and status; the submitted password never reaches
      a log record or an error message
    - Reject any request whose `CloudFront-Forwarded-Proto` is not `https`
    - _Design: Auth_Service (Sign-in proxy, Transport); Requirements: 2.6, 9.9, 11.3_
  - [ ] 12.5 Implement sign-out and credential revocation
    - `DELETE /api/author/session` writes `PK=AUTHSESSION#<jti>, SK=STATE` with `revokedAt` and a
      TTL set to the token's `exp`, then calls `GlobalSignOut`
    - _Design: Auth_Service (Revocation); Requirements: 2.8, 2.9_
  - [ ] 12.6 Write the property test for credential validation
    - **Property 26: Credential validation admits exactly valid Author credentials**
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.7, 2.9**
  - [ ] 12.7 Write CDK template assertions for the user pool
    - Access token validity is exactly 12 hours; self sign-up is disabled; exactly one
      `CfnUserPoolUser` is declared; the `api` role holds only `InitiateAuth` and `GlobalSignOut` on
      the one pool
    - _Design: Infrastructure assertions; Requirements: 2.5, 9.4_

- [ ] 13. Rate_Limiter and abuse protection
  - [ ] 13.1 Implement the DynamoDB token bucket
    - `src/core/rate-limiter.ts`: capacity 30, refill 10 tokens per second, one conditional
      `UpdateItem` performing refill-and-consume atomically on `IPB#<sha256(ip)>`; a condition
      failure means empty
    - On rejection return 429 with `Retry-After` carrying the whole number of seconds until one
      token is available, rounded up
    - _Design: Devlog_API (Rate_Limiter), Rate limiting without WAF; Requirements: 9.1, 9.2_
  - [ ] 13.2 Implement the Author submission quota counters
    - Separate `RATE#<authorSub>` counter items per rolling hour bucket and rolling day bucket with
      TTL expiry, enforcing 10 per 60 minutes and 40 per 24 hours, rejecting with 429 and a
      whole-number retry-after
    - _Design: Devlog_API (Rate_Limiter); Requirements: 9.7_
  - [ ] 13.3 Wire limiting and origin control into the request paths
    - Apply the token bucket on every unauthenticated route in both the `api` and `site-renderer`
      handlers, keyed by the hashed client address from `X-Forwarded-For`
    - Apply the submission quota to `POST /api/author/sessions` only, after authentication so
      anonymous traffic cannot consume the Author's quota
    - Set the CORS allowlist to the single Public_URL origin, withholding cross-origin approval from
      every other declared origin on write routes
    - _Design: Middleware pipeline, Route map; Requirements: 9.1, 9.2, 9.7, 9.8_
  - [ ] 13.4 Write the property test for rate limiting
    - **Property 22: Rate limiting never admits more than the configured allowance**
    - **Validates: Requirements 9.1, 9.2, 9.7**

- [ ] 14. Session_Input capture
  - [ ] 14.1 Implement the Session_Input validation module
    - `src/api/validate-session-input.ts`: note text 1–20000 **code points** with at least one
      non-whitespace code point by the Unicode `White_Space` property; optional `commitLog`;
      optional `sessionDate` matching `YYYY-MM-DD`, a real calendar date, and not after the
      submission date in UTC
    - Each rejection returns 400 with the message the design's table specifies and returns before
      any write
    - _Design: Session_Input capture; Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.7, 3.8_
  - [ ] 14.2 Implement `POST /api/author/sessions`
    - Allocate `sessionId` and `entryId` as ULIDs, persist the SESSION item with `noteText` and
      `commitLog` **verbatim** (no trimming, no newline or Unicode normalization) plus
      `generationState: 'pending'` and `correlationId`, then invoke the generator asynchronously
      with `{ sessionId, entryId, deadlineEpochMs, correlationId }` and return 202
    - Surface a commit-log parse failure as 400 with the 1-based line number while still retaining
      the raw commit log on the SESSION item
    - _Design: Authenticated write path, Session_Input item shape; Requirements: 3.1, 3.6, 4.4_
  - [ ] 14.3 Implement `GET /api/author/sessions/{id}`
    - Return `generationState`, `entryId`, the verbatim `noteText` and `commitLog`, and
      `sessionDate` for console polling
    - _Design: Author_Console; Requirements: 3.6_
  - [ ] 14.4 Write the property test for note text validation
    - **Property 15: Note text validation accepts exactly the specified range**
    - **Validates: Requirements 3.1, 3.2, 3.3**
  - [ ] 14.5 Write the property test for session date resolution
    - **Property 16: Session date resolution and validation**
    - **Validates: Requirements 3.4, 3.5, 3.7, 3.8**
  - [ ] 14.6 Write the property test for verbatim note retention
    - **Property 14: Submitted note text is retained verbatim**
    - **Validates: Requirements 3.6**

- [ ] 15. Entry_Generator
  - [ ] 15.1 Define the `generator` Lambda in CDK
    - Node.js 22, arm64, 1024 MB, 75 s timeout, reserved concurrency 2, explicit log group;
      `bedrock:InvokeModel` on the single model resource from the `bedrockModelId` context value
      defaulting to `us.anthropic.claude-3-5-haiku-20241022-v1:0`
    - Asynchronous invocation configured with the SNS topic as the dead-letter target; grant the
      `api` role `lambda:InvokeFunction` on this function only
    - _Design: Entry_Generator, Least-privilege IAM; Requirements: 9.4, 10.4, 10.6_
  - [ ] 15.2 Implement the prompt builder
    - `src/generator/prompt.ts`: the fixed system template verbatim from the design plus one user
      message of delimited data blocks, with `<` and `>` escaped to `&lt;`/`&gt;` inside the blocks
    - Model input is only the template, the note text, and the parsed Commit_Records — no other
      Entry and no retrieved content
    - Truncate note text over 9000 code points at a code-point boundary with the
      `[note truncated for generation; full text retained]` marker, and cap commit subjects at 60
      and 2400 characters; request `maxTokens: 2000`
    - _Design: Entry_Generator (Prompt structure, Token budget); Requirements: 5.6, 5.8, 10.6_
  - [ ] 15.3 Implement the invocation budget state machine
    - `src/generator/state-machine.ts`: `invocations ≤ 4`, `retries ≤ 2` for throttling and server
      errors, `repeats ≤ 1` for output failing validation, backoff sleeps of 1 s then 2 s capped at
      5 s, and a deadline check that subtracts a per-call duration estimate before each invocation
      so it stops early rather than starting a call it cannot finish
    - Validate output as JSON with a title of 1–120 characters and a body of 200–10000 characters
    - Enforce commit-subject inclusion: if no non-empty subject appears verbatim in the body, treat
      the output as invalid and consume the repeat with an added instruction; if the repeat also
      fails, append a `## Commits` section listing subjects verbatim while staying within 10000
      characters
    - _Design: Entry_Generator (state machine, Commit subject inclusion); Requirements: 4.7, 5.1,
      5.3, 5.5, 5.7, 10.6_
  - [ ] 15.4 Implement generator persistence and the fallback path
    - On success `PutItem` the Entry with status literal `'draft'`, `createdAt` and `updatedAt` set
      to the write time, `generationFailed: false`, and the system-assigned identifiers
    - On `Fallback` persist a Draft whose body is the **unaltered** retained note text, whose title
      is `Session <sessionDate>`, and whose `generationFailed` is `true`
    - Update the SESSION item's `generationState` to `generated` or `failed`; emit records carrying
      the inherited correlation identifier
    - _Design: Entry_Generator (Fallback path), Why Req 5.8 holds structurally; Requirements: 5.2,
      5.4, 5.8, 11.7_
  - [ ] 15.5 Write the property test for the generation budget
    - **Property 17: Generation is budget-bounded and always terminates in one of two outcomes**
    - **Validates: Requirements 5.1, 5.3, 5.4, 5.5, 5.7, 10.6**
  - [ ] 15.6 Write the property test for model-output containment
    - **Property 18: Model output cannot influence anything but title and body**
    - **Validates: Requirements 5.6, 5.8**

- [ ] 16. Checkpoint - write path produces Drafts end to end
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 17. Draft review, editing, and status transitions
  - [ ] 17.1 Implement the Author read routes
    - `GET /api/author/entries?status=` using the GSI1 `TL#DRAFT` / `TL#PUB` descending query so
      Drafts arrive in session-date-then-creation-timestamp order, and
      `GET /api/author/entries/{id}`
    - _Design: Access patterns 3 and 4; Requirements: 6.6_
  - [ ] 17.2 Implement `PATCH /api/author/entries/{id}`
    - Accept a replacement title of 1–120 code points and a replacement body of 1–20000 code
      points, leave `sessionDate` and `createdAt` unchanged, set `updatedAt` to the acceptance time
    - Reject out-of-bound content with 400 naming the violated bound, leaving the stored title,
      body, and `updatedAt` unchanged
    - _Design: Devlog_API; Requirements: 6.2, 6.7_
  - [ ] 17.3 Implement publish and unpublish
    - `UpdateItem` with a condition on the current status so a doubled request returns 409 with no
      change to status, `updatedAt`, or timeline membership; maintain `GSI1PK` as `TL#PUB` or
      `TL#DRAFT`
    - Reject publishing a body under 200 code points with 400 stating the minimum, retaining status
      `draft`
    - _Design: Publish and propagation path; Requirements: 6.3, 6.4, 6.5, 6.8_
  - [ ] 17.4 Implement draft deletion
    - `DELETE /api/author/entries/{id}` with a condition `status = draft`, after which every request
      naming the identifier returns 404 and the Entry appears in no listing
    - _Design: Access patterns 12; Requirements: 6.9_
  - [ ] 17.5 Implement best-effort CloudFront invalidation
    - Issue `CreateInvalidation` for `/`, `/page/*`, `/entry/{id}`, and `/feed.xml` on publish,
      unpublish, delete of a published Entry, and edit of a published Entry; a failure is logged at
      `warn` and the request still returns 200
    - _Design: Publish and propagation path; Requirements: 6.3, 6.4_
  - [ ] 17.6 Write the model-based property test for status transitions
    - **Property 20: Status transitions follow the two-state machine**
    - **Validates: Requirements 6.3, 6.4, 6.5, 6.8, 6.9**
  - [ ] 17.7 Write the property test for editing
    - **Property 21: Editing preserves identity fields and rejections change nothing**
    - **Validates: Requirements 6.2, 6.7**

- [ ] 18. Author_Console
  - [ ] 18.1 Implement the `AuthorConsoleClient` module
    - `src/console/client.ts` implementing the design's interface; access token held in memory and
      mirrored to `sessionStorage` only, never `localStorage` and never a cookie
    - _Design: Author_Console; Requirements: 2.8, 6.2_
  - [ ] 18.2 Implement the five console screens
    - Sign in, submit session, draft list in the Req 6.6 order, draft edit, published list; the
      `generationFailed` badge with raw notes ready to edit; the 2-second polling loop with a
      90-second ceiling surfacing a "still working" state and manual refresh
    - Navigate to the session view rather than the entry view after submission, transitioning to the
      entry once `generationState` leaves `pending`
    - _Design: Author_Console, Authenticated write path; Requirements: 5.4, 6.6, 6.2, 6.3, 6.4, 6.9_
  - [ ] 18.3 Bundle and serve the console
    - Build `/console/*` with `scripts/build.ts`, deploy it as an S3 bucket asset, and wire the
      `/console/*` CloudFront behaviour with `max-age=0` on `index.html` and immutable hashed assets
    - _Design: Route map; Requirements: 1.1_
  - [ ] 18.4 Write unit tests for the console client bounds
    - Length counters count Unicode code points and match the server bounds (120 title, 20000 body,
      20000 note text) for emoji and combining-mark input
    - _Design: Author_Console; Requirements: 3.3, 6.7_

- [ ] 19. Public_Site read path
  - [ ] 19.1 Define the `site-renderer` Lambda and its IAM
    - Node.js 22, arm64, 512 MB, 10 s timeout, reserved concurrency 20, explicit log group; IAM
      granting `GetItem` and `Query` on the table and GSI1 plus `UpdateItem` scoped to `IPB#*` keys
      by the `dynamodb:LeadingKeys` condition, so no write to an `ENTRY#` item is possible
    - Wire the default CloudFront behaviour and the `/`, `/page/{n}`, `/entry/{id}` routes to it
    - _Design: Public_Site, Least-privilege IAM; Requirements: 9.4, 10.4, 10.5_
  - [ ] 19.2 Implement `renderTimeline`
    - One descending GSI1 query with `Limit = n * 20 + 1`, discarding the leading `(n-1) * 20`
      items, rendering 20, and using the extra item to decide the following-page link; preceding-page
      link whenever `n ≥ 2`; out-of-range pages render the empty state with status 200
    - Render each entry's title, ISO 8601 session date, and a link addressed by the entry
      identifier; render the 100–600 character introductory text above the first entry; render the
      empty-state message when there are zero Published_Entries
    - Set `Cache-Control: public, max-age=0, s-maxage=30` with no `stale-while-revalidate`
    - _Design: Pagination, Publish and propagation path; Requirements: 1.6, 7.1, 7.2, 7.9, 16.8_
  - [ ] 19.3 Implement `renderEntry` and the not-found page
    - Render the title as the document title and the top-level heading, the ISO 8601 session date,
      and the body through Markdown_Renderer
    - Return a genuine HTTP 404 with a not-found page linking to the Public_Timeline for an absent
      identifier or an Entry holding status `draft`
    - _Design: Why public HTML is server-rendered; Requirements: 7.3, 7.4_
  - [ ] 19.4 Implement the degraded read path
    - Catch a DynamoDB error, throttle, timeout, or `DecodeError` at the router boundary and return
      status 200 with the "entries are temporarily unavailable" page, performing no write
    - _Design: Public_Site (Degraded read path); Requirements: 1.8_
  - [ ] 19.5 Write the property test for pagination
    - **Property 10: Pagination partitions the timeline exactly once**
    - **Validates: Requirements 7.9**
  - [ ] 19.6 Write the property test for draft opacity
    - **Property 19: Drafts are indistinguishable from entries that do not exist**
    - **Validates: Requirements 2.4, 6.1, 7.4**
  - [ ]* 19.7 Implement the RSS 2.0 feed
    - `GET /feed.xml` listing the 20 most recent Published_Entries in the timeline order with title,
      link, and session date, served with the RSS content type and the same `s-maxage=30`; render a
      link to the feed on the Public_Timeline
    - Optional: Req 7.8 is WHERE-guarded, so the timeline is complete without it
    - _Design: Route map, Access patterns 5; Requirements: 7.8_
  - [ ]* 19.8 Write the property test for the feed
    - **Property 11: The feed mirrors the timeline and is well-formed XML**
    - **Validates: Requirements 7.8**
    - Optional: applies only if sub-task 19.7 is implemented

- [ ] 20. Presentation and accessibility
  - [ ] 20.1 Write the single public stylesheet
    - Fluid single-column layout with `max-width` in `ch` units and no fixed-width elements, correct
      from 320 to 1920 CSS pixels with no horizontal scrolling; a `:focus-visible` outline rule with
      a non-transparent colour on every interactive element
    - _Design: Public_Site (Presentation obligations); Requirements: 7.6, 7.10_
  - [ ] 20.2 Implement the contrast-ratio function and its unit test
    - A pure function computing the WCAG contrast ratio, plus a unit test asserting every
      foreground/background pair in the palette is at least 4.5:1, so a palette change fails the
      build
    - _Design: Accessibility verification; Requirements: 7.7_
  - [ ] 20.3 Add the axe-core checks over rendered HTML
    - Run `axe-core` in jsdom against the rendered timeline, an entry page, the empty state, and the
      not-found page, checking heading order, link names, landmark structure, and image alternatives
    - _Design: Accessibility verification; Requirements: 7.7_

- [ ] 21. Observability, alarms, and the availability probe
  - [ ] 21.1 Implement the health probe Lambda and its schedule
    - `src/probe/handler.ts` requesting the health route through the Public_URL, measuring latency,
      and publishing one custom metric with value 1 or 0; EventBridge rule at a 5-minute cadence;
      IAM limited to `cloudwatch:PutMetricData` on one namespace and its own log group
    - _Design: Availability probing without Synthetics; Requirements: 11.8, 10.1_
  - [ ] 21.2 Define the SNS topic and the three required alarms
    - `infra/lib/observability.ts`: SNS topic with an email subscription to the `authorEmail`
      context value
    - Billing forecast alarm on forecast monthly charges over 20 USD evaluated at least every 6
      hours, with notification as its only action and no change to concurrency limits
    - Server error rate alarm as metric math over API Gateway `5XXError` and `Count`, breaching
      above 5 % across a 5-minute window gated on `Count >= 10`
    - Availability alarm on the probe metric with 2 evaluation periods of 300 seconds
    - _Design: Metrics and alarms; Requirements: 10.2, 10.3, 10.8, 11.4, 11.5, 11.8_
  - [ ]* 21.3 Add the generation failure rate alarm
    - Alarm when `generationFailed` writes exceed 25 % over 1 hour, notifying the same topic
    - Optional: the design labels this operational rather than required by any acceptance criterion
    - _Design: Metrics and alarms; Requirements: none (operational)_
  - [ ] 21.4 Write CDK template assertions for observability and cost control
    - Billing alarm targets the forecast metric with threshold 20 and a period of 6 hours or less;
      every alarm has an SNS action and the topic has an email subscription; the 5xx alarm
      expression matches the 5 %-over-5-minutes-with-at-least-10-requests shape; the availability
      alarm uses 2 evaluation periods of 300 seconds; the Bedrock policy names one model resource
      and one action
    - _Design: Infrastructure assertions; Requirements: 9.4, 10.2, 10.3, 10.6, 11.4, 11.5, 11.8_

- [ ] 22. Checkpoint - full System deployed and functional
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 23. Integration tests against the deployed stack
  - [ ] 23.1 Round-trip publish and read
    - Submit Session_Input with a real Bedrock call, poll to `generated`, publish, then poll the
      Public_URL until the entry appears, asserting arrival within 60 seconds
    - _Design: Integration tests 1; Requirements: 5.1, 5.2, 6.3_
  - [ ] 23.2 Unpublish propagation
    - Publish, confirm visibility, unpublish, confirm absence from the Public_URL within 60 seconds
    - _Design: Integration tests 2; Requirements: 6.4_
  - [ ] 23.3 Draft opacity over the wire
    - Create a Draft, request it unauthenticated, assert 404 with a body identical to the response
      for a random absent identifier
    - _Design: Integration tests 3; Requirements: 2.4, 7.4_
  - [ ] 23.4 HTTP to HTTPS redirect
    - Request `http://<public-url>/entry/x?y=1` and assert a redirect to the HTTPS equivalent with
      path and query preserved and no timeline content in the HTTP response
    - _Design: Integration tests 4; Requirements: 1.4_
  - [ ] 23.5 Health and version agreement
    - Assert the health route returns 200 with a version identifier equal to the
      `DeployedVersionIdentifier` stack output, and that the body carries nothing else
    - _Design: Integration tests 5; Requirements: 11.6, 12.4_
  - [ ] 23.6 Empty state
    - Against a stack with no Published_Entries, assert the Public_URL returns 200 with the
      empty-state message
    - _Design: Integration tests 6; Requirements: 1.6_
  - [ ] 23.7 Rate limit behaviour
    - Drive more than the burst allowance from one address, assert 429 with a whole-number
      retry-after, then assert in-limit requests still succeed
    - _Design: Integration tests 7; Requirements: 9.1, 9.2_
  - [ ] 23.8 Authentication lockout
    - Five failed sign-ins, then assert further attempts receive the identical generic response for
      15 minutes
    - _Design: Integration tests 8; Requirements: 9.9_
  - [ ] 23.9 Oversize request body
    - POST a 300 KB body and assert 413 with no Entry_Store change
    - _Design: Integration tests 9; Requirements: 9.3_
  - [ ] 23.10 Encryption and recovery window
    - `DescribeTable` and `DescribeContinuousBackups` asserting SSE is present and the PITR window
      is 35 days
    - _Design: Integration tests 10; Requirements: 8.1, 8.6_
  - [ ] 23.11 Deploy idempotence
    - Deploy, assert `cdk diff` reports no changes, deploy again and assert the CloudFormation event
      stream contains zero creations, replacements, and deletions
    - _Design: Integration tests 11; Requirements: 12.3_
  - [ ] 23.12 Public URL stability
    - Compare the recorded Public_URL against the output of a redeploy and assert it is unchanged
    - _Design: Integration tests 12; Requirements: 1.7_
  - [ ] 23.13 Synth determinism from the shell
    - Run `cdk synth` twice into separate directories and diff, covering asset hashing that
      in-process synthesis does not exercise
    - _Design: Integration tests 13; Requirements: 12.8_

- [ ] 24. Hackathon deliverables
  - [ ] 24.1 Assemble the Agent_Proof_Artifact
    - `docs/agent-proof/` holding between 2 and 10 files, including at least one AWS console
      screenshot at a minimum width of 1280 pixels with no downscaling and at least one Kiro
      transcript excerpt committed as Markdown of 10–200 selectable lines
    - `docs/agent-proof/README.md` as the index carrying, per file, a caption naming the agent as
      Kiro, an ISO 8601 capture date inside 2026-09-18 to 2026-10-02, the AWS service shown, and the
      category of value removed from each masked region
    - Pair at least one transcript excerpt showing an operation requested through Kiro with a
      console screenshot of the resulting resource state in the same service (the first `cdk deploy`
      and the created DynamoDB table)
    - _Design: Agent_Proof_Artifact (Req 13); Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.7, 13.8_
  - [ ] 24.2 Write the repository lint script
    - `scripts/lint-repo.ts` checking: agent-proof file count between 2 and 10, a caption and a date
      present for every file, every date inside the window, the category tag `personal-expression`
      and lane tag `community` present exactly once each, and every tracked file whose first commit
      predates 2026-09-18 flagged for disclosure
    - Wire it into `npm test`
    - _Design: Hackathon Deliverable Mechanics; Requirements: 13.1, 13.4, 15.1, 15.2, 15.3, 15.4_
  - [ ] 24.3 Author and render the architecture diagram
    - `docs/architecture.mmd` derived from the design's architecture diagram, rendered to
      `docs/architecture.png` by an npm script using `@mermaid-js/mermaid-cli`, both committed
    - The render script fails if any node label is not found verbatim in the requirements Glossary;
      the diagram shows the request path from a Reader through CloudFront and API Gateway to
      Public_Site and on to Entry_Store and names every AWS service the System uses
    - _Design: Builder_Writeup architecture diagram (Req 14.9); Requirements: 14.6, 14.9_
  - [ ] 24.4 Generate `THIRD-PARTY.md` and enforce the license allow-list
    - An npm script reading the lockfile to record every dependency name and license, plus a check
      that each recorded license is on a permissive allow-list compatible with redistribution under
      the repository's MIT license; fail the build on a non-permitted license
    - _Design: Originality and licensing (Req 15); Requirements: 15.8, 15.9, 15.10_
  - [ ] 24.5 Write the README operational content
    - The documented deploy command, the `admin-set-user-password` manual step, and the separate
      documented procedure for deleting Entry_Store data outside the deploy command
    - _Design: Repository layout, Infrastructure_Stack; Requirements: 12.2, 12.7_
  - [ ] 24.6 Write the Builder_Writeup
    - Cover all ten obligations from the design's content table: purpose and problem in at least 100
      words with a concrete example, at least 3 dated milestones inside the window each with the
      work done and how it was confirmed, at least 3 named Kiro contributions each with the task and
      observable result, HTTPS links to the Public_URL and the Agent_Proof_Artifact, the technical
      approach naming each AWS service and its role, the intended audience and a stated impact, the
      architecture diagram, the license name, and the category and lane tags
    - Cite at least 3 Published_Entries by link resolving on the Public_Site
    - _Design: Builder_Writeup content obligations; Requirements: 14.1–14.10, 15.4, 15.8, 16.5_
  - [ ] 24.7 Produce the self-documenting build record
    - Submit Session_Input through the deployed Author_Console and publish at least 7 entries across
      at least 5 distinct session dates inside 2026-09-18 to 2026-10-02, each generated by the
      Entry_Generator with its note text retained
    - Ensure at least one entry names a problem encountered and the change that removed it, at least
      one names the agent as Kiro with a concrete task it completed, and at least one was generated
      from Session_Input that included a Commit_Log and quotes a commit subject
    - _Design: Write-up sourcing, Sequencing risk; Requirements: 16.1, 16.2, 16.3, 16.4, 16.6, 16.7_

- [ ] 25. Ship-gate verification
  - [ ] 25.1 Automate the scriptable ship-gate checks
    - `scripts/ship-gate.ts` running the mechanical rows: `curl -I` on the HTTP origin for the
      redirect, ten timed HTTPS requests asserting every sample under 3 seconds, the health route
      and version match, the published-entry count and distinct session dates, the introductory text
      length, pagination link resolution, the draft-identifier 404 comparison, and
      `gitleaks detect` over tracked files
    - _Design: Ship-gate verification checklist; Requirements: 1.2, 1.3, 1.4, 11.6, 12.5, 16.1,
      16.2, 16.8_
  - [ ] 25.2 Execute the full 21-row ship-gate checklist
    - Run `scripts/ship-gate.ts`, then complete the manual rows from a device and network that have
      never touched the build: private-window load with no credential prompt, keyboard-only pass
      with visible focus, viewport sweep at 320, 768, and 1920 CSS pixels, feed reader check, billing
      console and alarm states, every Builder_Writeup and Agent_Proof_Artifact link followed
      unauthenticated, submission metadata, and Submission_Package completeness
    - A failure on rows 1 through 4 is a stop-everything event
    - _Design: Ship-gate verification checklist; Requirements: 1.2, 1.5, 7.6, 7.8, 7.10, 10.2, 10.3,
      11.4, 11.5, 11.8, 13.6, 13.9, 14.8, 15.6, 15.7_

- [ ] 26. Final checkpoint - submission ready
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional: the RSS feed and its property test (19.7, 19.8), which
  Requirement 7.8 guards with WHERE, and the generation failure rate alarm (21.3), which the design
  labels operational rather than required by any acceptance criterion. Everything else, including
  every property test and integration test, is in scope — the properties are how the round-trip,
  totality, determinism, idempotence, and total-ordering criteria are discharged, so skipping them
  would leave those requirements unverified.
- All 27 correctness properties appear exactly once: 1–4 with the parser and printer (tasks 3, 4),
  5–6 with the serializer (5), 7–8 with the repository (9), 9 with ordering (6), 10 and 19 with the
  public read path (19), 11 with the feed (19, optional), 12–13 with the renderer (7), 14–16 with
  Session_Input capture (14), 17–18 with the generator (15), 20–21 with status transitions (17), 22
  with the rate limiter (13), 23–25 with the API spine (10), 26 with auth (12), 27 with the stack
  (11).
- Each property test carries the tag comment the design requires immediately above `fc.assert`, runs
  a minimum of 100 iterations, and calls no AWS service: the Entry_Store is the in-memory fake,
  Bedrock is a stub, and time comes from the injectable clock.
- Task 11.6 is the ship gate. Everything after it is improvement on a site that is already publicly
  reachable; nothing before it can be verified against the requirement that decides pass or fail.
- Task 24.7 must begin as soon as task 17 completes, not at the end. Seven entries across five
  distinct session dates cannot be produced in one sitting, and Requirement 14 depends on them
  existing before the write-up is written.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4"] },
    { "id": 2, "tasks": ["2.1"] },
    { "id": 3, "tasks": ["2.2", "2.3", "3.1"] },
    { "id": 4, "tasks": ["3.2", "3.3", "3.4", "3.5", "4.1", "5.1", "6.1", "7.1"] },
    { "id": 5, "tasks": ["4.2", "5.2", "6.2", "7.2", "9.1", "10.2"] },
    { "id": 6, "tasks": ["5.3", "5.4", "7.3", "7.4", "9.2", "10.1"] },
    { "id": 7, "tasks": ["9.3", "9.4", "10.3", "11.1", "12.1"] },
    { "id": 8, "tasks": ["9.5", "11.2", "12.3", "13.1"] },
    { "id": 9, "tasks": ["10.4", "10.5", "10.6", "11.3", "12.4", "13.2"] },
    { "id": 10, "tasks": ["11.4", "12.5", "12.7", "13.3", "14.1"] },
    { "id": 11, "tasks": ["11.5", "11.6", "12.6", "13.4", "14.2", "15.1"] },
    { "id": 12, "tasks": ["12.2", "14.3", "15.2"] },
    { "id": 13, "tasks": ["14.4", "14.5", "14.6", "15.3"] },
    { "id": 14, "tasks": ["15.4", "17.1", "19.1"] },
    { "id": 15, "tasks": ["15.5", "15.6", "17.2", "17.3", "19.2"] },
    { "id": 16, "tasks": ["17.4", "17.5", "19.3", "19.4", "20.1"] },
    { "id": 17, "tasks": ["17.6", "17.7", "19.5", "19.7", "20.2", "21.1"] },
    { "id": 18, "tasks": ["18.1", "19.6", "19.8", "20.3", "21.2"] },
    { "id": 19, "tasks": ["18.2", "21.3", "24.3", "24.4"] },
    { "id": 20, "tasks": ["18.3", "18.4", "21.4", "24.1", "24.2", "24.5"] },
    { "id": 21, "tasks": ["23.1", "23.2", "23.3", "23.4", "23.5", "23.6", "23.7", "23.8", "23.9", "23.10", "25.1"] },
    { "id": 22, "tasks": ["23.11", "23.12", "23.13", "24.7"] },
    { "id": 23, "tasks": ["24.6"] },
    { "id": 24, "tasks": ["25.2"] }
  ]
}
```
