# Requirements Document

## Introduction

Devlog Narrator is a public build-in-public journal for a single builder. At the end of a work
session the Author drops raw material into the Author_Console: freeform notes and, optionally,
pasted `git log` output. The system turns that raw material into a readable devlog entry, holds the
entry as a draft for the Author to review and edit, and publishes approved entries to a public
timeline at a stable URL.

The system is also the submission for the AWS "Zero to Shipped" hackathon (submission window
2026-09-18 to 2026-10-02). The hackathon imposes pass/fail delivery obligations that are captured
here as first-class requirements alongside the product behavior, because a working local build that
is not publicly reachable on AWS at judging time scores zero regardless of quality.

The system documents its own construction. Entries written during the build period become the
primary source material for the required Builder Center write-up, which makes the storytelling
artifact a byproduct of using the product rather than a separate writing task.

## Glossary

- **System**: The complete deployed Devlog Narrator application, comprising Public_Site,
  Author_Console, Devlog_API, and Infrastructure_Stack.
- **Author**: The single authenticated human who owns the devlog and writes entries. This build
  supports exactly one Author.
- **Reader**: Any unauthenticated member of the public who views the Public_Site.
- **Public_Site**: The publicly reachable, unauthenticated web frontend that renders the
  Public_Timeline and individual published entries.
- **Author_Console**: The authenticated web interface used by the Author to submit Session_Input,
  review Drafts, edit Drafts, and publish Entries.
- **Devlog_API**: The HTTP API that serves read requests for published Entries and write requests
  from the Author_Console.
- **Health route**: The Devlog_API route, reachable without credentials, that reports that the
  System is running by returning HTTP status 200 and the deployed version identifier.
- **Correlation identifier**: The short identifier the Devlog_API assigns to a single request and
  includes in every log record emitted while handling that request.
- **Deployed version identifier**: The string naming the build of the System currently deployed,
  reported both as a named Infrastructure_Stack deployment output and by the health route.
- **Auth_Service**: The identity component that authenticates the Author and issues session
  credentials.
- **Session_Input**: The raw material submitted for one work session: a required freeform note text
  and an optional Commit_Log.
- **Commit_Log**: Text in `git log` output format supplied as part of Session_Input.
- **Commit_Record**: A structured representation of one commit, containing commit hash, author name,
  author date, and subject line.
- **Commit_Log_Parser**: The component that converts Commit_Log text into an ordered list of
  Commit_Records.
- **Commit_Log_Printer**: The component that converts an ordered list of Commit_Records back into
  Commit_Log text.
- **Entry_Generator**: The component that converts Session_Input into Entry narrative content using
  a large language model.
- **Entry**: A single devlog record, holding a title, Markdown body, session date, status, creation
  timestamp, and last-modified timestamp.
- **Draft**: An Entry whose status is `draft`. A Draft is visible only to the authenticated Author.
- **Published_Entry**: An Entry whose status is `published`. A Published_Entry is visible to
  Readers.
- **Public_Timeline**: The reverse-chronological list of Published_Entries rendered by the
  Public_Site.
- **Entry_Serializer**: The component that converts an Entry to and from the persisted storage
  representation.
- **Entry_Store**: The persistent datastore holding Entries.
- **Infrastructure_Stack**: The infrastructure-as-code definition that provisions all AWS resources
  for the System.
- **Billing alarm**: The alarm provisioned by the Infrastructure_Stack that evaluates forecast
  monthly charges for the AWS account and enters a triggered state when the forecast exceeds the
  configured threshold.
- **Public_URL**: The single HTTPS URL at which Readers reach the Public_Site.
- **Judging_Period**: The interval beginning at the close of the hackathon submission window
  (2026-10-02) during which judges access the Public_URL and the Submission_Package.
- **Submission_Package**: The set of hackathon deliverables: the Public_URL, the
  Agent_Proof_Artifact, the Builder_Writeup, the Category_Tag, and the Lane_Tag.
- **Agent_Proof_Artifact**: Documented evidence that an AI coding agent was connected to the AWS
  console during development.
- **Builder_Writeup**: The Builder Center project write-up describing the application, the
  development process, and the coding agent's contribution.
- **Category_Tag**: The single hackathon category label applied to the submission. For this
  submission the value is `personal-expression`.
- **Lane_Tag**: The single lane label applied to the submission. For this submission the value is
  `community`.

## Scope Boundaries

The following are deliberately excluded from this build to protect the two-week delivery window.
Each may become a follow-on spec.

- Multiple Authors, teams, or per-Reader accounts.
- Audio or voice capture and transcription of Session_Input.
- Direct OAuth integration with a git hosting provider. Commit history enters the System as pasted
  text only.
- Comments, reactions, or any Reader-submitted content.
- Custom domain registration. The System may ship on an AWS-issued hostname.

## Requirements

### Requirement 1: Publicly Reachable Deployment

**User Story:** As the Author, I want the application running on AWS and reachable by anyone at a
stable URL, so that the submission clears the hackathon ship gate.

#### Acceptance Criteria

1. THE System SHALL run on AWS infrastructure, with every compute, storage, and networking
   resource the Public_Site, Author_Console, Devlog_API, and Entry_Store depend on provisioned by
   the Infrastructure_Stack.
2. WHILE the Judging_Period is active, THE Public_Site SHALL return the Public_Timeline over HTTPS
   at the Public_URL to requests carrying no credentials from any source address on the public
   internet, and SHALL return a successful response to at least 99 percent of such requests
   measured over any 24-hour window.
3. WHEN a Reader requests the Public_URL, THE Public_Site SHALL return a response with HTTP status
   200 within 3 seconds at the 95th percentile, measured over any rolling 5-minute window
   containing at least 20 requests.
4. IF a request arrives at the Public_URL over HTTP, THEN THE Public_Site SHALL redirect the
   request to the HTTPS equivalent of the requested path, preserving the path and query string of
   the request, and SHALL return no Public_Timeline content over the HTTP connection.
5. THE Public_Site SHALL serve the Public_Timeline to requests carrying no credential without
   returning an authentication challenge or a redirect to the Author_Console, because public
   readability is the purpose of a build-in-public devlog.
6. WHILE the Entry_Store contains zero Published_Entries, THE Public_Site SHALL return HTTP status
   200 for requests to the Public_URL and SHALL render an empty-state message indicating that no
   entries have been published yet.
7. WHEN the Infrastructure_Stack is redeployed, THE Public_URL SHALL remain unchanged from the
   value reported by the preceding successful deployment.
8. IF the Public_Site cannot retrieve Published_Entries from the Entry_Store, THEN THE Public_Site
   SHALL render a message indicating that entries are temporarily unavailable and SHALL leave the
   Entry_Store unchanged.

### Requirement 2: Author Authentication and Authorization

**User Story:** As the Author, I want write access restricted to me, so that no other party can
create, alter, or publish entries on the devlog.

#### Acceptance Criteria

1. WHEN a request to create, modify, publish, or unpublish an Entry arrives at the Devlog_API, THE
   Devlog_API SHALL verify the credential carried by the request and SHALL treat that credential as
   valid only where the credential was issued by the Auth_Service, is well-formed, has not passed
   its expiry time, has not been revoked, and identifies the Author.
2. IF a request to create, modify, publish, or unpublish an Entry carries no credential, THEN THE
   Devlog_API SHALL reject the request with HTTP status 401, SHALL return an error response
   indicating that authentication is required, and SHALL leave the Entry_Store unchanged.
3. IF a request to create, modify, publish, or unpublish an Entry carries a credential that
   identifies a principal other than the Author, THEN THE Devlog_API SHALL reject the request with
   HTTP status 403, SHALL return an error response indicating that the principal is not permitted
   to perform the operation, and SHALL leave the Entry_Store unchanged.
4. IF a request to read a Draft carries no credential, or carries a credential that criterion 1
   does not establish as valid for the Author, THEN THE Devlog_API SHALL reject the request with
   HTTP status 404, SHALL exclude every field of the Draft from the response body, and SHALL return
   a response body identical in shape to the response returned for an Entry identifier absent from
   the Entry_Store.
5. WHEN the Auth_Service issues a session credential, THE Auth_Service SHALL set the expiry time of
   that credential to exactly 12 hours after the issuance time, measured in UTC.
6. THE Auth_Service SHALL transmit credentials only over HTTPS connections and SHALL refuse to
   establish a session over a connection that is not HTTPS.
7. IF a request to create, modify, publish, or unpublish an Entry carries a credential that is
   malformed, that has passed its expiry time, or that the Auth_Service did not issue, THEN THE
   Devlog_API SHALL reject the request with HTTP status 401, SHALL return an error response
   indicating that the credential is not valid and that re-authentication is required, and SHALL
   leave the Entry_Store unchanged.
8. WHEN the Author ends a session through the Author_Console, THE Auth_Service SHALL record the
   session credential as revoked within 5 seconds of receiving the end-session request.
9. IF a request to create, modify, publish, unpublish, or read an Entry carries a credential
   recorded as revoked, THEN THE Devlog_API SHALL reject the request with HTTP status 401 and SHALL
   leave the Entry_Store unchanged.

### Requirement 3: Raw Session Capture

**User Story:** As the Author, I want to dump unstructured notes from a work session in one action,
so that recording a session costs me under a minute.

#### Acceptance Criteria

1. WHEN the Author submits Session_Input whose note text contains between 1 and 20000 Unicode
   characters inclusive and at least 1 non-whitespace character, THE Devlog_API SHALL accept the
   Session_Input and SHALL return, within 60 seconds of submission, an identifier for the resulting
   Draft that differs from the identifier of every other Entry held in the Entry_Store.
2. IF submitted Session_Input contains note text of zero characters or note text consisting only of
   whitespace characters, THEN THE Devlog_API SHALL reject the submission with HTTP status 400,
   SHALL return a message naming the empty note text field, and SHALL leave the Entry_Store
   unchanged.
3. IF submitted Session_Input contains note text exceeding 20000 Unicode characters, THEN THE
   Devlog_API SHALL reject the submission with HTTP status 400, SHALL return a message stating the
   20000 character limit, and SHALL leave the Entry_Store unchanged.
4. WHERE the Author supplies a session date with the Session_Input, IF the supplied value is a
   calendar date in ISO 8601 date format falling on or before the submission date in UTC, THEN THE
   Devlog_API SHALL record the supplied session date on the resulting Entry.
5. WHERE the Author omits a session date from the Session_Input, THE Devlog_API SHALL record the UTC
   calendar date at the instant of acceptance as the session date on the resulting Entry.
6. WHEN the Devlog_API accepts Session_Input, THE Devlog_API SHALL retain the submitted note text
   alongside the generated Entry character for character, preserving whitespace, line breaks, and
   Unicode characters outside the ASCII range, and SHALL return that retained note text to the
   Author on request.
7. WHERE the Author supplies a session date with the Session_Input, IF the supplied value is not a
   calendar date in ISO 8601 date format, THEN THE Devlog_API SHALL reject the submission with HTTP
   status 400, SHALL return a message naming the session date field and the expected date format,
   and SHALL leave the Entry_Store unchanged.
8. WHERE the Author supplies a session date with the Session_Input, IF the supplied value falls
   after the submission date in UTC, THEN THE Devlog_API SHALL reject the submission with HTTP
   status 400, SHALL return a message stating that the session date cannot follow the submission
   date, and SHALL leave the Entry_Store unchanged.

### Requirement 4: Commit Log Parsing and Printing

**User Story:** As the Author, I want to paste raw `git log` output alongside my notes, so that the
generated entry reflects what the code actually did without me restating it.

#### Acceptance Criteria

1. WHEN a Commit_Log of up to 100000 characters holding up to 500 commit entries is supplied, where
   each commit entry consists of a `commit` line carrying 7 to 40 hexadecimal characters, an
   optional `Merge` line, an `Author` line carrying an author name followed by an email address in
   angle brackets, a `Date` line carrying the author date, a blank line, and zero or more body
   lines each indented by 4 spaces, with commit entries separated by a blank line, THE
   Commit_Log_Parser SHALL produce an ordered list of Commit_Records preserving the order of
   appearance in the Commit_Log and SHALL complete parsing within 1 second.
2. WHEN a supplied Commit_Log uses carriage-return-line-feed line endings or holds author names
   containing Unicode characters outside the ASCII range, THE Commit_Log_Parser SHALL produce the
   same Commit_Record list, character for character in every field, that the Commit_Log_Parser
   produces for the line-feed-terminated equivalent of that Commit_Log.
3. WHEN a commit entry in a supplied Commit_Log holds zero body lines, THE Commit_Log_Parser SHALL
   produce a Commit_Record with a subject of zero characters and SHALL retain the commit hash, the
   author name, and the author date of that commit entry.
4. IF a supplied Commit_Log does not conform to the format stated in criterion 1, THEN THE
   Commit_Log_Parser SHALL return an error identifying the first non-conforming line by its 1-based
   line number and SHALL return no Commit_Record list.
5. THE Commit_Log_Printer SHALL convert an ordered list of Commit_Records into Commit_Log text
   conforming to the format stated in criterion 1, using line-feed line endings, such that the
   Commit_Log_Parser parses that text without error.
6. FOR ALL Commit_Record lists that the Commit_Log_Printer prints without error, THE
   Commit_Log_Parser SHALL produce a Commit_Record list whose commit hash, author name, author
   date, and subject fields equal those of the original list in the same order when parsing the
   output of the Commit_Log_Printer applied to that list (round-trip property).
7. WHERE a Commit_Log is supplied with Session_Input and parsing that Commit_Log yields at least
   one Commit_Record with a subject of 1 or more characters, THE Entry_Generator SHALL include the
   subject text of at least one such Commit_Record verbatim in the generated Entry body.
8. WHEN a supplied Commit_Log holds zero characters or holds only whitespace characters, THE
   Commit_Log_Parser SHALL produce a Commit_Record list of zero elements and SHALL return no error.
9. WHEN a commit entry in a supplied Commit_Log holds 2 or more body lines, THE Commit_Log_Parser
   SHALL set the Commit_Record subject to the text of the first body line with its 4-space indent
   removed and SHALL exclude the remaining body lines from the subject.
10. FOR ALL text inputs of up to 262144 bytes, THE Commit_Log_Parser SHALL return either a
    Commit_Record list or an error identifying a line number (totality property), and SHALL return
    the identical result for every repeated parse of identical input (determinism property).

### Requirement 5: Devlog Entry Generation

**User Story:** As the Author, I want raw notes turned into a readable narrative entry, so that
publishing does not depend on me having energy to write prose.

#### Acceptance Criteria

1. WHEN the Devlog_API accepts Session_Input, THE Entry_Generator SHALL produce an Entry containing
   a title of between 1 and 120 characters and a Markdown body of between 200 and 10000 characters.
2. WHEN the Entry_Generator produces an Entry, THE Devlog_API SHALL persist the Entry with status
   `draft` within 5 seconds of generation completion and SHALL set the creation timestamp and the
   last-modified timestamp of the Entry to the persistence time in UTC.
3. WHEN the Devlog_API accepts Session_Input, THE Entry_Generator SHALL complete generation,
   including every retry and repeat attempt, within 60 seconds of Session_Input acceptance, and
   SHALL perform at most 4 language model invocations for that Session_Input.
4. IF generation does not complete within the 60 seconds stated in criterion 3, THEN THE Devlog_API
   SHALL persist a Draft whose body is the unaltered Session_Input note text and whose title states
   the session date of the Session_Input, SHALL mark the Draft with a generation-failed indicator
   readable in the Author_Console, and SHALL retain status `draft`.
5. IF the language model returns an error response or a throttling response, THEN THE Devlog_API
   SHALL retry generation up to 2 further times, SHALL wait between 1 and 5 seconds before each
   retry, and SHALL apply criterion 4 when the final retry returns an error response or a
   throttling response or when the 60 seconds stated in criterion 3 elapse first.
6. WHEN the Entry_Generator invokes the language model, THE Entry_Generator SHALL supply as model
   input only a fixed instruction template, the Session_Input note text, and the Commit_Records
   parsed from the supplied Commit_Log, excluding the content of any other Entry and any content
   retrieved from outside the Session_Input.
7. IF the language model returns a title outside the range of 1 to 120 characters or a body outside
   the range of 200 to 10000 characters, THEN THE Entry_Generator SHALL discard that output, SHALL
   repeat generation once within the 60 seconds stated in criterion 3, and SHALL apply criterion 4
   when the repeated attempt again returns a title or body outside those ranges.
8. WHEN Session_Input note text contains text that directs the language model to disregard its
   instructions, reveal its instructions, or change the Entry status, THE Entry_Generator SHALL
   treat that text as narrative source content only, THE Devlog_API SHALL persist the resulting
   Entry with status `draft`, and THE Devlog_API SHALL leave every other Entry in the Entry_Store
   unchanged.

### Requirement 6: Draft Review and Publishing Control

**User Story:** As the Author, I want to read and correct a generated entry before anyone else sees
it, so that the public devlog carries only text I stand behind.

#### Acceptance Criteria

1. WHILE an Entry holds status `draft`, THE Devlog_API SHALL exclude the Entry from the
   Public_Timeline, from every single-Entry response served to unauthenticated requests, and from
   any syndication feed the Public_Site serves.
2. WHEN the Author submits a replacement title of 1 to 120 characters or a replacement Markdown
   body of 1 to 20000 characters for a Draft, THE Devlog_API SHALL persist the replacement content,
   SHALL leave the session date and creation timestamp of the Entry unchanged, and SHALL set the
   last-modified timestamp of the Entry to the UTC time at which the replacement was accepted.
3. WHEN the Author publishes a Draft, THE Devlog_API SHALL set the Entry status to `published` and
   SHALL make the Entry retrievable in the Public_Timeline by unauthenticated requests within 60
   seconds of returning the success response, the 60-second bound covering completion of cache
   invalidation on the public delivery path.
4. WHEN the Author unpublishes an Entry holding status `published`, THE Devlog_API SHALL set the
   Entry status to `draft` and SHALL make the Entry absent from the Public_Timeline served to
   unauthenticated requests within 60 seconds of returning the success response, the 60-second
   bound covering completion of cache invalidation on the public delivery path.
5. IF the Author publishes an Entry whose Markdown body contains fewer than 200 characters, THEN THE
   Devlog_API SHALL reject the publish request with HTTP status 400, SHALL return a message stating
   the 200-character body minimum, and SHALL retain status `draft` for the Entry.
6. THE Author_Console SHALL list every Entry holding status `draft` in reverse-chronological order
   by session date, ordering Drafts that share a session date by creation timestamp with the most
   recent first.
7. IF the Author submits a replacement title outside the range of 1 to 120 characters or a
   replacement Markdown body outside the range of 1 to 20000 characters, THEN THE Devlog_API SHALL
   reject the request with HTTP status 400, SHALL return a message stating the violated length
   bound, and SHALL retain the stored title, body, and last-modified timestamp of the Entry
   unchanged.
8. IF the Author publishes an Entry already holding status `published` or unpublishes an Entry
   already holding status `draft`, THEN THE Devlog_API SHALL reject the request with HTTP status 409
   and SHALL leave the Entry status, last-modified timestamp, and Public_Timeline membership
   unchanged.
9. WHEN the Author deletes an Entry holding status `draft`, THE Devlog_API SHALL remove the Entry
   from the Entry_Store, SHALL exclude the Entry from every subsequent Draft listing served to the
   Author_Console, and SHALL return HTTP status 404 for every subsequent request naming that Entry
   identifier.

### Requirement 7: Public Timeline Presentation

**User Story:** As a Reader, I want to follow the build as a sequence of entries, so that I can
understand what was built and how it progressed.

#### Acceptance Criteria

1. WHEN a Reader requests the Public_Timeline, THE Public_Site SHALL present Published_Entries in
   reverse-chronological order by session date, rendering for each Entry the title of the Entry,
   the session date of the Entry in ISO 8601 date format, and a link to the Entry addressed by the
   identifier of the Entry.
2. WHEN two or more Published_Entries carry the same session date, THE Public_Timeline SHALL order
   those Entries by creation timestamp with the most recent first, and SHALL order Entries whose
   session date and creation timestamp are both equal by ascending Entry identifier, yielding a
   single deterministic order for any set of Published_Entries (total ordering property).
3. WHEN a Reader requests a Published_Entry by the identifier of that Entry, THE Public_Site SHALL
   render the title of the Entry as the document title and as the top-level heading, the session
   date in ISO 8601 date format, and the Markdown body converted to HTML, supporting headings of
   levels 1 to 6, bold and italic emphasis, ordered and unordered lists, links, inline code, fenced
   code blocks, and block quotes, and rendering any other Markdown construct as its literal source
   text.
4. IF a Reader requests an Entry identifier that is absent from the Entry_Store or that resolves to
   an Entry holding status `draft`, THEN THE Public_Site SHALL return HTTP status 404 and SHALL
   render a not-found message containing a link to the Public_Timeline.
5. WHEN the Public_Site renders an Entry body, THE Public_Site SHALL render every HTML tag present
   in the Markdown body as literal visible text rather than as markup, so that no script contained
   in the Markdown body executes in the Reader browser.
6. THE Public_Site SHALL render the Public_Timeline at viewport widths from 320 to 1920 CSS pixels
   without horizontal scrolling.
7. THE Public_Site SHALL expose the Public_Timeline and each Published_Entry with document heading
   levels in sequential order skipping no level, with a text contrast ratio of at least 4.5 to 1
   for body text, and with each link carrying an accessible name that states the destination of
   that link.
8. WHERE the Public_Site renders the Public_Timeline, THE Public_Site SHALL serve a syndication feed
   in RSS 2.0 format listing the 20 most recent Published_Entries in the order defined by criteria
   1 and 2, carrying for each Entry the title, the link to the Entry, and the session date, and
   SHALL render a link to that feed on the Public_Timeline.
9. WHEN the count of Published_Entries exceeds 20, THE Public_Site SHALL render the Public_Timeline
   in pages holding at most 20 Entries each in the order defined by criteria 1 and 2, SHALL render
   the page holding the most recent Entries as the Public_Timeline landing page, and SHALL render a
   link to the preceding page and a link to the following page where such a page exists.
10. WHEN a Reader operates the Public_Site using keyboard input alone, THE Public_Site SHALL make
    every link on the Public_Timeline and on each Published_Entry page reachable in document order
    and SHALL render a visible focus indicator on the link currently holding focus.

### Requirement 8: Entry Persistence and Serialization

**User Story:** As the Author, I want entries stored durably and retrieved intact, so that the build
record survives past the hackathon.

#### Acceptance Criteria

1. WHEN the Devlog_API persists an Entry, THE Entry_Store SHALL retain that Entry with the title,
   Markdown body, session date, status, creation timestamp, and last-modified timestamp unchanged
   across System restarts and across redeployments of the Infrastructure_Stack, and SHALL retain a
   recoverable copy permitting restoration of that Entry to any point within the preceding 35 days.
2. FOR ALL Entries whose title is 1 to 120 characters, whose Markdown body is 1 to 20000
   characters, and whose session date, status, creation timestamp, and last-modified timestamp are
   each present, THE Entry_Serializer SHALL produce a persisted storage representation without
   error (totality property).
3. FOR ALL Entries that the Entry_Serializer writes to the Entry_Store, THE Entry_Serializer SHALL
   produce, on reading that stored representation back, an Entry whose title, Markdown body,
   session date, status, creation timestamp, and last-modified timestamp each equal the
   corresponding value of the original Entry, with text values equal code point for code point and
   timestamp values equal to the same instant in UTC (round-trip property).
4. WHEN an Entry title or body contains Unicode code points outside the ASCII range, including code
   points above U+FFFF, THE Entry_Serializer SHALL produce on read-back the identical sequence of
   Unicode code points, with no substituted, dropped, escaped, or replacement character.
5. WHEN the Devlog_API writes an Entry with the same Entry identifier two or more times, THE
   Entry_Store SHALL hold exactly one Entry carrying that identifier, and that Entry SHALL hold the
   field values of the most recently completed write (idempotence property).
6. THE Entry_Store SHALL encrypt Entry data at rest.
7. FOR ALL pairs of Entries whose field values are equal, THE Entry_Serializer SHALL produce
   persisted storage representations that are identical byte for byte, on every invocation and
   independent of invocation order (determinism property).
8. IF the persisted storage representation of an Entry exceeds 384 kilobytes, THEN THE Devlog_API
   SHALL reject the write with an error indicating that the Entry exceeds the storage size limit
   and SHALL leave the Entry_Store unchanged.
9. WHEN two or more writes targeting the same Entry identifier are in progress at the same time,
   THE Entry_Store SHALL apply each write as a single indivisible update, such that a subsequent
   read returns the complete field set of exactly one of those writes and never a mixture of field
   values drawn from different writes.

### Requirement 9: Public Endpoint Abuse Protection

**User Story:** As the Author, I want the public surface protected against abuse, so that traffic
spikes cannot exhaust my budget or take the site down during judging.

#### Acceptance Criteria

1. THE Devlog_API SHALL limit unauthenticated read routes to a sustained rate of 10 requests per
   second per source address with a burst allowance of 30 requests, and SHALL limit unauthenticated
   read routes across all source addresses combined to a sustained rate of 50 requests per second.
2. IF unauthenticated requests exceed either limit stated in criterion 1, THEN THE Devlog_API SHALL
   reject the excess requests with HTTP status 429, SHALL state in the response the whole number of
   seconds after which the caller may retry, and SHALL continue serving requests that fall within
   the limits.
3. IF a request body exceeds 256 kilobytes, THEN THE Devlog_API SHALL reject the request with HTTP
   status 413 before parsing the body and SHALL leave the Entry_Store unchanged.
4. THE Infrastructure_Stack SHALL grant each compute component permission only to the AWS resources
   that component reads or writes.
5. THE Infrastructure_Stack SHALL keep the Entry_Store unreachable from the public internet by
   denying every connection attempt that does not originate from a compute component of the
   Infrastructure_Stack.
6. WHEN the Devlog_API returns an error response to an unauthenticated request, THE Devlog_API SHALL
   exclude stack traces, resource identifiers, and configuration values from the response body.
7. WHEN the Author submits Session_Input, THE Devlog_API SHALL limit accepted submissions to 10 per
   rolling 60-minute period and 40 per rolling 24-hour period per Author credential, and SHALL
   reject submissions beyond either limit with HTTP status 429 stating the whole number of seconds
   after which the Author may retry.
8. IF a request to a Devlog_API write route declares an origin other than the Public_URL origin or
   the Author_Console origin, THEN THE Devlog_API SHALL withhold cross-origin access approval from
   the response and SHALL leave the Entry_Store unchanged.
9. IF 5 authentication attempts for the Author identity fail within a rolling 15-minute period,
   THEN THE Auth_Service SHALL reject further authentication attempts from the originating source
   address for the following 15 minutes and SHALL return a response that does not indicate whether
   the submitted credential was valid.

### Requirement 10: Cost Control

**User Story:** As the Author, I want the running cost bounded and visible, so that shipping a
public app does not produce a surprise bill.

#### Acceptance Criteria

1. THE Infrastructure_Stack SHALL provision the Entry_Store under on-demand, pay-per-request
   capacity mode and every other AWS resource the System depends on under free-tier or usage-based
   pricing carrying no provisioned-capacity charge, no reserved-capacity commitment, and no minimum
   monthly charge.
2. THE Infrastructure_Stack SHALL provision a billing alarm that evaluates forecast monthly charges
   for the account at least once every 6 hours and enters the triggered state when the forecast
   exceeds 20 US dollars.
3. WHEN the billing alarm enters the triggered state, THE Infrastructure_Stack SHALL deliver a
   notification to the Author email address within 15 minutes, stating the forecast amount and the
   20 US dollar threshold.
4. THE Infrastructure_Stack SHALL set a concurrency limit of at least 10 and at most 50 simultaneous
   executions on each compute component serving requests to the Public_URL, and a concurrency limit
   of 2 simultaneous executions on the compute component running the Entry_Generator.
5. THE Infrastructure_Stack SHALL set an explicit retention period of 30 days or fewer on every log
   group it provisions, leaving no log group with unlimited retention.
6. WHEN the Entry_Generator invokes the language model for one Session_Input, THE Entry_Generator
   SHALL bound that invocation to at most 4000 input tokens and at most 2000 output tokens, and
   SHALL perform at most 4 invocations in total for that Session_Input, counting every retry under
   Requirement 5 criterion 5 and every repeat attempt under Requirement 5 criterion 7.
7. THE Infrastructure_Stack SHALL apply an identical project tag and environment tag to every AWS
   resource it provisions that supports tagging, so that every account charge is attributable to a
   named resource of the System.
8. IF the billing alarm is in the triggered state, THEN THE Infrastructure_Stack SHALL limit its
   automated response to notification delivery, SHALL leave the concurrency limits of criterion 4
   unchanged, and SHALL keep the Public_Site serving the Public_Timeline at the Public_URL.

### Requirement 11: Observability and Failure Handling

**User Story:** As the Author, I want to see what broke and when, so that I can repair the site
quickly during the submission window and the Judging_Period.

#### Acceptance Criteria

1. WHEN the Devlog_API finishes handling a request, THE Devlog_API SHALL emit one JSON-structured
   log record containing the correlation identifier of that request, the route, the HTTP method,
   the HTTP status, and the elapsed duration in milliseconds.
2. IF a component of the System raises an unhandled error while a request is being handled, THEN THE
   Devlog_API SHALL return HTTP status 500 with a response body carrying the correlation identifier
   of that request and no stack trace, SHALL emit a JSON-structured log record containing that
   correlation identifier, the error type, and the error message, SHALL leave the Entry_Store
   unchanged for that request, and SHALL return a response other than HTTP status 500 to the next
   valid request.
3. THE Devlog_API SHALL exclude credentials, authentication tokens, Session_Input note text, and
   Commit_Log text from every log record, recording the character count of submitted note text in
   place of the note text itself.
4. THE Infrastructure_Stack SHALL provision an alarm that triggers when responses carrying HTTP
   status 500 through 599 exceed 5 percent of the requests the Devlog_API handles in a 5-minute
   window containing at least 10 requests.
5. WHEN an alarm provisioned under this requirement triggers, THE Infrastructure_Stack SHALL deliver
   a notification naming the triggered alarm to the Author email address within 5 minutes of the
   trigger.
6. THE Devlog_API SHALL expose a health route reachable without credentials that returns HTTP status
   200 and the deployed version identifier within 500 milliseconds at the 95th percentile, and SHALL
   exclude resource identifiers, configuration values, AWS account identifiers, and dependency
   status detail from the health route response body.
7. WHEN the Devlog_API begins handling a request, THE Devlog_API SHALL assign that request a
   correlation identifier of between 8 and 64 characters, and SHALL include that identifier in every
   log record emitted by any component of the System while handling that request.
8. THE Infrastructure_Stack SHALL provision an availability alarm that triggers when 2 consecutive
   probes of the Public_URL spaced 5 minutes apart fail to return HTTP status 200 within 3 seconds.

### Requirement 12: Reproducible Infrastructure

**User Story:** As the Author, I want the whole stack defined in code and deployable in one command,
so that I can rebuild or repair the deployment under time pressure.

#### Acceptance Criteria

1. THE Infrastructure_Stack SHALL define every AWS resource the System depends on as AWS CDK
   infrastructure-as-code held in the project repository, such that no resource the System depends
   on requires manual creation or manual configuration through the AWS console.
2. WHEN the Author runs the documented deploy command against an AWS account holding no prior
   resources for the System, THE Infrastructure_Stack SHALL provision a System whose health route
   returns HTTP status 200 over HTTPS at the Public_URL within 30 minutes of command invocation.
3. WHEN the Author runs the documented deploy command against an account where the System is already
   deployed from an unchanged Infrastructure_Stack definition, THE Infrastructure_Stack SHALL
   complete with zero resource creations, zero resource replacements, and zero resource deletions
   (idempotence property).
4. WHEN a deploy command completes successfully, THE Infrastructure_Stack SHALL report the
   Public_URL and a deployed version identifier as named outputs of that deployment, and the
   reported deployed version identifier SHALL equal the deployed version identifier returned by the
   Devlog_API health route.
5. THE Infrastructure_Stack SHALL resolve AWS credentials at deploy time from the local environment
   or an IAM role, keeping every tracked file in the project repository free of AWS access key
   identifiers, secret access keys, session tokens, and any other secret value, such that a scan of
   tracked files for those values returns zero matches.
6. IF any resource fails to provision or update during a deploy command, THEN THE
   Infrastructure_Stack SHALL roll every resource changed by that command back to the last
   successfully deployed configuration, SHALL terminate the deploy command with a non-zero exit
   status, and SHALL report an error naming the resource that failed.
7. WHEN the Infrastructure_Stack is deleted, THE Infrastructure_Stack SHALL retain the Entry_Store
   and every Entry the Entry_Store holds, so that removing Entry_Store data requires a separate
   documented action outside the deploy command.
8. WHEN the Infrastructure_Stack is synthesized twice from the same repository commit with the same
   deploy-time configuration values, THE Infrastructure_Stack SHALL produce byte-identical
   synthesized templates (determinism property).

### Requirement 13: Coding Agent to AWS Console Proof

**User Story:** As the Author, I want documented proof that my AI coding agent was connected to the
AWS console, so that the submission satisfies the hard evidence requirement.

#### Acceptance Criteria

1. THE Submission_Package SHALL include an Agent_Proof_Artifact consisting of at least 2 and at most
   10 static image or text files stored in the System source repository and linked from the
   Builder_Writeup, comprising at least 1 screenshot of the AWS console and at least 1 excerpt of
   the Kiro session transcript.
2. THE Agent_Proof_Artifact SHALL name the AI coding agent as Kiro in text adjacent to each
   screenshot and each transcript excerpt.
3. THE Agent_Proof_Artifact SHALL document at least 1 AWS operation initiated through Kiro, showing
   the operation request in a transcript excerpt, naming the AWS service acted on, and showing the
   resulting resource state in a screenshot of the AWS console for that same service.
4. THE Agent_Proof_Artifact SHALL state, for each screenshot and each transcript excerpt, a capture
   date in ISO 8601 calendar form (YYYY-MM-DD) falling on or between 2026-09-18 and 2026-10-02.
5. THE Agent_Proof_Artifact SHALL exclude AWS account identifiers, access keys, and session tokens,
   SHALL cover each region from which such a value was removed with an opaque mask, and SHALL name
   in adjacent text the category of value removed from each masked region.
6. WHEN an unauthenticated judge follows the Agent_Proof_Artifact link in the Builder_Writeup, THE
   linked location SHALL render every screenshot and transcript excerpt of the Agent_Proof_Artifact
   within 10 seconds.
7. THE Agent_Proof_Artifact SHALL present each screenshot at a minimum width of 1280 pixels with no
   downscaling applied, and each transcript excerpt as selectable text of at least 10 and at most
   200 lines.
8. IF a candidate screenshot or transcript excerpt shows an unmasked AWS account identifier, access
   key, or session token, THEN THE Author SHALL mask that value or remove that file from the
   Agent_Proof_Artifact before the Submission_Package is submitted, retaining the remaining files
   that still satisfy criteria 1 through 4.
9. IF the Agent_Proof_Artifact link in the Builder_Writeup does not resolve to the artifact for an
   unauthenticated request, THEN THE Author SHALL correct the link before the close of the
   submission window on 2026-10-02.

### Requirement 14: Builder Center Write-Up

**User Story:** As the Author, I want a Builder Center write-up that tells the build story, so that
judges can assess creativity, process, and the agent's contribution.

#### Acceptance Criteria

1. THE Submission_Package SHALL include a Builder_Writeup published on Builder Center at its own
   HTTPS URL on or before 2026-10-02, readable by a requester carrying no credentials.
2. THE Builder_Writeup SHALL state, in at least 100 words, the purpose of the System, the problem
   the System addresses, and at least one concrete example of that problem in the Author's own build
   practice, addressing the creativity and storytelling judging criterion.
3. THE Builder_Writeup SHALL describe the development process across the submission window of
   2026-09-18 to 2026-10-02 by naming at least 3 dated milestones inside that window and, for each
   milestone, the work completed and how the Author confirmed it worked, addressing the
   implementation and communication quality judging criterion.
4. THE Builder_Writeup SHALL describe specific contributions the AI coding agent made to shipping
   the System, naming at least 3 concrete instances and, for each instance, the task the agent
   performed and the resulting change observable in the System or in the AWS console.
5. THE Builder_Writeup SHALL link to the Public_URL and to the Agent_Proof_Artifact, each link
   addressing its target over HTTPS.
6. THE Builder_Writeup SHALL state the technical approach, naming each AWS service the System uses
   and, for each service, the role that service plays in the System, addressing the technical
   innovation and originality judging criterion.
7. THE Builder_Writeup SHALL state the intended audience of the System and at least one stated
   impact the System aims to have on that audience, addressing the community and market impact
   judging criterion.
8. WHILE the Judging_Period is active, THE Builder_Writeup SHALL contain only hyperlinks that
   resolve to their stated targets over HTTPS within 10 seconds without requiring the requester to
   authenticate.
9. THE Builder_Writeup SHALL include an architecture diagram showing each AWS service the System
   uses and the request path from a Reader to the Entry_Store, labelling every depicted component
   with a term defined in the Glossary.
10. THE Builder_Writeup SHALL state the Category_Tag value `personal-expression` and the Lane_Tag
    value `community`.

### Requirement 15: Submission Compliance and Originality

**User Story:** As the Author, I want the submission metadata correct and the work verifiably
original, so that the entry is not disqualified on a technicality.

#### Acceptance Criteria

1. THE Submission_Package SHALL carry exactly one Category_Tag, set to the value
   `personal-expression`, and SHALL carry no other category label.
2. THE Submission_Package SHALL carry exactly one Lane_Tag, set to the value `community`, and SHALL
   carry no other lane label.
3. THE System SHALL consist of work created between 2026-09-18 00:00:00 Pacific Time and 2026-10-02
   23:59:00 Pacific Time, where every file tracked in the project repository other than third-party
   dependency files and files produced by framework scaffolding commands carries a first commit date
   inside that interval.
4. WHERE the System incorporates pre-existing code authored by the Author before 2026-09-18
   00:00:00 Pacific Time, THE Builder_Writeup SHALL disclose, for each such pre-existing unit of
   code, the name of the unit, the prior project or repository it came from, and the date it was
   originally authored.
5. THE System SHALL reach first public availability on a date on or after 2026-09-18, and SHALL have
   been unreachable by a Reader and unpublished in any public venue at every instant before
   2026-09-18 00:00:00 Pacific Time.
6. THE Submission_Package SHALL be submitted at or before 2026-10-02 23:59:00 Pacific Time, with the
   Public_URL, the Agent_Proof_Artifact, the Builder_Writeup, the Category_Tag, and the Lane_Tag all
   present at the instant of submission.
7. THE Submission_Package SHALL be the single entry submitted by the Author, submitted under exactly
   one Builder Center profile belonging to the Author, where the Author is 18 years of age or older
   at the time of submission.
8. THE project repository SHALL declare exactly one open-source license covering the System, and THE
   Builder_Writeup SHALL name that license.
9. THE project repository SHALL record the name and the license of every third-party dependency the
   System depends on, and each recorded license SHALL permit redistribution of the System under the
   license declared for the project repository.
10. IF any third-party dependency carries a license that does not permit redistribution of the
    System under the declared open-source license, THEN THE System SHALL exclude that dependency
    before 2026-10-02 23:59:00 Pacific Time.

### Requirement 16: Self-Documenting Build Record

**User Story:** As the Author, I want the devlog to contain the story of its own construction, so
that the product demonstrates its value and supplies the write-up source material at the same time.

#### Acceptance Criteria

1. WHILE the Judging_Period is active, THE Public_Timeline SHALL contain at least 7
   Published_Entries whose bodies each describe work performed on the System during one session,
   naming at least one component defined in the Glossary or one development task completed in that
   session.
2. WHILE the Judging_Period is active, THE Public_Timeline SHALL contain at least 7
   Published_Entries carrying session dates on or after 2026-09-18 and on or before 2026-10-02,
   spread across at least 5 distinct session dates, including at least one Published_Entry with a
   session date on or after 2026-09-19 and at least one Published_Entry with a session date on or
   before 2026-10-02.
3. THE Public_Timeline SHALL contain at least one Published_Entry whose body names a specific
   problem encountered during development of the System and names the change that removed that
   problem.
4. THE Public_Timeline SHALL contain at least one Published_Entry whose body names the AI coding
   agent as Kiro and names at least one concrete development task that agent completed.
5. WHEN the Author prepares the Builder_Writeup, THE Builder_Writeup SHALL cite at least 3
   Published_Entries from the Public_Timeline as source material, each cited by a link resolving to
   that Published_Entry on the Public_Site.
6. WHILE the Judging_Period is active, THE Public_Timeline SHALL contain at least 7
   Published_Entries that the Entry_Generator produced from Session_Input submitted through the
   Author_Console of the deployed System, each retaining the submitted note text alongside the Entry
   as required by Requirement 3.
7. THE Public_Timeline SHALL contain at least one Published_Entry generated from Session_Input that
   included a Commit_Log, whose body references at least one subject line from the Commit_Records
   parsed from that Commit_Log.
8. WHEN a Reader requests the Public_URL, THE Public_Site SHALL render, above the first entry of the
   Public_Timeline, introductory text of between 100 and 600 characters stating the purpose of the
   devlog, stating that a single Author writes it, and stating that each Published_Entry was
   generated by the System from session notes.
