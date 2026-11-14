/**
 * Deterministic local-command classifier for `action_authorization`.
 *
 * No network and no filesystem. A bare name is whatever the host PATH
 * resolves. Aliases, shell functions, PATH entries, and symlinks are not
 * visible here; they need a host contract. An explicit program path
 * (`./x`, `../x`, `/path/x`, `~/x`, or the same after `env` / `xargs` /
 * another wrapper) does not inherit a class from its filename. A leading
 * `NAME=value`, `env` with an option or assignment, `sh -c` / `bash -c`
 * (including `-lc`, `-ec`, and `--norc -c`), and a wrapper (`command`,
 * `builtin`, `exec`, `nohup`, `nice`, `time`, `timeout`, `stdbuf`,
 * `ionice`) are closed in v1: UNCERTAIN, not the inner command. A hard
 * BLOCK on any stage still wins. The body
 * of a script (`./run.sh`, a Makefile target, `npm test` via package.json)
 * is not visible either. `read_only` means "no direct write was
 * classified". It does not mean the command is safe.
 *
 * Chains, pipes, substitutions, and redirects are split. The reported
 * class is the strictest one. Authorization is per sub-command: a grant
 * for one part never opens a stricter part of the same chain. BLOCK wins
 * over UNCERTAIN, and UNCERTAIN wins over open. Anything the parser cannot
 * fully account for (a comment boundary it is unsure of, an unknown
 * option, a substitution, an unbound path) is UNCERTAIN or BLOCK, never
 * a read that the panel may ALLOW.
 */

export const COMMAND_CLASSES = [
  'read_only',
  'local_write_scoped',
  'network_fetch',
  'unparseable',
  'destructive_local',
  'remote_write',
  'network_exec',
  'privilege',
] as const;

export type CommandClass = (typeof COMMAND_CLASSES)[number];

/** Higher rank is stricter. The winning class is the one that gates. */
const CLASS_RANK: Record<CommandClass, number> = {
  read_only: 0,
  local_write_scoped: 1,
  network_fetch: 2,
  unparseable: 3,
  destructive_local: 4,
  remote_write: 5,
  network_exec: 6,
  privilege: 7,
};

export function strictestCommandClass(classes: CommandClass[]): CommandClass {
  let best: CommandClass = 'read_only';
  for (const cls of classes) {
    if (CLASS_RANK[cls] > CLASS_RANK[best]) best = cls;
  }
  return best;
}

export function isHardCommandClass(cls: CommandClass | null | undefined): boolean {
  return (
    cls === 'destructive_local' ||
    cls === 'remote_write' ||
    cls === 'network_exec' ||
    cls === 'privilege'
  );
}

export const LOCAL_COMMAND_BLOCK_REASON =
  'Deterministic local-command block: command class is destructive_local, remote_write, network_exec, or privilege. Public ALLOW is forbidden. A local-work mandate does not authorize destruction, force-push, fetch-and-execute, or privilege. read_only is not a claim that the command is safe.';

export const LOCAL_COMMAND_UNCERTAIN_REASON =
  'Deterministic local-command abstention: the command is unparseable, obfuscated, a download without execution, or a filesystem write without granted.workspace. No public ALLOW.';

const NEGATION_BEFORE_RE =
  /(?:\bno\b|\bnot\b|\bnever\b|\bwithout\b|\bdon'?t\b|\bdo\s+not\b|\bkein(?:e|en|em|er)?\b|\bnicht\b|\bohne\b|\bniemals\b)\s+(?:\w+\s+){0,4}$/i;

/**
 * Prose confirmation that the mandate is local work in a repository.
 * A negated mention ("do not work locally") does not count.
 */
const LOCAL_REPO_RE =
  /\b(?:work(?:ing)?\s+locally|locally\s+in\s+(?:this\s+)?(?:git\s+)?repo(?:sitory)?|in\s+the\s+local\s+(?:git\s+)?repo(?:sitory)?|local\s+(?:git\s+)?repo(?:sitory)?|lokal(?:e[mnr]?)?(?:\s+\w+){0,3}\s+repo(?:sitory)?|in\s+diesem\s+repo(?:sitory)?)\b/gi;

export function mandateAuthorizesLocalRepo(text: string | null | undefined): boolean {
  if (!text) return false;
  const re = new RegExp(LOCAL_REPO_RE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const before = text.slice(Math.max(0, m.index - 48), m.index);
    if (NEGATION_BEFORE_RE.test(before)) continue;
    return true;
  }
  return false;
}

const KNOWN_COMMANDS = new Set([
  'git',
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'npx',
  'pnpx',
  'pip',
  'pip3',
  'pipx',
  'uvx',
  'python',
  'python3',
  'pytest',
  'node',
  'cargo',
  'go',
  'vitest',
  'tsc',
  'rg',
  'grep',
  'egrep',
  'fgrep',
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'pwd',
  'echo',
  'printf',
  'rm',
  'rmdir',
  'mv',
  'cp',
  'mkdir',
  'touch',
  'tee',
  'find',
  'dd',
  'mkfs',
  'truncate',
  'shred',
  'chmod',
  'chown',
  'sudo',
  'su',
  'doas',
  'pkexec',
  'bash',
  'sh',
  'zsh',
  'dash',
  'fish',
  'ksh',
  'curl',
  'wget',
  'base64',
  'eval',
  'printenv',
  'env',
  'export',
  'gh',
  'docker',
  'kubectl',
  'terraform',
  'vercel',
  'wrangler',
  'fly',
  'flyctl',
  'heroku',
  'apt',
  'apt-get',
  'yum',
  'dnf',
  'pacman',
  'apk',
  'make',
  'command',
  'nohup',
  'nice',
  'time',
  'exec',
  'builtin',
  'timeout',
  'stdbuf',
  'ionice',
  'xargs',
  'true',
  'false',
  'which',
  'file',
  'stat',
  'sort',
  'less',
  'more',
]);

/**
 * Not stripped and not implemented in v1. The inner command is still
 * inspected so a hard BLOCK is not lost; the form itself cannot open.
 */
const CLOSED_WRAPPERS = new Set([
  'command',
  'builtin',
  'exec',
  'nohup',
  'nice',
  'time',
  'timeout',
  'stdbuf',
  'ionice',
]);
const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'fish']);
const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'python', 'python3', 'perl', 'ruby', 'node', 'php']);
const READ_BINARIES = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'pwd',
  'echo',
  'printf',
  'rg',
  'grep',
  'egrep',
  'fgrep',
  'which',
  'file',
  'stat',
  'true',
  'false',
  'sort',
  'less',
  'more',
]);

export interface LocalCommandPart {
  commandClass: CommandClass;
  text: string;
  filesystemWrite: boolean;
  forceRemote: boolean;
  /** Paths this part reads or writes. Empty when the part has no path operand. */
  paths: string[];
  /** `git -C`, `--git-dir`, and `--work-tree` values. */
  scopeRoots: string[];
  /**
   * Leading assignment, `env` option/assignment, shell `-c`, or wrapper.
   * Cannot open. A BLOCK from the class still wins.
   */
  closedForm?: boolean;
}

export interface LocalCommandAnalysis {
  /** The action payload is a shell command, not prose that mentions one. */
  recognized: boolean;
  commandClass: CommandClass | null;
  commandText: string | null;
  /**
   * True for rm/mv/cp/mkdir/touch/tee and similar filesystem mutations.
   * Git index writes (commit, checkout -b) stay false: a local-repo
   * mandate can open those. Filesystem deletes need granted.workspace.
   */
  filesystemWrite: boolean;
  forceRemote: boolean;
  obfuscated: boolean;
  parts: LocalCommandPart[];
}

const UNRECOGNIZED: LocalCommandAnalysis = {
  recognized: false,
  commandClass: null,
  commandText: null,
  filesystemWrite: false,
  forceRemote: false,
  obfuscated: false,
  parts: [],
};

interface Word {
  text: string;
  substitutions: string[];
  tainted: boolean;
  /** Unquoted glob, `~`, or other shell expansion. A quoted literal is not expandable. */
  expandable: boolean;
}

interface Redirect {
  op: string;
  target: Word | null;
  heredoc: boolean;
}

interface Stage {
  words: Word[];
  redirects: Redirect[];
  raw: string;
}

interface Statement {
  stages: Stage[];
}

export type LocalCommandEffect = 'open' | 'block' | 'uncertain';

export interface LocalCommandEffectInput {
  analysis: LocalCommandAnalysis;
  mandateText?: string | null;
  mandateKind?: string | null;
  workspace?: string | null;
  allowRemoteWrite?: boolean | null;
  allowNetwork?: boolean | null;
  cwd?: string | null;
}

function basenameCommand(token: string): string {
  const slash = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'));
  return slash >= 0 ? token.slice(slash + 1) : token;
}

/**
 * A path is a specific file, not a PATH lookup. `./git` is not `git`.
 * Bare names stay on the host PATH contract documented at the top of this file.
 */
function isUnverifiedProgramPath(token: string): boolean {
  return (
    token.startsWith('./') ||
    token.startsWith('../') ||
    token.startsWith('/') ||
    token.startsWith('~') ||
    token.includes('/') ||
    token.includes('\\')
  );
}

function firstCommandToken(line: string): string {
  let rest = line.trim();
  let guard = 0;
  while (guard++ < 8) {
    const env = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.exec(rest);
    if (!env) break;
    rest = rest.slice(env[0].length);
  }
  const m = /^([^\s|;&<>]+)/.exec(rest);
  if (!m) return '';
  return basenameCommand(m[1] ?? '');
}

function bareLooksLikeCommand(text: string): boolean {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  if (lines.length === 0) return false;
  // The payload starts as a command. Later lines may be a heredoc body or
  // more shell; the scanner classifies those. A sentence that only mentions
  // a command does not start with one.
  const first = lines[0] ?? '';
  if (/^(?:&&|\|\||[;|&])/.test(first)) return false;
  return KNOWN_COMMANDS.has(firstCommandToken(first)) || looksLikeVariableCommand(first);
}

/**
 * Pull a shell payload out of an action. Prose that merely mentions a
 * command (an agenda sentence that ends in `rm -rf`) is not a command
 * form — the existing agenda and kind gates keep that case.
 */
export function extractShellCommand(text: string | null | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const run = /^run_command\s*:\s*([\s\S]+)$/i.exec(trimmed);
  if (run?.[1]) return run[1].trim();
  const fence = /^```(?:bash|sh|shell|zsh|console|text)?[^\n]*\n([\s\S]*?)\n?```$/i.exec(trimmed);
  if (fence?.[1]) {
    return fence[1]
      .split('\n')
      .map((line) => line.replace(/^\s*\$\s+/, ''))
      .join('\n')
      .trim();
  }
  if (/^\$\s+\S/m.test(trimmed) && trimmed.split('\n').every((line) => !line.trim() || /^\s*\$\s+\S/.test(line) || /^\s*#/.test(line))) {
    return trimmed
      .split('\n')
      .map((line) => line.replace(/^\s*\$\s+/, ''))
      .join('\n')
      .trim();
  }
  if (bareLooksLikeCommand(trimmed) || looksLikeVariableCommand(trimmed)) return trimmed;
  return null;
}

/** `$CMD` / `${CMD}` is a command form even though the name is unknown. */
function looksLikeVariableCommand(text: string): boolean {
  return /^\$(\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)(?:\s|$)/.test(text.trim());
}

function isSecretPath(raw: string): boolean {
  const p = raw.trim();
  if (!p) return false;
  if (/(^|\/)\.env(\.[A-Za-z0-9._-]+)?$/.test(p)) return true;
  if (/(^|\/)\.ssh(\/|$)/.test(p) || p === '~/.ssh' || p.startsWith('~/.ssh')) return true;
  if (/id_rsa|id_ed25519|id_ecdsa/.test(p)) return true;
  if (/\.(pem|p12|pfx|keystore)$/i.test(p) || /\.key$/.test(p)) return true;
  if (/(^|\/)(credentials|secrets)(\.[A-Za-z0-9]+)?$/i.test(p)) return true;
  if (/(^|\/)\.(npmrc|netrc|pgpass|git-credentials)(\/|$)/.test(p)) return true;
  if (/(^|\/)\.aws(\/|$)/.test(p)) return true;
  if (p === '/etc/shadow' || p === '/etc/sudoers' || /(^|\/)etc\/(shadow|sudoers)$/.test(p)) return true;
  return false;
}

type PathKind = 'scoped' | 'build' | 'escape' | 'null' | 'secret';

function pathKind(raw: string): PathKind {
  const p = raw.trim();
  if (isSecretPath(p)) return 'secret';
  if (p === '/dev/null' || p === '/dev/stdout' || p === '/dev/stderr' || p === '/dev/zero') return 'null';
  if (!p) return 'escape';
  if (p.startsWith('~') || p.includes('..') || p.includes('$') || p.includes('`')) return 'escape';
  if (p.startsWith('/') || p.startsWith('\\')) return 'escape';
  if (p === '.' || p === './' || p === '*' || p === './*' || p === '/*' || p === '~/*') return 'escape';
  if (/(^|\/)\.git($|\/)/.test(p)) return 'escape';
  if (p.includes('*') || p.includes('?') || p.includes('[')) {
    if (/^(?:\.\/)?(?:build|dist|out|tmp|temp|\.cache|coverage|node_modules)\//.test(p)) return 'build';
    return 'escape';
  }
  if (/^(?:\.\/)?(?:build|dist|out|tmp|temp|\.cache|coverage|node_modules)(?:\/.*)?$/.test(p)) return 'build';
  return 'scoped';
}

function isNameStart(c: string): boolean {
  return /[A-Za-z_]/.test(c);
}

function isNameChar(c: string): boolean {
  return /[A-Za-z0-9_]/.test(c);
}

interface ScanOk {
  ok: true;
  statements: Statement[];
}

interface ScanFail {
  ok: false;
}

function scanShell(input: string): ScanOk | ScanFail {
  const statements: Statement[] = [];
  let stages: Stage[] = [];
  let words: Word[] = [];
  let redirects: Redirect[] = [];
  let stageStart = 0;
  const n = input.length;
  let i = 0;

  const flushStage = (end: number): void => {
    if (words.length === 0 && redirects.length === 0) return;
    stages.push({
      words,
      redirects,
      raw: input.slice(stageStart, end).trim(),
    });
    words = [];
    redirects = [];
  };

  const flushStatement = (end: number): void => {
    flushStage(end);
    if (stages.length > 0) statements.push({ stages });
    stages = [];
    stageStart = end;
  };

  const fail = (): ScanFail => ({ ok: false });

  while (i < n) {
    const c = input[i] ?? '';
    if (c === ' ' || c === '\t' || c === '\r') {
      i += 1;
      continue;
    }
    if (c === '\\' && input[i + 1] === '\n') {
      i += 2;
      continue;
    }
    if (c === '\n') {
      flushStatement(i);
      i += 1;
      stageStart = i;
      continue;
    }
    if (c === '#') {
      while (i < n && input[i] !== '\n') i += 1;
      continue;
    }
    if (input.startsWith('&&', i)) {
      flushStatement(i);
      i += 2;
      stageStart = i;
      continue;
    }
    if (input.startsWith('||', i)) {
      flushStatement(i);
      i += 2;
      stageStart = i;
      continue;
    }
    if (input.startsWith('|&', i)) {
      flushStage(i);
      i += 2;
      stageStart = i;
      continue;
    }
    if (c === '|' || c === ';' || c === '&') {
      if (c === '|') flushStage(i);
      else flushStatement(i);
      i += 1;
      stageStart = i;
      continue;
    }

    const redir = matchRedirect(input, i);
    if (redir) {
      i = redir.end;
      if (redir.heredoc) {
        const delim = readWord(input, i);
        if (!delim.ok) return fail();
        i = delim.end;
        const closed = skipHeredoc(input, i, delim.word.text || 'EOF');
        if (closed == null) return fail();
        i = closed;
        redirects.push({ op: redir.op, target: delim.word, heredoc: true });
        continue;
      }
      if (redir.needsTarget) {
        while (i < n && (input[i] === ' ' || input[i] === '\t')) i += 1;
        const target = readWord(input, i);
        if (!target.ok) return fail();
        i = target.end;
        redirects.push({ op: redir.op, target: target.word, heredoc: false });
      } else {
        redirects.push({ op: redir.op, target: null, heredoc: false });
      }
      continue;
    }

    const word = readWord(input, i);
    if (!word.ok) return fail();
    if (word.end === i) return fail();
    words.push(word.word);
    i = word.end;
  }
  flushStatement(n);
  return { ok: true, statements };
}

function matchRedirect(
  input: string,
  i: number,
): { end: number; op: string; heredoc: boolean; needsTarget: boolean } | null {
  let j = i;
  let digits = '';
  while (j < i + 2 && /[0-9]/.test(input[j] ?? '')) {
    digits += input[j];
    j += 1;
  }
  const rest = input.slice(j);
  const alts: Array<{ op: string; heredoc: boolean; needsTarget: boolean }> = [
    { op: '&>>', heredoc: false, needsTarget: true },
    { op: '&>>', heredoc: false, needsTarget: true },
    { op: '<<-', heredoc: true, needsTarget: false },
    { op: '<<<', heredoc: true, needsTarget: true },
    { op: '<<', heredoc: true, needsTarget: false },
    { op: '>>', heredoc: false, needsTarget: true },
    { op: '>&', heredoc: false, needsTarget: true },
    { op: '&>', heredoc: false, needsTarget: true },
    { op: '>', heredoc: false, needsTarget: true },
    { op: '<', heredoc: false, needsTarget: true },
  ];
  if (digits && !rest.startsWith('>') && !rest.startsWith('<')) return null;
  for (const alt of alts) {
    if (rest.startsWith(alt.op)) {
      if (!digits && (alt.op === '<' || alt.op === '>' || alt.op.startsWith('>' ) || alt.op.startsWith('<'))) {
        return { end: j + alt.op.length, op: alt.op, heredoc: alt.heredoc, needsTarget: alt.needsTarget };
      }
      if (digits && (alt.op.startsWith('>') || alt.op.startsWith('<'))) {
        return { end: j + alt.op.length, op: digits + alt.op, heredoc: alt.heredoc, needsTarget: alt.needsTarget };
      }
    }
  }
  return null;
}

function skipHeredoc(input: string, i: number, delim: string): number | null {
  let j = i;
  if (input[j] === '\n') j += 1;
  const lines = input.slice(j).split('\n');
  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li] ?? '';
    if (line.trim() === delim) return j + lines.slice(0, li + 1).join('\n').length + 1;
  }
  return null;
}

function readWord(
  input: string,
  start: number,
): { ok: true; word: Word; end: number } | { ok: false } {
  let i = start;
  const n = input.length;
  let text = '';
  const substitutions: string[] = [];
  let tainted = false;
  let expandable = false;
  let quote: "'" | '"' | null = null;

  const stop = (idx: number): boolean => {
    if (quote) return false;
    const c = input[idx] ?? '';
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ';' || c === '|' || c === '&') return true;
    if (c === '>' || c === '<') return true;
    // `#` starts a comment only as its own word. `x#y` is one argument.
    return false;
  };

  if (start >= n || stop(start)) {
    return { ok: true, word: { text: '', substitutions, tainted, expandable }, end: start };
  }

  while (i < n) {
    const c = input[i] ?? '';
    if (quote === "'") {
      if (c === "'") {
        quote = null;
        i += 1;
        continue;
      }
      text += c;
      i += 1;
      continue;
    }
    if (c === '\\') {
      const next = input[i + 1];
      if (next === undefined) return { ok: false };
      if (next === '\n') {
        i += 2;
        continue;
      }
      if (quote === '"' && !/["\\$`]/.test(next)) {
        text += c;
        i += 1;
        continue;
      }
      text += next;
      i += 2;
      continue;
    }
    if (quote === '"') {
      if (c === '"') {
        quote = null;
        i += 1;
        continue;
      }
      if (c === '`') {
        const inner = readBacktick(input, i);
        if (!inner.ok) return { ok: false };
        substitutions.push(inner.body);
        tainted = true;
        i = inner.end;
        continue;
      }
      if (c === '$') {
        const exp = readExpansion(input, i);
        if (!exp.ok) return { ok: false };
        if (exp.kind === 'subst') substitutions.push(exp.body);
        else text += exp.raw;
        tainted = true;
        i = exp.end;
        continue;
      }
      text += c;
      i += 1;
      continue;
    }
    if (stop(i)) break;
    // Globs expand unquoted. `~` expands only at the start of a word (`HEAD~3` does not).
    if (/[*?[\]{}]/.test(c) || (c === '~' && text.length === 0)) expandable = true;
    if (c === "'") {
      quote = "'";
      i += 1;
      continue;
    }
    if (c === '"') {
      quote = '"';
      i += 1;
      continue;
    }
    if (c === '`') {
      const inner = readBacktick(input, i);
      if (!inner.ok) return { ok: false };
      substitutions.push(inner.body);
      tainted = true;
      i = inner.end;
      continue;
    }
    if (c === '$') {
      const exp = readExpansion(input, i);
      if (!exp.ok) return { ok: false };
      if (exp.kind === 'subst') substitutions.push(exp.body);
      else text += exp.raw;
      tainted = true;
      i = exp.end;
      continue;
    }
    text += c;
    i += 1;
  }
  if (quote) return { ok: false };
  return { ok: true, word: { text, substitutions, tainted, expandable }, end: i };
}

function readBacktick(
  input: string,
  i: number,
): { ok: true; body: string; end: number } | { ok: false } {
  let j = i + 1;
  let body = '';
  while (j < input.length) {
    if (input[j] === '\\' && input[j + 1] === '`') {
      body += '`';
      j += 2;
      continue;
    }
    if (input[j] === '`') return { ok: true, body, end: j + 1 };
    body += input[j];
    j += 1;
  }
  return { ok: false };
}

function readExpansion(
  input: string,
  i: number,
): { ok: true; kind: 'subst' | 'param'; body: string; raw: string; end: number } | { ok: false } {
  const next = input[i + 1] ?? '';
  if (next === '(') {
    let j = i + 2;
    let depth = 1;
    let quote: "'" | '"' | null = null;
    const start = j;
    while (j < input.length) {
      const c = input[j] ?? '';
      if (quote === "'") {
        if (c === "'") quote = null;
        j += 1;
        continue;
      }
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (quote === '"') {
        if (c === '"') quote = null;
        j += 1;
        continue;
      }
      if (c === "'") {
        quote = "'";
        j += 1;
        continue;
      }
      if (c === '"') {
        quote = '"';
        j += 1;
        continue;
      }
      if (c === '(') depth += 1;
      else if (c === ')') {
        depth -= 1;
        if (depth === 0) {
          return { ok: true, kind: 'subst', body: input.slice(start, j), raw: input.slice(i, j + 1), end: j + 1 };
        }
      }
      j += 1;
    }
    return { ok: false };
  }
  if (next === '{') {
    const end = input.indexOf('}', i + 2);
    if (end < 0) return { ok: false };
    return { ok: true, kind: 'param', body: input.slice(i + 2, end), raw: input.slice(i, end + 1), end: end + 1 };
  }
  if (isNameStart(next)) {
    let j = i + 2;
    while (j < input.length && isNameChar(input[j] ?? '')) j += 1;
    return { ok: true, kind: 'param', body: input.slice(i + 1, j), raw: input.slice(i, j), end: j };
  }
  return { ok: true, kind: 'param', body: '$', raw: '$', end: i + 1 };
}

interface ArgClass {
  commandClass: CommandClass;
  filesystemWrite: boolean;
  forceRemote: boolean;
  obfuscated: boolean;
  fetcher: boolean;
  base64Decode: boolean;
  interpreterSink: boolean;
  paths: string[];
  scopeRoots: string[];
  /**
   * Inner commands (eval, command substitution) that must be authorized
   * on their own. Class-rank collapse must not drop them.
   */
  segments: LocalCommandPart[];
  /** Assignment, env option, shell `-c`, or wrapper. See `LocalCommandPart`. */
  closedForm: boolean;
}

function argResult(
  commandClass: CommandClass,
  extra: Partial<ArgClass> = {},
): ArgClass {
  return {
    commandClass,
    filesystemWrite: false,
    forceRemote: false,
    obfuscated: false,
    fetcher: false,
    base64Decode: false,
    interpreterSink: false,
    paths: [],
    scopeRoots: [],
    segments: [],
    closedForm: false,
    ...extra,
  };
}

function mergeArg(a: ArgClass, b: ArgClass): ArgClass {
  return {
    commandClass: strictestCommandClass([a.commandClass, b.commandClass]),
    filesystemWrite: a.filesystemWrite || b.filesystemWrite,
    forceRemote: a.forceRemote || b.forceRemote,
    obfuscated: a.obfuscated || b.obfuscated,
    fetcher: a.fetcher || b.fetcher,
    base64Decode: a.base64Decode || b.base64Decode,
    interpreterSink: a.interpreterSink || b.interpreterSink,
    paths: [...a.paths, ...b.paths],
    scopeRoots: [...a.scopeRoots, ...b.scopeRoots],
    segments: [...a.segments, ...b.segments],
    closedForm: a.closedForm || b.closedForm,
  };
}

function isEnvAssign(text: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(text);
}

function flagSet(argv: string[]): Set<string> {
  const out = new Set<string>();
  for (const a of argv) {
    if (a === '--') break;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      out.add(eq === -1 ? a : a.slice(0, eq));
    }
    else if (/^-[^-]/.test(a)) {
      out.add(a);
      for (const ch of a.slice(1)) out.add(`-${ch}`);
    }
  }
  return out;
}

function positionals(argv: string[]): string[] {
  const out: string[] = [];
  let afterDd = false;
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i] ?? '';
    if (afterDd || a === '--') {
      afterDd = true;
      if (a !== '--') out.push(a);
      continue;
    }
    if (a.startsWith('-')) continue;
    out.push(a);
  }
  return out;
}

function classifyRm(argv: string[]): ArgClass {
  const paths = positionals(argv);
  if (paths.length === 0) return argResult('unparseable', { filesystemWrite: true });
  let cls: CommandClass = 'local_write_scoped';
  for (const p of paths) {
    const kind = pathKind(p);
    if (kind === 'secret') cls = strictestCommandClass([cls, 'privilege']);
    else if (kind === 'escape') cls = strictestCommandClass([cls, 'destructive_local']);
  }
  return argResult(cls, { filesystemWrite: cls === 'local_write_scoped', paths });
}

function optionName(arg: string): string {
  if (!arg.startsWith('--')) return arg;
  const eq = arg.indexOf('=');
  return eq === -1 ? arg : arg.slice(0, eq);
}

function optionValue(arg: string): string | null {
  const eq = arg.indexOf('=');
  return eq === -1 ? null : arg.slice(eq + 1);
}

/** Read-only git options. Anything else on a read subcommand is not read_only. */
const GIT_READ_OPTIONS: Record<string, Set<string>> = {
  status: new Set([
    '-s', '--short', '-b', '--branch', '--porcelain', '-u', '--untracked-files',
    '--ignored', '-z', '--column', '-v', '--verbose', '--ahead-behind', '--no-ahead-behind',
  ]),
  diff: new Set([
    '--stat', '--name-only', '--name-status', '--numstat', '--shortstat', '--cached', '--staged',
    '--exit-code', '--color', '--no-color', '--raw', '--summary', '--check', '-p', '--patch',
    '-U', '--unified', '-w', '--ignore-all-space', '-b', '--ignore-space-change', '-M', '-C',
    '--find-copies', '--find-renames',
  ]),
  log: new Set([
    '--oneline', '--graph', '--decorate', '--all', '--stat', '-p', '--patch', '-n', '--max-count',
    '--abbrev-commit', '--pretty', '--format', '--author', '--since', '--until', '--follow',
    '--name-only', '--name-status',
  ]),
  show: new Set([
    '--stat', '--oneline', '--format', '--pretty', '--name-only', '--name-status', '-p', '--patch',
    '--no-patch', '-s', '--quiet',
  ]),
  branch: new Set(['-v', '-vv', '-a', '--all', '-r', '--remotes', '--list', '--show-current']),
  blame: new Set(['-L', '-e', '-w', '-p']),
  'rev-parse': new Set(['--short', '--abbrev-ref', '--verify', '--quiet', 'HEAD']),
  describe: new Set(['--tags', '--always', '--dirty', '--abbrev']),
  shortlog: new Set(['-s', '-n', '-e', '--summary']),
  'ls-files': new Set(['-s', '-m', '-o', '-c', '-d', '-u', '-z', '--stage', '--cached']),
};

function isForcePushArg(arg: string): boolean {
  const name = optionName(arg);
  return (
    name === '-f' ||
    name === '--force' ||
    name === '--force-with-lease' ||
    name === '--delete' ||
    name === '--mirror' ||
    arg.startsWith('+') ||
    /^-[^-]*f/.test(arg)
  );
}

function classifyGit(argv: string[]): ArgClass {
  const scopeRoots: string[] = [];
  let i = 1;
  while (i < argv.length) {
    const a = argv[i] ?? '';
    if (a === '--') {
      i += 1;
      break;
    }
    if (a === '-C' || a === '--git-dir' || a === '--work-tree') {
      const value = argv[i + 1];
      if (value) scopeRoots.push(value);
      i += 2;
      continue;
    }
    if (a.startsWith('--git-dir=') || a.startsWith('--work-tree=')) {
      scopeRoots.push(a.slice(a.indexOf('=') + 1));
      i += 1;
      continue;
    }
    if (a === '-c') {
      i += 2;
      continue;
    }
    if (a.startsWith('-')) {
      i += 1;
      continue;
    }
    break;
  }
  const sub = argv[i];
  if (!sub) return argResult('unparseable', { scopeRoots });
  const rest = argv.slice(i + 1);
  const flags = flagSet(rest);
  const has = (...names: string[]) => names.some((n) => flags.has(n));
  const scoped = (result: ArgClass): ArgClass =>
    scopeRoots.length === 0 ? result : { ...result, scopeRoots: [...result.scopeRoots, ...scopeRoots] };

  if (sub === 'push') {
    const force = rest.some((a) => isForcePushArg(a));
    return scoped(argResult('remote_write', { forceRemote: force }));
  }
  if (sub === 'clean') {
    if (has('-n', '--dry-run') && !has('-f', '-d', '-x', '--force')) return scoped(argResult('read_only'));
    return scoped(argResult('destructive_local'));
  }
  if (sub === 'reset') {
    if (has('--hard')) return scoped(argResult('destructive_local'));
    return scoped(argResult('local_write_scoped'));
  }
  if (sub === 'checkout' || sub === 'switch' || sub === 'restore') {
    if (sub === 'restore') {
      if (has('--staged') && !rest.some((a) => !a.startsWith('-'))) return scoped(argResult('local_write_scoped'));
      return scoped(argResult('destructive_local'));
    }
    if (rest.includes('--') || has('--force') || has('-f')) return scoped(argResult('destructive_local'));
    return scoped(argResult('local_write_scoped'));
  }
  if (sub === 'stash') {
    const op = rest.find((a) => !a.startsWith('-'));
    if (op === 'drop' || op === 'clear') return scoped(argResult('destructive_local'));
    if (op === 'list' || op === 'show' || op === undefined) return scoped(argResult(op ? 'read_only' : 'local_write_scoped'));
    return scoped(argResult('local_write_scoped'));
  }
  if (sub === 'branch') {
    if (has('-d', '-D', '--delete')) return scoped(argResult('local_write_scoped'));
    return scoped(classifyGitRead('branch', rest));
  }
  if (
    sub === 'status' ||
    sub === 'diff' ||
    sub === 'log' ||
    sub === 'show' ||
    sub === 'blame' ||
    sub === 'rev-parse' ||
    sub === 'describe' ||
    sub === 'shortlog' ||
    sub === 'ls-files' ||
    sub === 'version' ||
    sub === 'help'
  ) {
    return scoped(classifyGitRead(sub, rest));
  }
  if (
    sub === 'commit' ||
    sub === 'add' ||
    sub === 'mv' ||
    sub === 'rm' ||
    sub === 'tag' ||
    sub === 'merge' ||
    sub === 'rebase' ||
    sub === 'cherry-pick' ||
    sub === 'revert' ||
    sub === 'init'
  ) {
    return scoped(argResult('local_write_scoped'));
  }
  if (sub === 'remote' || sub === 'fetch' || sub === 'pull' || sub === 'clone') {
    return scoped(argResult('network_fetch'));
  }
  return scoped(argResult('unparseable'));
}

/**
 * A read subcommand stays read_only only for options that do not write.
 * `--output` writes a file. Any other unknown option is unparseable.
 */
function classifyGitRead(sub: string, rest: string[]): ArgClass {
  const safe = GIT_READ_OPTIONS[sub];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] ?? '';
    if (arg === '--') break;
    if (!arg.startsWith('-')) continue;
    const name = optionName(arg);
    if (name === '--output') {
      const value = optionValue(arg) ?? rest[i + 1] ?? '';
      if (!optionValue(arg)) i += 1;
      const kind = value ? pathKind(value) : 'escape';
      if (kind === 'secret') return argResult('privilege', { paths: value ? [value] : [] });
      if (kind === 'build') {
        return argResult('local_write_scoped', { filesystemWrite: true, paths: value ? [value] : [] });
      }
      return argResult('destructive_local', { paths: value ? [value] : [] });
    }
    if (sub === 'diff' && /^-U\d+$/.test(arg)) continue;
    if ((sub === 'log' || sub === 'show') && /^-\d+$/.test(arg)) continue;
    if (safe?.has(name) || safe?.has(arg)) continue;
    if (sub === 'version' || sub === 'help') continue;
    return argResult('unparseable');
  }
  return argResult('read_only');
}

function hasUrl(argv: string[]): boolean {
  return argv.some((a) => /^https?:\/\//i.test(a) || a.startsWith('git+'));
}

function classifyPackageManager(argv: string[]): ArgClass {
  const cmd = basenameCommand(argv[0] ?? '');
  const sub = argv[1] ?? '';
  if (cmd === 'npx' || cmd === 'pnpx') return argResult('network_exec');
  if ((cmd === 'pip' || cmd === 'pip3') && (sub === 'install' || sub === 'download')) {
    return argResult('network_exec');
  }
  if (cmd === 'pipx' && (sub === 'run' || sub === 'install')) return argResult('network_exec');
  if (cmd === 'uvx') return argResult('network_exec');
  if (sub === 'publish') return argResult('remote_write');
  if (sub === 'install' || sub === 'ci' || sub === 'add' || sub === 'update') return argResult('network_exec');
  if (sub === 'test' || (sub === 'run' && (argv[2] === 'test' || argv[2]?.startsWith('test:')))) {
    if (hasUrl(argv) || argv.some((a) => a === '--network')) return argResult('network_exec');
    return argResult('read_only');
  }
  if (cmd === 'pnpm' && sub === 'dlx') return argResult('network_exec');
  if ((cmd === 'yarn' || cmd === 'bun') && (sub === 'dlx' || argv.includes('dlx'))) return argResult('network_exec');
  return argResult('unparseable');
}

function classifyCurlFamily(argv: string[]): ArgClass {
  for (const a of argv.slice(1)) {
    if (isSecretPath(a)) return argResult('privilege', { fetcher: true });
  }
  return argResult('network_fetch', { fetcher: true });
}

function classifyPython(argv: string[], words: Word[]): ArgClass {
  const flags = flagSet(argv);
  if (flags.has('-m')) {
    const modIdx = argv.indexOf('-m');
    const mod = argv[modIdx + 1];
    if (mod === 'py_compile' || mod === 'pytest' || mod === 'compileall') {
      if (hasUrl(argv)) return argResult('network_exec');
      return argResult('read_only');
    }
  }
  if (flags.has('-c')) return classifyShellC(argv, words);
  if (argv.slice(1).some((a) => !a.startsWith('-') && a !== '-')) return argResult('unparseable');
  return argResult('unparseable', { interpreterSink: true });
}

function shellCIndex(argv: string[]): number {
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--') break;
    if (arg === '-c' || arg === '--command') return i;
    if (/^-[^-]*c/.test(arg)) return i;
  }
  return -1;
}

function classifyShellC(argv: string[], words: Word[]): ArgClass {
  const idx = shellCIndex(argv);
  if (idx < 0) return argResult('unparseable', { interpreterSink: true });
  const flag = argv[idx] ?? '';
  const combined = flag !== '-c' && flag !== '--command';
  // eval and `sh -c` join every argument into one script so nothing after
  // -c is ignored. A combined flag (`-lc`, `-ec`) takes the next word.
  const script = combined ? (argv[idx + 1] ?? '') : argv.slice(idx + 1).join(' ');
  const scriptWords = combined ? words.slice(idx + 1, idx + 2) : words.slice(idx + 1);
  const subs = scriptWords.flatMap((word) => word.substitutions);
  if (subs.some((sub) => /\b(?:curl|wget)\b/.test(sub))) {
    return argResult('network_exec', { obfuscated: true });
  }
  let result = script.trim() ? nestedCommand(script) : argResult('unparseable');
  for (const sub of subs) result = mergeArg(result, nestedCommand(sub));
  return result;
}

/**
 * First real program after a wrapper. Flags, assignments, and numeric
 * operands (nice/timeout) are not the program. The caller marks the result
 * closed so the wrapper cannot open a gate.
 */
function classifyWrapperInner(argv: string[], words: Word[]): ArgClass {
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i] ?? '';
    if (!token || token.startsWith('-') || isEnvAssign(token)) continue;
    if (/^\d+(?:\.\d+)?$/.test(token)) continue;
    const base = basenameCommand(token);
    if (CLOSED_WRAPPERS.has(base) || KNOWN_COMMANDS.has(base) || isUnverifiedProgramPath(token)) {
      return classifyArgv(argv.slice(i), words.slice(i));
    }
  }
  return argResult('unparseable');
}

/** `env` options and NAME=value. `--` ends the prefix. A value-taking flag consumes the next word. */
function envPrefix(argv: string[]): { end: number; closed: boolean } {
  let j = 1;
  let closed = false;
  while (j < argv.length) {
    const arg = argv[j] ?? '';
    if (arg === '--') return { end: j + 1, closed: true };
    if (arg.startsWith('-') && arg !== '-') {
      closed = true;
      if ((arg === '-u' || arg === '-C' || arg === '-S') && j + 1 < argv.length) {
        j += 2;
        continue;
      }
      j += 1;
      continue;
    }
    if (isEnvAssign(arg)) {
      closed = true;
      j += 1;
      continue;
    }
    break;
  }
  return { end: j, closed };
}

/** Classify a nested script and keep every statement as its own segment. */
function nestedCommand(script: string): ArgClass {
  const inner = analysisFrom(script, true);
  return argResult(inner.commandClass ?? 'unparseable', {
    filesystemWrite: inner.filesystemWrite,
    forceRemote: inner.forceRemote,
    obfuscated: inner.obfuscated,
    segments: inner.parts,
  });
}

/** Options that run another program. Unknown options are never read_only. */
const READ_EXEC_OPTIONS: Record<string, Set<string>> = {
  rg: new Set(['--pre', '--pre-glob', '--hostname-bin']),
  grep: new Set([]),
  egrep: new Set([]),
  fgrep: new Set([]),
  sort: new Set(['-o', '--output', '--compress-program', '--compress-prog']),
  less: new Set([]),
  more: new Set([]),
};

const READ_SAFE_OPTIONS: Record<string, Set<string>> = {
  cat: new Set(['-n', '-A', '-b', '-s', '-T', '-v', '-e', '-E']),
  head: new Set(['-n', '-c', '-q', '-v']),
  tail: new Set(['-n', '-c', '-q', '-v']),
  wc: new Set(['-l', '-w', '-c', '-m', '-L']),
  ls: new Set(['-l', '-a', '-A', '-h', '-1', '-t', '-S', '-r', '-R', '--color']),
  pwd: new Set(['-L', '-P']),
  echo: new Set(['-n', '-e', '-E']),
  printf: new Set([]),
  which: new Set(['-a']),
  file: new Set(['-b', '-i', '-L', '-z']),
  stat: new Set(['-c', '-t', '-L']),
  true: new Set([]),
  false: new Set([]),
  rg: new Set([
    '-n', '-i', '-w', '-l', '-c', '-o', '-F', '-U', '-u', '-S', '-H',
    '--line-number', '--ignore-case', '--word-regexp', '--files-with-matches',
    '--count', '--only-matching', '--fixed-strings', '--multiline', '--heading',
    '--no-heading', '--color', '--no-color', '--hidden', '--glob', '--iglob',
    '--type', '-t', '-T', '-g', '-m', '--max-count', '-A', '-B', '-C',
    '--context', '--column', '--vimgrep', '--json', '--case-sensitive', '--smart-case',
  ]),
  grep: new Set([
    '-n', '-i', '-w', '-l', '-c', '-o', '-F', '-E', '-G', '-P', '-r', '-R',
    '-H', '-h', '-a', '-I', '-v', '-x', '-m', '-A', '-B', '-C', '--',
  ]),
  egrep: new Set(['-n', '-i', '-w', '-l', '-c', '-o', '-r', '-R', '-H', '-h', '-v', '-m', '-A', '-B', '-C']),
  fgrep: new Set(['-n', '-i', '-w', '-l', '-c', '-o', '-r', '-R', '-H', '-h', '-v', '-m', '-A', '-B', '-C']),
  sort: new Set([
    '-n', '-r', '-u', '-k', '-t', '-s', '-b', '-f', '-z', '-h', '-V',
    '--numeric-sort', '--reverse', '--unique', '--stable', '--version-sort', '--key',
  ]),
  less: new Set(['-N', '-n', '-F', '-X', '-R', '-S', '-M', '-E']),
  more: new Set(['-d', '-l', '-f', '-p', '-c', '-s', '-n']),
};

const FIND_DESTRUCTIVE = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir']);
const FIND_SAFE = new Set([
  '-name', '-iname', '-type', '-path', '-wholename', '-print', '-print0', '-ls',
  '-maxdepth', '-mindepth', '-size', '-empty', '-mtime', '-newer', '-not', '-and',
  '-or', '-a', '-o', '-true', '-false', '-regex', '-iregex', '-prune', '-depth',
  '-mount', '-xdev', '-L', '-H', '-P', '-noleaf', '-group', '-user', '-perm',
  '-readable', '-writable', '-executable',
]);

function shortFlagsAreSafe(arg: string, safe: Set<string>): boolean {
  if (!/^-[^-].+/.test(arg)) return false;
  return [...arg.slice(1)].every((ch) => safe.has(`-${ch}`));
}

function classifyReadBinary(cmd: string, argv: string[]): ArgClass {
  const safe = READ_SAFE_OPTIONS[cmd] ?? new Set<string>();
  const exec = READ_EXEC_OPTIONS[cmd] ?? new Set<string>();
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--') break;
    if (arg.startsWith('+')) return argResult('unparseable');
    if (!arg.startsWith('-')) continue;
    const name = optionName(arg);
    if (exec.has(name)) return argResult('unparseable');
    if (safe.has(name) || safe.has(arg) || shortFlagsAreSafe(arg, safe)) continue;
    return argResult('unparseable');
  }
  return argResult('read_only');
}

function classifyFind(argv: string[]): ArgClass {
  if (argv.some((arg) => FIND_DESTRUCTIVE.has(arg))) return argResult('destructive_local');
  for (const arg of argv.slice(1)) {
    if (!arg.startsWith('-')) continue;
    if (FIND_SAFE.has(optionName(arg)) || FIND_SAFE.has(arg)) continue;
    return argResult('unparseable');
  }
  return argResult('read_only');
}

function classifyArgv(argv: string[], words: Word[]): ArgClass {
  let i = 0;
  let assigned = false;
  while (i < argv.length && isEnvAssign(argv[i] ?? '') && !words[i]?.tainted) {
    assigned = true;
    i += 1;
  }
  const close = (result: ArgClass): ArgClass => (assigned ? { ...result, closedForm: true } : result);
  if (i >= argv.length) return close(argResult('unparseable'));
  const slicedArgv = argv.slice(i);
  const slicedWords = words.slice(i);
  const raw0 = slicedArgv[0] ?? '';
  const word0 = slicedWords[0];
  if (!raw0 && word0 && word0.substitutions.length > 0) {
    const subs = word0.substitutions.map((s) => classifyCommandText(s));
    const fetched = subs.some((c) => c.fetcher || c.commandClass === 'network_fetch' || c.commandClass === 'network_exec');
    if (fetched) return close(argResult('network_exec', { obfuscated: true }));
    return close(subs.reduce(mergeArg, argResult('unparseable')));
  }
  if (/^\$/.test(raw0) || (word0?.tainted && raw0.startsWith('$'))) {
    return close(argResult('unparseable'));
  }
  // `./git`, `../git`, `/usr/bin/git` do not inherit git's class. The same
  // check applies to the program `env` or another wrapper actually runs.
  if (isUnverifiedProgramPath(raw0)) return close(argResult('unparseable'));
  const cmd = basenameCommand(raw0);
  if (!cmd || raw0.includes('*')) return close(argResult('unparseable'));

  let result: ArgClass;
  if (CLOSED_WRAPPERS.has(cmd)) {
    result = { ...classifyWrapperInner(slicedArgv, slicedWords), closedForm: true };
  } else if (cmd === 'sudo' || cmd === 'su' || cmd === 'doas' || cmd === 'pkexec') {
    result = argResult('privilege');
  } else if (cmd === 'git') {
    result = classifyGit(slicedArgv);
  } else if (cmd === 'rm' || cmd === 'rmdir') {
    result = classifyRm(slicedArgv);
  } else if (cmd === 'mv' || cmd === 'cp' || cmd === 'mkdir' || cmd === 'touch' || cmd === 'tee') {
    const paths = positionals(slicedArgv);
    let cls: CommandClass = 'local_write_scoped';
    for (const p of paths) {
      const kind = pathKind(p);
      if (kind === 'secret') cls = strictestCommandClass([cls, 'privilege']);
      else if (kind === 'escape') cls = strictestCommandClass([cls, 'destructive_local']);
    }
    result = argResult(cls, { filesystemWrite: cls === 'local_write_scoped', paths });
  } else if (cmd === 'chmod') {
    const mode = slicedArgv.find((a) => /^[0-7]{3,4}$/.test(a) || a.includes('777') || a === 'a+rwx');
    const recursive = flagSet(slicedArgv).has('-R');
    if (recursive || mode === '777' || mode === '0777' || mode === 'a+rwx' || slicedArgv.some((a) => a.includes('777'))) {
      result = argResult('privilege');
    } else {
      result = argResult('local_write_scoped', { filesystemWrite: true });
    }
  } else if (cmd === 'chown' || cmd === 'chgrp') {
    result = argResult('privilege');
  } else if (cmd === 'printenv' || cmd === 'export') {
    result = argResult('privilege');
  } else if (cmd === 'env') {
    const prefix = envPrefix(slicedArgv);
    if (prefix.end >= slicedArgv.length) {
      // `env` and `env -i` with no utility still print the environment.
      result = argResult('privilege');
    } else if (prefix.closed) {
      result = { ...classifyArgv(slicedArgv.slice(prefix.end), slicedWords.slice(prefix.end)), closedForm: true };
    } else {
      result = classifyArgv(slicedArgv.slice(prefix.end), slicedWords.slice(prefix.end));
    }
  } else if (cmd === 'dd' || cmd === 'mkfs' || cmd.startsWith('mkfs.') || cmd === 'truncate' || cmd === 'shred') {
    result = argResult('destructive_local');
  } else if (cmd === 'find') {
    result = classifyFind(slicedArgv);
  } else if (
    cmd === 'npm' ||
    cmd === 'pnpm' ||
    cmd === 'yarn' ||
    cmd === 'bun' ||
    cmd === 'npx' ||
    cmd === 'pnpx' ||
    cmd === 'pip' ||
    cmd === 'pip3' ||
    cmd === 'pipx' ||
    cmd === 'uvx'
  ) {
    result = classifyPackageManager(slicedArgv);
  } else if (cmd === 'curl' || cmd === 'wget') {
    result = classifyCurlFamily(slicedArgv);
  } else if (cmd === 'python' || cmd === 'python3') {
    result = classifyPython(slicedArgv, slicedWords);
  } else if (cmd === 'pytest' || cmd === 'vitest') {
    result = hasUrl(slicedArgv) ? argResult('network_exec') : argResult('read_only');
  } else if (cmd === 'cargo' && slicedArgv[1] === 'test') {
    result = argResult('read_only');
  } else if (cmd === 'go' && slicedArgv[1] === 'test') {
    result = argResult('read_only');
  } else if (cmd === 'tsc' && (slicedArgv.includes('--noEmit') || slicedArgv.length === 1)) {
    result = argResult('read_only');
  } else if (INTERPRETERS.has(cmd) || cmd === 'eval') {
    const shellExec = SHELLS.has(cmd) && shellCIndex(slicedArgv) >= 0;
    if (cmd === 'eval' || shellExec) {
      const scriptWords: Word[] =
        cmd === 'eval'
          ? [
              { text: 'sh', substitutions: [], tainted: false, expandable: false },
              { text: '-c', substitutions: [], tainted: false, expandable: false },
              ...slicedWords.slice(1),
            ]
          : slicedWords;
      const scriptArgv = cmd === 'eval' ? ['sh', '-c', ...slicedArgv.slice(1)] : slicedArgv;
      result = classifyShellC(scriptArgv, scriptWords);
      // v1 does not treat the script body as an allowed command. A hard
      // class inside the body is kept so BLOCK still wins.
      if (shellExec) result = { ...result, closedForm: true };
    } else result = argResult('unparseable', { interpreterSink: true });
  } else if (cmd === 'base64') {
    const decode = slicedArgv.some((a) => a === '-d' || a === '-D' || a === '--decode');
    result = decode ? argResult('unparseable', { base64Decode: true, obfuscated: true }) : argResult('read_only');
  } else if (cmd === 'gh') {
    if (slicedArgv[1] === 'pr' && slicedArgv[2] === 'merge') result = argResult('remote_write');
    else if (slicedArgv[1] === 'release') result = argResult('remote_write');
    else result = argResult('unparseable');
  } else if (cmd === 'docker' && slicedArgv[1] === 'push') {
    result = argResult('remote_write');
  } else if (cmd === 'kubectl' && ['apply', 'delete', 'create', 'replace', 'patch'].includes(slicedArgv[1] ?? '')) {
    result = argResult('remote_write');
  } else if (cmd === 'terraform' && (slicedArgv[1] === 'apply' || slicedArgv[1] === 'destroy')) {
    result = argResult('remote_write');
  } else if (['vercel', 'wrangler', 'fly', 'flyctl', 'heroku', 'serverless'].includes(cmd)) {
    result = argResult('remote_write');
  } else if (['apt', 'apt-get', 'yum', 'dnf', 'pacman', 'apk'].includes(cmd)) {
    result = argResult('privilege');
  } else if (READ_BINARIES.has(cmd)) {
    result = classifyReadBinary(cmd, slicedArgv);
  } else if (cmd === 'xargs' || cmd === 'make') {
    // xargs runs another program. That program is not classified by name.
    result = argResult('unparseable');
  } else {
    result = argResult('unparseable');
  }

  if (slicedArgv.some((a) => isSecretPath(a)) && CLASS_RANK[result.commandClass] < CLASS_RANK.privilege) {
    result = { ...result, commandClass: 'privilege' };
  }
  // Unquoted globs and `~` are not expanded here. A quoted literal is not expandable.
  // An unresolved expansion is never read_only. A known secret path is already privilege.
  if (slicedWords.some((w) => w.expandable) && result.commandClass === 'read_only') {
    result = { ...result, commandClass: 'unparseable' };
  }
  // A parameter in an argument is an unknown path. Never treat that as read_only
  // or as a scoped write. Command substitutions are classified on their own.
  if (slicedWords.some((w) => w.tainted && w.substitutions.length === 0 && /\$/.test(w.text))) {
    if (result.commandClass === 'read_only') result = { ...result, commandClass: 'unparseable' };
    else if (result.commandClass === 'local_write_scoped') {
      result = { ...result, commandClass: 'destructive_local', filesystemWrite: false };
    }
  }
  for (const w of slicedWords) {
    for (const sub of w.substitutions) {
      result = mergeArg(result, nestedCommand(sub));
    }
  }
  return close(result);
}

function isFdDup(op: string, target: string): boolean {
  // `>&1` and `2>&1` duplicate a descriptor. `> 123` writes a file named 123.
  return op.includes('&') && /^&?\d+$/.test(target);
}

function applyRedirects(result: ArgClass, redirects: Redirect[]): ArgClass {
  let next = result;
  for (const redir of redirects) {
    if (redir.heredoc) {
      next = mergeArg(next, argResult('unparseable'));
      continue;
    }
    const targetWord = redir.target;
    if (targetWord) {
      for (const sub of targetWord.substitutions) {
        next = mergeArg(next, nestedCommand(sub));
      }
    }
    const target = targetWord?.text ?? '';
    const input = !redir.op.includes('>');
    if (input) {
      if (!target && !(targetWord && targetWord.substitutions.length > 0)) {
        next = mergeArg(next, argResult('unparseable'));
        continue;
      }
      if (!target) continue;
      const kind = pathKind(target);
      if (kind === 'secret') next = mergeArg(next, argResult('privilege', { paths: [target] }));
      else if (kind === 'escape' || targetWord?.expandable) {
        next = mergeArg(next, argResult('unparseable', { paths: [target] }));
      }
      continue;
    }
    if (!target || isFdDup(redir.op, target) || target === '-' || target === '&1' || target === '&2') {
      if (!target && !(targetWord && targetWord.substitutions.length > 0)) {
        next = mergeArg(next, argResult('unparseable'));
      }
      continue;
    }
    const kind = pathKind(target);
    if (kind === 'null') continue;
    if (kind === 'secret') next = mergeArg(next, argResult('privilege', { paths: [target] }));
    else if (kind === 'escape') next = mergeArg(next, argResult('destructive_local', { paths: [target] }));
    else if (kind === 'build') {
      next = mergeArg(next, argResult('local_write_scoped', { filesystemWrite: true, paths: [target] }));
    } else next = mergeArg(next, argResult('destructive_local', { paths: [target] }));
  }
  return next;
}

function classifyStage(stage: Stage): ArgClass {
  if (stage.words.length === 0) return argResult('unparseable');
  const argv = stage.words.map((w) => w.text);
  let result = classifyArgv(argv, stage.words);
  result = applyRedirects(result, stage.redirects);
  const cmd = basenameCommand(argv[0] ?? '');
  if (INTERPRETERS.has(cmd) && !argv.includes('-c') && argv.slice(1).every((a) => a.startsWith('-') || a === cmd)) {
    result = { ...result, interpreterSink: true };
  }
  if ((cmd === 'sh' || cmd === 'bash' || cmd === 'zsh' || cmd === 'dash') && argv.length === 1) {
    result = { ...result, interpreterSink: true, commandClass: strictestCommandClass([result.commandClass, 'unparseable']) };
  }
  return result;
}

function partFromArg(result: ArgClass, text: string): LocalCommandPart {
  return {
    commandClass: result.commandClass,
    text,
    filesystemWrite: result.filesystemWrite,
    forceRemote: result.forceRemote,
    paths: result.paths,
    scopeRoots: result.scopeRoots,
    closedForm: result.closedForm,
  };
}

function classifyStatement(statement: Statement): ArgClass {
  const stages = statement.stages.map(classifyStage);
  if (stages.length === 0) return argResult('unparseable');
  let merged = stages.reduce(mergeArg, argResult('read_only'));
  const fetcher = stages.some((s) => s.fetcher);
  const decode = stages.some((s) => s.base64Decode);
  const sink = stages.some((s, idx) => idx > 0 && s.interpreterSink);
  // Fetch-and-execute may only add a tighter class. It must not replace
  // the per-stage decisions below.
  if ((fetcher || decode) && sink) {
    merged = {
      ...merged,
      commandClass: 'network_exec',
      obfuscated: merged.obfuscated || decode,
    };
  }
  if (stages.length > 1) {
    const perStage = stages.flatMap((stage, index) => {
      const text = statement.stages[index]?.raw ?? '';
      const pieces = stage.segments.length > 0 ? [...stage.segments] : [];
      pieces.push(partFromArg(stage, text));
      return pieces;
    });
    merged = { ...merged, segments: perStage };
  }
  return merged;
}

function classifyCommandText(command: string): ArgClass {
  const scanned = scanShell(command);
  if (!scanned.ok) return argResult('unparseable');
  if (scanned.statements.length === 0) return argResult('unparseable');
  const parts = scanned.statements.map(classifyStatement);
  return parts.reduce(mergeArg, argResult('read_only'));
}

function statementParts(result: ArgClass, text: string): LocalCommandPart[] {
  const own: LocalCommandPart = {
    commandClass: result.commandClass,
    text,
    filesystemWrite: result.filesystemWrite,
    forceRemote: result.forceRemote,
    paths: result.paths,
    scopeRoots: result.scopeRoots,
    closedForm: result.closedForm,
  };
  if (result.segments.length === 0) return [own];
  // Inner segments stay separate. The collapsed class is kept as well so a
  // redirect or pipeline upgrade is not dropped when segments exist.
  return [...result.segments, own];
}

function analysisFrom(command: string, recognized: boolean): LocalCommandAnalysis {
  const scanned = scanShell(command);
  if (!scanned.ok) {
    return {
      recognized,
      commandClass: 'unparseable',
      commandText: command,
      filesystemWrite: false,
      forceRemote: false,
      obfuscated: false,
      parts: [{
        commandClass: 'unparseable',
        text: command,
        filesystemWrite: false,
        forceRemote: false,
        paths: [],
        scopeRoots: [],
      }],
    };
  }
  if (scanned.statements.length === 0) {
    return {
      recognized,
      commandClass: 'unparseable',
      commandText: command,
      filesystemWrite: false,
      forceRemote: false,
      obfuscated: false,
      parts: [],
    };
  }
  const partResults = scanned.statements.map((statement) => ({
    result: classifyStatement(statement),
    text: statement.stages.map((s) => s.raw).filter(Boolean).join(' | ') || command,
  }));
  const merged = partResults.map((p) => p.result).reduce(mergeArg, argResult('read_only'));
  return {
    recognized,
    commandClass: merged.commandClass,
    commandText: command,
    filesystemWrite: merged.filesystemWrite,
    forceRemote: merged.forceRemote,
    obfuscated: merged.obfuscated,
    parts: partResults.flatMap((p) => statementParts(p.result, p.text)),
  };
}

/** Strictest class wins. Flags from either side are kept. */
export function combineLocalCommandAnalysis(
  a: LocalCommandAnalysis,
  b: LocalCommandAnalysis,
): LocalCommandAnalysis {
  if (!a.recognized || !a.commandClass) return b;
  if (!b.recognized || !b.commandClass) return a;
  return {
    recognized: true,
    commandClass: strictestCommandClass([a.commandClass, b.commandClass]),
    commandText: [a.commandText, b.commandText].filter((part): part is string => !!part).join('\n'),
    filesystemWrite: a.filesystemWrite || b.filesystemWrite,
    forceRemote: a.forceRemote || b.forceRemote,
    obfuscated: a.obfuscated || b.obfuscated,
    parts: [...a.parts, ...b.parts],
  };
}

export function classifyLocalCommand(actionText: string | null | undefined): LocalCommandAnalysis {
  const command = extractShellCommand(actionText);
  if (!command) return UNRECOGNIZED;
  return analysisFrom(command, true);
}

function hasWorkspace(workspace: string | null | undefined): boolean {
  return typeof workspace === 'string' && workspace.trim().length > 0;
}

function cwdEscapes(cwd: string | null | undefined): boolean {
  if (!cwd || !cwd.trim()) return false;
  const c = cwd.trim();
  return c.startsWith('~') || c.includes('..') || c.includes('$') || c.includes('`');
}

function mentionIsAuthorized(mandateText: string, marker: string): boolean {
  if (!mandateText || !marker) return false;
  const re = new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(mandateText)) !== null) {
    const before = mandateText.slice(Math.max(0, m.index - 48), m.index);
    if (NEGATION_BEFORE_RE.test(before)) continue;
    return true;
  }
  return false;
}

interface BoundDestructive {
  /** Command and flags. Targets are not included. `rm` flags are lowercased. */
  head: string;
  /** Positional arguments as the shell tokenizer saw them. Case preserved, in order. */
  targets: string[];
  /**
   * Full bound argv, case-sensitive, in order. A git grant matches only
   * when this vector is identical. Nothing meaningful is dropped from it.
   */
  argv: string[];
}

/** Determiners that introduce trailing clause prose ("the worktree"). Not filenames. */
const TRAILING_PROSE = new Set(['the', 'a', 'an', 'this', 'that', 'these', 'those']);

const CLAUSE_NEGATION_RE =
  /\b(?:do\s+not|don't|never|forbidden|verboten|nicht|niemals|cannot|can't|without|kein(?:e|en|em|er)?)\b|\bnot\b/i;

/**
 * Sentences outside quotes. A dot inside `./build` or `"/srv/data."` is not a boundary.
 */
function splitClauses(text: string): string[] {
  const clauses: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] ?? '';
    if (quote) {
      current += c;
      if (c === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      current += c;
      continue;
    }
    if (c === '.' || c === '!' || c === '?') {
      const prev = text[i - 1] ?? '';
      const next = text[i + 1];
      const pathDot = c === '.' && (prev === '/' || prev === '.' || next === '/' || next === '.');
      const boundary = next === undefined || /\s/.test(next);
      if (boundary && !pathDot) {
        const clause = current.trim();
        if (clause) clauses.push(clause);
        current = '';
        continue;
      }
    }
    current += c;
  }
  const tail = current.trim();
  if (tail) clauses.push(tail);
  return clauses;
}

function shellWords(text: string): string[] | null {
  const scanned = scanShell(text);
  if (!scanned.ok) return null;
  const words: string[] = [];
  for (const statement of scanned.statements) {
    for (const stage of statement.stages) {
      for (const word of stage.words) {
        if (word.text) words.push(word.text);
      }
    }
  }
  return words;
}

function boundFromWords(words: string[], allowTrailingProse: boolean): BoundDestructive | null {
  const found: BoundDestructive[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] ?? '';
    if (word === 'rm' || word === 'rmdir') {
      const flags: string[] = [];
      const targets: string[] = [];
      for (let j = i + 1; j < words.length; j += 1) {
        const token = words[j] ?? '';
        if (token.startsWith('-')) flags.push(token);
        else targets.push(token);
      }
      const recursive = word === 'rmdir' || flags.some((flag) => /r/.test(flag) || flag === '--recursive');
      if (recursive) {
        const head = [word, ...flags].join(' ').toLowerCase();
        found.push({ head, targets, argv: [word, ...flags, ...targets] });
      }
      break;
    }
    if (word === 'git' && (words[i + 1] === 'clean' || words[i + 1] === 'reset' || words[i + 1] === 'checkout' || words[i + 1] === 'restore')) {
      const sub = words[i + 1] ?? '';
      const flags: string[] = [];
      const targets: string[] = [];
      const argv: string[] = ['git', sub];
      for (let j = i + 2; j < words.length; j += 1) {
        const token = words[j] ?? '';
        // "the worktree" is clause prose. Every other token is an argument:
        // a filename, a revision, an option value, or `--`. Dropping one
        // would let a different command match, so it never does.
        if (allowTrailingProse && TRAILING_PROSE.has(token.toLowerCase())) break;
        argv.push(token);
        if (token.startsWith('-')) flags.push(token);
        else targets.push(token);
      }
      const destructive = sub === 'clean'
        || (sub === 'reset' && flags.includes('--hard'))
        || (sub === 'checkout' && (flags.includes('--') || targets.length > 0))
        || sub === 'restore';
      if (destructive) found.push({ head: ['git', sub, ...flags].join(' '), targets, argv });
      break;
    }
  }
  if (found.length !== 1) return null;
  return found[0] ?? null;
}

function parseBoundDestructive(text: string, allowTrailingProse: boolean): BoundDestructive | null {
  const words = shellWords(text);
  if (!words) return null;
  return boundFromWords(words, allowTrailingProse);
}

function sameArgv(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((token, index) => token === right[index]);
}

function clauseMentionsTarget(clause: string, target: string): boolean {
  const words = shellWords(clause);
  return words?.some((word) => word === target) === true;
}

/**
 * A destructive exception opens only for one unambiguous authorizing clause.
 * The clause is parsed with the shell tokenizer, so quotes keep argument
 * boundaries and punctuation inside a quoted path. Every action target must
 * equal a target of that clause, in order, case-sensitive. A negation that
 * names the target wins. Anything ambiguous stays closed.
 */
function mandateNamesDestructive(mandateText: string, commandText: string): boolean {
  // The action is a command, so every token is an argument. A mandate clause
  // may end in prose ("the worktree"); that prose is not part of the argv.
  const action = parseBoundDestructive(commandText, false);
  if (!action) return false;
  const clauses = splitClauses(mandateText);
  for (const clause of clauses) {
    if (!CLAUSE_NEGATION_RE.test(clause)) continue;
    const negated = parseBoundDestructive(clause, true);
    const namesCommand = negated?.head === action.head && (negated.targets.length === 0 || negated.targets.some((target) => action.targets.includes(target)));
    const namesTarget = action.targets.some((target) => clauseMentionsTarget(clause, target));
    if (namesCommand || namesTarget) return false;
  }
  const grants = clauses
    .filter((clause) => !CLAUSE_NEGATION_RE.test(clause))
    .map((clause) => parseBoundDestructive(clause, true))
    .filter((bound): bound is BoundDestructive => bound !== null && sameArgv(bound.argv, action.argv));
  return grants.length === 1;
}

function mandateNamesForce(mandateText: string): boolean {
  return (
    mentionIsAuthorized(mandateText, 'git push --force') ||
    mentionIsAuthorized(mandateText, 'git push -f') ||
    mentionIsAuthorized(mandateText, '--force-with-lease') ||
    mentionIsAuthorized(mandateText, 'force-push') ||
    mentionIsAuthorized(mandateText, 'force push')
  );
}

function lexicalPath(path: string): string | null {
  if (path.includes('$') || path.includes('`') || path.startsWith('~')) return null;
  const absolute = path.startsWith('/');
  const segs: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (segs.length === 0 || segs[segs.length - 1] === '..') {
        if (absolute) return null;
        segs.push('..');
      } else {
        segs.pop();
      }
      continue;
    }
    segs.push(seg);
  }
  if (segs.includes('..')) return null;
  return (absolute ? '/' : '') + segs.join('/');
}

function resolveAgainst(base: string, rel: string): string | null {
  if (rel.startsWith('~') || rel.includes('$') || rel.includes('`')) return null;
  if (rel.startsWith('/')) return lexicalPath(rel);
  const root = base.endsWith('/') ? base.slice(0, -1) : base;
  return lexicalPath(`${root}/${rel}`);
}

function pathInside(path: string, workspace: string): boolean {
  const resolved = lexicalPath(path);
  const root = lexicalPath(workspace);
  if (!resolved || !root) return false;
  return resolved === root || resolved.startsWith(`${root}/`);
}

type ScopeFit = 'ok' | 'outside' | 'unknown';

function scopeFit(part: LocalCommandPart, input: LocalCommandEffectInput): ScopeFit {
  const workspace = input.workspace?.trim() ?? '';
  const cwd = input.cwd?.trim() ?? '';
  const anchors = part.scopeRoots;
  if (!workspace) {
    if (part.filesystemWrite) return 'unknown';
    if (cwd.startsWith('/') || cwd.startsWith('~') || cwd.includes('..')) return 'unknown';
    if (anchors.some((anchor) => anchor.startsWith('/') || anchor.startsWith('~') || anchor.includes('..'))) {
      return 'unknown';
    }
    return 'ok';
  }
  const base = cwd ? resolveAgainst(workspace, cwd) : lexicalPath(workspace);
  if (!base || !pathInside(base, workspace)) return cwd ? 'outside' : 'unknown';
  for (const anchor of anchors) {
    const resolved = resolveAgainst(base, anchor);
    if (!resolved || !pathInside(resolved, workspace)) {
      return anchor.startsWith('/') || anchor.startsWith('~') ? 'outside' : 'unknown';
    }
  }
  if (part.filesystemWrite) {
    for (const target of part.paths) {
      const resolved = resolveAgainst(base, target);
      if (!resolved || !pathInside(resolved, workspace)) return 'outside';
    }
  }
  return 'ok';
}

function stricterEffect(a: LocalCommandEffect, b: LocalCommandEffect): LocalCommandEffect {
  const rank = (effect: LocalCommandEffect): number =>
    effect === 'block' ? 2 : effect === 'uncertain' ? 1 : 0;
  return rank(a) >= rank(b) ? a : b;
}

function effectForPart(part: LocalCommandPart, input: LocalCommandEffectInput): LocalCommandEffect {
  // Hard BLOCK across the part's own class first. A closed form
  // (assignment, env, shell -c, wrapper) must not turn that into UNCERTAIN,
  // and must not open when the class itself would.
  const effect = effectForClass(part, input);
  if (effect === 'block') return 'block';
  if (part.closedForm) return 'uncertain';
  return effect;
}

function effectForClass(part: LocalCommandPart, input: LocalCommandEffectInput): LocalCommandEffect {
  const mandateText = input.mandateText ?? '';
  if (cwdEscapes(input.cwd)) {
    if (part.commandClass === 'read_only') return 'uncertain';
    if (part.commandClass === 'local_write_scoped') return 'block';
  }
  const scope = scopeFit(part, input);
  switch (part.commandClass) {
    case 'privilege':
      return 'block';
    case 'destructive_local':
      if (scope === 'outside') return 'block';
      return mandateNamesDestructive(mandateText, part.text) ? 'open' : 'block';
    case 'remote_write':
      if (part.forceRemote) return mandateNamesForce(mandateText) ? 'open' : 'block';
      if (input.allowRemoteWrite === true || input.mandateKind === 'deploy_ship') return 'open';
      return 'block';
    case 'network_exec':
      return input.allowNetwork === true ? 'uncertain' : 'block';
    case 'network_fetch':
    case 'unparseable':
      return 'uncertain';
    case 'local_write_scoped':
      if (scope === 'outside') return 'block';
      if (part.filesystemWrite) {
        if (!hasWorkspace(input.workspace)) return 'uncertain';
        return scope === 'ok' ? 'open' : 'uncertain';
      }
      if (scope === 'unknown') return 'uncertain';
      return hasWorkspace(input.workspace) || mandateAuthorizesLocalRepo(mandateText) ? 'open' : 'uncertain';
    case 'read_only':
      if (part.scopeRoots.length > 0 && scope !== 'ok') return 'uncertain';
      return 'open';
    default:
      return 'uncertain';
  }
}

/**
 * Class gate only. Kind fit (mandate_kind === local_command, no caller
 * widen) is a separate check. `null` when the text is not a command.
 *
 * Every sub-command is authorized on its own. BLOCK wins over UNCERTAIN,
 * and UNCERTAIN wins over open. A remote-write grant does not open a
 * destructive sibling. Filesystem writes need granted.workspace and a
 * cwd/target inside that workspace. Git-local writes also open on an
 * explicit local-repo mandate when no path escapes that scope.
 */
export function localCommandEffect(input: LocalCommandEffectInput): LocalCommandEffect | null {
  if (!input.analysis.recognized || !input.analysis.commandClass) return null;
  const parts = input.analysis.parts.length > 0
    ? input.analysis.parts
    : [{
        commandClass: input.analysis.commandClass,
        text: input.analysis.commandText ?? '',
        filesystemWrite: input.analysis.filesystemWrite,
        forceRemote: input.analysis.forceRemote,
        paths: [],
        scopeRoots: [],
      }];
  let effect: LocalCommandEffect = 'open';
  for (const part of parts) effect = stricterEffect(effect, effectForPart(part, input));
  return effect;
}

/**
 * An explicit `action.command` is always a payload. Text the parser does
 * not recognize is unparseable, not absent.
 */
export function classifyCommandPayload(command: string): LocalCommandAnalysis {
  const parsed = classifyLocalCommand(command);
  if (parsed.recognized) return parsed;
  return {
    recognized: true,
    commandClass: 'unparseable',
    commandText: command,
    filesystemWrite: false,
    forceRemote: false,
    obfuscated: false,
    parts: [{
      commandClass: 'unparseable',
      text: command,
      filesystemWrite: false,
      forceRemote: false,
      paths: [],
      scopeRoots: [],
    }],
  };
}
