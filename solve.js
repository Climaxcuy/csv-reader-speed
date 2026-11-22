// csv-reader-speed entry — event-index scanner over typed arrays.
//
// Architecture (two passes, deliberately unlike a plain char-loop parser):
//
//   PASS A — event indexing. One charCodeAt sweep over the text that parses
//   nothing: it only records every "interesting" character — comma (44),
//   quote (34), LF (10), CR (13) — into ONE growable Uint32Array, packed as
//   (position * 4 + class) with class 0=comma, 1=quote, 2=LF, 3=CR: one
//   store per event in pass A, one load per event in pass B. The buffer is
//   pre-sized to n/4 (measured event density on real CSV is ~0.11/char)
//   and still grows geometrically (doubling, copied with .set) if a dense
//   text ever overflows it. In real CSV the event list is far smaller than
//   the text: most characters are payload that no parser decision ever
//   touches.
//
//   PASS B — event-driven parse. A state machine that walks ONLY the event
//   list. Between two consecutive events lies a run of ordinary characters,
//   so every decision — field boundary, quote open/close, "" escape (two
//   quote events at adjacent positions), CRLF (a CR event immediately
//   followed by an LF event), stray CR, record end — is taken from event
//   positions/classes alone. Field strings are produced with slice() over
//   the untouched runs; a field is stitched from multiple slices only when
//   it actually contains an event that changes bytes (a dropped stray CR,
//   a doubled quote collapsing to one, a CR/CRLF inside quotes becoming
//   '\n'). All line/row/error bookkeeping is derived in pass B.
//
// The single non-monotonic step is the unterminated-quote rule: when a
// quoted scan reaches end-of-text without closing, the opening quote turns
// literal and the parser rewinds to just after it. The event cursor is
// restored with a binary search (lower bound) over the packed ev, and the line
// counter is restored to the line the quote opened on, exactly discarding
// the newlines the aborted scan had counted.
//
// No state is kept between calls: buffers are allocated per call, so the
// import-time self-warmup below only tiers the code, never the data.

// How a field ended (numeric, to keep the hot loop on small ints).
const ENDED_COMMA = 0;
const ENDED_BREAK = 1;
const ENDED_END = 2;

// Packed event classes (low 2 bits of each event word).
const EV_COMMA = 0;
const EV_QUOTE = 1;
const EV_LF = 2;
const EV_CR = 3;

// First index i in ev[0..m) whose position (ev[i] >>> 2) is >= target.
// Packed words are monotonic in position, so this is a plain search for
// the first word >= target * 4.
function lowerBound(ev, m, target) {
  const packedTarget = target * 4;
  let lo = 0;
  let hi = m;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ev[mid] < packedTarget) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// PASS A: build the event index.
function scanEvents(text, n) {
  let cap = n > 4096 ? n >>> 2 : 1024;
  let ev = new Uint32Array(cap);
  let m = 0;
  for (let i = 0; i < n; i++) {
    const cc = text.charCodeAt(i);
    // Every event char is <= 44, so one comparison dismisses the great
    // majority of payload (letters, digits, most punctuation) outright;
    // only the <= 44 minority pays the classification chain.
    if (cc <= 44) {
      let cls;
      if (cc === 44) cls = EV_COMMA;
      else if (cc === 34) cls = EV_QUOTE;
      else if (cc === 10) cls = EV_LF;
      else if (cc === 13) cls = EV_CR;
      else continue;
      if (m === cap) {
        const grown = new Uint32Array(cap * 2);
        grown.set(ev);
        ev = grown;
        cap *= 2;
      }
      ev[m] = i * 4 + cls;
      m++;
    }
  }
  return { ev, m };
}

// Reads an unquoted run starting at S.pos onto `prefix` ('' normally, the
// quoted value for the quote-junk continuation, or '"' for the
// unterminated-quote re-read). Quote events are ordinary payload here and
// are passed over without splitting the current slice run; stray CR events
// split it (the CR is dropped and reported). Returns {value, ended, added}
// where `added` counts characters kept by this call only.
function readUnquoted(S, prefix) {
  const text = S.text;
  const ev = S.ev;
  const m = S.m;
  const n = S.n;
  let ei = S.ei;
  let pos = S.pos;
  let segStart = pos;
  let parts = null;
  let added = 0;
  let ended = ENDED_END;
  let endPos = n;

  while (ei < m) {
    const word = ev[ei];
    const epos = word >>> 2;
    const ecls = word & 3;
    if (ecls === EV_COMMA) { // ','
      endPos = epos;
      ei += 1;
      pos = epos + 1;
      ended = ENDED_COMMA;
      break;
    }
    if (ecls === EV_LF) { // LF
      endPos = epos;
      ei += 1;
      pos = epos + 1;
      S.line += 1;
      ended = ENDED_BREAK;
      break;
    }
    if (ecls === EV_CR) { // CR
      if (epos + 1 < n && text.charCodeAt(epos + 1) === 10) { // CRLF
        endPos = epos;
        ei += 2; // the LF at epos+1 is necessarily the next event
        pos = epos + 2;
        S.line += 1;
        ended = ENDED_BREAK;
        break;
      }
      // Lone CR: dropped, one stray_cr error, run splits here.
      if (parts === null) parts = [];
      if (epos > segStart) parts.push(text.slice(segStart, epos));
      added += epos - segStart;
      S.errors.push({ code: 'stray_cr', line: S.recordLine, row: S.recordRow });
      ei += 1;
      pos = epos + 1;
      segStart = pos;
      continue;
    }
    // Quote event inside an unquoted field: a literal character that lives
    // inside the current slice run — just step over its event.
    ei += 1;
  }
  if (ended === ENDED_END) pos = n;

  const tail = text.slice(segStart, endPos);
  added += tail.length;
  let value;
  if (parts === null) {
    value = prefix === '' ? tail : prefix + tail;
  } else {
    if (tail !== '') parts.push(tail);
    value = prefix + parts.join('');
  }
  S.ei = ei;
  S.pos = pos;
  return { value, ended, added };
}

// Reads a quoted field whose opening quote is at S.pos, deciding everything
// from the event list: a quote event followed by another quote event at the
// very next position is an escaped quote; a CR event (with its LF partner
// when present) becomes one '\n' and advances the line; an LF event is kept
// verbatim and advances the line; comma events are payload.
function readQuoted(S) {
  const text = S.text;
  const ev = S.ev;
  const m = S.m;
  const n = S.n;
  const open = S.pos;
  const openLine = S.line;
  let ei = S.ei;
  if (ei < m && (ev[ei] >>> 2) === open) ei += 1;
  else ei = lowerBound(ev, m, open + 1);
  let pos = open + 1;
  let segStart = pos;
  let parts = null;
  let value = '';
  let closed = false;

  while (ei < m) {
    const word = ev[ei];
    const epos = word >>> 2;
    const ecls = word & 3;
    if (ecls === EV_QUOTE) { // '"'
      if (epos + 1 < n && text.charCodeAt(epos + 1) === 34) {
        // Doubled quote: one literal quote, both events consumed.
        if (parts === null) parts = [];
        parts.push(text.slice(segStart, epos), '"');
        ei += 2;
        pos = epos + 2;
        segStart = pos;
        continue;
      }
      // Closing quote.
      if (parts === null) {
        value = text.slice(segStart, epos);
      } else {
        parts.push(text.slice(segStart, epos));
        value = parts.join('');
      }
      ei += 1;
      pos = epos + 1;
      closed = true;
      break;
    }
    if (ecls === EV_CR) { // CR inside quotes: CRLF or lone CR -> one '\n'
      if (parts === null) parts = [];
      parts.push(text.slice(segStart, epos), '\n');
      S.line += 1;
      if (epos + 1 < n && text.charCodeAt(epos + 1) === 10) {
        ei += 2;
        pos = epos + 2;
      } else {
        ei += 1;
        pos = epos + 1;
      }
      segStart = pos;
      continue;
    }
    if (ecls === EV_LF) { // LF inside quotes: kept, line advances
      S.line += 1;
      ei += 1;
      continue;
    }
    ei += 1; // comma inside quotes: payload, part of the slice run
  }

  if (!closed) {
    // The quote never closes: it becomes a literal '"' and the following
    // text is re-read as an unquoted field. Rewind both cursors; the line
    // counter resets to the opening line (aborted-scan newlines vanish).
    S.line = openLine;
    S.errors.push({ code: 'unterminated_quote', line: S.recordLine, row: S.recordRow });
    S.pos = open + 1;
    S.ei = lowerBound(ev, m, open + 1);
    return readUnquoted(S, '"');
  }

  S.ei = ei;
  S.pos = pos;
  if (pos >= n) return { value, ended: ENDED_END, added: 0 };
  const cc = text.charCodeAt(pos);
  if (cc === 44) {
    if (ei < m && (ev[ei] >>> 2) === pos) S.ei = ei + 1;
    S.pos = pos + 1;
    return { value, ended: ENDED_COMMA, added: 0 };
  }
  if (cc === 10) {
    if (ei < m && (ev[ei] >>> 2) === pos) S.ei = ei + 1;
    S.pos = pos + 1;
    S.line += 1;
    return { value, ended: ENDED_BREAK, added: 0 };
  }
  if (cc === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
    if (ei < m && (ev[ei] >>> 2) === pos) S.ei = ei + 2;
    S.pos = pos + 2;
    S.line += 1;
    return { value, ended: ENDED_BREAK, added: 0 };
  }
  // Junk after the closing quote: read as an unquoted continuation appended
  // to the value. quote_junk is reported only if the continuation kept at
  // least one character, and after any stray_cr errors it produced (they
  // are pushed inside readUnquoted, before this check runs).
  const junk = readUnquoted(S, value);
  if (junk.added > 0) {
    S.errors.push({ code: 'quote_junk', line: S.recordLine, row: S.recordRow });
  }
  return junk;
}

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;

  const { ev, m } = scanEvents(text, n);
  const S = {
    text, n, ev, m,
    ei: 0, pos: 0, line: 1,
    errors: [], recordLine: 1, recordRow: null,
  };
  const errors = S.errors;
  const rows = [];
  let columns = null;
  let width = -1;

  if (n > 0 && text.charCodeAt(0) === 0xFEFF) S.pos = 1; // BOM dropped

  while (true) {
    // Blank lines (empty, or CRLF only) are no records: skip LF / CRLF
    // events sitting exactly at the cursor. A lone CR is NOT blank — it
    // starts a record attempt whose stray_cr errors must survive.
    while (S.pos < n && S.ei < m && (ev[S.ei] >>> 2) === S.pos) {
      const cls = ev[S.ei] & 3;
      if (cls === EV_LF) {
        S.ei += 1;
        S.pos += 1;
        S.line += 1;
      } else if (cls === EV_CR && S.pos + 1 < n && text.charCodeAt(S.pos + 1) === 10) {
        S.ei += 2;
        S.pos += 2;
        S.line += 1;
      } else {
        break;
      }
    }
    if (S.pos >= n) break;

    S.recordLine = S.line;
    S.recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let field;
    let quoted = false;
    let recordDone = false;

    // FAST PATH — unquoted fields materialised directly from comma/break
    // event positions in one tight loop, with no per-field call or result
    // object. Quote events inside an unquoted field are literal payload
    // (they sit inside the slice), so they are simply stepped over. The
    // fast path commits nothing it cannot finish: if a field starts with
    // a quote, or a field contains a lone CR, the cursors are parked at
    // that field's start and the general state machine below re-reads
    // from there, with the fields already collected kept. (A CRLF is a
    // clean record end, not a lone CR.) Fast fields produce no errors and
    // never advance the line mid-record, so the hand-over is exact.
    if (!(S.pos < n && text.charCodeAt(S.pos) === 34)) {
      let ei = S.ei;
      let fieldStart = S.pos;
      let fieldEi = ei; // index of the first event at/after fieldStart
      scan: while (true) {
        if (ei >= m) {
          fields.push(text.slice(fieldStart, n));
          S.ei = ei;
          S.pos = n;
          recordDone = true;
          break scan;
        }
        const word = ev[ei];
        const epos = word >>> 2;
        const ecls = word & 3;
        if (ecls === EV_COMMA) {
          fields.push(text.slice(fieldStart, epos));
          ei += 1;
          fieldStart = epos + 1;
          fieldEi = ei;
          if (fieldStart < n && text.charCodeAt(fieldStart) === 34) {
            S.ei = ei;
            S.pos = fieldStart;
            break scan; // quoted field follows: general path takes over
          }
          continue;
        }
        if (ecls === EV_LF) {
          fields.push(text.slice(fieldStart, epos));
          S.ei = ei + 1;
          S.pos = epos + 1;
          S.line += 1;
          recordDone = true;
          break scan;
        }
        if (ecls === EV_CR) {
          if (epos + 1 < n && text.charCodeAt(epos + 1) === 10) { // CRLF
            fields.push(text.slice(fieldStart, epos));
            S.ei = ei + 2;
            S.pos = epos + 2;
            S.line += 1;
            recordDone = true;
          } else {
            S.ei = fieldEi;
            S.pos = fieldStart; // lone CR: general path re-reads this field
          }
          break scan;
        }
        ei += 1; // quote event inside an unquoted field: literal, in-slice
      }
    }
    if (!recordDone) {
      do {
        quoted = S.pos < n && text.charCodeAt(S.pos) === 34;
        field = quoted ? readQuoted(S) : readUnquoted(S, '');
        fields.push(field.value);
      } while (field.ended === ENDED_COMMA);
    }

    // A record whose only field is '' and whose (last) field was not quoted
    // is not a record at all (the lone-CR-only line) — its errors stay.
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: S.recordLine, row: S.recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: S.recordLine, row: S.recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}

// ---- Self-warmup -----------------------------------------------------------
// A small synthetic (~430 chars) that walks every path of the parser:
// quoted fields with doubled quotes, CRLF and lone CR inside quotes, junk
// after a closing quote (with and without a stray CR in it), stray CRs in
// unquoted fields, short and long rows, blank lines, a CR-only line, a
// quoted empty field, a BOM, and — placed last so no later quote can close
// it — an unterminated quote. 40 reps, alternating header mode, results
// discarded; run() keeps no state between calls, so this only tiers the
// JIT on the hot paths before the first real case arrives.
const WARM_TEXT =
  '\uFEFFname,age,note\r\n' +
  '"a""b","line1\r\nline2","x\ry"\n' +
  'ab\rcd,only-two\n' +
  '"q"junk,2,3\n' +
  '"q"\rspill,2,3\r\n' +
  '1,2,3,4,5\n' +
  '\n' +
  '\r\n' +
  '\r\r\n' +
  '\rtail,after-cr-line\n' +
  '"",,\n' +
  'last,row,here\n' +
  '"never closes,still going';
for (let rep = 0; rep < 40; rep++) {
  run({ text: WARM_TEXT, header: rep % 2 === 0 });
}
