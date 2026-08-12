/**
 * Meta Graph API request policy — classification, allowlisting and redaction.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 * --------------------------------
 * **This hook is a defense-in-depth control for directly visible request
 * commands. It is NOT the primary Meta egress security boundary.**
 *
 * Five rounds of independent review each found another way for a request to
 * reach Meta without being classified. Each was fixed, and the pattern in the
 * findings is the point: a shell-command parser is being asked to decide what a
 * process will do at runtime, which it cannot do in general. It cannot reliably
 * govern:
 *
 *   - executables named by a variable, or resolved through PATH;
 *   - arbitrary wrappers beyond the small set modelled here;
 *   - checked-in scripts whose URLs never appear in the command;
 *   - other interpreters and HTTP libraries with runtime destinations;
 *   - environment, user or machine-level curl configuration;
 *   - direct IP access, and every alternate request client.
 *
 * Treating a passing guard as proof that Meta cannot be reached is the mistake
 * this comment exists to prevent. The real boundary is a dedicated Meta gateway
 * holding the credentials, with direct Graph egress denied to general agent
 * workloads by network policy — see the Port architecture blocker
 * `blocker-meta-egress-boundary-required-2026-08-12`.
 *
 * WHY THIS EXISTS
 * ---------------
 * The previous rule was a single regex pair: match `graph.facebook.com`, then
 * treat ANY curl data flag as evidence of a mutation. That produced two opposing
 * safety defects at once (defect-isola-guard-meta-graph-read-classification-and-
 * token-minting-gap-2026-08-05):
 *
 *   1. FALSE DENY. `curl -G --data-urlencode 'fields=webhook_configuration'` is a
 *      GET. `-G` moves data flags into the query string. The old indicator listed
 *      `--data-urlencode` as a mutation marker and had no concept of `-G`, so the
 *      SAFER form of a read — properly URL-encoded parameters — was blocked while
 *      the sloppier inline-query form was allowed. Engineers were pushed toward
 *      hand-built query strings to get work done.
 *
 *   2. FALSE ALLOW. Credential-minting endpoints are plain GETs.
 *      `GET /oauth/access_token?grant_type=fb_exchange_token` returns a live
 *      long-lived token in the response body, straight into an agent transcript.
 *      "Read-only GETs against Graph are permitted" allowed exactly that.
 *
 * The fix is not "allow all GETs". It is default-deny with a named allowlist of
 * the metadata reads Isola's webhook-ownership work actually requires.
 *
 * DESIGN
 * ------
 * Six separable concerns, each a pure function, each independently testable:
 *
 *   1. tokenize()            shell tokenization (quote-aware)
 *   2. classifyHttpMethod()  method from -X / -G / data flags / JS client shape
 *   3. parseGraphUrls()      endpoint extraction -> {version, segments, query}
 *   4. classifyEndpoint()    object/edge/field allowlisting
 *   5. validateCredentials() token must be an env reference, never a literal
 *   6. redactSensitive()     scrub credentials from anything we echo back
 *
 * SCOPE LIMIT, STATED HONESTLY: this is a PreToolUse hook. It sees the command
 * BEFORE execution and cannot filter the response body. So "redact credential
 * output" is enforced structurally — every endpoint that RETURNS a credential is
 * denied outright (§TOKEN_MINTING_*), and redactSensitive() guarantees the
 * guard's own deny messages never echo a credential that was in the command.
 * Claiming this hook can scrub a live API response would be false.
 */

'use strict';

const crypto = require('crypto');

// ---------------------------------------------------------------- 0. host

const META_HOST_RE = /graph\.facebook\.com/i;

/** A parseable Graph URL. Stops at shell metacharacters and quotes. */
const GRAPH_URL_RE = /(?:https?:\/\/)?graph\.facebook\.com\/[^\s'"`|;&<>()]*/gi;

const URL_TERMINATOR_RE = /[\s"'`|;&<>()]/;

/**
 * Split every `scheme://…` URL in a command into its AUTHORITY and the rest.
 *
 * Structural, not an enumeration. Round 3 found that matching `$HOST` and
 * `${HOST}` by pattern missed every other valid shell expansion —
 * `${HOST:?required}`, `${HOST:-fallback}`, `${HOST%/}`, `${HOST##p}` … — each
 * of which hides the authority while keeping a protected literal path. Listing
 * expansion syntaxes is the same drift that rounds 1 and 2 already punished, so
 * this walks the string instead: brace depth is tracked, so a `/` INSIDE an
 * expansion (as in `${HOST%/}`) does not end the authority, and the authority is
 * simply "everything before the first unbraced `/` or `?`".
 *
 * The authority is then indeterminate if it contains `$` at all — any runtime
 * expansion, in any form, present or future.
 */
function splitUrls(cmd) {
  const s = String(cmd || '');
  const out = [];
  const schemeRe = /https?:\/\//gi;
  let m;
  while ((m = schemeRe.exec(s)) !== null) {
    let i = m.index + m[0].length;
    let depth = 0;
    let authority = '';
    for (; i < s.length; i++) {
      const ch = s[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth = depth > 0 ? depth - 1 : 0;
      if (depth === 0 && (ch === '/' || ch === '?')) break;
      if (depth === 0 && URL_TERMINATOR_RE.test(ch)) break;
      authority += ch;
    }
    let rest = '';
    for (; i < s.length; i++) {
      const ch = s[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth = depth > 0 ? depth - 1 : 0;
      if (depth === 0 && URL_TERMINATOR_RE.test(ch)) break;
      rest += ch;
    }
    out.push({ authority, rest });
  }
  return out;
}

/** Any runtime expansion in the authority makes the destination unknowable. */
function authorityIsIndeterminate(authority) {
  return String(authority || '').includes('$');
}

// ------------------------------------------------- shared request-target analysis
//
// Round 4 found the classifier's ENTRY BOUNDARY was the remaining hole. Scanning
// raw contiguous `http(s)://…` text only classified an indeterminate authority
// when a protected LITERAL path or parameter still happened to be visible. So a
// target that becomes Meta only after expansion — `"https://$HOST/$WABA/$EDGE"`,
// a bare `"$META_URL"`, `"${SCHEME}://${HOST}/…"`, `https://"$HOST"/…`,
// `$(get_meta_host)`, backticks, `--url`, `-K file`, curl's own `{{…}}` — never
// entered evaluateMetaGraph() at all.
//
// This is ONE analysis, used by both classification and evaluation, built on the
// existing quote-aware tokenizer. It deliberately contains no list of variable
// names: a name carries no provenance, and `$HOST` is not more suspicious than
// `$X`. What matters is whether a component of the request target is decidable
// before the command runs.

/** `$VAR`, `${…}`, `$(…)`, backticks, and curl's own `{{…}}` expansion. */
const EXPANSION_MARKER_RE = /\$\{|\$\(|\$[A-Za-z_{(]|`|\{\{/;

/** Shell separators that start a new command segment. */
const SEGMENT_SEPARATORS = new Set([';', '&&', '||', '|', '&']);

/** Binaries whose operands are request targets, matched on BASENAME. */
const CURL_FAMILY_RE = /^(curl|wget|xh|http|https|httpie)$/i;

/**
 * Wrappers that run another program. Their own options must be parsed, not
 * skipped by guesswork: `sudo -u root curl …` and `sudo -n docker ps` differ
 * only in whether the option takes a value, and getting that wrong either
 * blocks ordinary work or lets a request client through unexamined.
 *
 * Anything not listed makes the invocation UNDECIDABLE, which fails closed.
 */
const WRAPPERS = new Map([
  ['env', { bool: new Set(['-i', '-0', '--ignore-environment', '--null']), value: new Set(['-u', '--unset', '-C', '--chdir']), indeterminate: new Set(['-S', '--split-string']), assignments: true }],
  ['command', { bool: new Set(['-p']), value: new Set() }],
  ['sudo', { bool: new Set(['-n', '-E', '-H', '-b', '-k', '--non-interactive', '--preserve-env', '--set-home']), value: new Set(['-u', '--user', '-g', '--group', '-p', '--prompt', '-C', '--close-from', '-D', '--chdir', '-R', '--chroot']) }],
  ['nohup', { bool: new Set(), value: new Set() }],
  ['nice', { bool: new Set(), value: new Set(['-n', '--adjustment']) }],
  ['timeout', { bool: new Set(['--preserve-status', '--foreground']), value: new Set(['-s', '--signal', '-k', '--kill-after']), positional: 1 }],
  ['stdbuf', { bool: new Set(), value: new Set(['-i', '-o', '-e', '--input', '--output', '--error']) }],
]);

/** `/usr/bin/curl`, `./curl`, `curl.exe` all normalise to `curl`. */
function basename(tok) {
  const t = String(tok || '').replace(/\\/g, '/');
  const last = t.slice(t.lastIndexOf('/') + 1);
  return last.replace(/\.exe$/i, '');
}

/**
 * Resolve the effective request client through any supported wrappers.
 *
 * @returns {{client:string|null, start:number, undecidable:boolean}}
 */
function resolveInvocation(tokens) {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;

  for (let guard = 0; guard < 8; guard++) {
    const tok = tokens[i];
    if (tok == null) return { client: null, start: i, undecidable: false };

    // A binary supplied at runtime cannot be identified before it runs.
    if (hasExpansion(tok)) return { client: null, start: i, undecidable: true };

    const base = basename(tok);
    if (CURL_FAMILY_RE.test(base)) return { client: base.toLowerCase(), start: i + 1, undecidable: false };

    const w = WRAPPERS.get(base.toLowerCase());
    if (!w) return { client: null, start: i, undecidable: false };

    i++;
    if (w.assignments) while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
    let positionalsLeft = w.positional || 0;
    while (i < tokens.length) {
      const t = tokens[i];
      if (t === '--') { i++; break; }
      if (!t.startsWith('-')) {
        if (positionalsLeft > 0) { positionalsLeft--; i++; continue; }
        break; // the wrapped program
      }
      const eq = t.indexOf('=');
      const name = eq === -1 ? t : t.slice(0, eq);
      // An option that re-parses its argument into a command hides the client.
      if (w.indeterminate && w.indeterminate.has(name)) return { client: null, start: i, undecidable: true };
      if (w.bool.has(name)) { i++; continue; }
      if (w.value.has(name)) { i += eq === -1 ? 2 : 1; continue; }
      // An option we cannot classify may or may not consume the next token, so
      // the effective client is no longer determinable.
      return { client: null, start: i, undecidable: true };
    }
  }
  return { client: null, start: 0, undecidable: true };
}

/** Every curl config form. A config source can set URL, method, headers and data. */
function hasOpaqueConfig(tokens, start) {
  for (let i = start; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-K' || t === '--config') return true;
    if (/^--config=/.test(t)) return true;
    if (/^-K./.test(t)) return true; // -Kfile, -K-
    if (/^-[A-Za-z]*K/.test(t)) return true; // clustered, attached or not
  }
  return false;
}

/** curl expands {a,b} and [1-9] in URLs unless -g/--globoff is given. */
// A brace preceded by a dollar sign is shell expansion, not curl's {a,b}
// sequence; that is classified elsewhere and must not be double-counted here.
const CURL_GLOB_RE = /(^|[^$])[{[]/;
function globbingDisabled(tokens, start) {
  for (let i = start; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--globoff') return true;
    if (/^-[A-Za-z]*g/.test(t) && !t.startsWith('--')) return true;
  }
  return false;
}

/**
 * `-q` / `--disable` must be the FIRST curl PARAMETER, not merely the first
 * option, or curl reads `.curlrc` before it gets there.
 *
 * The previous version skipped operands looking for the first flag, so
 * `curl <url> -q` counted — but curl parses left to right and has already read
 * its config file by the time it reaches `-q`. Position is the whole control
 * here, so it is checked exactly: token[start] and nothing else.
 *
 * A short cluster whose FIRST letter is `q` (`-qsG`) is accepted: `q` is still
 * the first parameter curl sees. `-sq` is not.
 */
function disablesCurlrc(tokens, start) {
  const first = tokens[start];
  if (first == null) return false;
  if (first === '-q' || first === '--disable') return true;
  return /^-q[A-Za-z0-9]*$/.test(first);
}

function hasExpansion(s) {
  return EXPANSION_MARKER_RE.test(String(s || ''));
}

/**
 * Is this operand plausibly a request TARGET rather than a data pair?
 *
 * Not every non-flag token is a URL. `-d "access_token=$APP"` puts a data pair
 * in operand position whenever the short flag is not in VALUE_TAKING, and
 * treating that as a fully-variable target denied the sanctioned debug_token
 * read — caught by the existing 95-assertion suite before this shipped.
 *
 * A target either carries a scheme, IS an expansion, or has a path whose first
 * separator is not preceded by a `=` or `@` (which would make it a data pair or
 * a file-sourced parameter).
 */
function looksLikeTarget(tok) {
  const t = String(tok || '');
  if (t === '') return false;
  if (t.includes('://')) return true;
  if (/^(\$|`|\{\{)/.test(t)) return true;
  const slash = t.indexOf('/');
  if (slash === -1) return false;
  const head = t.slice(0, slash);
  return !head.includes('=') && !head.includes('@');
}

/**
 * Split a request target into scheme / authority / path / query, treating
 * `${…}`, `$(…)` and `{{…}}` as atomic so a separator inside an expansion does
 * not end a component early.
 */
function splitTarget(raw) {
  const s = String(raw || '');
  let scheme = '';
  let rest = s;
  const sep = s.indexOf('://');
  if (sep !== -1) {
    scheme = s.slice(0, sep);
    rest = s.slice(sep + 3);
  }

  let depth = 0;
  let i = 0;
  let authority = '';
  for (; i < rest.length; i++) {
    const two = rest.slice(i, i + 2);
    if (two === '${' || two === '$(' || two === '{{') {
      depth++;
      authority += two;
      i++;
      continue;
    }
    const ch = rest[i];
    if (ch === '}' || ch === ')') {
      if (depth > 0) depth--;
      authority += ch;
      continue;
    }
    if (depth === 0 && (ch === '/' || ch === '?')) break;
    authority += ch;
  }

  const tail = rest.slice(i);
  const q = tail.indexOf('?');
  return {
    scheme,
    authority,
    path: q === -1 ? tail : tail.slice(0, q),
    query: q === -1 ? '' : tail.slice(q + 1),
  };
}

/**
 * Collect request targets and opaque sources from the curl-family segments of a
 * command. Only those segments are analysed, so an ordinary `cd $DIR && …` is
 * untouched — its operands are not request targets.
 */
function analyzeRequestTargets(cmd) {
  // `invocations` groups targets by curl invocation. The flat `targets` list is
  // kept for callers that only ask "is any target undecidable"; anything that
  // reasons about how many destinations ONE curl has must use `invocations`,
  // because `a && b` is two invocations and must not be conflated.
  const result = { targets: [], invocations: [], opaqueConfig: false, sawRequestClient: false };
  const toks = tokenize(cmd);

  let seg = [];
  const segments = [];
  for (const t of toks) {
    if (SEGMENT_SEPARATORS.has(t)) {
      segments.push(seg);
      seg = [];
      continue;
    }
    seg.push(t);
  }
  segments.push(seg);

  for (const segment of segments) {
    const inv = resolveInvocation(segment);
    if (inv.undecidable) {
      result.undecidableInvocation = true;
      continue;
    }
    if (!inv.client) continue;
    const k = inv.start - 1;
    result.sawRequestClient = true;
    if (hasOpaqueConfig(segment, inv.start)) result.opaqueConfig = true;
    if (!disablesCurlrc(segment, inv.start)) result.curlrcReachable = true;
    const globOff = globbingDisabled(segment, inv.start);

    const invocation = { client: inv.client, tokens: segment.slice(k), targets: [], multiTransfer: false, ambiguous: false };
    result.invocations.push(invocation);
    const push = (entry) => {
      invocation.targets.push(entry);
      result.targets.push(entry);
    };

    // AUTHORITATIVE PARSE, from the resolved executable. argv[0] is the curl
    // binary itself so the shared parser sees the shape it expects.
    const argv = segment.slice(k);
    const parsed = parseCurlTokens(argv);

    // curl's transfer separator, long and short form. A second transfer is a
    // second destination, carrying the options that follow it.
    if (argv.some((t) => t === '--next' || t === '-:')) invocation.multiTransfer = true;

    // An option we cannot classify may or may not consume the next token, so
    // which tokens are operands is no longer decidable.
    if (parsed.unknown.length > 0) invocation.ambiguous = true;

    for (const o of parsed.opts) {
      if (o.flag === '--url' && o.value != null) push({ raw: o.value, globOff, fromUrlFlag: true });
    }
    // Everything curl did not consume as an option or an option value is a URL.
    // Scheme-less hosts, host:port, bare IPv4/IPv6 and localhost all land here
    // without any syntax being enumerated.
    //
    // Only for curl, though. The other clients in CURL_FAMILY_RE do not share
    // curl's grammar — httpie's `key==value` is a query parameter, not a
    // destination — so applying curl's operand rule to them would invent
    // targets. They keep the older shape-based filter, and their own policy
    // rules refuse them with more precise messages.
    const isCurl = inv.client === 'curl';
    for (const op of parsed.operands) {
      if (isCurl || looksLikeTarget(op)) push({ raw: op, globOff });
    }
  }
  return result;
}

/**
 * Anchored scheme. `indexOf('://')` is not good enough: in
 * `attacker.example/#https://graph.facebook.com/...` the first `://` sits in the
 * FRAGMENT, and reading a scheme from there is how an attacker target came to be
 * described as a Graph target.
 */
const ANCHORED_SCHEME_RE = /^([A-Za-z][A-Za-z0-9+.\-]*):\/\//;

/**
 * Parse a request target's identity FROM ITS BEGINNING.
 *
 * Round 9: target identity was previously decided by scanning the whole command
 * for a `graph.facebook.com` substring. That validated a Graph-looking string
 * sitting in another target's path, query or fragment, or in a header, referer
 * or user-agent value — while curl's actual destination was elsewhere and the
 * bearer credential went with it.
 *
 * Identity now comes only from the operand curl will actually contact.
 */
function parseTargetIdentity(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const m = ANCHORED_SCHEME_RE.exec(s);
  const scheme = m ? m[1].toLowerCase() : null;
  const rest = m ? s.slice(m[0].length) : s;

  let end = rest.length;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === '/' || c === '?' || c === '#') {
      end = i;
      break;
    }
  }
  let authority = rest.slice(0, end);

  const at = authority.lastIndexOf('@');
  const hadUserinfo = at !== -1;
  if (hadUserinfo) authority = authority.slice(at + 1);

  let port = '';
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close !== -1) {
      if (authority[close + 1] === ':') port = authority.slice(close + 2);
      authority = authority.slice(0, close + 1);
    }
  } else {
    const colon = authority.lastIndexOf(':');
    if (colon !== -1) {
      port = authority.slice(colon + 1);
      authority = authority.slice(0, colon);
    }
  }

  return { scheme, host: authority.toLowerCase(), port, hadUserinfo, hadScheme: m !== null };
}

/** Exactly the Graph authority, over HTTPS, with nothing else in the authority. */
function isExactGraphHttpsTarget(id) {
  return id.scheme === 'https' && id.host === 'graph.facebook.com' && id.port === '' && !id.hadUserinfo;
}

/**
 * The command mentions the Graph host, but is that where curl is actually going?
 *
 * Answered per curl invocation, from its own tokens — never from the whole
 * command, so a Graph read chained after an ordinary request is not accused of
 * something the other invocation did.
 *
 * @returns {{reason:string, remedy:string}|null}
 */
function metaTargetIdentityViolation(cmd) {
  const { invocations } = analyzeRequestTargets(cmd);
  for (const inv of invocations) {
    if (inv.client !== 'curl') continue; // other clients have their own rules

    let exact = 0;
    for (const e of inv.targets) {
      const id = parseTargetIdentity(e.raw);
      if (id.host !== 'graph.facebook.com') continue;

      if (isExactGraphHttpsTarget(id)) {
        exact++;
        continue;
      }
      if (id.scheme !== 'https') {
        return {
          reason:
            'This Meta request is not HTTPS. curl defaults a scheme-less target to plaintext HTTP, so a missing scheme is ' +
            'not a neutral omission — it sends the bearer credential in the clear. A sanctioned Meta request must name ' +
            '`https` literally.',
          remedy: 'write the target as `https://graph.facebook.com/...`.',
        };
      }
      return {
        reason:
          'The target’s authority is not exactly `graph.facebook.com`. Userinfo, an explicit port, a hostname prefix or ' +
          'suffix, or a trailing dot all make the host that will actually be contacted something other than Graph, while the ' +
          'command still reads as a Graph request.',
        remedy: 'use the bare authority `graph.facebook.com` with no userinfo and no port.',
      };
    }

    if (exact > 0) continue;

    // No authoritative Graph destination in this invocation — yet the Graph host
    // appears in its text. It is in a path, query, fragment, header, referer,
    // user-agent or some other option value, and the request is going somewhere
    // else entirely.
    if (inv.tokens.some((t) => META_HOST_RE.test(String(t || '')))) {
      return {
        reason:
          'The Graph host appears in this command, but it is not the destination. curl will contact a different authority, ' +
          'and every credential-bearing option applies to THAT request. A Graph URL embedded in a path, query, fragment, ' +
          'header, referer or user-agent proves nothing about where the request goes.',
        remedy: 'make the Graph URL the request target itself, as the single operand or a single `--url`.',
      };
    }
  }
  return null;
}

/**
 * A Meta curl must have exactly ONE destination.
 *
 * curl applies shared options — `-H`, and `-G` data parameters — to EVERY URL in
 * a transfer, and `--next` starts another transfer with the options that follow.
 * So a command could pass every rule this policy checks against its Graph URL
 * and, in the same breath, send the same `Authorization: Bearer` header to a
 * second, entirely literal, attacker-controlled destination. The Graph target
 * was valid; the credential still left for somewhere else.
 *
 * Counted per INVOCATION, not per command: `curl A && curl B` is two separate
 * single-destination requests and stays allowed.
 *
 * Checked before splitTransfers(), which discards non-Graph transfers and would
 * therefore throw away the very evidence this rule needs.
 *
 * @returns {{reason:string, remedy:string}|null}
 */
function singleDestinationViolation(cmd) {
  const { invocations } = analyzeRequestTargets(cmd);
  for (const inv of invocations) {
    // Scoped to curl: this rule exists because curl applies shared options to
    // every URL in a transfer. Other clients are refused by their own rules,
    // which name the offending construct more precisely than this one could.
    if (inv.client !== 'curl') continue;

    const touchesGraph = inv.targets.some((e) => META_HOST_RE.test(String(e.raw || '')));
    if (!touchesGraph) continue; // an ordinary multi-URL curl elsewhere is not ours to police

    if (inv.multiTransfer) {
      // Accuracy note, verified against curl's own docs for --next: LOCAL
      // options (-H, -d, …) are RESET for the subsequent URL; only global
      // options persist. So the risk is not that the credential leaks forward
      // automatically — it is that a second transfer in the same command can
      // supply its own credential to a different destination, and that only the
      // Graph transfer is examined by the rules below. One command, two
      // requests, one of them unreviewed.
      return {
        reason:
          'This curl performs more than one transfer (`--next` / `-:`) and one of them is a Graph request. Each transfer ' +
          'can carry its own credential to its own destination, and only the Graph transfer is validated here. ' +
          'Multi-transfer Meta curl has no legitimate use.',
        remedy: 'issue one curl per request, each with a single Graph URL.',
      };
    }

    // An unmodelled option is already refused downstream by a rule that NAMES
    // it, so it can be added deliberately. Pre-empting that with a vaguer
    // message would be a regression in the refusal, not an improvement in
    // safety — the command is refused either way. Transfer separators are
    // checked ABOVE this, because `--next` is itself unmodelled by the option
    // tables and would otherwise be skipped here.
    if (inv.ambiguous) continue;

    if (inv.targets.length > 1) {
      return {
        reason:
          'This curl has more than one request target and one of them is a Graph request. curl applies a shared ' +
          '`-H` header and `-G` data parameters to EVERY URL in the transfer, so the Meta credential would be sent to each ' +
          'destination in turn — including any that is not Meta. Only the Graph URL is validated by this policy; the others ' +
          'are not, and need not be for the credential to leave.',
        remedy: 'give this curl exactly one URL. Multiple Graph reads are separate curl commands.',
      };
    }
  }
  return null;
}

/**
 * Hygiene a Meta request must satisfy, beyond having a decidable target.
 *
 * Scoped to Meta-classified commands so ordinary non-Meta curl usage is not
 * forced to adopt it.
 *
 * @returns {{reason:string, remedy:string}|null}
 */
function metaCurlHygieneViolation(cmd) {
  const toks = tokenize(cmd);
  const segments = [];
  let seg = [];
  for (const t of toks) {
    if (SEGMENT_SEPARATORS.has(t)) { segments.push(seg); seg = []; continue; }
    seg.push(t);
  }
  segments.push(seg);

  for (const segment of segments) {
    const inv = resolveInvocation(segment);
    if (!inv.client || inv.client !== 'curl') continue;

    // curl reads ~/.curlrc unless disabled FIRST. That file can add headers,
    // a proxy, --resolve, --insecure — none of it visible in this command.
    if (!disablesCurlrc(segment, inv.start)) {
      return {
        reason:
          'curl reads its default configuration file unless `-q` (or `--disable`) is the FIRST option. That file can add ' +
          'headers, a proxy, an address override or disable certificate verification, none of which appear in this command — ' +
          'so the request that actually leaves the machine cannot be read from what is written here.',
        remedy: 'put `-q` immediately after `curl`, before every other option.',
      };
    }

    // A header value read from a file hides the credential and its destination.
    for (let i = inv.start; i < segment.length; i++) {
      const t = segment[i];
      let value = null;
      if (t === '-H' || t === '--header') value = segment[i + 1];
      else if (/^--header=/.test(t)) value = t.slice('--header='.length);
      else if (/^-H./.test(t)) value = t.slice(2);
      if (value != null && /^@/.test(String(value).trim())) {
        return {
          reason:
            'A request header is being read from a file. The header contents are not visible in the command, so neither the ' +
            'credential being sent nor its destination can be verified before the request runs.',
          remedy: 'write the header literally, keeping only the token as an environment reference.',
        };
      }
    }
  }
  return null;
}

/**
 * Does anything about this command's request target resist decision before it
 * runs? Fail-closed by construction: an undecidable target is classified so
 * evaluateMetaGraph() can deny it, rather than skipped because no protected
 * literal happened to survive.
 */
function targetsResistDecision(cmd) {
  const { targets, opaqueConfig, undecidableInvocation } = analyzeRequestTargets(cmd);

  // A wrapper option we cannot classify may or may not consume the next token,
  // so the effective request client is no longer determinable.
  if (undecidableInvocation) return true;

  // A config source can set the URL, method, headers and data. Whatever it
  // contains is unknown here, and reading it is not this guard's job.
  if (opaqueConfig) return true;

  for (const entry of targets) {
    const raw = entry.raw;

    // `--url @file` / `--url=@file` / `--url @-` read the target from a file or
    // from stdin. The destination is therefore not in the command at all, and
    // reading the source to find out is not this guard's job — nor would it be
    // sound, since the file can change between inspection and execution.
    if (entry.fromUrlFlag && /^@/.test(String(raw || '').trim())) return true;

    const t = splitTarget(raw);

    // curl expands {a,b} and [1-9] in URLs by default. `graph.face{book,x}.com`
    // constructs the Meta hostname from a literal that never contains it.
    //
    // Scoped to the components that decide WHERE the request goes: scheme,
    // authority, path and query-KEY identity. A glob inside a query VALUE
    // cannot change the destination, and Graph's own field-expansion syntax
    // uses braces there — treating that as indeterminate would deny the
    // credential-field assertions this policy exists to make.
    if (!entry.globOff) {
      const routing = [t.scheme, t.authority, t.path];
      if (routing.some((c) => CURL_GLOB_RE.test(String(c || '')))) return true;
      if (splitQuery(t.query).some((p) => CURL_GLOB_RE.test(String(p.key || '')))) return true;
    }
    const authorityUnknown = hasExpansion(t.authority) || hasExpansion(t.scheme);
    if (!authorityUnknown) continue; // a literal non-Meta authority is provably not Meta

    // Nothing literal follows the authority: the whole destination is a variable.
    if (t.path === '' && t.query === '') return true;

    if (hasExpansion(t.path)) return true;
    if (splitQuery(t.query).some((p) => hasExpansion(p.key))) return true;

    if (isGraphShapedPath(t.path + (t.query ? '?' + t.query : ''))) return true;
  }
  return false;
}

/**
 * `/v21.0/...` — a Graph version segment. The decimal is REQUIRED: Graph
 * versions are always `v<major>.<minor>`, whereas plain `/v1/`, `/v2/` are the
 * commonest internal-API convention there is. Matching those would fail-closed
 * every versioned internal request on a variable host.
 */
const VERSION_SEGMENT_RE = /^\/v\d+\.\d+(?:\/|$)/i;

/**
 * Every edge the policy models, in one derived set.
 *
 * Round-2 review found the previous version derived from the token-minting sets
 * ONLY, which left the mutation edges outside classification: with
 * HOST=graph.facebook.com exported earlier, `POST https://$HOST/{id}/messages`
 * and `POST|DELETE https://$HOST/{id}/subscribed_apps` are real Meta mutations,
 * and the guard treated them as ordinary Bash. ALLOWED_EDGES and
 * SIDE_EFFECTING_EDGES are just as protected as the minting ones — an edge the
 * policy bothers to name is an edge that must be classified.
 *
 * Built lazily so it always reflects the sets as declared, and can never be a
 * stale copy of them.
 */
let _protectedEdges = null;
function protectedEdges() {
  if (!_protectedEdges) {
    _protectedEdges = new Set([...TOKEN_MINTING_EDGES, ...ALLOWED_EDGES, ...SIDE_EFFECTING_EDGES]);
  }
  return _protectedEdges;
}

let _protectedRootPaths = null;
function protectedRootPaths() {
  if (!_protectedRootPaths) {
    _protectedRootPaths = new Set([...TOKEN_MINTING_PATHS, ...ALLOWED_ROOT_PATHS]);
  }
  return _protectedRootPaths;
}

/** `https://$HOST:443/...` — strip an explicit port before the path is read. */
const LEADING_PORT_RE = /^:\d{1,5}/;

/**
 * Is this URL path Graph-shaped enough to classify, when the host is hidden
 * behind a shell variable?
 *
 * DERIVED from the authoritative sets — never a second hand-kept list. Two
 * successive reviews caught drift in exactly that pattern, so the lists are
 * gone: widening any protected set now widens classification automatically.
 *
 * Deliberately NOT matched: a single-segment `/accounts`. The Meta shapes are
 * `/{id}/accounts` and `/me/accounts`; requiring two segments keeps an ordinary
 * internal `https://$SVC/accounts` working.
 */
/**
 * Percent-decode ONCE for comparison purposes.
 *
 * Round 3: the classifier lowercased raw segments but never decoded them, so
 * `/123/%73ubscribed_apps` and `/123/m%65ssages` compared unequal to the
 * protected edges while curl sent the decoded path — the same live mutation.
 *
 * Exactly one pass, never a loop: repeated decoding invents attacks that curl
 * would not perform and has no natural stopping point. A malformed escape
 * returns `null`, which callers treat as fail-closed — decoding is a
 * comparison aid, and input that cannot be normalised cannot be cleared.
 */
function decodeOnceForCompare(s) {
  const raw = String(s || '');
  if (!raw.includes('%')) return raw;
  if (/%(?![0-9a-fA-F]{2})/.test(raw)) return null; // malformed escape
  try {
    return decodeURIComponent(raw);
  } catch (_) {
    return null; // e.g. a lone surrogate escape
  }
}

function isGraphShapedPath(rawPath) {
  let raw = String(rawPath || '');
  raw = raw.replace(LEADING_PORT_RE, '');
  if (!raw.startsWith('/')) return false;

  const qIndex = raw.indexOf('?');
  const pathPartRaw = qIndex === -1 ? raw : raw.slice(0, qIndex);
  const queryPart = qIndex === -1 ? '' : raw.slice(qIndex + 1);

  // A credential exchange is identifiable from its query alone — checked
  // against the authoritative parameter set, with keys percent-decoded by
  // splitQuery(), so `client%5Fsecret` cannot slip past a literal match.
  if (hasTokenExchangeParam(splitQuery(queryPart))) return true;

  // Versioned Graph URL — nothing else uses this shape.
  if (VERSION_SEGMENT_RE.test(pathPartRaw)) return true;

  const pathPart = decodeOnceForCompare(pathPartRaw);
  if (pathPart === null) return true; // malformed escape → classify → fail closed
  if (VERSION_SEGMENT_RE.test(pathPart)) return true;

  // Split AFTER decoding, so an encoded separator (%2F) yields real segments.
  const segs = pathPart.split('/').filter(Boolean).map((x) => x.toLowerCase());
  if (segs.length === 0) return false;
  const joined = segs.join('/');

  if (protectedRootPaths().has(joined)) return true; // oauth/access_token, device/login, debug_token …
  // /{id}/messages, /{id}/subscribed_apps, /{id}/accounts, /{id}/request_code …
  if (segs.length >= 2 && protectedEdges().has(segs[segs.length - 1])) return true;

  return false;
}

/** True when any parameter key is one the policy already treats as an exchange. */
function hasTokenExchangeParam(params) {
  for (const p of params || []) {
    if (!p || typeof p.key !== 'string') continue;
    if (TOKEN_EXCHANGE_PARAMS.has(p.key.trim().toLowerCase())) return true;
  }
  return false;
}

function isMetaGraphCommand(cmd) {
  const s = String(cmd || '');
  if (META_HOST_RE.test(s)) return true;

  // The literal host is absent. That alone used to end classification, which
  // left a hole: `curl "https://$HOST/oauth/access_token"` — with HOST exported
  // in an earlier turn, so the name never appears in THIS command — skipped the
  // Meta policy entirely and reached a credential-minting endpoint. The
  // VARIABLE_HOST_RE defence in evaluateMetaGraph() could not fire, because
  // evaluateMetaGraph() was never entered.
  //
  // Classify on the PATH instead when it is unmistakably Graph-shaped. The
  // request is then denied as unclassifiable, which is the correct outcome: an
  // endpoint that cannot be identified cannot be allowlisted.
  // Shared request-target analysis. Wrapped: a parsing fault inside the guard
  // must fail CLOSED for a request-shaped command, never escape to the outer
  // fail-open handler and let an unexamined request through.
  try {
    if (targetsResistDecision(s)) return true;
  } catch (_) {
    if (REQUEST_CLIENT_RE.test(s)) return true;
  }

  let sawIndeterminateAuthority = false;
  for (const u of splitUrls(s)) {
    if (!authorityIsIndeterminate(u.authority)) continue;
    sawIndeterminateAuthority = true;
    if (isGraphShapedPath(u.rest || '')) return true;
  }

  if (!sawIndeterminateAuthority) return false;

  // The path can be a variable too, so its shape proves nothing:
  //   curl -sG "https://$HOST/$EDGE" --data-urlencode "client_secret=$VALUE"
  // Nothing here is literal except the PARAMETER, and a client_secret exchange
  // is a Graph operation whatever the path spells. Reuse the same curl parser
  // the rest of the policy uses, so flag-supplied query parameters
  // (-G --data-urlencode, --url-query, -d, --json …) are seen exactly as
  // classifyFields() sees them, and cannot disagree about what a cluster meant.
  const params = collectDataParams(s);
  if (hasTokenExchangeParam(params)) return true;

  // A file-sourced parameter set (`--data-urlencode "@params.txt"`) makes the
  // effective query unknowable. Combined with an authority that is already
  // indeterminate, nothing about this request can be verified before it runs,
  // so it must be classified and denied rather than waved through.
  if (params.some((p) => p && p.opaque)) return true;

  return false;
}

// ---------------------------------------------------------------- 1. tokenize

/**
 * Quote-aware shell tokenizer. Good enough for classification: we need to know
 * which flags are present and what their values are, not to execute anything.
 * Line continuations are folded first so a multi-line curl reads as one command.
 */
function tokenize(cmd) {
  const src = String(cmd || '').replace(/\\\r?\n/g, ' ');
  const out = [];
  let cur = '';
  let quote = null;
  let started = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) out.push(cur);
      cur = '';
      started = false;
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}

// ---------------------------------------------------------------- 2. method

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Data flags that -G CAN promote into the query string. These, and only these,
 * are what the force-GET flag actually converts.
 */
const QUERYABLE_DATA_FLAGS = new Set([
  '--data',
  '--data-raw',
  '--data-binary',
  '--data-ascii',
  '--data-urlencode',
  '--url-query', // curl's explicit query-parameter builder
]);

/**
 * Flags that carry a body or an upload and that -G does NOT convert.
 *
 * Getting this wrong was a real bypass: `-G` was allowed to override `-T`, but
 * `-T` is a file upload (PUT), not query promotion, so an upload classified as a
 * metadata read. `--json` is likewise an HTTP POST of a JSON body. curl only
 * folds --data* / --url-query into the query string; everything here is a write
 * regardless of -G.
 */
const UPLOAD_FLAGS = new Set(['--upload-file']); // PUT
const BODY_FLAGS = new Set(['--form', '--form-string', '--json']); // POST

/** All flags that take a value and may carry request data. */
const LONG_DATA_FLAGS = new Set([...QUERYABLE_DATA_FLAGS, ...UPLOAD_FLAGS, ...BODY_FLAGS]);

/** Short-form cluster letters: d = queryable data, F = form body, T = upload. */
const SHORT_QUERYABLE_LETTERS = new Set(['d']);
const SHORT_BODY_LETTERS = new Set(['F']);
const SHORT_UPLOAD_LETTERS = new Set(['T']);
const SHORT_DATA_LETTERS = new Set(['d', 'F', 'T']);

/**
 * THE SANCTIONED COMMAND FORM.
 * ---------------------------------------------------------------------------
 * Six rounds of adversarial review kept finding the same shape of bypass: some
 * client expresses "write" in a way the classifier did not model. wget, httpie,
 * python requests, PHP curl_setopt, Perl LWP, Ruby Net::HTTP, PowerShell
 * `-Method Post`. Enumerating client shapes is a race that the guard loses,
 * because the attack surface is "every HTTP client that exists".
 *
 * So the model is inverted. Instead of blocklisting write shapes, a Graph
 * request must POSITIVELY MATCH a known-good form:
 *
 *   [VAR=value ...] curl <only recognised flags> <literal Graph URL>
 *
 * Any unrecognised flag, any other binary, any inline interpreter, any option
 * source the guard cannot read -> refused as unclassifiable. This converges by
 * construction: a new curl flag or a new HTTP client cannot silently become a
 * bypass, it becomes a refusal until someone adds it deliberately with a test.
 *
 * The cost is real and accepted: an engineer wanting a Graph read must use plain
 * curl with a literal URL. That is exactly the sanctioned path the S0.1 prepared
 * reads (G1-G6) already use.
 */

/** curl flags that take no value and cannot introduce a body or change method. */
const SAFE_CURL_BOOLEAN_FLAGS = new Set([
  '-q', '--disable',
  '-s', '--silent',
  '-S', '--show-error',
  '-i', '--include',
  '-I', '--head',
  '-f', '--fail',
  '--fail-with-body',
  '--compressed',
  '-g', '--globoff',
  '-G', '--get',
  '--no-progress-meter',
  '-4', '-6',
]);

/** curl flags that take a value. The value is consumed, never read as a flag. */
const SAFE_CURL_VALUE_FLAGS = new Set([
  '-H', '--header',
  '-o', '--output',
  '-A', '--user-agent',
  '-e', '--referer',
  '--url',
  '-X', '--request',
  '-d', '--data', '--data-raw', '--data-ascii', '--data-urlencode',
  '--url-query',
  '--connect-timeout', '--max-time', '-m',
  '--retry', '--retry-delay', '--retry-max-time',
  '--max-redirs',
]);

/** Short-cluster letters, split by whether they consume a value. */
const SHORT_BOOLEAN_LETTERS = new Set(['q', 's', 'S', 'i', 'I', 'f', 'g', 'G', '4', '6']);
const SHORT_VALUE_LETTERS = new Set(['H', 'o', 'A', 'e', 'X', 'd', 'm']);

/**
 * A data value curl reads FROM A FILE rather than from the command line:
 * `-d @params.txt`, `--data-urlencode fields@payload.txt`. The guard cannot read
 * that file, so the parameters it contributes — including `fields=` and any
 * credential — are invisible to classification. Being on the safe-flag list is
 * not enough if the VALUE is unreadable; the flag is safe, the source is not.
 */
const FILE_SOURCED_VALUE_RE = /^@|^[A-Za-z0-9_.[\]-]*@/;

/**
 * Query parameters that let one request address objects the URL does not name,
 * escaping the object allowlist entirely.
 */
const MULTI_OBJECT_PARAMS = new Set(['ids', 'batch']);

/** Flags that take a separate value token, which must not be read as a flag. */
const VALUE_TAKING = new Set([
  '-X',
  '--request',
  '-H',
  '--header',
  '-o',
  '--output',
  '-u',
  '--user',
  '-A',
  '--user-agent',
  '-e',
  '--referer',
  '-b',
  '--cookie',
  '--url',
  ...LONG_DATA_FLAGS,
]);

/**
 * Parse one command as a curl invocation into a normalised option list.
 *
 * ONE parser feeds BOTH method classification and parameter collection. They
 * previously had separate ad-hoc cluster handling and disagreed: `-sGd'fields=x'`
 * was understood as a data flag by the method classifier but returned nothing
 * from the parameter collector, so the field allowlist never ran on it. A single
 * parser makes that class of divergence impossible.
 *
 * Returns {ok, binary, opts:[{flag,value}], operands, unknown:[]}.
 * `ok` is false when the command is not a plain curl invocation.
 */
function parseCurlArgs(cmd) {
  return parseCurlTokens(tokenize(cmd));
}

/**
 * The same parser, over an already-tokenised argv whose first element is the
 * curl executable.
 *
 * Split out in round 8 so destination counting can run the AUTHORITATIVE parse
 * after a wrapper has been resolved, instead of a second heuristic scan. Round 7
 * counted destinations with a `looksLikeTarget()` guess that required `://`, an
 * expansion marker or a slash — so a scheme-less operand (`attacker.example`,
 * `host:8443`, a bare IPv4, `localhost`) was discarded, and a curl carrying the
 * Meta credential to a second host looked single-destination.
 *
 * curl's grammar is the only correct rule: options consume their values, and
 * EVERYTHING that remains is a URL operand. No hostname, IP or domain syntax is
 * enumerated anywhere, because curl does not enumerate it either.
 */
function parseCurlTokens(tokens) {
  const opts = [];
  const operands = [];
  const unknown = [];
  let binary = null;
  let i = 0;

  // Leading `VAR=value` environment assignments are part of the sanctioned form.
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;

  if (i < tokens.length) {
    binary = tokens[i];
    i++;
  }

  // `--` is STATEFUL: it ends option parsing. Everything after it is an
  // operand, including tokens that begin with a dash.
  let endOfOptions = false;

  for (; i < tokens.length; i++) {
    const t = tokens[i];

    if (endOfOptions) {
      operands.push(t);
      continue;
    }
    if (t === '--') {
      endOfOptions = true;
      continue;
    }

    if (/^--[a-z]/i.test(t)) {
      const eq = t.indexOf('=');
      const name = eq === -1 ? t : t.slice(0, eq);
      const inlineValue = eq === -1 ? null : t.slice(eq + 1);
      if (SAFE_CURL_BOOLEAN_FLAGS.has(name)) {
        opts.push({ flag: name, value: null });
      } else if (SAFE_CURL_VALUE_FLAGS.has(name)) {
        let v = inlineValue;
        if (v === null) {
          v = tokens[i + 1] == null ? '' : tokens[i + 1];
          i++;
        }
        opts.push({ flag: name, value: v });
      } else {
        unknown.push(name);
      }
      continue;
    }

    if (/^-[A-Za-z0-9]/.test(t)) {
      // Short cluster. Walk letter by letter; the first value-taking letter
      // consumes the remainder of the token, or the next token.
      const body = t.slice(1);
      let k = 0;
      for (; k < body.length; k++) {
        const c = body[k];
        if (SHORT_BOOLEAN_LETTERS.has(c)) {
          opts.push({ flag: '-' + c, value: null });
          continue;
        }
        if (SHORT_VALUE_LETTERS.has(c)) {
          const rest = body.slice(k + 1);
          let v;
          if (rest !== '') v = rest;
          else {
            v = tokens[i + 1] == null ? '' : tokens[i + 1];
            i++;
          }
          opts.push({ flag: '-' + c, value: v });
          k = body.length; // remainder consumed as the value
          break;
        }
        unknown.push('-' + c);
        break;
      }
      continue;
    }

    operands.push(t);
  }

  const isCurl = binary != null && /(^|[/\\])curl(\.exe)?$/i.test(binary);
  return { ok: isCurl, binary, opts, operands, unknown };
}

/** Canonical flag name -> whether it is a data/body/upload carrier. */
function optIsQueryableData(flag) {
  return flag === '-d' || QUERYABLE_DATA_FLAGS.has(flag);
}

/**
 * Is this segment the sanctioned command form: a plain curl invocation using
 * only recognised flags? Anything else cannot be classified safely.
 */
function isSanctionedCurlForm(cmd) {
  const parsed = parseCurlArgs(cmd);
  return parsed.ok && parsed.unknown.length === 0;
}

/**
 * Classify the HTTP method of a command.
 *
 * Precedence, and the reasoning for each step:
 *   1. Explicit -X / --request wins. curl honours it over everything.
 *   2. A JS client's literal method (`method: 'POST'`, `.delete(`) wins next.
 *   3. -I / --head is HEAD.
 *   4. -G / --get forces GET **even when data flags are present** — this is the
 *      whole point of -G, and the bug this module exists to fix.
 *   5. Otherwise a data/upload flag implies POST.
 *   6. Otherwise GET.
 *
 * Returns one of GET | HEAD | POST | PUT | PATCH | DELETE.
 */
function classifyHttpMethod(cmd) {
  const src = String(cmd || '');

  // Preferred path: a plain curl invocation, parsed by the shared parser.
  const parsed = parseCurlArgs(src);
  if (parsed.ok) {
    let explicitM = null;
    let getM = false;
    let headM = false;
    let dataM = false;
    let bodyM = false;
    let uploadM = false;
    for (const o of parsed.opts) {
      if (o.flag === '-X' || o.flag === '--request') explicitM = String(o.value || '').toUpperCase();
      else if (o.flag === '-G' || o.flag === '--get') getM = true;
      else if (o.flag === '-I' || o.flag === '--head') headM = true;
      else if (optIsQueryableData(o.flag)) dataM = true;
    }
    // An unrecognised flag could be -T/-F/--json/-K; the caller refuses the
    // command outright, but report the most conservative method meanwhile.
    if (parsed.unknown.length) return 'UNKNOWN';
    if (explicitM) {
      if (WRITE_METHODS.has(explicitM)) return explicitM;
      if (explicitM === 'GET' || explicitM === 'HEAD') {
        // `-X GET -d body` still SENDS the body; curl only changes the method
        // token. Returning GET here let a body-bearing request classify as a
        // read. Without -G to fold the data into the query, this is
        // contradictory and is refused rather than believed.
        if (dataM && !getM) return 'UNKNOWN';
        return explicitM;
      }
      return 'UNKNOWN';
    }
    if (headM) return 'HEAD';
    if (uploadM) return 'PUT';
    if (bodyM) return 'POST';
    if (getM) return 'GET';
    if (dataM) return 'POST';
    return 'GET';
  }

  // Fallback: not a curl invocation. The caller refuses these, but a best-effort
  // classification produces a clearer deny reason for obvious writes.
  const tokens = tokenize(src);

  let explicit = null;
  let sawGet = false;
  let sawHead = false;
  let sawData = false; // -G-convertible
  let sawBody = false; // form / json body — NOT -G-convertible
  let sawUpload = false; // file upload — NOT -G-convertible

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    // -X POST / --request POST
    if (t === '-X' || t === '--request') {
      const v = tokens[i + 1];
      if (v) explicit = v.toUpperCase();
      i++;
      continue;
    }
    let m = /^-X(.+)$/.exec(t); // -XPOST
    if (m) {
      explicit = m[1].toUpperCase();
      continue;
    }
    m = /^--request=(.+)$/.exec(t);
    if (m) {
      explicit = m[1].toUpperCase();
      continue;
    }

    if (t === '-G' || t === '--get') {
      sawGet = true;
      continue;
    }
    if (t === '-I' || t === '--head') {
      sawHead = true;
      continue;
    }

    // --data-urlencode 'k=v'  /  --data=...  /  --json '{...}'  /  -T file
    if (LONG_DATA_FLAGS.has(t)) {
      if (UPLOAD_FLAGS.has(t)) sawUpload = true;
      else if (BODY_FLAGS.has(t)) sawBody = true;
      else sawData = true;
      i++; // consume value
      continue;
    }
    let attached = /^--(data(?:-[a-z]+)?|url-query|form(?:-string)?|upload-file|json)=/.exec(t);
    if (attached) {
      const name = '--' + attached[1];
      if (UPLOAD_FLAGS.has(name)) sawUpload = true;
      else if (BODY_FLAGS.has(name)) sawBody = true;
      else sawData = true;
      continue;
    }

    // Short clusters: -sG, -sd, -X is handled above. Skip values of value-taking flags.
    if (VALUE_TAKING.has(t)) {
      i++;
      continue;
    }
    // A single-dash short-option cluster. curl lets a value attach directly to
    // the LAST option letter, and that letter can sit anywhere in the cluster:
    // `-sdk=v` is -s plus -d with value "k=v". Matching only `-[dFT]...` missed
    // every cluster with a leading flag, so `-sdsubscribed_fields=messages`
    // classified as a read. Walk the cluster letter by letter instead, and stop
    // at the first value-taking letter — the rest is its value.
    if (/^-[A-Za-z]/.test(t) && !/^--/.test(t)) {
      const body = t.slice(1);
      let consumedValue = false;
      for (let k = 0; k < body.length; k++) {
        const c = body[k];
        if (!/[A-Za-z]/.test(c)) break; // into an attached value
        if (c === 'G') sawGet = true;
        else if (c === 'I') sawHead = true;
        else if (SHORT_UPLOAD_LETTERS.has(c)) sawUpload = true;
        else if (SHORT_BODY_LETTERS.has(c)) sawBody = true;
        else if (SHORT_QUERYABLE_LETTERS.has(c)) sawData = true;
        if (SHORT_DATA_LETTERS.has(c) || c === 'X' || c === 'H' || c === 'o' || c === 'u') {
          // This letter takes a value: either attached here, or the next token.
          consumedValue = k === body.length - 1;
          break;
        }
      }
      if (consumedValue) i++; // value is the following token
      continue;
    }
  }

  if (explicit) {
    if (WRITE_METHODS.has(explicit) || explicit === 'GET' || explicit === 'HEAD') return explicit;
    // A method flag was supplied but its value is not a literal method — almost
    // always shell indirection such as -X$METHOD. The method is decided at run
    // time and is not knowable here. Previously this fell through to GET, which
    // let a write classify as a read. Refuse instead of guessing.
    return 'UNKNOWN';
  }

  // --- non-curl clients ----------------------------------------------------
  // Adversarial review 2026-08-05 showed the classifier only understood curl and
  // a couple of JS shapes, so `wget --post-data`, `http POST`, and
  // `requests.request('POST', ...)` all classified as GET and reached an
  // allowlisted edge as writes. A guard that only understands one client is a
  // guard against one client.
  const js = /\.\s*(post|put|patch|delete)\s*\(/i.exec(src);
  if (js) return js[1].toUpperCase();
  const jsMethod = /\bmethod\s*[:=]\s*['"`](GET|HEAD|POST|PUT|PATCH|DELETE)['"`]/i.exec(src);
  if (jsMethod) return jsMethod[1].toUpperCase();

  // wget
  if (/--post-data|--post-file|--body-data|--body-file/i.test(src)) return 'POST';
  const wgetMethod = /--method[=\s]+["']?(GET|HEAD|POST|PUT|PATCH|DELETE)/i.exec(src);
  if (wgetMethod) return wgetMethod[1].toUpperCase();

  // python requests / urllib: requests.request('POST', ...)
  const pyRequest = /\brequest\s*\(\s*["'](GET|HEAD|POST|PUT|PATCH|DELETE)["']/i.exec(src);
  if (pyRequest) return pyRequest[1].toUpperCase();

  // Catch-all: a bare UPPERCASE method token standing alone as an argument.
  // Covers httpie (`http POST url`), xh, and any client that names the method
  // positionally. Deliberately case-SENSITIVE so ordinary prose does not match.
  const standalone = /(^|[\s'"(,[])(POST|PUT|PATCH|DELETE)([\s'"),\]]|$)/.exec(src);
  if (standalone) return standalone[2];

  // LAST RESORT, after every literal-method detector has had its turn: a
  // `method` supplied by an expression rather than a literal — process.env.X,
  // os.environ[...], a bare variable — is decided at run time. curl's -X$VAR
  // form is handled above; this is the same hole in every other client. It must
  // run last, or a perfectly literal `--method=DELETE` would be misread as
  // indirection.
  if (/\bmethod\s*[:=]\s*(?!['"`])[A-Za-z_$({[]/.test(src)) return 'UNKNOWN';

  if (sawHead) return 'HEAD';
  // Uploads and bodies are NOT query promotion, so -G does not convert them.
  // Ordered before the -G check deliberately.
  if (sawUpload) return 'PUT';
  if (sawBody) return 'POST';
  if (sawGet) return 'GET'; // <-- -G beats --data* flags. The core correction.
  if (sawData) return 'POST';
  return 'GET';
}

/**
 * Option sources this module cannot see into. `curl -K file` (and --config) read
 * arbitrary options — including `request = "POST"` — from a file or process
 * substitution. The method is then genuinely unknowable at classification time,
 * so the only honest verdict is refusal rather than a guess of GET.
 */
const OPAQUE_OPTION_SOURCE_RE = /(^|\s)-[A-Za-z]*K|(^|\s)--config\b/;

/**
 * A scheme whose HOST is assembled from a shell variable. The path may contain
 * variables — the real ownership probe loops phone-number ids that way — but a
 * variable HOST means the endpoint itself is unknowable, which is how
 * /oauth/access_token stayed reachable. Matches `https://$HOST/...` and not
 * `https://graph.facebook.com/v23.0/$PNID`.
 */
const VARIABLE_HOST_RE = /https?:\/\/[^\s"'/]*\$/;

/**
 * A variable ASSIGNED in this same command whose value contains URL structure —
 * a path separator, a query, a fragment. `NODE=123/accounts; curl .../$NODE`
 * presents to the policy as a bare node read but expands to a token-minting
 * edge. Where the assignment is visible we can catch it exactly.
 *
 * RESIDUAL, STATED: a variable exported by an EARLIER, separate command is not
 * visible here at all. That is inherent to classifying one command string, and
 * is why the object-id allowance is documented as a residual rather than a
 * guarantee. See isAllowedNodeId().
 */
const STRUCTURED_ASSIGNMENT_RE = /(^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=["']?[^\s"';|&]*[/?#&][^\s"';|&]*/;

function assignsUrlStructure(cmd) {
  return STRUCTURED_ASSIGNMENT_RE.test(String(cmd || ''));
}

/**
 * Does this command actually issue a request, as opposed to merely mentioning
 * the Graph host? Used to decide whether an UNPARSEABLE Graph reference is an
 * unclassifiable request (deny) or just a grep/comment (allow).
 */
const REQUEST_CLIENT_RE =
  /(^|[\s;&|(])(curl|wget|xh|http|https|httpie|python[0-9.]*|node|deno|bun|php|ruby|perl|Invoke-RestMethod|Invoke-WebRequest)([\s;&|)]|$)/i;

/**
 * A general-purpose interpreter running inline code.
 *
 * Rounds 1, 3 and 4 of adversarial review each found the same class of bypass:
 * some client library expresses "this is a write" in a way the classifier did
 * not model — `requests.request('POST', ...)`, `fetch(u,{method:V})`, PHP's
 * `curl_setopt($c, CURLOPT_POST, 1)`, Perl's `LWP::UserAgent->post`, Ruby's
 * `Net::HTTP::Post`. Enumerating client APIs is an unwinnable race.
 *
 * So the rule is structural instead: if a Graph URL appears inside an inline
 * interpreter one-liner, the method is whatever arbitrary code decides, and the
 * request is refused as unclassifiable. This costs nothing real — the sanctioned
 * read path is curl with a literal URL, and a checked-in script is not affected
 * because its URL lives in the file, not in the command line the guard sees.
 */
const INLINE_INTERPRETER_RE =
  /(^|[\s;&|(])(?:[\w./\\-]*[/\\])?(php|perl|ruby|python|node|deno|bun|Rscript|osascript|irb|ghci)[0-9.]*(?:\.exe)?([\s;&|)]|$)/i;

function isWriteMethod(method) {
  return WRITE_METHODS.has(String(method || '').toUpperCase());
}

// ---------------------------------------------------------------- 3. url + params

/**
 * decodeURIComponent throws URIError on a malformed escape such as `%ZZ`.
 *
 * That is a CRITICAL failure mode here, not a cosmetic one: isola-guard.js fails
 * open on any internal error, so a single bad escape anywhere in the query string
 * would make the whole Meta policy throw and let a POST straight through. Found
 * by adversarial review 2026-08-05; regression-tested. NEVER call
 * decodeURIComponent directly in this module.
 */
function safeDecode(s) {
  const str = String(s == null ? '' : s);
  try {
    return decodeURIComponent(str);
  } catch (_) {
    return str; // undecodable input is still classified, on its raw form
  }
}

function splitQuery(qs) {
  const params = [];
  for (const pair of String(qs || '').split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq !== -1) {
      params.push({ key: safeDecode(pair.slice(0, eq).trim()), value: pair.slice(eq + 1) });
      continue;
    }
    // No '='. curl's file-backed forms live here, and reading the whole string
    // as the key is what let `client_secret@params.txt` miss TOKEN_EXCHANGE_PARAMS.
    //   name@file  -> a NAMED parameter whose value is read from a file
    //   @file      -> an entirely file-sourced parameter set: opaque
    const at = pair.indexOf('@');
    if (at > 0) {
      params.push({ key: safeDecode(pair.slice(0, at).trim()), value: pair.slice(at), fileSourced: true });
    } else if (at === 0) {
      params.push({ key: '', value: pair, fileSourced: true, opaque: true });
    } else {
      params.push({ key: safeDecode(pair.trim()), value: '' });
    }
  }
  return params;
}

/**
 * Parse every Graph URL in the command.
 * Returns [{raw, version, segments, params}], segments being the path AFTER an
 * optional /vNN.N/ version prefix.
 */
function parseGraphUrls(cmd) {
  const src = String(cmd || '');
  const out = [];
  const re = new RegExp(GRAPH_URL_RE.source, 'gi');
  let m;
  while ((m = re.exec(src)) !== null) {
    const raw = m[0];
    const afterHost = raw.replace(/^(?:https?:\/\/)?graph\.facebook\.com/i, '');
    const qIdx = afterHost.indexOf('?');
    const pathPart = qIdx === -1 ? afterHost : afterHost.slice(0, qIdx);
    const queryPart = qIdx === -1 ? '' : afterHost.slice(qIdx + 1);

    const segments = pathPart.split('/').filter(Boolean);
    let version = null;
    if (segments.length && /^v\d+\.\d+$/i.test(segments[0])) version = segments.shift();

    out.push({ raw, version, segments, params: splitQuery(queryPart) });
  }
  return out;
}

/**
 * Collect the effective query parameters for a GET: those in the URL PLUS those
 * supplied via data flags, because `-G` promotes data flags into the query
 * string. Without this, `-G --data-urlencode 'fields=access_token'` would be
 * field-checked against an empty parameter set and wrongly pass.
 */
function collectDataParams(cmd) {
  // Preferred path: the shared curl parser, so parameter collection can never
  // disagree with method classification about what a cluster meant.
  const parsed = parseCurlArgs(cmd);
  if (parsed.ok) {
    const out = [];
    for (const o of parsed.opts) {
      if (o.value == null) continue;
      if (!optIsQueryableData(o.flag) && o.flag !== '-F' && o.flag !== '--form') continue;
      for (const p of splitQuery(o.value)) out.push(p);
    }
    return out;
  }

  const tokens = tokenize(cmd);
  const params = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    let value = null;
    if (LONG_DATA_FLAGS.has(t)) {
      value = tokens[i + 1];
      i++;
    } else {
      // --url-query is curl's explicit query builder. Omitting it meant
      // `--url-query "fields=access_token"` never reached classifyFields().
      const m = /^--(?:data(?:-[a-z]+)?|url-query|form(?:-string)?|json)=(.*)$/.exec(t);
      if (m) value = m[1];
      else if (/^-[dF](.+)$/.test(t)) value = /^-[dF](.+)$/.exec(t)[1];
      else if (t === '-d' || t === '-F') {
        value = tokens[i + 1];
        i++;
      }
    }
    if (value == null) continue;
    // A data value may itself be several & separated pairs.
    for (const p of splitQuery(value)) params.push(p);
  }
  return params;
}

function effectiveParams(cmd, url) {
  return [...(url.params || []), ...collectDataParams(cmd)];
}

function paramValue(params, key) {
  const hit = params.find((p) => p.key.toLowerCase() === key.toLowerCase());
  return hit ? hit.value : null;
}

// ---------------------------------------------------------------- 4. allowlist

/**
 * Node fields permitted on a metadata read. This is the UNION of WhatsApp phone
 * number, WABA and business metadata, because a bare numeric id in a URL does not
 * tell us which kind of object it is. Every field here is descriptive
 * configuration or identity. None of them returns a credential.
 */
const ALLOWED_NODE_FIELDS = new Set([
  // shared
  'id',
  'name',
  'status',
  // phone number identity / display metadata
  'display_phone_number',
  'verified_name',
  'quality_rating',
  'code_verification_status',
  'name_status',
  'new_name_status',
  'platform_type',
  // Coexistence state — whether the number is still on the WhatsApp Business
  // App. Required by the prepared S0.1 reads G3/G4/G5, which resolve the
  // tenant_registry-vs-brain-provider display-number drift on 3742.
  'is_on_biz_app',
  'throughput',
  'account_mode',
  'certificate',
  'is_official_business_account',
  'is_pin_enabled',
  'messaging_limit_tier',
  'search_visibility',
  'last_onboarded_time',
  // phone-level webhook ownership — the reason this allowlist exists
  'webhook_configuration',
  // WABA metadata
  'currency',
  'timezone_id',
  'message_template_namespace',
  'account_review_status',
  'business_verification_status',
  'country',
  'ownership_type',
  'owner_business_info',
  'on_behalf_of_business_info',
  'primary_funding_id',
  'purchase_order_number',
  'health_status',
  // business / WABA association metadata
  'verification_status',
  'created_time',
  'primary_page',
  // enumerations reachable as a field expansion
  'phone_numbers',
  'subscribed_apps',
]);

/** Edges permitted for GET. Anything not named here is denied by default. */
const ALLOWED_EDGES = new Set([
  'subscribed_apps', // WABA app subscription — proves webhook ownership
  'phone_numbers', // WABA phone-number enumeration
  'owned_whatsapp_business_accounts', // business/WABA association
  'client_whatsapp_business_accounts', // business/WABA association
]);

/** Standalone paths permitted for GET. */
const ALLOWED_ROOT_PATHS = new Set([
  'debug_token', // metadata only — see DEBUG_TOKEN POLICY below
]);

/**
 * Credential-minting / credential-exchange paths. These are GETs that RETURN a
 * live credential. They are the false-allow half of the defect.
 */
const TOKEN_MINTING_PATHS = new Set([
  'oauth/access_token',
  'oauth/client_code',
  'oauth/authorize',
  'device/login',
  'device/login_status',
]);

/**
 * Edges that return access tokens for other objects. `/{user-id}/accounts` hands
 * back a page access token per page — a mint in everything but name.
 */
const TOKEN_MINTING_EDGES = new Set(['accounts', 'access_token', 'app_access_token', 'client_code']);

/** Query parameters that signal a token exchange regardless of path. */
const TOKEN_EXCHANGE_PARAMS = new Set(['grant_type', 'fb_exchange_token', 'client_secret', 'code_verifier']);

/**
 * GET-shaped endpoints with real side effects. Meta exposes several of these;
 * a request-code call sends an SMS or voice call to a live business number.
 */
const SIDE_EFFECTING_EDGES = new Set([
  'request_code',
  'verify_code',
  'register',
  'deregister',
  'migrate',
  'messages',
  'media',
  'set_two_step',
]);

/** Field names that must never be requested, at any nesting depth. */
const FORBIDDEN_FIELD_RE = /\b(access_token|app_secret|client_secret|appsecret_proof|secret)\b/i;

/**
 * A shell variable standing in for an object id.
 *
 * The real ownership probe iterates phone-number ids from a shell variable —
 * `for PNID in ...; do curl ... /$PNID?fields=webhook_configuration; done` — so
 * refusing variable object ids would refuse the very reads this policy exists to
 * permit (S0.1 prepared reads G3, G4 and G6).
 *
 * RESIDUAL RISK, STATED RATHER THAN HIDDEN: a variable's value is not knowable
 * at classification time, so a variable containing a path separator could expand
 * to a different endpoint than the one classified. This is accepted, with three
 * compensating controls that do NOT depend on the variable: the EDGE segment must
 * still be a literal on the allowlist, the `fields` allowlist still applies, and
 * the token-minting/exchange checks still apply. A variable can therefore shift
 * WHICH asset is read, but not WHAT KIND of read is permitted.
 */
const NODE_ID_VAR_RE =
  /^(\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*|\$env:[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z_][A-Za-z0-9_]*%)$/;

/** Numeric asset id, the `me` alias, or a shell variable standing in for one. */
function isAllowedNodeId(segment) {
  const s = String(segment || '');
  return /^[0-9]+$/.test(s) || /^me$/i.test(s) || NODE_ID_VAR_RE.test(s);
}

/**
 * Split a Graph `fields=` value into TOP-LEVEL field names, ignoring the
 * contents of nested `{...}` expansions (which are checked separately by
 * FORBIDDEN_FIELD_RE against the raw string).
 */
/**
 * Every field name in a `fields=` value, AT EVERY NESTING DEPTH.
 *
 * Validating only top-level names was a real hole: `fields=phone_numbers{messages}`
 * passed because `phone_numbers` is allowlisted, while `messages` — an unapproved
 * edge — rode along inside the expansion. Graph field expansion reaches edges, so
 * the allowlist has to reach into expansions too.
 *
 * Only a NAMED list of modifiers is stripped. Stripping every `.name(...)` was
 * itself a hole: Graph's `.fields(...)` modifier SELECTS fields, so
 * `phone_numbers.fields(messages)` had its unapproved argument removed before
 * the allowlist ever saw it. Modifiers that constrain a read (limit, offset,
 * paging, ordering) are safe to drop; anything else stays and must pass the
 * allowlist on its own.
 */
const SAFE_FIELD_MODIFIER_RE =
  /\.(limit|offset|summary|as|since|until|after|before|order|order_by|filtering|date_format|req_id|breakdowns)\([^()]*\)/gi;

function allFieldNames(fieldsValue) {
  const s = safeDecode(fieldsValue).replace(SAFE_FIELD_MODIFIER_RE, '');
  return s
    .split(/[,{}()\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function topLevelFields(fieldsValue) {
  const s = safeDecode(fieldsValue);
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '{' || ch === '(') depth++;
    else if (ch === '}' || ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out
    .map((f) => f.trim().split(/[{(.]/)[0].trim())
    .filter(Boolean);
}

/**
 * Classify one parsed Graph URL against the allowlist.
 * Returns {ok:true} or {ok:false, ruleId, reason}.
 */
function classifyEndpoint(url, params) {
  const segments = url.segments || [];
  const path = segments.join('/');

  if (!segments.length) {
    return { ok: false, ruleId: 'unapproved-object', reason: 'Graph root with no object path is not an allowlisted read.' };
  }

  // --- multi-object addressing escapes the object allowlist ----------------
  for (const p of params) {
    if (MULTI_OBJECT_PARAMS.has(p.key.toLowerCase())) {
      return {
        ok: false,
        ruleId: 'unapproved-object',
        reason:
          'Parameter `' + p.key + '` addresses objects the URL does not name, which bypasses the object allowlist. ' +
          'Read one named object per request.',
      };
    }
  }

  // --- token exchange, by parameter, before anything else ------------------
  for (const p of params) {
    if (TOKEN_EXCHANGE_PARAMS.has(p.key.toLowerCase())) {
      return {
        ok: false,
        ruleId: 'token-exchange',
        reason:
          'Token-exchange parameter `' + p.key + '` present. This request exchanges or mints a credential and would ' +
          'return a live token into the transcript.',
      };
    }
  }

  // --- token minting, by path ---------------------------------------------
  if (TOKEN_MINTING_PATHS.has(path.toLowerCase())) {
    return {
      ok: false,
      ruleId: 'token-minting',
      reason: 'Endpoint /' + path + ' mints or exchanges a credential and returns it in the response body.',
    };
  }

  // --- allowlisted standalone paths (debug_token) -------------------------
  if (segments.length === 1 && ALLOWED_ROOT_PATHS.has(segments[0].toLowerCase())) {
    return { ok: true, kind: 'root', path };
  }

  // --- edge reads ----------------------------------------------------------
  if (segments.length >= 2) {
    const edge = segments[segments.length - 1].toLowerCase();

    if (TOKEN_MINTING_EDGES.has(edge)) {
      return {
        ok: false,
        ruleId: 'token-minting',
        reason: 'Edge /' + edge + ' returns access tokens for the referenced objects.',
      };
    }
    if (SIDE_EFFECTING_EDGES.has(edge)) {
      return {
        ok: false,
        ruleId: 'side-effecting-get',
        reason:
          'Edge /' + edge + ' has real side effects (it sends a message, a verification code, or changes number ' +
          'registration) even when issued as a GET.',
      };
    }
    if (segments.length > 2) {
      return {
        ok: false,
        ruleId: 'unapproved-edge',
        reason: 'Nested path /' + path + ' is not an allowlisted metadata read.',
      };
    }
    if (!ALLOWED_EDGES.has(edge)) {
      return {
        ok: false,
        ruleId: 'unapproved-edge',
        reason: 'Edge /' + edge + ' is not on the metadata read allowlist.',
      };
    }
    // The edge is a literal on the allowlist; the object it hangs off must still
    // be an asset id (or a variable standing in for one), never a named node.
    if (!isAllowedNodeId(segments[0])) {
      return {
        ok: false,
        ruleId: 'unapproved-object',
        reason: 'Object /' + segments[0] + ' is not an asset id and is not an allowlisted read target.',
      };
    }
    return { ok: true, kind: 'edge', path, edge };
  }

  // --- node reads ----------------------------------------------------------
  const node = segments[0];
  if (!isAllowedNodeId(node)) {
    return {
      ok: false,
      ruleId: 'unapproved-object',
      reason: 'Object /' + node + ' is not an asset id and is not an allowlisted read target.',
    };
  }
  return { ok: true, kind: 'node', path };
}

/** Validate the `fields` parameter of an otherwise-allowlisted read. */
function classifyFields(params) {
  const raw = paramValue(params, 'fields');
  if (raw == null || raw === '') return { ok: true, fields: [] };

  const decoded = safeDecode(raw);
  if (FORBIDDEN_FIELD_RE.test(decoded)) {
    return {
      ok: false,
      ruleId: 'credential-field',
      reason: 'The `fields` parameter requests credential material (' + decoded.match(FORBIDDEN_FIELD_RE)[0] + ').',
    };
  }

  // Checked at EVERY depth, not just top level — see allFieldNames().
  const fields = allFieldNames(raw);
  const bad = fields.filter((f) => !ALLOWED_NODE_FIELDS.has(f.toLowerCase()));
  if (bad.length) {
    return {
      ok: false,
      ruleId: 'unapproved-field',
      reason: 'Field(s) not on the metadata allowlist: ' + bad.join(', ') + '.',
    };
  }
  return { ok: true, fields };
}

// ---------------------------------------------------------------- 5. credentials

/**
 * An APPROVED credential source: a plain environment-variable reference in any
 * of the shells this repo actually uses. Anything else — a literal, a
 * command substitution such as $(cat .env), a file read — is refused, because
 * only an env reference keeps the value out of argv and out of the transcript.
 */
const APPROVED_CREDENTIAL_REF_RE =
  /^(\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*|\$env:[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z_][A-Za-z0-9_]*%)$/;

/** Parameters whose value is credential material. */
const CREDENTIAL_PARAMS = new Set([
  'access_token',
  'input_token',
  'appsecret_proof',
  'client_secret',
  'app_secret',
  'fb_exchange_token',
  'code',
]);

/**
 * Literal Meta credential shapes. EAA-prefixed user/system tokens, and the
 * `{app-id}|{app-secret}` app access token form.
 */
const META_TOKEN_LITERAL_RES = [
  { id: 'meta-user-token', re: /\bEA[A-Za-z0-9]{28,}\b/ },
  { id: 'meta-app-access-token', re: /\b\d{13,18}\|[A-Za-z0-9_-]{16,}\b/ },
];

/** A command that would print a credential straight into the transcript. */
const CREDENTIAL_PRINT_RE =
  /\b(echo|printf|print|Write-Host|Write-Output|console\.log)\b[^\n|;&]*\$\{?[A-Za-z_][A-Za-z0-9_]*(TOKEN|SECRET|KEY|PASSWORD|PROOF)/i;

/**
 * Validate every credential-bearing value in the command.
 * Returns {ok:true} or {ok:false, ruleId, reason}.
 */
function validateCredentials(cmd, params) {
  const src = String(cmd || '');

  for (const s of META_TOKEN_LITERAL_RES) {
    if (s.re.test(src)) {
      return {
        ok: false,
        ruleId: 'credential-literal',
        reason:
          'A literal Meta credential (' + s.id + ') appears in the command. Credentials in argv are captured by shell ' +
          'history, process listings and this transcript.',
      };
    }
  }

  if (CREDENTIAL_PRINT_RE.test(src)) {
    return {
      ok: false,
      ruleId: 'credential-print',
      reason: 'This command prints a credential value into the transcript.',
    };
  }

  const authHeader = /Authorization:\s*Bearer\s+(\S+)/i.exec(src);
  if (authHeader && !APPROVED_CREDENTIAL_REF_RE.test(authHeader[1].replace(/["']/g, ''))) {
    return {
      ok: false,
      ruleId: 'credential-literal',
      reason: 'The Authorization header carries a literal bearer value rather than an environment reference.',
    };
  }

  for (const p of params) {
    if (!CREDENTIAL_PARAMS.has(p.key.toLowerCase())) continue;
    const v = String(p.value || '').replace(/["']/g, '');
    if (v === '') continue;
    if (!APPROVED_CREDENTIAL_REF_RE.test(v)) {
      return {
        ok: false,
        ruleId: 'credential-literal',
        reason:
          'Parameter `' + p.key + '` supplies a credential that is not an environment reference. Approved forms are ' +
          '$VAR, ${VAR}, $env:VAR or %VAR%.',
      };
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------- 6. redaction

/**
 * Scrub credential material from text the guard is about to write into the
 * transcript. Values are replaced wholesale — never truncated to a prefix or
 * suffix, because a token prefix is still a usable correlation handle and a
 * suffix is still secret material.
 */
function redactSensitive(text) {
  let s = String(text == null ? '' : text);
  s = s.replace(/\bEA[A-Za-z0-9]{28,}\b/g, '[REDACTED:meta-token]');
  s = s.replace(/\b\d{13,18}\|[A-Za-z0-9_-]{16,}\b/g, '[REDACTED:app-access-token]');
  // Key list is kept in step with CREDENTIAL_PARAMS. `code` is an OAuth
  // authorization code — credential material that was validated but not
  // redacted, so it could still reach the on-disk session ledger.
  s = s.replace(
    /\b(access_token|input_token|client_secret|app_secret|appsecret_proof|fb_exchange_token|code|code_verifier)(["']?\s*[=:]\s*["']?)([^\s"'&,}]+)/gi,
    (_m, key, sep, val) => key + sep + (APPROVED_CREDENTIAL_REF_RE.test(val) ? val : '[REDACTED]')
  );
  s = s.replace(/(Authorization:\s*Bearer\s+)(\S+)/gi, (_m, p, val) =>
    p + (APPROVED_CREDENTIAL_REF_RE.test(val.replace(/["']/g, '')) ? val : '[REDACTED]')
  );
  return s;
}

/**
 * A stable, non-reversible fingerprint for correlating evidence across records
 * without ever writing the credential down. Same token always yields the same
 * 12 hex characters; the token cannot be recovered from it.
 */
function tokenFingerprint(token) {
  return crypto.createHash('sha256').update(String(token == null ? '' : token)).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------- evaluate

const REMEDY_MUTATION =
  'prepare the exact Graph call AND its reversal, hand both to the owner for authorization, and execute only after ' +
  'explicit approval. Metadata reads are available without approval — see the allowlist in ' +
  '.claude/hooks/lib/meta-graph-policy.js.';

const REMEDY_CREDENTIAL =
  'pass the token as an environment reference the shell expands at run time (e.g. --data-urlencode ' +
  '"access_token=$META_GRAPH_TOKEN"), never as a literal, and never echo it. If a literal token reached this command ' +
  'it should be treated as exposed and rotated.';

const REMEDY_READ =
  'restrict the request to an allowlisted metadata read (subscribed_apps, phone_numbers, node identity/display ' +
  'fields, webhook_configuration, business/WABA association, or debug_token). If this read is genuinely required, ' +
  'add it to ALLOWED_EDGES / ALLOWED_NODE_FIELDS with a stated reason and a test, rather than widening the rule.';

/**
 * Full evaluation of a command against Meta Graph policy.
 * Returns {decision:'allow'} or {decision:'deny', ruleId, reason, remedy}.
 * All returned strings are already redacted.
 */
/**
 * curl performs several independent transfers in one command, separated by
 * `--next` (short form `-:`). Each transfer gets its OWN options, so a single
 * global method for the whole command is wrong — and exploitably so:
 *
 *   curl -G "…/123?fields=name" --next -d "x=y" "…/123/subscribed_apps"
 *
 * classified globally as GET (the `-G` from transfer 1) while transfer 2 is a
 * POST to an allowlisted edge. Found by adversarial review 2026-08-05. Each
 * segment is now classified and allowlisted independently, and the command is
 * denied if ANY segment is denied.
 */
function splitTransfers(cmd) {
  const src = String(cmd || '').replace(/\\\r?\n/g, ' ');
  const parts = [];
  let cur = '';
  let quote = null;

  // Pass 1: shell command separators, quote-aware. `a && b`, `a ; b`, `a | b`
  // and `a & b` are separate processes, so a -G in one must never vouch for a
  // body flag in another. Splitting on an UNQUOTED `&` also matches real shell
  // semantics: in `curl url?a=1&b=2 -d x` the shell backgrounds `curl url?a=1`,
  // so classifying that as a GET is correct, not a concession.
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ';' || ch === '\n') {
      parts.push(cur);
      cur = '';
      continue;
    }
    if (ch === '&' || ch === '|') {
      if (src[i + 1] === ch) i++; // && or ||
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  parts.push(cur);

  // Pass 2: curl's own multi-transfer separators within each command.
  const out = [];
  for (const part of parts) {
    for (const seg of part.split(/\s(?:--next|-:)(?=\s|$)/)) {
      if (seg.trim() !== '') out.push(seg);
    }
  }
  return out;
}

function unclassifiable(reason, remedy) {
  return {
    decision: 'deny',
    ruleId: 'unclassifiable-graph-request',
    reason: redactSensitive(reason),
    remedy: remedy,
    method: 'UNKNOWN',
  };
}

const REMEDY_LITERAL_URL =
  'write the Graph host, path and method as literal text so the policy can classify them, keeping only the token in an ' +
  'environment variable — e.g. curl -sG --data-urlencode "access_token=$META_GRAPH_TOKEN" ' +
  'https://graph.facebook.com/v23.0/<id>/subscribed_apps';

function evaluateMetaGraph(cmd) {
  const whole = String(cmd || '');
  if (!isMetaGraphCommand(whole)) return { decision: 'allow', reason: 'not a Graph command' };

  // ---- whole-command checks, BEFORE segmentation ---------------------------
  // These must not be done per segment. Splitting `HOST=graph.facebook.com; curl
  // "https://$HOST/..."` puts the host name in one segment and the request in
  // another, so neither segment looks like a Graph call on its own.
  if (VARIABLE_HOST_RE.test(whole)) {
    return unclassifiable(
      'This command builds the Graph host from a shell variable, so the endpoint it will actually reach is not knowable ' +
        'before it runs. An endpoint that cannot be identified cannot be allowlisted.',
      REMEDY_LITERAL_URL
    );
  }

  // The SAME analysis classification used. Sharing it is the point: a target
  // that was classified because it resists decision must also be denied here,
  // rather than falling through to per-URL rules that need a literal URL to
  // examine and would find none.
  let resists = false;
  try {
    resists = targetsResistDecision(whole);
  } catch (_) {
    resists = true; // an inspection fault on a request-shaped command fails closed
  }
  // Hygiene required of a Meta request specifically. Scoped here so ordinary
  // non-Meta curl usage elsewhere in the repo is unaffected.
  let hygiene = null;
  try {
    hygiene = metaCurlHygieneViolation(whole);
  } catch (_) {
    hygiene = {
      reason: 'This Meta request could not be inspected for configuration and header hygiene.',
      remedy: REMEDY_LITERAL_URL,
    };
  }
  if (hygiene) return unclassifiable(hygiene.reason, hygiene.remedy);

  // Single-destination contract. Deliberately BEFORE splitTransfers(), which
  // keeps only the Graph transfers — exactly the information this rule needs.
  let multiDest = null;
  try {
    multiDest = singleDestinationViolation(whole);
  } catch (_) {
    multiDest = {
      reason: 'The set of destinations this curl would contact could not be determined.',
      remedy: REMEDY_LITERAL_URL,
    };
  }
  if (multiDest) return unclassifiable(multiDest.reason, multiDest.remedy);

  // Target identity, from the operand curl will actually contact. Runs before
  // any path/field/credential rule, because those rules answer "is this Graph
  // request acceptable" and are meaningless until "is this a Graph request at
  // all" has been settled from the destination rather than from stray text.
  let identity = null;
  try {
    identity = metaTargetIdentityViolation(whole);
  } catch (_) {
    identity = {
      reason: 'The destination this command would contact could not be identified.',
      remedy: REMEDY_LITERAL_URL,
    };
  }
  if (identity) return unclassifiable(identity.reason, identity.remedy);

  if (resists) {
    return unclassifiable(
      'The request target cannot be decided before this command runs: its scheme, authority, path, protected edge, ' +
        'query-key provenance or configuration source is supplied at runtime. A destination that cannot be identified ' +
        'cannot be allowlisted, and a Meta mutation is indistinguishable from an ordinary request until it has already happened.',
      REMEDY_LITERAL_URL
    );
  }

  // A variable used in the URL is only acceptable as a bare asset id. If this
  // command also assigns a variable to something containing URL structure, the
  // "id" can expand into an extra path segment or query — turning an allowlisted
  // node read into /{id}/accounts, which returns page access tokens.
  if (/\$\{?[A-Za-z_]/.test(whole) && assignsUrlStructure(whole)) {
    return unclassifiable(
      'This command assigns a shell variable containing URL structure (a path separator, query or fragment) and uses a ' +
        'variable in a Graph URL. The endpoint after expansion is not the endpoint being classified.',
      REMEDY_LITERAL_URL
    );
  }

  const segments = splitTransfers(whole);
  const parsedAnywhere = segments.some((s) => parseGraphUrls(s).length > 0);

  if (!parsedAnywhere) {
    // The host is named but no Graph URL could be parsed. Prose, a grep, or a
    // string literal in a script — nothing to gate — UNLESS the command really
    // is issuing a request, in which case refusing is the only honest answer.
    if (/https?:\/\//i.test(whole) && REQUEST_CLIENT_RE.test(whole)) {
      return unclassifiable(
        'This command issues a Meta Graph request whose URL cannot be statically classified.',
        REMEDY_LITERAL_URL
      );
    }
    return { decision: 'allow', reason: 'no parseable Graph URL' };
  }

  // ---- per-segment classification -----------------------------------------
  for (const seg of segments) {
    if (!parseGraphUrls(seg).length) continue;
    const v = evaluateSegment(seg, whole);
    if (v.decision === 'deny') return v;
  }
  return { decision: 'allow', method: 'GET', reason: 'all transfers are allowlisted Graph metadata reads' };
}

/** Evaluate ONE curl transfer (or a whole non-curl command). */
function evaluateSegment(src, whole) {
  const urls = parseGraphUrls(src);
  if (!urls.length) return { decision: 'allow', reason: 'no parseable Graph URL in segment' };

  // THE POSITIVE FORM CHECK. A Graph request must be a plain curl invocation
  // using only recognised flags. Everything else — PowerShell, wget, httpie,
  // python/php/perl/ruby/node, an unknown curl flag, an opaque config source —
  // is refused rather than classified by guesswork. See the SANCTIONED COMMAND
  // FORM note above for why this replaced client-shape enumeration.
  const parsed = parseCurlArgs(src);
  if (!parsed.ok) {
    // Give an obvious write the clearer reason before the generic refusal.
    const guessed = classifyHttpMethod(src);
    if (isWriteMethod(guessed)) {
      return {
        decision: 'deny',
        ruleId: 'meta-asset-mutation',
        reason: redactSensitive(
          'This is a ' + guessed + ' against Meta Graph. It mutates Meta/WhatsApp asset configuration ' +
            '(webhook, subscription, template or number registration).\n' +
            'Webhook ownership defects have twice caused live incidents (WABA-level 2026-07-10, phone-level 9043).'
        ),
        remedy: REMEDY_MUTATION,
        method: guessed,
      };
    }
    return unclassifiable(
      'A Meta Graph request must be issued as a plain curl command so its method and endpoint can be verified before it ' +
        'runs. This command uses a different client or wrapper (' + (parsed.binary || 'unknown') + '), whose request ' +
        'method cannot be determined from the command line.',
      REMEDY_LITERAL_URL
    );
  }
  // A safe flag with an UNREADABLE value is not safe. `-d @params.txt` supplies
  // parameters from a file the guard cannot see, so `fields=` and credential
  // checks would run against nothing.
  for (const o of parsed.opts) {
    if (o.value == null) continue;
    if (!optIsQueryableData(o.flag)) continue;
    if (FILE_SOURCED_VALUE_RE.test(String(o.value).replace(/^["']|["']$/g, ''))) {
      return unclassifiable(
        'A data option reads its value from a file (' + o.flag + ' @...). The parameters that file contributes — ' +
          'including `fields` and any credential — cannot be inspected, so the request cannot be classified as an ' +
          'allowlisted read.',
        'pass the parameters inline, e.g. --data-urlencode "fields=webhook_configuration", keeping only the token in an ' +
          'environment variable.'
      );
    }
  }

  if (parsed.unknown.length) {
    return unclassifiable(
      'This curl command uses option(s) the policy does not model: ' + parsed.unknown.slice(0, 5).join(', ') +
        '. An unrecognised option may carry a request body, change the method, or replace the URL, so the request cannot ' +
        'be classified as a read.',
      'use only the recognised read options (-s, -S, -G, -H, -d/--data-urlencode/--url-query, -o, -w, timeouts). If a new ' +
        'option is genuinely needed, add it to the safe-flag tables in meta-graph-policy.js with a test, rather than ' +
        'working around this refusal.'
    );
  }

  // An opaque option source can inject `request = "POST"` — or an entirely
  // different `url =` — from a file the guard cannot read, so neither the method
  // nor the endpoint is knowable. Attached forms (-Kfile, -K<(...)) count.
  if (OPAQUE_OPTION_SOURCE_RE.test(src)) {
    return unclassifiable(
      'This request reads curl options from an external config source (-K/--config). Those options can set the HTTP ' +
        'method and even replace the URL, so the request cannot be classified as a read.',
      'pass the required options explicitly on the command line so the request method and URL are visible to the policy.'
    );
  }

  const method = classifyHttpMethod(src);

  if (method === 'UNKNOWN') {
    return unclassifiable(
      'The HTTP method of this request is supplied indirectly (for example -X$METHOD), so it is decided at run time and ' +
        'cannot be classified as a read.',
      REMEDY_LITERAL_URL
    );
  }

  if (isWriteMethod(method)) {
    return {
      decision: 'deny',
      // Rule id preserved from the previous implementation so existing evidence,
      // runbooks and tests that cite it keep resolving.
      ruleId: 'meta-asset-mutation',
      reason: redactSensitive(
        'This is a ' + method + ' against Meta Graph. It mutates Meta/WhatsApp asset configuration ' +
          '(webhook, subscription, template or number registration).\n' +
          'Webhook ownership defects have twice caused live incidents (WABA-level 2026-07-10, phone-level 9043).'
      ),
      remedy: REMEDY_MUTATION,
      method,
    };
  }

  // A Graph URL inside inline interpreter code: the method is decided by
  // arbitrary code (PHP's CURLOPT_POST, Perl's LWP post, Ruby's Net::HTTP::Post),
  // so no static classification of the command line can be trusted. Checked
  // AFTER the write-method test, so an obvious inline write still reports the
  // clearer meta-asset-mutation reason rather than a generic refusal.
  if (INLINE_INTERPRETER_RE.test(src)) {
    return unclassifiable(
      'This Graph URL appears inside inline interpreter code, where the HTTP method is chosen by the code itself and ' +
        'cannot be determined from the command.',
      'issue allowlisted metadata reads with curl and a literal URL, or put the logic in a checked-in script that goes ' +
        'through review rather than an inline one-liner.'
    );
  }

  for (const url of urls) {
    const params = effectiveParams(src, url);

    // Credential literals are scanned across the WHOLE command, not just this
    // transfer: a token pasted into any segment is already exposed.
    const cred = validateCredentials(whole || src, params);
    if (!cred.ok) {
      return {
        decision: 'deny',
        ruleId: cred.ruleId,
        reason: redactSensitive(cred.reason),
        remedy: REMEDY_CREDENTIAL,
        method,
      };
    }

    const ep = classifyEndpoint(url, params);
    if (!ep.ok) {
      const mint = ep.ruleId === 'token-minting' || ep.ruleId === 'token-exchange';
      return {
        decision: 'deny',
        ruleId: ep.ruleId,
        reason: redactSensitive(ep.reason),
        remedy: mint
          ? 'credential issuance is an owner-operated action performed outside an agent session. Use `debug_token` to ' +
            'inspect an existing token\'s metadata instead — it returns scopes and expiry, never a token value.'
          : REMEDY_READ,
        method,
      };
    }

    // debug_token is metadata-only: it returns app_id, scopes, expiry and
    // validity for a token you already hold. It issues nothing. It stays
    // available so rotation preflight can verify a replacement credential
    // BEFORE it is put into service.
    if (ep.kind === 'root' && ep.path.toLowerCase() === 'debug_token') continue;

    const fields = classifyFields(params);
    if (!fields.ok) {
      return {
        decision: 'deny',
        ruleId: fields.ruleId,
        reason: redactSensitive(fields.reason),
        remedy: fields.ruleId === 'credential-field' ? REMEDY_CREDENTIAL : REMEDY_READ,
        method,
      };
    }
  }

  return { decision: 'allow', method, reason: 'allowlisted Graph metadata read' };
}

module.exports = {
  META_HOST_RE,
  ALLOWED_NODE_FIELDS,
  ALLOWED_EDGES,
  ALLOWED_ROOT_PATHS,
  TOKEN_MINTING_PATHS,
  TOKEN_MINTING_EDGES,
  SIDE_EFFECTING_EDGES,
  APPROVED_CREDENTIAL_REF_RE,
  NODE_ID_VAR_RE,
  OPAQUE_OPTION_SOURCE_RE,
  REQUEST_CLIENT_RE,
  VARIABLE_HOST_RE,
  SAFE_FIELD_MODIFIER_RE,
  SAFE_CURL_BOOLEAN_FLAGS,
  SAFE_CURL_VALUE_FLAGS,
  isAllowedNodeId,
  isMetaGraphCommand,
  safeDecode,
  tokenize,
  splitTransfers,
  parseCurlArgs,
  isSanctionedCurlForm,
  classifyHttpMethod,
  isWriteMethod,
  parseGraphUrls,
  collectDataParams,
  effectiveParams,
  paramValue,
  topLevelFields,
  allFieldNames,
  classifyEndpoint,
  classifyFields,
  validateCredentials,
  redactSensitive,
  tokenFingerprint,
  evaluateMetaGraph,
};
