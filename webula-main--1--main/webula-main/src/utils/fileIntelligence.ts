export type FileIntelligenceKind = 'source' | 'markdown' | 'package' | 'config' | 'data' | 'text';

export interface PackageIntelligence {
  name?: string;
  version?: string;
  packageManager?: string;
  type?: string;
  main?: string;
  module?: string;
  types?: string;
  scripts: string[];
  dependencyCount: number;
  devDependencyCount: number;
  peerDependencyCount: number;
  optionalDependencyCount: number;
  workspaceCount: number;
}

export interface FileIntelligence {
  kind: FileIntelligenceKind;
  language?: string;
  lineCount: number;
  charCount: number;
  imports: string[];
  exports: string[];
  symbols: string[];
  headings: string[];
  links: string[];
  scripts: string[];
  configKeys: string[];
  entryPoints: string[];
  frameworkHints: string[];
  notes: string[];
  packageSummary?: PackageIntelligence;
}

const JS_IMPORT_RE = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const JS_REQUIRE_RE = /(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g;
const JS_EXPORT_FROM_RE = /export\s+(?:type\s+)?\{[^}]+\}\s+from\s+['"]([^'"]+)['"]/g;
const JS_EXPORT_ALL_FROM_RE = /export\s+\*\s+from\s+['"]([^'"]+)['"]/g;
const JS_EXPORT_STAR_AS_RE = /export\s+\*\s+as\s+[A-Za-z0-9_$]+\s+from\s+['"]([^'"]+)['"]/g;
const JS_EXPORT_NAME_RE = /export\s+(?:default\s+)?(?:class|function|const|let|var|interface|type|enum)\s+([A-Za-z0-9_$]+)/g;
const JS_EXPORT_LIST_RE = /export\s+\{([^}]+)\}/g;
const JS_TOP_LEVEL_SYMBOL_PATTERNS = [
  /^\s*export\s+default\s+function\s+([A-Za-z0-9_$]+)/gm,
  /^\s*export\s+default\s+class\s+([A-Za-z0-9_$]+)/gm,
  /^\s*export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/gm,
  /^\s*(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/gm,
  /^\s*export\s+class\s+([A-Za-z0-9_$]+)/gm,
  /^\s*class\s+([A-Za-z0-9_$]+)/gm,
  /^\s*export\s+interface\s+([A-Za-z0-9_$]+)/gm,
  /^\s*interface\s+([A-Za-z0-9_$]+)/gm,
  /^\s*export\s+type\s+([A-Za-z0-9_$]+)/gm,
  /^\s*type\s+([A-Za-z0-9_$]+)/gm,
  /^\s*export\s+enum\s+([A-Za-z0-9_$]+)/gm,
  /^\s*enum\s+([A-Za-z0-9_$]+)/gm,
  /^\s*export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::|=)/gm,
  /^\s*(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::|=)/gm,
];
const PY_IMPORT_RE = /^\s*import\s+([A-Za-z0-9_., ]+)/gm;
const PY_FROM_RE = /^\s*from\s+([.\w]+)\s+import\s+/gm;
const PY_SYMBOL_RE = /^\s*(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(/gm;
const PY_CLASS_RE = /^\s*class\s+([A-Za-z0-9_]+)\b/gm;
const MD_HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*)$/gm;
const MD_LINK_RE = /\[[^\]]+\]\(([^)]+)\)/g;
const YAML_KEY_RE = /^\s*([A-Za-z0-9_.-]+)\s*:/gm;
const TOML_KEY_RE = /^\s*([A-Za-z0-9_.-]+)\s*=/gm;
const ENV_KEY_RE = /^\s*([A-Za-z0-9_.-]+)\s*=/gm;

const getExt = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
};

const getBaseName = (name: string) => name.split(/[\\/]/).pop()?.toLowerCase() ?? name.toLowerCase();

const uniquePush = (list: string[], value: string) => {
  if (!value) return;
  if (!list.includes(value)) list.push(value);
};

const collectMatches = (text: string, regex: RegExp, mapper: (value: string, match: RegExpExecArray) => string = (value) => value) => {
  regex.lastIndex = 0;
  const results: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) {
    const value = mapper(match[1] ?? match[0], match).trim();
    uniquePush(results, value);
  }
  return results;
};

const collectPackageEntries = (value: unknown, entries: Set<string>) => {
  if (!value) return;
  if (typeof value === 'string') {
    entries.add(value.trim());
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectPackageEntries(item, entries));
    return;
  }
  if (typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((item) => collectPackageEntries(item, entries));
  }
};

const detectLanguage = (fileName: string, kind: FileIntelligenceKind) => {
  const lower = fileName.toLowerCase();
  const ext = getExt(lower);

  if (lower === 'dockerfile') return 'dockerfile';
  if (lower === '.env' || lower.startsWith('.env.')) return 'env';
  if (kind === 'markdown' || ext === '.md' || ext === '.mdx') return 'markdown';
  if (ext === '.tsx') return 'tsx';
  if (ext === '.ts') return 'typescript';
  if (ext === '.jsx') return 'jsx';
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return 'javascript';
  if (ext === '.py') return 'python';
  if (ext === '.json') return 'json';
  if (ext === '.toml') return 'toml';
  if (ext === '.yaml' || ext === '.yml') return 'yaml';
  if (ext === '.css') return 'css';
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.jl') return 'julia';
  if (ext === '.rs') return 'rust';
  if (ext === '.go') return 'go';
  if (ext === '.java') return 'java';
  return undefined;
};

const inferKind = (fileName: string, text: string): FileIntelligenceKind => {
  const lower = fileName.toLowerCase();
  const ext = getExt(lower);

  if (getBaseName(lower) === 'package.json') return 'package';
  if (lower === 'dockerfile' || lower === 'docker-compose.yml' || lower === 'docker-compose.yaml') return 'config';
  if (lower.startsWith('.env')) return 'config';
  if (['.json', '.toml', '.yaml', '.yml', '.ini', '.cfg', '.conf'].includes(ext)) return 'config';
  if (ext === '.md' || ext === '.mdx') return 'markdown';
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.jl', '.go', '.rs', '.java', '.css', '.html', '.htm', '.sh'].includes(ext)) return 'source';
  if (text.trim()) return 'text';
  return 'text';
};

const collectJsSymbols = (text: string) => {
  const symbols = new Set<string>();
  JS_TOP_LEVEL_SYMBOL_PATTERNS.forEach((pattern) => {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      symbols.add(match[1]);
    }
  });
  return Array.from(symbols);
};

const collectJsExports = (text: string) => {
  const exports = new Set<string>();
  collectMatches(text, JS_EXPORT_NAME_RE).forEach((item) => exports.add(item));
  collectMatches(text, JS_EXPORT_LIST_RE, (value) => value)
    .forEach((chunk) => {
      chunk
        .split(',')
        .map((part) => part.trim().split(' as ')[0].trim())
        .filter(Boolean)
        .forEach((name) => exports.add(name));
    });
  if (/export\s+default\b/.test(text)) {
    exports.add('default export');
  }
  return Array.from(exports);
};

const collectJsImports = (text: string) => {
  const imports = new Set<string>();
  collectMatches(text, JS_IMPORT_RE).forEach((item) => imports.add(item));
  collectMatches(text, JS_REQUIRE_RE).forEach((item) => imports.add(item));
  collectMatches(text, JS_EXPORT_FROM_RE).forEach((item) => imports.add(item));
  collectMatches(text, JS_EXPORT_ALL_FROM_RE).forEach((item) => imports.add(item));
  collectMatches(text, JS_EXPORT_STAR_AS_RE).forEach((item) => imports.add(item));
  return Array.from(imports);
};

const collectPythonImports = (text: string) => {
  const imports = new Set<string>();
  collectMatches(text, PY_IMPORT_RE, (value) => value)
    .forEach((line) => {
      line.split(',').forEach((entry) => {
        const clean = entry.trim().split(' as ')[0].trim();
        if (clean) imports.add(clean);
      });
    });
  collectMatches(text, PY_FROM_RE).forEach((item) => imports.add(item));
  return Array.from(imports);
};

const collectPythonSymbols = (text: string) => {
  const symbols = new Set<string>();
  collectMatches(text, PY_SYMBOL_RE).forEach((item) => symbols.add(item));
  collectMatches(text, PY_CLASS_RE).forEach((item) => symbols.add(item));
  return Array.from(symbols);
};

const collectMarkdownHeadings = (text: string) => collectMatches(text, MD_HEADING_RE, (_, match) => {
  const level = match[1].length;
  const title = match[2].trim().replace(/\s+/g, ' ');
  return `H${level}: ${title}`;
});

const collectMarkdownLinks = (text: string) => collectMatches(text, MD_LINK_RE);

const collectObjectKeys = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>);
};

const collectYamlKeys = (text: string) => collectMatches(text, YAML_KEY_RE);

const collectTomlKeys = (text: string) => collectMatches(text, TOML_KEY_RE);

const collectEnvKeys = (text: string) => collectMatches(text, ENV_KEY_RE);

const buildPackageSummary = (fileName: string, text: string) => {
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    const dependencies = collectObjectKeys(json.dependencies);
    const devDependencies = collectObjectKeys(json.devDependencies);
    const peerDependencies = collectObjectKeys(json.peerDependencies);
    const optionalDependencies = collectObjectKeys(json.optionalDependencies);
    const scripts = collectObjectKeys(json.scripts);
    const entryPoints = new Set<string>();

    collectPackageEntries(json.main, entryPoints);
    collectPackageEntries(json.module, entryPoints);
    collectPackageEntries(json.types ?? json.typings, entryPoints);
    collectPackageEntries(json.bin, entryPoints);
    collectPackageEntries(json.exports, entryPoints);

    const summary: PackageIntelligence = {
      name: typeof json.name === 'string' ? json.name : undefined,
      version: typeof json.version === 'string' ? json.version : undefined,
      packageManager: typeof json.packageManager === 'string' ? json.packageManager : undefined,
      type: typeof json.type === 'string' ? json.type : undefined,
      main: typeof json.main === 'string' ? json.main : undefined,
      module: typeof json.module === 'string' ? json.module : undefined,
      types: typeof json.types === 'string' ? json.types : (typeof json.typings === 'string' ? json.typings : undefined),
      scripts,
      dependencyCount: dependencies.length,
      devDependencyCount: devDependencies.length,
      peerDependencyCount: peerDependencies.length,
      optionalDependencyCount: optionalDependencies.length,
      workspaceCount: Array.isArray(json.workspaces)
        ? json.workspaces.length
        : Array.isArray((json.workspaces as { packages?: unknown[] } | undefined)?.packages)
          ? (json.workspaces as { packages?: unknown[] }).packages?.length ?? 0
          : 0,
    };

    const imports = Array.from(new Set([
      ...dependencies,
      ...devDependencies,
      ...peerDependencies,
      ...optionalDependencies,
    ]));

    const entryPointsList = Array.from(entryPoints);
    const symbols = [
      ...(summary.name ? [summary.name] : []),
      ...(summary.version ? [`version:${summary.version}`] : []),
      ...scripts.map((script) => `script:${script}`),
      ...entryPointsList.map((entry) => `entry:${entry}`),
    ];

    const notes = [
      `Detected package manifest${summary.name ? ` for ${summary.name}` : ''}.`,
      `${dependencies.length + devDependencies.length + peerDependencies.length + optionalDependencies.length} declared dependency entries.`,
    ];

    return {
      kind: 'package' as const,
      language: 'json',
      imports,
      exports: [],
      symbols,
      headings: [],
      links: [],
      scripts,
      configKeys: Object.keys(json),
      entryPoints: entryPointsList,
      frameworkHints: inferFrameworkHints(fileName, text, imports, summary),
      notes,
      packageSummary: summary,
    };
  } catch {
    return null;
  }
};

const buildTomlAnalysis = (fileName: string, text: string) => {
  const lower = fileName.toLowerCase();
  const imports = collectTomlKeys(text);
  const entryPoints = lower.includes('cargo.toml') ? ['src/main.rs', 'src/lib.rs'] : [];
  const notes = lower.includes('cargo.toml')
    ? ['Detected Rust manifest.']
    : lower.includes('project.toml')
      ? ['Detected Julia project manifest.']
      : ['Detected TOML configuration.'];

  return {
    kind: lower.includes('cargo.toml') || lower.includes('project.toml') ? 'config' as const : 'data' as const,
    language: 'toml',
    imports,
    exports: [],
    symbols: imports.map((item) => `key:${item}`),
    headings: [],
    links: [],
    scripts: [],
    configKeys: imports,
    entryPoints,
    frameworkHints: inferFrameworkHints(fileName, text, imports),
    notes,
  };
};

const buildYamlAnalysis = (fileName: string, text: string) => {
  const imports = collectYamlKeys(text);
  const notes = [getBaseName(fileName) === 'vercel.json' ? 'Deployment configuration.' : 'Detected YAML configuration.'];

  return {
    kind: 'config' as const,
    language: 'yaml',
    imports,
    exports: [],
    symbols: imports.map((item) => `key:${item}`),
    headings: [],
    links: [],
    scripts: [],
    configKeys: imports,
    entryPoints: [],
    frameworkHints: inferFrameworkHints(fileName, text, imports),
    notes,
  };
};

const buildEnvAnalysis = (fileName: string, text: string) => {
  const imports = collectEnvKeys(text);
  return {
    kind: 'config' as const,
    language: 'env',
    imports,
    exports: [],
    symbols: imports.map((item) => `env:${item}`),
    headings: [],
    links: [],
    scripts: [],
    configKeys: imports,
    entryPoints: [],
    frameworkHints: inferFrameworkHints(fileName, text, imports),
    notes: ['Environment file detected.'],
  };
};

const buildMarkdownAnalysis = (fileName: string, text: string) => {
  const headings = collectMarkdownHeadings(text);
  const links = collectMarkdownLinks(text);
  const notes = headings.length
    ? [`Markdown outline with ${headings.length} heading${headings.length === 1 ? '' : 's'}.`]
    : ['Markdown document detected.'];

  return {
    kind: 'markdown' as const,
    language: 'markdown',
    imports: [],
    exports: [],
    symbols: headings.slice(),
    headings,
    links,
    scripts: [],
    configKeys: [],
    entryPoints: [],
    frameworkHints: inferFrameworkHints(fileName, text, []),
    notes,
  };
};

const buildSourceAnalysis = (fileName: string, text: string) => {
  const ext = getExt(fileName);
  const lower = fileName.toLowerCase();
  const isJsLike = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext);
  const imports = isJsLike ? collectJsImports(text) : ext === '.py' ? collectPythonImports(text) : [];
  const exports = isJsLike ? collectJsExports(text) : [];
  const symbols = isJsLike ? collectJsSymbols(text) : ext === '.py' ? collectPythonSymbols(text) : [];
  const entryPoints: string[] = [];

  if (/(^|\/)(main|index|app)\.(tsx?|jsx?|mjs|cjs|py|jl|go|rs|java)$/i.test(lower)) {
    entryPoints.push(fileName);
  }
  if (/electron\/main/i.test(lower) || /main\.cjs$/i.test(lower)) {
    entryPoints.push(fileName);
  }

  const notes = [
    `Detected ${imports.length} import${imports.length === 1 ? '' : 's'} and ${exports.length} export${exports.length === 1 ? '' : 's'}.`,
  ];

  return {
    kind: 'source' as const,
    language: detectLanguage(fileName, 'source'),
    imports,
    exports,
    symbols,
    headings: [],
    links: [],
    scripts: [],
    configKeys: [],
    entryPoints,
    frameworkHints: inferFrameworkHints(fileName, text, imports),
    notes,
  };
};

const inferFrameworkHints = (
  fileName: string,
  text: string,
  imports: string[],
  packageSummary?: PackageIntelligence,
) => {
  const hints = new Set<string>();
  const lowerName = fileName.toLowerCase();
  const lowerText = text.toLowerCase();
  const importList = imports.map((item) => item.toLowerCase());
  const packageDeps = packageSummary ? [
    ...(packageSummary.name ? [packageSummary.name.toLowerCase()] : []),
    ...packageSummary.scripts.map((item) => item.toLowerCase()),
  ] : [];

  const has = (value: string) => importList.includes(value) || packageDeps.includes(value) || lowerText.includes(value);

  if (has('react') || has('react-dom') || lowerName.endsWith('.tsx') || lowerName.endsWith('.jsx')) {
    hints.add('React');
  }
  if (has('vite') || lowerName.includes('vite.config')) {
    hints.add('Vite');
  }
  if (has('electron') || lowerName.includes('electron/')) {
    hints.add('Electron');
  }
  if (has('next') || lowerName.includes('next.config')) {
    hints.add('Next.js');
  }
  if (has('three')) {
    hints.add('Three.js / 3D rendering');
  }
  if (has('tailwindcss')) {
    hints.add('Tailwind CSS');
  }
  if (has('ollama') || lowerText.includes('11434')) {
    hints.add('Local Ollama integration');
  }
  if (lowerName.includes('vercel.json') || has('@vercel/analytics') || has('vercel')) {
    hints.add('Vercel deployment');
  }
  if (has('typescript') || lowerName.endsWith('.ts') || lowerName.endsWith('.tsx')) {
    hints.add('TypeScript');
  }
  if (has('python') || lowerName.endsWith('.py') || lowerName.includes('pyproject.toml')) {
    hints.add('Python');
  }
  if (has('rust') || lowerName.includes('cargo.toml') || lowerName.endsWith('.rs')) {
    hints.add('Rust');
  }
  if (has('julia') || lowerName.endsWith('.jl') || lowerName.includes('project.toml')) {
    hints.add('Julia');
  }

  return Array.from(hints);
};

export const analyzeTextFile = (fileName: string, text: string): FileIntelligence => {
  const lineCount = text.length ? text.split(/\r?\n/).length : 0;
  const charCount = text.length;
  const kind = inferKind(fileName, text);
  const language = detectLanguage(fileName, kind);
  const lowerName = fileName.toLowerCase();

  if (kind === 'package') {
    const packageAnalysis = buildPackageSummary(fileName, text);
    if (packageAnalysis) {
      return {
        ...packageAnalysis,
        lineCount,
        charCount,
      };
    }
  }

  if (kind === 'markdown') {
    return {
      ...buildMarkdownAnalysis(fileName, text),
      lineCount,
      charCount,
    };
  }

  if (lowerName === 'dockerfile' || lowerName === 'docker-compose.yml' || lowerName === 'docker-compose.yaml') {
    const importNames = collectYamlKeys(text);
    return {
      kind: 'config',
      language: 'dockerfile',
      lineCount,
      charCount,
      imports: importNames,
      exports: [],
      symbols: importNames.map((item) => `key:${item}`),
      headings: [],
      links: [],
      scripts: [],
      configKeys: importNames,
      entryPoints: [],
      frameworkHints: inferFrameworkHints(fileName, text, importNames),
      notes: ['Deployment/runtime configuration detected.'],
    };
  }

  if (lowerName === '.env' || lowerName.startsWith('.env.')) {
    return {
      ...buildEnvAnalysis(fileName, text),
      lineCount,
      charCount,
    };
  }

  if (kind === 'config' && (lowerName.endsWith('.json') || lowerName.endsWith('.yaml') || lowerName.endsWith('.yml'))) {
    const jsonLike = lowerName.endsWith('.json');
    if (jsonLike) {
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const keys = Object.keys(parsed);
        const imports = keys.filter((key) => !['name', 'version', 'scripts', 'dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].includes(key));
        return {
          kind: 'config',
          language: 'json',
          lineCount,
          charCount,
          imports,
          exports: [],
          symbols: keys.map((key) => `key:${key}`),
          headings: [],
          links: [],
          scripts: [],
          configKeys: keys,
          entryPoints: [],
          frameworkHints: inferFrameworkHints(fileName, text, keys),
          notes: ['Structured JSON configuration detected.'],
        };
      } catch {
        return {
          kind: 'data',
          language: 'json',
          lineCount,
          charCount,
          imports: [],
          exports: [],
          symbols: [],
          headings: [],
          links: [],
          scripts: [],
          configKeys: [],
          entryPoints: [],
          frameworkHints: inferFrameworkHints(fileName, text, []),
          notes: ['JSON data detected, but parsing failed.'],
        };
      }
    }
    return {
      ...buildYamlAnalysis(fileName, text),
      lineCount,
      charCount,
    };
  }

  if (lowerName.endsWith('.toml')) {
    return {
      ...buildTomlAnalysis(fileName, text),
      lineCount,
      charCount,
    };
  }

  if (kind === 'source') {
    return {
      ...buildSourceAnalysis(fileName, text),
      lineCount,
      charCount,
    };
  }

  return {
    kind: 'text',
    language,
    lineCount,
    charCount,
    imports: [],
    exports: [],
    symbols: [],
    headings: collectMarkdownHeadings(text),
    links: collectMarkdownLinks(text),
    scripts: [],
    configKeys: [],
    entryPoints: [],
    frameworkHints: inferFrameworkHints(fileName, text, []),
    notes: ['Plain text file detected.'],
  };
};
