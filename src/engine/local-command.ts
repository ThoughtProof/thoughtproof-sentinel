/**
 * Deterministic local-command classifier for `action_authorization`.
 *
 * No network and no filesystem. A text parser cannot see aliases, shell
 * functions, or the body of a script (`./run.sh`, a Makefile target,
 * `npm test` via package.json). `read_only` means "no direct write was
 * classified". It does not mean the command is safe.
 *
 * Chains, pipes, substitutions, and redirects are split. The strictest
 * class wins. Hard classes are decided here so the model cascade cannot
 * ALLOW them.
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
  'true',
  'false',
  'which',
  'file',
  'stat',
]);

const WRAPPERS = new Set(['command', 'nohup', 'nice', 'time', 'exec']);
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
]);

export interface LocalCommandPart {
  commandClass: CommandClass;
  text: string;
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
  let quote: "'" | '"' | null = null;

  const stop = (idx: number): boolean => {
    if (quote) return false;
    const c = input[idx] ?? '';
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ';' || c === '|' || c === '&') return true;
    if (c === '>' || c === '<') return true;
    if (c === '#') return true;
    return false;
  };

  if (start >= n || stop(start)) {
    return { ok: true, word: { text: '', substitutions, tainted }, end: start };
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
  return { ok: true, word: { text, substitutions, tainted }, end: i };
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
  };
}

function isEnvAssign(text: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(text);
}

function flagSet(argv: string[]): Set<string> {
  const out = new Set<string>();
  for (const a of argv) {
    if (a === '--') break;
    if (a.startsWith('--')) out.add(a);
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
  return argResult(cls, { filesystemWrite: cls === 'local_write_scoped' });
}

function classifyGit(argv: string[]): ArgClass {
  let i = 1;
  while (i < argv.length) {
    const a = argv[i] ?? '';
    if (a === '--') {
      i += 1;
      break;
    }
    if (a === '-C' || a === '-c' || a === '--git-dir' || a === '--work-tree') {
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
  if (!sub) return argResult('unparseable');
  const rest = argv.slice(i + 1);
  const flags = flagSet(rest);
  const has = (...names: string[]) => names.some((n) => flags.has(n));

  if (sub === 'push') {
    const force =
      has('-f', '--force', '--force-with-lease', '--delete') ||
      rest.some((a) => a.startsWith('+') || /^-[^-]*f/.test(a));
    return argResult('remote_write', { forceRemote: force });
  }
  if (sub === 'clean') {
    if (has('-n', '--dry-run') && !has('-f', '-d', '-x', '--force')) return argResult('read_only');
    return argResult('destructive_local');
  }
  if (sub === 'reset') {
    if (has('--hard')) return argResult('destructive_local');
    return argResult('local_write_scoped');
  }
  if (sub === 'checkout' || sub === 'switch' || sub === 'restore') {
    if (sub === 'restore') {
      if (has('--staged') && !rest.some((a) => !a.startsWith('-'))) return argResult('local_write_scoped');
      return argResult('destructive_local');
    }
    if (rest.includes('--') || has('--force') || has('-f')) return argResult('destructive_local');
    return argResult('local_write_scoped');
  }
  if (sub === 'stash') {
    const op = rest.find((a) => !a.startsWith('-'));
    if (op === 'drop' || op === 'clear') return argResult('destructive_local');
    if (op === 'list' || op === 'show' || op === undefined) return argResult(op ? 'read_only' : 'local_write_scoped');
    return argResult('local_write_scoped');
  }
  if (sub === 'branch') {
    if (has('-d', '-D', '--delete')) return argResult('local_write_scoped');
    return argResult('read_only');
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
    return argResult('read_only');
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
    return argResult('local_write_scoped');
  }
  if (sub === 'remote' || sub === 'fetch' || sub === 'pull' || sub === 'clone') {
    return argResult('network_fetch');
  }
  return argResult('unparseable');
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

function classifyShellC(argv: string[], words: Word[]): ArgClass {
  const idx = argv.indexOf('-c');
  if (idx < 0) return argResult('unparseable', { interpreterSink: true });
  const scriptWord = words[idx + 1];
  const script = argv[idx + 1] ?? '';
  const subs = scriptWord?.substitutions ?? [];
  const subClasses = subs.map((s) => classifyCommandText(s));
  if (subs.length > 0) {
    const fetched = subClasses.some(
      (c) => c.commandClass === 'network_fetch' || c.commandClass === 'network_exec' || c.fetcher,
    );
    if (fetched) return argResult('network_exec', { obfuscated: true });
  }
  const inner = script.trim() ? classifyCommandText(script) : argResult('unparseable');
  return subClasses.reduce(mergeArg, inner);
}

function classifyArgv(argv: string[], words: Word[]): ArgClass {
  let i = 0;
  while (i < argv.length && isEnvAssign(argv[i] ?? '') && !words[i]?.tainted) i += 1;
  while (i < argv.length && WRAPPERS.has(basenameCommand(argv[i] ?? ''))) i += 1;
  if (i >= argv.length) return argResult('unparseable');
  const slicedArgv = argv.slice(i);
  const slicedWords = words.slice(i);
  const raw0 = slicedArgv[0] ?? '';
  const word0 = slicedWords[0];
  if (!raw0 && word0 && word0.substitutions.length > 0) {
    const subs = word0.substitutions.map((s) => classifyCommandText(s));
    const fetched = subs.some((c) => c.fetcher || c.commandClass === 'network_fetch' || c.commandClass === 'network_exec');
    if (fetched) return argResult('network_exec', { obfuscated: true });
    return subs.reduce(mergeArg, argResult('unparseable'));
  }
  if (/^\$/.test(raw0) || (word0?.tainted && raw0.startsWith('$'))) {
    return argResult('unparseable');
  }
  const cmd = basenameCommand(raw0);
  if (!cmd || raw0.includes('*')) return argResult('unparseable');

  let result: ArgClass;
  if (cmd === 'sudo' || cmd === 'su' || cmd === 'doas' || cmd === 'pkexec') {
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
    result = argResult(cls, { filesystemWrite: cls === 'local_write_scoped' });
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
    let j = 1;
    const flags = flagSet(slicedArgv);
    if (flags.has('-i') || flags.has('-0')) j = slicedArgv.findIndex((a, idx) => idx > 0 && !a.startsWith('-') && !isEnvAssign(a));
    while (j < slicedArgv.length && (slicedArgv[j]?.startsWith('-') || isEnvAssign(slicedArgv[j] ?? ''))) j += 1;
    if (j < 0 || j >= slicedArgv.length) result = argResult('privilege');
    else result = classifyArgv(slicedArgv.slice(j), slicedWords.slice(j));
  } else if (cmd === 'dd' || cmd === 'mkfs' || cmd.startsWith('mkfs.') || cmd === 'truncate' || cmd === 'shred') {
    result = argResult('destructive_local');
  } else if (cmd === 'find') {
    if (slicedArgv.some((a) => a === '-delete' || a === '-exec' || a === '-execdir' || a === '-ok')) {
      result = argResult('destructive_local');
    } else {
      result = argResult('read_only');
    }
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
    if (cmd === 'eval' || slicedArgv.includes('-c')) {
      const scriptWords: Word[] =
        cmd === 'eval'
          ? [
              { text: 'sh', substitutions: [], tainted: false },
              { text: '-c', substitutions: [], tainted: false },
              ...slicedWords.slice(1),
            ]
          : slicedWords;
      const scriptArgv = cmd === 'eval' ? ['sh', '-c', ...slicedArgv.slice(1)] : slicedArgv;
      result = classifyShellC(scriptArgv, scriptWords);
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
    result = argResult('read_only');
  } else if (cmd === 'make') {
    result = argResult('unparseable');
  } else if (raw0.startsWith('./') || raw0.startsWith('../') || raw0.includes('/')) {
    result = argResult('unparseable');
  } else {
    result = argResult('unparseable');
  }

  if (slicedArgv.some((a) => isSecretPath(a)) && CLASS_RANK[result.commandClass] < CLASS_RANK.privilege) {
    result = { ...result, commandClass: 'privilege' };
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
      result = mergeArg(result, classifyCommandText(sub));
    }
  }
  return result;
}

function applyRedirects(result: ArgClass, redirects: Redirect[]): ArgClass {
  let next = result;
  for (const redir of redirects) {
    if (redir.heredoc) {
      next = mergeArg(next, argResult('unparseable'));
      continue;
    }
    if (!redir.op.includes('>')) continue;
    const target = redir.target?.text ?? '';
    if (!target || /^[0-9]+$/.test(target) || target === '-' || target === '&1' || target === '&2') continue;
    const kind = pathKind(target);
    if (kind === 'null') continue;
    if (kind === 'secret') next = mergeArg(next, argResult('privilege'));
    else if (kind === 'escape') next = mergeArg(next, argResult('destructive_local'));
    else if (kind === 'build') next = mergeArg(next, argResult('local_write_scoped', { filesystemWrite: true }));
    else next = mergeArg(next, argResult('destructive_local'));
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

function classifyStatement(statement: Statement): ArgClass {
  const stages = statement.stages.map(classifyStage);
  if (stages.length === 0) return argResult('unparseable');
  let merged = stages.reduce(mergeArg, argResult('read_only'));
  const fetcher = stages.some((s) => s.fetcher);
  const decode = stages.some((s) => s.base64Decode);
  const sink = stages.some((s, idx) => idx > 0 && s.interpreterSink);
  if ((fetcher || decode) && sink) {
    merged = {
      ...merged,
      commandClass: 'network_exec',
      obfuscated: merged.obfuscated || decode,
    };
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
      parts: [{ commandClass: 'unparseable', text: command }],
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
    parts: partResults.map((p) => ({ commandClass: p.result.commandClass, text: p.text })),
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

const DESTRUCTIVE_MARKERS = [
  'git clean',
  'git reset --hard',
  'reset --hard',
  'git checkout --',
  'git restore',
  'stash drop',
  'stash clear',
  'rm -rf',
  'rm -fr',
  'mkfs',
];

function mandateNamesDestructive(mandateText: string, commandText: string): boolean {
  const command = commandText.toLowerCase();
  return DESTRUCTIVE_MARKERS.some(
    (marker) => command.includes(marker) && mentionIsAuthorized(mandateText, marker),
  );
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

/**
 * Class gate only. Kind fit (mandate_kind === local_command, no caller
 * widen) is a separate check. `null` when the text is not a command.
 *
 * Filesystem writes (`rm -fr ./build`) open only with granted.workspace.
 * Git-local writes (`git commit`) also open on an explicit local-repo mandate.
 */
export function localCommandEffect(input: LocalCommandEffectInput): LocalCommandEffect | null {
  if (!input.analysis.recognized || !input.analysis.commandClass) return null;
  let cls = input.analysis.commandClass;
  if (cwdEscapes(input.cwd)) {
    if (cls === 'read_only') cls = 'unparseable';
    else if (cls === 'local_write_scoped') cls = 'destructive_local';
  }
  const mandateText = input.mandateText ?? '';
  switch (cls) {
    case 'privilege':
      return 'block';
    case 'destructive_local':
      return mandateNamesDestructive(mandateText, input.analysis.commandText ?? '') ? 'open' : 'block';
    case 'remote_write':
      if (input.analysis.forceRemote) {
        return mandateNamesForce(mandateText) ? 'open' : 'block';
      }
      if (input.allowRemoteWrite === true || input.mandateKind === 'deploy_ship') return 'open';
      return 'block';
    case 'network_exec':
      return input.allowNetwork === true ? 'uncertain' : 'block';
    case 'network_fetch':
    case 'unparseable':
      return 'uncertain';
    case 'local_write_scoped':
      if (input.analysis.filesystemWrite) {
        return hasWorkspace(input.workspace) ? 'open' : 'uncertain';
      }
      return hasWorkspace(input.workspace) || mandateAuthorizesLocalRepo(mandateText) ? 'open' : 'uncertain';
    case 'read_only':
      return 'open';
    default:
      return 'uncertain';
  }
}
