#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, resolve } from 'node:path';

const KNOWN_JL_ENGINE_ROOT = 'C:\\Users\\J_lin\\Desktop\\JL_ENGINE_V3.1';
const DEFAULT_PERSONA = 'SparkByte';

const HELP_TEXT = `
Usage:
  npm run run:mpf
  npm run run:mpf -- <persona-name>
  npm run run:mpf -- <path-to-file.mpf-or-json>
  npm run run:mpf -- --persona <persona-name>
  npm run run:mpf -- <path-to-file.mpf-or-json> [--engine <path-or-command>] [-- <extra args>]

Environment options:
  JL_ENGINE_EXE    Direct engine executable/command path (used like: <engine> <file> ...)
  JL_ENGINE_CMD    Full command template. Use "{file}" placeholder.
                   Example: JL_ENGINE_CMD='C:\\\\Tools\\\\jl-engine.exe --run "{file}"'
  JL_ENGINE_ROOT   JL Engine project root (auto-detects run_engine_cli.cmd + persona registry)

Examples:
  npm run run:mpf
  npm run run:mpf -- sparkbyte
  npm run run:mpf -- ./personas/SparkByte_Full.json
  npm run run:mpf -- --persona SparkByte -- --version
  npm run run:mpf -- ./examples/test.mpf --engine "C:\\\\Tools\\\\jl-engine.exe"
`.trim();

const quote = (value) => `"${String(value).replaceAll('"', '\\"')}"`;
const lowerPath = (value) => String(value).replace(/\//g, '\\').toLowerCase();

const fail = (message, code = 1) => {
  console.error(message);
  process.exit(code);
};

const runShell = (command) => new Promise((resolvePromise) => {
  const child = spawn(command, {
    stdio: 'inherit',
    shell: true,
  });
  child.on('exit', (code, signal) => resolvePromise({ code: code ?? 1, signal }));
  child.on('error', (error) => {
    console.error(`Failed to start command: ${error.message}`);
    resolvePromise({ code: 1, signal: null });
  });
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
});

const runBinary = (command, args, shell = false) => new Promise((resolvePromise) => {
  const child = spawn(command, args, {
    stdio: 'inherit',
    shell,
  });
  child.on('exit', (code, signal) => resolvePromise({ code: code ?? 1, signal }));
  child.on('error', (error) => {
    console.error(`Failed to start executable "${command}": ${error.message}`);
    resolvePromise({ code: 1, signal: null });
  });
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
});

const isCmdScript = (value) => /\.(cmd|bat)$/i.test(value);

const resolveJlRoot = () => {
  const envRoot = (process.env.JL_ENGINE_ROOT || '').trim();
  if (envRoot && existsSync(envRoot)) return resolve(envRoot);
  if (existsSync(KNOWN_JL_ENGINE_ROOT)) return resolve(KNOWN_JL_ENGINE_ROOT);
  return '';
};

const loadPersonaRegistry = (jlRoot) => {
  const empty = {
    profiles: {},
    registryPath: jlRoot ? resolve(jlRoot, 'personas', 'Personas.mpf.json') : '',
  };
  if (!jlRoot) return empty;
  if (!existsSync(empty.registryPath)) return empty;
  try {
    const raw = readFileSync(empty.registryPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return empty;
    return {
      profiles: parsed,
      registryPath: empty.registryPath,
    };
  } catch (error) {
    console.warn(`Failed to parse persona registry: ${error.message}`);
    return empty;
  }
};

const resolvePersonaName = (profiles, rawName) => {
  const target = (rawName || '').trim();
  if (!target) return '';
  if (Object.prototype.hasOwnProperty.call(profiles, target)) {
    return target;
  }
  const matched = Object.keys(profiles).find((name) => name.toLowerCase() === target.toLowerCase());
  return matched || '';
};

const detectPersonaFromRegistry = (jlRoot, profiles, targetFilePath) => {
  if (!jlRoot) return '';
  const targetNorm = lowerPath(targetFilePath);
  const targetBase = basename(targetFilePath).toLowerCase();
  for (const [personaName, profile] of Object.entries(profiles)) {
    if (!profile || typeof profile !== 'object') continue;
    const personaFile = profile.persona_file;
    if (typeof personaFile !== 'string' || !personaFile.trim()) continue;
    const expectedPath = resolve(jlRoot, 'personas', personaFile);
    if (lowerPath(expectedPath) === targetNorm || personaFile.toLowerCase() === targetBase) {
      return personaName;
    }
  }
  return '';
};

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(HELP_TEXT);
  process.exit(0);
}

let inputToken = '';
let personaArg = '';
let engineArg = '';
let passThroughIndex = -1;
for (let i = 0; i < argv.length; i += 1) {
  const token = argv[i];
  if (token === '--') {
    passThroughIndex = i;
    break;
  }
  if (token === '--engine') {
    const next = argv[i + 1];
    if (!next || next.startsWith('-')) {
      fail('Missing value for --engine');
    }
    engineArg = next;
    i += 1;
    continue;
  }
  if (token === '--persona') {
    const next = argv[i + 1];
    if (!next || next.startsWith('-')) {
      fail('Missing value for --persona');
    }
    personaArg = next;
    i += 1;
    continue;
  }
  if (!inputToken) {
    inputToken = token;
  }
}

const extraArgs = passThroughIndex >= 0 ? argv.slice(passThroughIndex + 1) : [];
const commandTemplate = (process.env.JL_ENGINE_CMD || '').trim();
const engineExecutable = (
  engineArg
  || process.env.JL_ENGINE_EXE
  || process.env.JL_ENGINE_PATH
  || process.env.JL_ENGINE_BIN
  || ''
).trim();
const jlRoot = resolveJlRoot();
const runEngineCliPath = jlRoot ? resolve(jlRoot, 'run_engine_cli.cmd') : '';
const { profiles: personaProfiles, registryPath } = loadPersonaRegistry(jlRoot);
const knownPersonaNames = Object.keys(personaProfiles);

const finish = ({ code, signal }) => {
  if (signal) {
    fail(`Process terminated by signal: ${signal}`);
  }
  process.exit(code);
};

const runJlCliWithPersona = async (personaCandidateRaw) => {
  if (!runEngineCliPath || !existsSync(runEngineCliPath)) {
    fail(
      [
        'JL Engine CLI launcher not found.',
        `Expected: ${runEngineCliPath || '(missing JL_ENGINE_ROOT)'}`,
        'Set JL_ENGINE_ROOT or pass --engine / JL_ENGINE_CMD with a custom runtime command.',
      ].join('\n'),
    );
  }

  let personaName = (personaCandidateRaw || '').trim();
  if (!personaName) {
    personaName = DEFAULT_PERSONA;
  }
  if (knownPersonaNames.length > 0) {
    const matched = resolvePersonaName(personaProfiles, personaName);
    if (!matched) {
      fail(
        [
          `Persona "${personaName}" not found in registry.`,
          `Registry: ${registryPath}`,
          `Available: ${knownPersonaNames.join(', ')}`,
        ].join('\n'),
      );
    }
    personaName = matched;
  }

  console.log(`[run:mpf] Launching JL Engine CLI with persona "${personaName}"`);
  let tempConfigPath = '';
  const args = ['--config', '', ...extraArgs];
  tempConfigPath = resolve(tmpdir(), `jl-engine-config-${randomUUID()}.json`);
  writeFileSync(
    tempConfigPath,
    JSON.stringify({ default_persona_name: personaName }, null, 2),
    'utf8',
  );
  args[1] = tempConfigPath;
  try {
    const command = [quote(runEngineCliPath), ...args.map(quote)].join(' ');
    finish(await runShell(command));
  } finally {
    if (tempConfigPath && existsSync(tempConfigPath)) {
      try {
        unlinkSync(tempConfigPath);
      } catch {
        // Ignore temp cleanup failures.
      }
    }
  }
};

const runInputFile = async (rawPath) => {
  const absoluteFilePath = resolve(process.cwd(), rawPath);
  if (!existsSync(absoluteFilePath)) {
    fail(`Input file not found: ${absoluteFilePath}`);
  }

  if (!absoluteFilePath.toLowerCase().endsWith('.mpf') && !absoluteFilePath.toLowerCase().endsWith('.json')) {
    console.warn(`Warning: expected .mpf or .json input, got: ${absoluteFilePath}`);
  }

  if (commandTemplate) {
    const hasPlaceholder = commandTemplate.includes('{file}');
    const base = hasPlaceholder
      ? commandTemplate.replaceAll('{file}', quote(absoluteFilePath))
      : `${commandTemplate} ${quote(absoluteFilePath)}`;
    const full = extraArgs.length ? `${base} ${extraArgs.map(quote).join(' ')}` : base;
    finish(await runShell(full));
  }

  if (engineExecutable) {
    if (isCmdScript(engineExecutable)) {
      const command = [quote(engineExecutable), quote(absoluteFilePath), ...extraArgs.map(quote)].join(' ');
      finish(await runShell(command));
    }
    finish(await runBinary(engineExecutable, [absoluteFilePath, ...extraArgs], false));
  }

  const ext = extname(absoluteFilePath).toLowerCase();
  if (ext === '.json') {
    const personaFromFile = detectPersonaFromRegistry(jlRoot, personaProfiles, absoluteFilePath);
    if (!personaFromFile) {
      fail(
        [
          `JSON persona file was provided but not found in registry: ${absoluteFilePath}`,
          `Expected mapping in: ${registryPath || '(registry not found)'}`,
          'Register the file in Personas.mpf.json or pass --persona <name>.',
        ].join('\n'),
      );
    }
    await runJlCliWithPersona(personaFromFile);
    return;
  }

  if (ext === '.mpf') {
    fail(
      [
        'Direct .mpf execution is not exposed by the current JL CLI entrypoint.',
        'Use a registered persona JSON (or --persona), or pass a custom --engine/JL_ENGINE_CMD that knows how to run .mpf.',
      ].join('\n'),
    );
  }

  fail('Unsupported input file type.');
};

const inputPathCandidate = inputToken ? resolve(process.cwd(), inputToken) : '';
const inputLooksLikePath = !!inputToken && (/[/\\]/.test(inputToken) || /\.(json|mpf)$/i.test(inputToken));
const inputIsExistingPath = !!inputToken && existsSync(inputPathCandidate);

if (personaArg && inputIsExistingPath) {
  fail('Use either a file path or --persona, not both.');
}

if (inputIsExistingPath) {
  await runInputFile(inputToken);
} else if (inputLooksLikePath) {
  fail(`Input file not found: ${inputPathCandidate}`);
} else {
  if (commandTemplate || engineExecutable) {
    fail(
      [
        'Persona shortcuts (no file path) are only supported with JL_ENGINE_ROOT auto mode.',
        'If using custom engine commands, pass an explicit file path.',
      ].join('\n'),
    );
  }
  const personaToRun = personaArg || inputToken || DEFAULT_PERSONA;
  await runJlCliWithPersona(personaToRun);
}
