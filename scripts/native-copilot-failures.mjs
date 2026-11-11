/**
 * Failure signatures in native Copilot session logs, for `native-copilot-audit.mjs --sessions <DIR>
 * --failures` (SPEC-OUT CON-015: offline and read-only; the audit script is the one reader of the
 * host's logs and hands this module their folder).
 *
 * Counts what stopped or slowed SFlow turns, by skill, step and work type: guard stops and denials,
 * hook timeouts and slow hooks, failed edits and whether they recovered, JSON and large-output
 * problems, turns that ended early, CLI refusal codes and skill-tool misses. Only `events.jsonl`
 * files are read and nothing is written. The report is content-free (codes, counts, session
 * prefixes and line numbers) unless `details` asks for short examples, and then the home folder,
 * user name, emails and personal names are redacted from them.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';


// ---------------------------------------------------------------- redaction
const HOME = os.homedir();
let USER = '';
try { USER = os.userInfo().username || ''; } catch { /* ignore */ }
const personalNames = new Set();
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function redact(s) {
  if (s == null) return s;
  let r = String(s);
  if (HOME) r = r.split(HOME).join('~').split(HOME.replace(/\\/g, '\\\\')).join('~');
  r = r.replace(/\/Users\/[^/\s"'`\\]+/g, '~')
    .replace(/\/home\/[^/\s"'`\\]+/g, '~')
    .replace(/[A-Za-z]:(\\\\|\\|\/)+Users(\\\\|\\|\/)+[^\\/\s"'`]+/gi, '~');
  if (USER && USER.length >= 3) r = r.replace(new RegExp(escRe(USER) + '[A-Za-z0-9_-]*', 'gi'), '<user>');
  r = r.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>');
  return r;
}
function redactNames(text) {
  let r = text;
  const names = [...personalNames].filter((n) => n.length >= 3).sort((a, b) => b.length - a.length);
  for (const n of names) r = r.replace(new RegExp(`\\b${escRe(n)}\\b`, 'g'), '<name>');
  return r;
}
function learnNames(text) {
  const vals = [];
  for (const m of text.matchAll(/\\?"(?:replyName|reviewer)\\?"\s*:\s*\\?"([^"\\]{2,60})\\?"/g)) vals.push(m[1]);
  for (const m of text.matchAll(/\\?"personalization\\?"\s*:\s*\{[^{}]{0,400}?\\?"displayName\\?"\s*:\s*\\?"([^"\\]{2,60})\\?"/g)) vals.push(m[1]);
  for (const raw of vals) {
    const v = raw.trim();
    if (!v || /^(null|unknown|human|agent|none)$/i.test(v)) continue;
    personalNames.add(v);
    for (const tok of v.split(/\s+/)) if (tok.length >= 3) personalNames.add(tok);
  }
}

// ---------------------------------------------------------------- helpers
const short = (s, n = 120) => (s == null ? '' : redact(String(s).replace(/\s+/g, ' ').trim()).slice(0, n));
const SKILL_RE = /(^|[\s"'`(])\/((?:sf|sflow)-[a-z0-9-]+)/i;
const SEED_PHASES = ['intake', 'requirements', 'design', 'implementation-spec', 'implementation', 'verification',
  'specification', 'planning', 'convergence', 'conformance', 'release', 'design-iterate', 'implement',
  'epic-requirements', 'discover-define', 'discovery', 'review', 'test', 'testing', 'refinement', 'analysis'];
const knownPhases = new Set(SEED_PHASES);
const EDIT_TOOLS = /^(edit|apply_patch|create|str_replace_editor|str_replace|write|write_file|edit_file|create_file|replace_string_in_file|insert_edit_into_file|multi_edit|edith)$/i;
const SFLOW_CMD_RE = /(^|[\s;&|("'`])(singularity-flow|sflow)(\.cmd|\.exe|\.ps1)?(['"]?)\s+[a-z]/i;
const isSflowCommand = (cmd) => typeof cmd === 'string' && SFLOW_CMD_RE.test(cmd);
function sflowSubcommands(cmd) {
  const out = [];
  for (const m of cmd.matchAll(/(?:^|[\s;&|("'`])(?:singularity-flow|sflow)(?:\.cmd|\.exe|\.ps1)?['"]?\s+((?:'[^']*'|"[^"]*"|[^\s|;&]+)(?:\s+(?:'[^']*'|"[^"]*"|[^\s|;&-][^\s|;&]*))?)/gi)) out.push(m[1].replace(/['"]/g, ''));
  return out;
}
function callSummary(name, args) {
  if (args == null) return name;
  if (typeof args === 'string') {
    const files = [...args.matchAll(/\*\*\* (?:Update|Add|Delete) File: ([^\n]+)/g)].map((m) => m[1].trim());
    return `${name} ${files.length ? files.join(', ') : args.slice(0, 80)}`;
  }
  if (args.command) return `${name}: ${args.command}`;
  if (args.path) return `${name} ${args.path}`;
  if (args.input && typeof args.input === 'string') return callSummary(name, args.input);
  return `${name} ${JSON.stringify(args).slice(0, 100)}`;
}
function editFiles(name, args) {
  if (args == null) return [];
  if (typeof args === 'string') return [...args.matchAll(/\*\*\* (?:Update|Add|Delete) File: ([^\n]+)/g)].map((m) => m[1].trim());
  if (typeof args.input === 'string') return editFiles(name, args.input);
  const p = args.path || args.filePath || args.file_path || args.file;
  return p ? [String(p)] : [];
}
function resultText(d) {
  let t = '';
  if (d.result) {
    if (typeof d.result === 'string') t += d.result;
    else if (typeof d.result.content === 'string') t += d.result.content;
    else if (d.result.content != null) t += JSON.stringify(d.result.content);
  }
  if (d.error) t += (t ? '\n' : '') + (typeof d.error === 'string' ? d.error : (d.error.message || JSON.stringify(d.error)));
  return t;
}
// Strip the Copilot shell trailer and postToolUse guidance so the CLI body remains.
function cliBody(text) {
  let b = text;
  const g = b.indexOf('\n\nTool "');
  if (g >= 0 && /Additional guidance from postToolUse hooks/.test(b.slice(g))) b = b.slice(0, g);
  b = b.replace(/\n?<shellId: [^>]*>\s*$/s, '');
  b = b.replace(/\n?<exited with exit code \d+>\s*$/s, '');
  return b.trim();
}
function tryParseJson(body) {
  const i = body.indexOf('{');
  const j = body.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(body.slice(i, j + 1)); } catch { return null; }
}
function findErrorCodes(obj, out = [], depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 8) return out;
  if (Array.isArray(obj)) { for (const v of obj) findErrorCodes(v, out, depth + 1); return out; }
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'error' && v && typeof v === 'object' && typeof v.code === 'string' && /^[A-Z][A-Z0-9_]{2,}$/.test(v.code)) out.push({ code: v.code, message: v.message || v.reason || '' });
    else if (v && typeof v === 'object') findErrorCodes(v, out, depth + 1);
  }
  return out;
}
function firstMatch(text, re) { const m = text.match(re); return m ? m[1] : null; }
function pct(arr, p) { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; }
function inc(map, key, n = 1) { const k = key == null || key === '' ? '(unknown)' : key; map[k] = (map[k] || 0) + n; }

/** The failure report for one folder of session logs (each session's `events.jsonl`). */
export function copilotFailureReport(dir, { details = false, maxExamples = 6 } = {}) {
  if (!fs.existsSync(dir)) throw new Error(`Copilot session folder not found: ${dir}`);
  personalNames.clear();
// ---------------------------------------------------------------- state
const sessions = [];
const turnsOut = [];
const occ = []; // signature occurrences
const hookDur = {}; // hookType -> durations
const workTypeByWorkId = {};
const allPhasesSeen = {}; // phase -> SFlow turns
let minTs = null, maxTs = null;
let filesScanned = 0, badLines = 0;
const windowsSessions = [];

function addOcc(o) { occ.push(o); return o; }

// ---------------------------------------------------------------- per-session scan
const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
for (const ent of entries) {
  const file = path.join(dir, ent.name, 'events.jsonl');
  if (!fs.existsSync(file)) continue;
  filesScanned++;
  const sid = ent.name;
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n');
  learnNames(raw.length < 60e6 ? raw : '');

  const sess = { id: sid, startTime: null, endTime: null, copilotVersion: null, turns: 0, sflowTurns: 0, events: 0, windows: [] };
  sessions.push(sess);
  const winHits = new Set();

  const calls = new Map(); // toolCallId -> {name,args,line,turn,seq}
  const hookStarts = new Map(); // hookInvocationId -> {type, ts, line, input}
  const ctx = { workId: null, phase: null, workType: null }; // running context
  let pendingSkill = null;
  let pendingTurnLines = [];
  let turn = null;
  let turnIdx = -1;
  let lastBash = null;

  const newTurn = (line, ts, content) => {
    finishTurn(turn);
    turnIdx++;
    const sm = typeof content === 'string' ? content.match(SKILL_RE) : null;
    let skill = sm ? sm[2].toLowerCase() : null;
    if (!skill && pendingSkill && /^(sf|sflow)-/.test(pendingSkill)) skill = pendingSkill;
    turn = {
      session: sid, index: turnIdx, line, ts, skill: skill || '(none)', prompt: short(content, 60),
      workId: null, phases: [], workType: null, firstWorkId: null, firstPhase: null,
      toolCalls: 0, sflowCommands: [], sflowTools: 0, seq: [], aborted: false, error: false,
      lastAssistant: '', boundaryContext: null, occ: [], sflow: !!skill, pausedReported: false,
    };
    pendingSkill = null;
    // userPromptSubmitted hooks that ran just before this user.message belong to it
    for (const p of pendingTurnLines) applyBoundary(p);
    pendingTurnLines = [];
    const d = deferred; deferred = [];
    for (const fn of d) fn();
  };
  let deferred = [];
  // true when a user.message follows shortly, before any assistant/tool activity
  const precedesUserMessage = (i) => {
    for (let k = i + 1; k < Math.min(lines.length, i + 20); k++) {
      const s = lines[k].slice(0, 60);
      if (s.startsWith('{"type":"user.message"')) return true;
      if (s.startsWith('{"type":"assistant.') || s.startsWith('{"type":"tool.')) return false;
    }
    return false;
  };
  const preambleTurn = () => { if (!turn) newTurn(0, null, ''); };

  function setCtx(field, val) {
    if (!val) return;
    ctx[field] = val;
    if (!turn) return;
    if (field === 'workId') { turn.workId = val; if (!turn.firstWorkId) turn.firstWorkId = val; }
    if (field === 'phase') { if (!turn.phases.includes(val)) turn.phases.push(val); if (!turn.firstPhase) turn.firstPhase = val; }
    if (field === 'workType') turn.workType = val;
  }
  function applyBoundary(text) {
    const m = text.match(/SFlow turn boundary \(([^)]+)\):\s*[a-z-]+ turn, (\S+) step ([a-z0-9-]+) generation/);
    if (m) { setCtx('workId', m[2]); setCtx('phase', m[3]); knownPhases.add(m[3]); }
    if (turn && /SFlow turn boundary/.test(text)) { turn.sflow = true; turn.boundaryContext = short(text, 160); }
  }
  function learnFromJson(text) {
    const wid = firstMatch(text, /"workId"\s*:\s*"([^"]{1,80})"/);
    const cur = firstMatch(text, /"currentPhase"\s*:\s*"([a-z][a-z0-9-]{1,40})"/);
    const ph = cur || firstMatch(text, /"phase"\s*:\s*\{\s*"id"\s*:\s*"([a-z][a-z0-9-]{1,40})"/) || firstMatch(text, /"phase"\s*:\s*"([a-z][a-z0-9-]{1,40})"/);
    const wt = firstMatch(text, /"workType"\s*:\s*"([^"]{1,80})"/);
    if (wid) setCtx('workId', wid);
    if (ph) { setCtx('phase', ph); knownPhases.add(ph); }
    if (wt) { setCtx('workType', wt); if (wid) workTypeByWorkId[wid] = wt; else if (ctx.workId) workTypeByWorkId[ctx.workId] = wt; }
  }
  function learnFromCommand(cmd) {
    const wid = firstMatch(cmd, /--work-id[= ]['"]?([A-Za-z0-9._-]+)/);
    const ph = firstMatch(cmd, /--phase[= ]['"]?([a-z][a-z0-9-]+)/);
    if (wid) setCtx('workId', wid);
    if (ph) setCtx('phase', ph);
    else {
      const m = cmd.match(/(?:singularity-flow|sflow)['"]?\s+(?:prepare|inputs|approve|reject|submit|phase\s+(?:enter|begin|show|prepublish|publish|draft-check|documents))\s+['"]?([a-z][a-z0-9-]+)/);
      if (m && knownPhases.has(m[1])) setCtx('phase', m[1]);
    }
  }
  function sigCtx(extra) {
    preambleTurn();
    const o = {
      session: sid.slice(0, 8), sessionId: sid, turn: turnIdx, skill: turn.skill,
      workId: ctx.workId, phase: ctx.phase, workType: ctx.workType, ...extra,
    };
    turn.occ.push(o);
    return addOcc(o);
  }

  function finishTurn(t) {
    if (!t) return;
    // back-fill context of occurrences from what the turn learned later
    for (const o of t.occ) {
      if (!o.workId) o.workId = t.firstWorkId || t.workId;
      if (!o.phase) o.phase = t.firstPhase || null;
      if (!o.workType) o.workType = t.workType;
    }
    if (t.sflowCommands.length || t.sflowTools) t.sflow = true;
    for (const o of t.occ) o.sflowTurn = t.sflow;
    // ---- signature 6: early-ending turns
    const cmds = t.sflowCommands.map((c) => c.sub);
    const pauseOnly = t.skill !== '(none)' && cmds.length > 0 && t.sflowTools === 0 &&
      cmds.every((c) => /^session current\b/.test(c) || /^pause status\b/.test(c));
    if (pauseOnly) {
      const which = cmds.every((c) => /^session current/.test(c)) ? 'session current' : cmds.every((c) => /^pause status/.test(c)) ? 'pause status' : 'session current + pause status';
      const o = {
        sig: 'early-end', kind: `pause-check-only (${which})`, session: sid.slice(0, 8), sessionId: sid, turn: t.index, line: t.line,
        ts: t.ts, skill: t.skill, workId: t.firstWorkId || t.workId, phase: t.firstPhase, workType: t.workType,
        aborted: t.aborted, pausedReported: t.pausedReported, toolCalls: t.toolCalls, sflowTurn: true,
        detail: short(t.lastAssistant, 140),
      };
      addOcc(o);
    }
    if (t.skill !== '(none)' && cmds.length === 0 && t.sflowTools === 0) {
      addOcc({
        sig: 'early-end', kind: 'skill-turn-without-sflow-command', error: t.error || null, session: sid.slice(0, 8), sessionId: sid, turn: t.index, line: t.line,
        ts: t.ts, skill: t.skill, workId: t.firstWorkId || t.workId, phase: t.firstPhase, workType: t.workType, sflowTurn: true,
        aborted: t.aborted, toolCalls: t.toolCalls, tools: [...new Set(t.seq.map((x) => x.name))].slice(0, 6), detail: short(t.lastAssistant, 140),
        reason: t.error ? `session/model error (${t.error})` : t.aborted ? 'aborted by user' : t.toolCalls === 0 ? 'no tool calls (answered from context)' : (t.skillNotFound && t.seq.every((x) => x.name === 'skill')) ? 'only failed skill-tool loads (Skill not found)' : 'used non-SFlow tools only',
      });
    }
    const last = t.seq[t.seq.length - 1];
    if (last && last.refusal) {
      addOcc({
        sig: 'early-end', kind: 'ended-after-refusal', code: last.refusal, session: sid.slice(0, 8), sessionId: sid, turn: t.index,
        line: last.line, ts: last.ts, skill: t.skill, workId: t.firstWorkId || t.workId, phase: last.phase || t.firstPhase,
        workType: t.workType, aborted: t.aborted, call: short(last.summary, 120), detail: short(t.lastAssistant, 140), sflowTurn: t.sflow,
      });
    }
    // ---- signature 4: edit failure chains
    const byFile = new Map();
    for (const s of t.seq) {
      if (!s.edit) continue;
      for (const f of (s.files.length ? s.files : ['(no path)'])) {
        if (!byFile.has(f)) byFile.set(f, []);
        byFile.get(f).push(s);
      }
    }
    for (const [f, chain] of byFile) {
      const firstFail = chain.findIndex((s) => !s.success);
      if (firstFail < 0) continue;
      const after = chain.slice(firstFail);
      const okIdx = after.findIndex((s) => s.success);
      const fails = chain.filter((s) => !s.success);
      addOcc({
        sig: 'edit-chain', session: sid.slice(0, 8), sessionId: sid, turn: t.index, line: chain[firstFail].line, skill: t.skill,
        workId: t.firstWorkId || t.workId, phase: chain[firstFail].phase || t.firstPhase, workType: t.workType,
        sflowTurn: t.sflow, file: short(f, 140), failures: fails.length, categories: [...new Set(fails.map((s) => s.category))],
        recovered: okIdx >= 0, attemptsToSuccess: okIdx >= 0 ? okIdx + 1 : null, tools: [...new Set(chain.map((s) => s.name))],
      });
    }
    for (const p of t.phases) if (t.sflow) allPhasesSeen[p] = (allPhasesSeen[p] || 0) + 1;
    if (t.workId && !t.workType && workTypeByWorkId[t.workId]) t.workType = workTypeByWorkId[t.workId];
    turnsOut.push({
      session: sid.slice(0, 8), index: t.index, line: t.line, ts: t.ts, skill: t.skill, sflow: t.sflow,
      workId: t.firstWorkId || t.workId, phases: t.phases, workType: t.workType, toolCalls: t.toolCalls,
      sflowCommands: t.sflowCommands.map((c) => c.sub), sflowTools: t.sflowTools, aborted: t.aborted,
      signatures: t.occ.map((o) => o.sig + (o.code ? `:${o.code}` : '')),
    });
    sess.turns++;
    if (t.sflow) sess.sflowTurns++;
  }

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    let e;
    try { e = JSON.parse(l); } catch { badLines++; continue; }
    const line = i + 1;
    const d = e.data || {};
    const ts = e.timestamp || null;
    sess.events++;
    if (ts) {
      if (!sess.startTime || ts < sess.startTime) sess.startTime = ts;
      if (!sess.endTime || ts > sess.endTime) sess.endTime = ts;
      if (!minTs || ts < minTs) minTs = ts;
      if (!maxTs || ts > maxTs) maxTs = ts;
    }
    // ---- Windows indicators (strong signals only from structured fields)
    if (e.type === 'session.start') {
      sess.copilotVersion = d.copilotVersion || null;
      const cwd = d.context?.cwd || '';
      if (/^[A-Za-z]:[\\/]/.test(cwd) || /\\/.test(cwd)) winHits.add('session.start cwd is a Windows path');
    }
    if (e.type === 'hook.start' && typeof d.input?.cwd === 'string' && /^[A-Za-z]:[\\/]/.test(d.input.cwd)) winHits.add('hook cwd is a Windows path');

    switch (e.type) {
      case 'skill.invoked':
        if (precedesUserMessage(i)) pendingSkill = d.name || pendingSkill;
        break;
      case 'user.message': {
        newTurn(line, ts, d.content || '');
        break;
      }
      case 'abort': preambleTurn(); turn.aborted = true; break;
      case 'session.error': preambleTurn(); turn.error = d.errorType || 'error'; break;
      case 'model.turn_failed': preambleTurn(); turn.error = turn.error || 'model-turn-failed'; break;
      case 'assistant.message':
        preambleTurn();
        if (typeof d.content === 'string' && d.content.trim()) turn.lastAssistant = d.content;
        break;
      case 'tool.execution_start': {
        preambleTurn();
        const name = d.toolName || '?';
        const args = d.arguments;
        const c = { name, args, line, ts, turn: turnIdx, summary: callSummary(name, args), phase: ctx.phase };
        calls.set(d.toolCallId, c);
        turn.toolCalls++;
        if (/^(powershell|pwsh)$/i.test(name)) winHits.add('powershell tool used');
        const cmd = args && typeof args === 'object' ? args.command : null;
        if (typeof cmd === 'string') {
          if (/^\s*(powershell|pwsh)(\.exe)?\b/i.test(cmd)) winHits.add('powershell command');
          if (/(^|[\s"'])[A-Za-z]:\\[A-Za-z]/.test(cmd)) winHits.add('drive-letter path in command');
          if (isSflowCommand(cmd)) {
            for (const sub of sflowSubcommands(cmd)) turn.sflowCommands.push({ sub, line });
            learnFromCommand(cmd);
          }
          if (name === 'bash' || name === 'powershell') lastBash = cmd;
        }
        if (/^sflow/i.test(name)) turn.sflowTools++;
        const p = args && typeof args === 'object' ? args.path : null;
        if (typeof p === 'string' && /^[A-Za-z]:\\/.test(p)) winHits.add('drive-letter path in tool args');
        break;
      }
      case 'tool.execution_complete': {
        preambleTurn();
        const c = calls.get(d.toolCallId) || { name: '?', args: null, line, summary: '?' };
        const text = resultText(d);
        const name = c.name;
        const cmd = c.args && typeof c.args === 'object' ? c.args.command : null;
        const isSflow = isSflowCommand(cmd) || /^sflow/i.test(name);
        const step = { name, line, ts, success: d.success !== false, summary: c.summary, phase: ctx.phase, refusal: null, edit: false, files: [], category: null };
        if (isSflow || /SFlow|singularity-flow|PHASE_MUTATION_/.test(text.slice(0, 4000))) learnNames(text);
        if (isSflow) {
          learnFromJson(text);
          if (/"paused"\s*:\s*true/.test(text)) turn.pausedReported = true;
        }
        // ---- signature 1 (tool-result side): PHASE_MUTATION codes that did not come from a hook
        const denied = /Denied by preToolUse hook/.test(text);
        const gIdx = text.indexOf('Additional guidance from postToolUse hooks');
        const bodyForCodes = gIdx >= 0 ? text.slice(0, gIdx) : text;
        if (denied) step.refusal = firstMatch(text, /(PHASE_MUTATION_[A-Z_]+)/) || 'PRETOOL_DENIED';
        else {
          const codes = [...new Set([...bodyForCodes.matchAll(/PHASE_MUTATION_[A-Z_]+/g)].map((m) => m[0]))];
          if (codes.length && isSflow) {
            for (const code of codes) sigCtx({ sig: 'guard', code, source: 'cli-output', line, ts, tool: name, call: short(c.summary) });
          }
        }
        if (gIdx >= 0) { const gc = firstMatch(text.slice(gIdx), /(PHASE_MUTATION_[A-Z_]+)/); if (gc && /Stop this SFlow/.test(text.slice(gIdx))) step.refusal = step.refusal || gc; }
        // ---- signature 7: refusal codes in CLI JSON
        if (isSflow) {
          const body = cliBody(text);
          const parsed = tryParseJson(body);
          let codes = parsed ? findErrorCodes(parsed) : [];
          if (!parsed) {
            codes = [...body.matchAll(/"error"\s*:\s*\{[^{}]*?"code"\s*:\s*"([A-Z][A-Z0-9_]{2,})"(?:[^{}]*?"message"\s*:\s*"([^"]{0,200}))?/g)].map((m) => ({ code: m[1], message: m[2] || '' }));
          }
          const seen = new Set();
          for (const r of codes) {
            if (seen.has(r.code)) continue; seen.add(r.code);
            sigCtx({ sig: 'refusal', code: r.code, line, ts, tool: name, call: short(c.summary), detail: short(r.message, 160) });
            step.refusal = step.refusal || r.code;
          }
          if (!step.refusal && d.success === false) step.refusal = 'SFLOW_COMMAND_FAILED';
          // ---- signature 5b: cut-off / invalid JSON from SFlow commands
          if (body.startsWith('{')) {
            let ok = true;
            try { JSON.parse(body); } catch { ok = false; }
            if (!ok && !parsed) {
              const composed = typeof cmd === 'string' && /\|\s*(head|tail|python3?|jq|sed|awk|grep|cut|less|more)\b|&&|;|\|\|/.test(cmd);
              sigCtx({ sig: 'json', code: (body.trimEnd().endsWith('}') ? 'INVALID_JSON_BODY' : 'CUT_OFF_JSON') + (composed ? ' (model-composed pipe/chain)' : ' (plain SFlow command)'), line, ts, tool: name, call: short(c.summary), detail: `${body.length} chars; tail: ${short(body.slice(-80), 80)}` });
            }
          }
          if (/"agentOutput"\s*:\s*\{\s*(?:"complete"\s*:\s*false|"view"\s*:\s*"(?:bounded|preview|detail-unavailable)")/.test(body)) sigCtx({ sig: 'json', code: 'SFLOW_BOUNDED_RESULT', line, ts, tool: name, call: short(c.summary), info: true });
        }
        // ---- signature 5: JSON / size problems in any tool result
        const sourceView = /^(view|read_file|grep|rg|glob|grep_search|file_search)$/i.test(name);
        if (!sourceView) {
          const jm = text.match(/Unexpected end of JSON input|Unterminated string in JSON[^\n]*|Unterminated string[^\n]{0,60}|[^\n]{0,60}is not valid JSON[^\n]{0,40}|SyntaxError:[^\n]{0,120}JSON[^\n]{0,60}|JSON\.parse[:(][^\n]{0,80}(?:error|unexpected|position)[^\n]{0,40}|Unexpected token[^\n]{0,40}in JSON[^\n]{0,40}|in JSON at position \d+/i);
          if (jm) sigCtx({ sig: 'json', code: 'JSON_PARSE_ERROR', line, ts, tool: name, call: short(c.summary), detail: short(jm[0], 160) });
          else {
            const sm = text.match(/SyntaxError[^\n]{0,140}/);
            if (sm) sigCtx({ sig: 'json', code: 'SYNTAX_ERROR_OTHER', line, ts, tool: name, call: short(c.summary), detail: short(sm[0], 160) });
          }
        }
        if (/\[Output truncated\./.test(text)) sigCtx({ sig: 'json', code: 'OUTPUT_TRUNCATED', line, ts, tool: name, call: short(c.summary) });
        if (/File too large to read at once/.test(text)) sigCtx({ sig: 'json', code: 'FILE_TOO_LARGE', line, ts, tool: name, call: short(c.summary), detail: short(firstMatch(text, /File too large to read at once \(([^)]+)\)/), 20) });
        const savedMsg = firstMatch(text, /Output too large to read at once[^\n]*?Saved to:\s*(\S+)/);
        const savedTel = d.toolTelemetry?.restrictedProperties?.large_output_file || null;
        if (!savedMsg && savedTel) sigCtx({ sig: 'json', code: 'LARGE_OUTPUT_FILE_TELEMETRY_ONLY', line, ts, tool: name, call: short(c.summary), info: true, sflowCommand: isSflow });
        const saved = savedMsg;
        if (saved) {
          const tmp = /copilot-tool-output|[\\/](T|tmp|Temp)[\\/]/i.test(saved);
          sigCtx({ sig: 'json', code: 'LARGE_OUTPUT_SAVED_TO_TEMP', line, ts, tool: name, call: short(c.summary), detail: `${tmp ? 'temp file outside workspace' : 'file'}; ${short(firstMatch(text, /Output too large to read at once \(([^)]+)\)/) || '', 20)}`, sflowCommand: isSflow });
        }
        if (name === 'skill' && d.success === false && /Skill not found/i.test(text)) {
          turn.skillNotFound = (turn.skillNotFound || 0) + 1;
          sigCtx({ sig: 'skill-not-found', code: String(c.args?.skill || '?'), line, ts, tool: name, call: short(c.summary) });
        }
        // ---- signature 4: edit failures
        if (EDIT_TOOLS.test(name)) {
          step.edit = true;
          step.files = editFiles(name, c.args);
          if (!step.success) {
            const msg = text;
            step.category =
              /Failed to find expected lines/.test(msg) ? 'Failed to find expected lines' :
              /No match found/.test(msg) ? 'No match found (old_str)' :
              /Multiple matches/.test(msg) ? 'Multiple matches' :
              /Denied by preToolUse hook/.test(msg) ? 'Denied by preToolUse hook' :
              /ENOENT/.test(msg) ? 'ENOENT (file missing)' :
              /EISDIR/.test(msg) ? 'EISDIR' :
              /already exists/i.test(msg) ? 'Path already exists' :
              /Parent directory does not exist/.test(msg) ? 'Parent directory missing' :
              /Permission denied/.test(msg) ? 'Permission denied' :
              /rejected/i.test(msg) ? 'User rejected' :
              /Required|Invalid inputs|is required/.test(msg) ? 'Invalid tool inputs' : 'Other';
            sigCtx({ sig: 'edit-fail', code: step.category, line, ts, tool: name, call: short(c.summary), file: short(step.files.join(', '), 140), detail: short(msg, 160) });
          }
        }
        turn.seq.push(step);
        break;
      }
      case 'hook.start':
        hookStarts.set(d.hookInvocationId, { type: d.hookType, ts, line, input: d.input || {} });
        if (/^userPrompt/.test(d.hookType) && !turn) { /* preamble prompt hook */ }
        break;
      case 'hook.end': {
        const hs = hookStarts.get(d.hookInvocationId);
        const type = d.hookType || hs?.type || '?';
        const input = hs?.input || {};
        const dur = hs && hs.ts && ts ? Date.parse(ts) - Date.parse(hs.ts) : null;
        let nCalls = 0, tools = [], callIds = [];
        if (Array.isArray(input.toolCalls)) { nCalls = input.toolCalls.length; tools = input.toolCalls.map((t) => t.name); callIds = input.toolCalls.map((t) => t.id); }
        else if (input.toolName) { nCalls = 1; tools = [input.toolName]; }
        if (dur != null) (hookDur[type] ||= []).push(dur);
        const outStr = d.output == null ? '' : typeof d.output === 'string' ? d.output : JSON.stringify(d.output);
        // prompt hooks normally run just before their user.message: attach them to the coming turn
        const forNextTurn = /^(userPrompt|sessionStart)/.test(type) && precedesUserMessage(i);
        if (/^userPrompt/.test(type) && /SFlow turn boundary/.test(outStr)) {
          const ac = d.output?.additionalContext || outStr;
          if (forNextTurn) pendingTurnLines.push(ac); else applyBoundary(ac);
        }
        const ctxLine = { line, ts, hookType: type, durationMs: dur, nCalls, tools };
        const record = (extra) => {
          if (forNextTurn) { deferred.push(() => sigCtx({ ...ctxLine, ...extra })); return null; }
          return sigCtx({ ...ctxLine, ...extra });
        };
        // ---- signature 2: hook timeouts
        const errMsg = d.error ? (d.error.message || JSON.stringify(d.error)) : '';
        if (/HookTimeoutError/.test(errMsg + outStr)) {
          const callDesc = Array.isArray(input.toolCalls) ? input.toolCalls.map((t) => short(callSummary(t.name, t.args), 120)) : input.toolName ? [short(callSummary(input.toolName, input.toolArgs), 120)] : [];
          record({ sig: 'hook-timeout', code: type, detail: short(errMsg, 100), calls: callDesc });
        }
        // other hook errors (spawn ENOENT, command not found)
        if (d.success === false && !/HookTimeoutError/.test(errMsg)) record({ sig: 'hook-error', code: short(errMsg.split('\n')[0], 70), source: type });
        // ---- signature 3: slow hooks
        if (dur != null && dur > 5000) record({ sig: 'slow-hook', code: type, success: d.success !== false });
        // ---- signature 1: guard stops / denials from hooks
        if (d.output && typeof d.output === 'object') {
          if (type === 'preToolUse') {
            for (const [cid, msg] of Object.entries(d.output)) {
              if (typeof msg !== 'string' || !/Denied/.test(msg)) continue;
              const tc = Array.isArray(input.toolCalls) ? input.toolCalls.find((t) => t.id === cid) : null;
              const cc = calls.get(cid);
              const summary = tc ? callSummary(tc.name, tc.args) : cc ? cc.summary : cid;
              const code = firstMatch(msg, /(PHASE_MUTATION_[A-Z_]+)/) || (/hook errored/.test(msg) ? 'HOOK_ERRORED_DENIAL' : 'OTHER_DENIAL: ' + short(msg.replace(/^Denied by preToolUse hook:\s*/, '').replace(/'[^']*'/g, "'X'").replace(/`[^`]*`/g, '`X`'), 60));
              record({ sig: 'guard', code, source: 'preToolUse', tool: tc?.name || cc?.name, call: short(summary), prevBash: short(lastBash), detail: short(msg.replace(/^Denied by preToolUse hook:\s*/, ''), 160) });
            }
          } else {
            const codes = [...new Set([...outStr.matchAll(/PHASE_MUTATION_[A-Z_]+/g)].map((m) => m[0]))];
            for (const code of codes) {
              const summary = input.toolName ? callSummary(input.toolName, input.toolArgs) : '';
              record({ sig: 'guard', code, source: type, tool: input.toolName, call: short(summary), prevBash: short(lastBash), detail: short(d.output.additionalContext || outStr, 160) });
            }
          }
        }
        break;
      }
      default: break;
    }
  }
  finishTurn(turn);
  sess.windows = [...winHits];
  if (winHits.size) windowsSessions.push({ session: sid.slice(0, 8), indicators: sess.windows });
}

// back-fill workType from the Story map
for (const o of occ) if (!o.workType && o.workId && workTypeByWorkId[o.workId]) o.workType = workTypeByWorkId[o.workId];
for (const t of turnsOut) if (!t.workType && t.workId && workTypeByWorkId[t.workId]) t.workType = workTypeByWorkId[t.workId];

// ---------------------------------------------------------------- aggregation
function aggregate(list) {
  const g = { count: list.length, inSflowTurns: list.filter((o) => o.sflowTurn).length, sessions: new Set(list.map((o) => o.sessionId)).size, bySkill: {}, byPhase: {}, byWorkType: {}, byCall: {}, byMonth: {}, byReason: {} };
  for (const o of list) { inc(g.bySkill, o.skill); inc(g.byPhase, o.phase); inc(g.byWorkType, o.workType); if (o.call) inc(g.byCall, String(o.call).slice(0, 70)); if (o.ts) inc(g.byMonth, o.ts.slice(0, 7)); if (o.reason) inc(g.byReason, o.reason); }
  for (const k of ['bySkill', 'byPhase', 'byWorkType', 'byCall', 'byReason']) g[k] = Object.fromEntries(Object.entries(g[k]).sort((a, b) => b[1] - a[1]).slice(0, k === 'byCall' ? 12 : 1000));
  g.byMonth = Object.fromEntries(Object.entries(g.byMonth).sort());
  if (!Object.keys(g.byReason).length) delete g.byReason;
  return g;
}
function pickExamples(list) {
  const out = []; const seenS = new Set();
  for (const o of list) { if (out.length >= maxExamples) break; if (seenS.has(o.sessionId) && list.length > maxExamples) continue; seenS.add(o.sessionId); out.push(o); }
  for (const o of list) { if (out.length >= maxExamples) break; if (!out.includes(o)) out.push(o); }
  return out.map(({ sessionId, ...rest }) => rest);
}
const SIGS = {
  'guard': '1. Guard stops/denials (PHASE_MUTATION_* and other preToolUse denials)',
  'hook-timeout': '2. Hook timeouts (HookTimeoutError)',
  'slow-hook': '3. Slow hooks (> 5 s)',
  'edit-fail': '4. Edit/apply_patch/create failures (individual)',
  'edit-chain': '4b. Edit failure chains per file per turn (recovery)',
  'json': '5. JSON / truncation / large-output problems',
  'early-end': '6. Early-ending turns',
  'refusal': '7. SFlow CLI refusal codes (error.code)',
  'hook-error': 'Extra: hook command errors (non-timeout)',
  'skill-not-found': 'Extra: skill tool "Skill not found" (model re-loading an already-injected SFlow skill)',
};
const signatures = {};
for (const [sig, title] of Object.entries(SIGS)) {
  const list = occ.filter((o) => o.sig === sig);
  const byCode = {};
  for (const o of list) {
    const key = sig === 'early-end' ? (o.kind === 'ended-after-refusal' ? `ended-after-refusal:${o.code}` : o.kind) : sig === 'guard' ? `${o.code} [${o.source}]` : o.code;
    (byCode[key] ||= []).push(o);
  }
  const codes = Object.entries(byCode).sort((a, b) => b[1].length - a[1].length).map(([code, l]) => ({ code, ...aggregate(l), examples: pickExamples(l) }));
  const s = { title, ...aggregate(list), codes };
  if (sig === 'edit-chain') {
    s.recovered = list.filter((o) => o.recovered).length;
    s.unrecovered = list.filter((o) => !o.recovered).length;
    const att = list.filter((o) => o.recovered).map((o) => o.attemptsToSuccess);
    s.attemptsToSuccess = { p50: pct(att, 50), p90: pct(att, 90), max: att.length ? Math.max(...att) : null, histogram: att.reduce((h, a) => (h[a] = (h[a] || 0) + 1, h), {}) };
    for (const c of s.codes) delete c.examples;
    s.examples = pickExamples(list);
    s.byCategory = {};
    for (const o of list) for (const cat of o.categories) inc(s.byCategory, cat);
  }
  if (sig === 'slow-hook' || sig === 'hook-timeout') {
    const d = list.map((o) => o.durationMs);
    s.durationMs = { p50: pct(d, 50), p90: pct(d, 90), max: d.length ? Math.max(...d) : null };
    s.byCalls = {}; for (const o of list) inc(s.byCalls, String(o.nCalls));
    s.byTool = {}; for (const o of list) for (const t of new Set(o.tools)) inc(s.byTool, t);
    for (const c of s.codes) { const dd = byCode[c.code].map((o) => o.durationMs); c.durationMs = { p50: pct(dd, 50), p90: pct(dd, 90), max: Math.max(...dd) }; }
  }
  signatures[sig] = s;
}
// phase coverage: which signatures appear in every phase that had SFlow turns
const MAIN_PHASES = ['intake', 'requirements', 'design', 'implementation-spec', 'specification', 'planning', 'implementation', 'verification', 'convergence', 'release', 'conformance'];
const phaseUniverse = MAIN_PHASES.filter((p) => (allPhasesSeen[p] || 0) >= 3);
const phaseCoverage = {};
for (const [sig, s] of Object.entries(signatures)) {
  const phases = Object.keys(s.byPhase).filter((p) => p !== '(unknown)');
  phaseCoverage[sig] = { phasesWith: phases, phasesWithout: phaseUniverse.filter((p) => !phases.includes(p)), everyPhase: phaseUniverse.every((p) => phases.includes(p)), codes: {} };
  for (const c of s.codes) {
    if (c.count < 5) continue;
    const cp = Object.keys(c.byPhase);
    phaseCoverage[sig].codes[c.code] = { mainPhasesWith: phaseUniverse.filter((p) => cp.includes(p)).length, of: phaseUniverse.length, missing: phaseUniverse.filter((p) => !cp.includes(p)) };
  }
}
const hookDurations = Object.fromEntries(Object.entries(hookDur).map(([k, v]) => [k, { n: v.length, p50: pct(v, 50), p90: pct(v, 90), p99: pct(v, 99), max: Math.max(...v), over5s: v.filter((x) => x > 5000).length, over10s: v.filter((x) => x > 10000).length }]));

const sflowTurns = turnsOut.filter((t) => t.sflow);
const skillTurns = {}; for (const t of sflowTurns) inc(skillTurns, t.skill);
const phaseTurns = {}; for (const t of sflowTurns) for (const p of (t.phases.length ? t.phases : ['(unknown)'])) inc(phaseTurns, p);
const workTypeTurns = {}; for (const t of sflowTurns) inc(workTypeTurns, t.workType);

const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  scanned: {
    sessionDirs: entries.length, sessionsWithEvents: filesScanned, sessionsWithSflow: sessions.filter((s) => s.sflowTurns > 0).length,
    turns: turnsOut.length, sflowTurns: sflowTurns.length, badLines, dateRange: { from: minTs, to: maxTs },
  },
  windows: { sessionsWithIndicators: windowsSessions.length, sessions: windowsSessions },
  turnsBySkill: Object.fromEntries(Object.entries(skillTurns).sort((a, b) => b[1] - a[1])),
  turnsByPhase: Object.fromEntries(Object.entries(phaseTurns).sort((a, b) => b[1] - a[1])),
  turnsByWorkType: Object.fromEntries(Object.entries(workTypeTurns).sort((a, b) => b[1] - a[1])),
  hookDurations,
  signatures,
  phaseCoverage,
  occurrences: occ.map(({ sessionId, ...o }) => o),
  sessions: sessions.map((s) => ({ ...s, id: s.id.slice(0, 8) })),
  turns: turnsOut,
};
  const report = JSON.parse(redactNames(redact(JSON.stringify(result))));
  return details ? report : contentFree(report);
}

// Fields that carry text from a session (commands, messages, paths): kept only with `details`.
const CONTENT_FIELDS = new Set(['call', 'detail', 'prompt', 'prevBash', 'file', 'calls', 'boundaryContext']);

function contentFree(report) {
  const strip = (value) => Array.isArray(value) ? value.map(strip)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
      .filter(([key]) => !CONTENT_FIELDS.has(key) && key !== 'byCall').map(([key, item]) => [key, strip(item)]))
      : value;
  const { occurrences, turns, ...rest } = report;
  return { ...strip(rest), details: false };
}

/** The report as a short plain-text summary, one line per signature and its leading codes. */
export function copilotFailureSummary(report) {
  const lines = [`sessions: dirs=${report.scanned.sessionDirs} withEvents=${report.scanned.sessionsWithEvents} withSflow=${report.scanned.sessionsWithSflow}; `
    + `turns=${report.scanned.turns} sflowTurns=${report.scanned.sflowTurns}; ${report.scanned.dateRange.from} .. ${report.scanned.dateRange.to}`,
  `windows sessions: ${report.windows.sessionsWithIndicators}`];
  for (const signature of Object.values(report.signatures)) {
    lines.push('', `## ${signature.title}: count=${signature.count} inSflowTurns=${signature.inSflowTurns} sessions=${signature.sessions}`);
    for (const entry of signature.codes.slice(0, 16)) {
      lines.push(`  ${entry.count}/${entry.inSflowTurns}\t${entry.code}\tskills=${JSON.stringify(entry.bySkill).slice(0, 160)}\tphases=${JSON.stringify(entry.byPhase).slice(0, 160)}`);
    }
  }
  return lines;
}
