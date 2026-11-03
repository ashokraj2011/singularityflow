/** RCP bounded pattern engine: anchored concatenations, classes and repetitions, no backtracking. */
export function compileCommitPattern(source) {
  const fail = () => { throw Object.assign(new Error('Commit patterns must be anchored and use literals, classes or bounded repetitions; groups, alternation, lookarounds and backreferences are unsupported.'), { code: 'RCP_PATTERN_UNSUPPORTED' }); };
  if (typeof source !== 'string' || source.length > 512 || !source.startsWith('^') || !source.endsWith('$')) fail();
  const body = source.slice(1, -1), states = [];
  const state = () => { if (states.length >= 1024) fail(); const s = { edges: [], epsilon: [] }; states.push(s); return states.length - 1; };
  const start = state(); let current = start, index = 0;
  function escaped() {
    const char = body[index++];
    if (char === 'd') return c => /^[0-9]$/u.test(c);
    if (char === 'w') return c => /^[A-Za-z0-9_]$/u.test(c);
    if (char === 's') return c => c === ' ' || c === '\t';
    if (char && '.[]{}()*+?^$|\\/-: '.includes(char)) return c => c === char;
    return fail();
  }
  while (index < body.length) {
    let matches; const char = body[index++];
    if (char === '\\') matches = escaped();
    else if (char === '.') matches = c => c !== '\n' && c !== '\r';
    else if (char === '[') {
      let inverted = false; if (body[index] === '^') { inverted = true; index++; }
      const predicates = []; let closed = false;
      while (index < body.length) {
        let c = body[index++];
        if (c === ']' && predicates.length) { closed = true; break; }
        if (c === '\\') { predicates.push(escaped()); continue; }
        if (body[index] === '-' && body[index + 1] && body[index + 1] !== ']') {
          index++; const end = body[index++]; if (c > end || end === '\\') fail();
          predicates.push(v => v >= c && v <= end);
        } else predicates.push(v => v === c);
      }
      if (!closed) fail();
      matches = c => inverted !== predicates.some(predicate => predicate(c));
    } else if ('()|^$*+?{}'.includes(char) || /[\r\n\u0000]/u.test(char)) fail();
    else matches = c => c === char;
    let minimum = 1, maximum = 1;
    if (body[index] === '*') { minimum = 0; maximum = Infinity; index++; }
    else if (body[index] === '+') { maximum = Infinity; index++; }
    else if (body[index] === '?') { minimum = 0; index++; }
    else if (body[index] === '{') {
      const found = /^\{(\d{1,3})(?:,(\d{0,3}))?\}/u.exec(body.slice(index));
      if (!found) fail();
      minimum = Number(found[1]); maximum = found[2] === undefined ? minimum : found[2] === '' ? Infinity : Number(found[2]);
      if (minimum > 128 || maximum < minimum || (maximum !== Infinity && maximum > 128)) fail();
      index += found[0].length;
    }
    for (let n = 0; n < minimum; n++) { const next = state(); states[current].edges.push({ matches, next }); current = next; }
    if (maximum === Infinity) { states[current].edges.push({ matches, next: current }); }
    else for (let n = minimum; n < maximum; n++) {
      const next = state(); states[current].epsilon.push(next); states[current].edges.push({ matches, next }); current = next;
    }
  }
  const accept = current;
  function closure(input) {
    const seen = new Set(input), queue = [...input];
    for (let n = 0; n < queue.length; n++) for (const next of states[queue[n]].epsilon) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    return seen;
  }
  return text => {
    if (typeof text !== 'string' || text.length > 8192) return false;
    let active = closure([start]);
    for (const char of text) {
      const next = new Set();
      for (const id of active) for (const edge of states[id].edges) if (edge.matches(char)) next.add(edge.next);
      active = closure(next); if (!active.size) return false;
    }
    return active.has(accept);
  };
}
