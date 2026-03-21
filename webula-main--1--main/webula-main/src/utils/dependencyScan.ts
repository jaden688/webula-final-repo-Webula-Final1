import { analyzeTextFile, type FileIntelligence } from './fileIntelligence';

type NodeType = 'folder' | 'file' | 'image' | 'code' | 'external';

export interface DependencyInfo {
  internal: string[];
  external: string[];
  unresolved: string[];
  exports: string[];
  analysis?: FileIntelligence;
}

export interface DependencyScanSettings {
  includeNodeModules: boolean;
  groupExternalDeps: boolean;
  maxDependencyFiles: number;
  maxDependencyFileSizeKb: number;
}

export interface DependencyScanNode {
  id: string;
  name: string;
  type: NodeType;
  val?: number;
  group?: number;
  handle?: any;
}

export interface DependencyScanLink {
  source: string;
  target: string;
  kind?: 'tree' | 'dep';
}

export interface DependencyScanInput {
  nodes: DependencyScanNode[];
  links: DependencyScanLink[];
}

export interface DependencyScanResult {
  dependencyLinks: DependencyScanLink[];
  externalNodes: DependencyScanNode[];
  dependencyMap: Record<string, DependencyInfo>;
  reverseDependencyMap: Record<string, string[]>;
  stats: {
    filesParsed: number;
    depLinks: number;
    externalCount: number;
    analyzedFiles?: number;
    symbolCount?: number;
    packageCount?: number;
    headingCount?: number;
  };
}

const CODE_IMPORT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.jl', '.json', '.toml'];

const JS_IMPORT_RE = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const JS_REQUIRE_RE = /(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g;
const JS_EXPORT_RE = /export\s+(?:default\s+)?(?:class|function|const|let|var|interface|type|enum)\s+([A-Za-z0-9_$]+)/g;
const JS_EXPORT_LIST_RE = /export\s+\{([^}]+)\}/g;
const JS_EXPORT_FROM_RE = /export\s+(?:type\s+)?\{[^}]+\}\s+from\s+['"]([^'"]+)['"]/g;
const JS_EXPORT_ALL_FROM_RE = /export\s+\*\s+from\s+['"]([^'"]+)['"]/g;
const JS_EXPORT_STAR_AS_RE = /export\s+\*\s+as\s+[A-Za-z0-9_$]+\s+from\s+['"]([^'"]+)['"]/g;
const JS_DYNAMIC_IMPORT_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
const PY_IMPORT_RE = /^\s*import\s+([A-Za-z0-9_., ]+)/gm;
const PY_FROM_RE = /^\s*from\s+([.\w]+)\s+import\s+/gm;
const JL_IMPORT_RE = /^\s*(?:using|import)\s+([A-Za-z0-9_.]+)/gm;
const JL_INCLUDE_RE = /include\(\s*["']([^"']+)["']\s*\)/g;

const getExt = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
};

const normalizePath = (input: string) => {
  const parts = input.replace(/\\/g, '/').split('/');
  const stack: string[] = [];
  parts.forEach((part) => {
    if (!part || part === '.') return;
    if (part === '..') {
      if (stack.length > 1) stack.pop();
      return;
    }
    stack.push(part);
  });
  return stack.join('/');
};

const joinPath = (base: string, rel: string) => {
  const cleaned = rel.replace(/^\.?\//, '');
  return normalizePath(`${base}/${cleaned}`);
};

const extractExports = (text: string) => {
  const exports: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = JS_EXPORT_RE.exec(text))) {
    exports.push(match[1]);
  }
  while ((match = JS_EXPORT_LIST_RE.exec(text))) {
    const names = match[1]
      .split(',')
      .map((item) => item.trim().split(' as ')[0])
      .filter(Boolean);
    exports.push(...names);
  }
  return exports;
};

const parsePackageJsonDeps = (text: string) => {
  try {
    const json = JSON.parse(text);
    const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
    return sections.flatMap((section) => Object.keys(json?.[section] || {}));
  } catch {
    return [];
  }
};

const parseTomlDeps = (text: string) => {
  const match = text.match(/\[deps\]([\s\S]*?)(\n\[|$)/);
  if (!match) return [];
  return match[1]
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/))
    .filter((item): item is RegExpMatchArray => !!item)
    .map((item) => item[1]);
};

const extractImportsAndExports = (fileName: string, text: string) => {
  const ext = getExt(fileName);
  const imports: string[] = [];
  let exports: string[] = [];

  if (['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext)) {
    let match: RegExpExecArray | null;
    while ((match = JS_IMPORT_RE.exec(text))) {
      imports.push(match[1]);
    }
    while ((match = JS_REQUIRE_RE.exec(text))) {
      imports.push(match[1]);
    }
    while ((match = JS_DYNAMIC_IMPORT_RE.exec(text))) {
      imports.push(match[1]);
    }
    while ((match = JS_EXPORT_FROM_RE.exec(text))) {
      imports.push(match[1]);
    }
    while ((match = JS_EXPORT_ALL_FROM_RE.exec(text))) {
      imports.push(match[1]);
    }
    while ((match = JS_EXPORT_STAR_AS_RE.exec(text))) {
      imports.push(match[1]);
    }
    exports = extractExports(text);
  } else if (ext === '.py') {
    let match: RegExpExecArray | null;
    while ((match = PY_IMPORT_RE.exec(text))) {
      match[1].split(',').forEach((entry) => {
        const clean = entry.trim().split(' as ')[0];
        if (clean) imports.push(clean);
      });
    }
    while ((match = PY_FROM_RE.exec(text))) {
      imports.push(match[1]);
    }
  } else if (ext === '.jl') {
    let match: RegExpExecArray | null;
    while ((match = JL_IMPORT_RE.exec(text))) {
      imports.push(match[1]);
    }
    while ((match = JL_INCLUDE_RE.exec(text))) {
      imports.push(match[1]);
    }
  } else if (ext === '.json' && fileName === 'package.json') {
    imports.push(...parsePackageJsonDeps(text));
  } else if (ext === '.toml' && (fileName === 'Project.toml' || fileName === 'Cargo.toml')) {
    imports.push(...parseTomlDeps(text));
  }

  return { imports, exports };
};

const resolvePathCandidate = (
  candidate: string,
  nodeIdByPath: Map<string, string>,
  folderIds: Set<string>,
) => {
  if (nodeIdByPath.has(candidate)) return candidate;

  const hasExt = /\.[A-Za-z0-9]+$/.test(candidate);
  if (!hasExt) {
    for (const ext of CODE_IMPORT_EXTENSIONS) {
      const withExt = `${candidate}${ext}`;
      if (nodeIdByPath.has(withExt)) return withExt;
    }
  }

  if (folderIds.has(candidate)) {
    for (const ext of CODE_IMPORT_EXTENSIONS) {
      const indexPath = `${candidate}/index${ext}`;
      if (nodeIdByPath.has(indexPath)) return indexPath;
    }
    const pyInit = `${candidate}/__init__.py`;
    if (nodeIdByPath.has(pyInit)) return pyInit;
  }

  return null;
};

const resolveImportToNodeId = (
  spec: string,
  fromId: string,
  nodeIdByPath: Map<string, string>,
  folderIds: Set<string>,
) => {
  const baseDir = fromId.includes('/') ? fromId.slice(0, fromId.lastIndexOf('/')) : fromId;
  const candidate = spec.startsWith('/')
    ? normalizePath(`root/${spec.replace(/^\/+/, '')}`)
    : joinPath(baseDir, spec);

  return resolvePathCandidate(candidate, nodeIdByPath, folderIds);
};

const resolvePythonRelative = (
  spec: string,
  fromId: string,
  nodeIdByPath: Map<string, string>,
  folderIds: Set<string>,
) => {
  const dotMatch = spec.match(/^\.+/);
  if (!dotMatch) return null;
  const dotCount = dotMatch[0].length;
  const baseDir = fromId.includes('/') ? fromId.slice(0, fromId.lastIndexOf('/')) : fromId;
  const baseParts = baseDir.split('/');
  for (let i = 1; i < dotCount; i += 1) {
    if (baseParts.length > 1) baseParts.pop();
  }
  const remainder = spec.slice(dotCount).replace(/\./g, '/');
  const candidate = normalizePath(remainder ? `${baseParts.join('/')}/${remainder}` : baseParts.join('/'));
  return resolvePathCandidate(candidate, nodeIdByPath, folderIds);
};

const pushUnique = (list: string[], value: string) => {
  if (!list.includes(value)) list.push(value);
};

export const scanDependencies = async (
  tree: DependencyScanInput,
  settings: DependencyScanSettings,
): Promise<DependencyScanResult> => {
  const nodeIdByPath = new Map(tree.nodes.map((node) => [normalizePath(node.id), node.id]));
  const folderIds = new Set(tree.nodes.filter((node) => node.type === 'folder').map((node) => node.id));
  const depLinks: DependencyScanLink[] = [];
  const depLinkSet = new Set<string>();
  const depMap: Record<string, DependencyInfo> = {};
  const reverseDependencyMap: Record<string, string[]> = {};
  const addReverseDependencyEntry = (target: string, source: string) => {
    if (!reverseDependencyMap[target]) reverseDependencyMap[target] = [];
    pushUnique(reverseDependencyMap[target], source);
  };
  const externalNodeMap = new Map<string, DependencyScanNode>();
  const maxFiles = Math.max(1, settings.maxDependencyFiles);
  const maxSizeBytes = settings.maxDependencyFileSizeKb * 1024;

  const externalClusterId = 'external:cluster';
  const codeNodes = tree.nodes.filter((node) => node.type === 'code' && node.handle);
  let parsedCount = 0;
  let analyzedCount = 0;
  let symbolCount = 0;
  let packageCount = 0;
  let headingCount = 0;

  const addLink = (source: string, target: string) => {
    const key = `${source}->${target}|dep`;
    if (depLinkSet.has(key)) return;
    depLinkSet.add(key);
    depLinks.push({ source, target, kind: 'dep' });
  };

  for (const node of codeNodes) {
    if (parsedCount >= maxFiles) break;
    if (!settings.includeNodeModules && node.id.split('/').includes('node_modules')) continue;
    if (!node.handle) continue;

    const file = await node.handle.getFile();
    if (file.size > maxSizeBytes) continue;

    const text = await file.text();
    const analysis = analyzeTextFile(file.name, text);
    const { imports, exports } = extractImportsAndExports(file.name, text);
    const info: DependencyInfo = { internal: [], external: [], unresolved: [], exports: [], analysis };

    analyzedCount += 1;
    symbolCount += analysis.symbols.length;
    headingCount += analysis.headings.length;
    if (analysis.packageSummary) {
      packageCount += 1;
    }

    exports.forEach((name) => pushUnique(info.exports, name));
    const isPython = getExt(file.name) === '.py';

    for (const specRaw of imports) {
      const spec = specRaw.trim();
      if (!spec) continue;

      const normalizedSpec = spec.startsWith('node:') ? spec.replace(/^node:/, '') : spec;
      const isRelative = normalizedSpec.startsWith('.') || normalizedSpec.startsWith('/');
      let resolvedId: string | null = null;

      if (isPython && spec.startsWith('.')) {
        resolvedId = resolvePythonRelative(spec, node.id, nodeIdByPath, folderIds);
      } else if (isRelative) {
        resolvedId = resolveImportToNodeId(normalizedSpec, node.id, nodeIdByPath, folderIds);
      }

      if (resolvedId) {
        addLink(node.id, resolvedId);
        pushUnique(info.internal, resolvedId);
        addReverseDependencyEntry(resolvedId, node.id);
        continue;
      }

      if (isRelative) {
        pushUnique(info.unresolved, normalizedSpec);
        continue;
      }

      pushUnique(info.external, normalizedSpec);
    }

    if (settings.groupExternalDeps && info.external.length > 0) {
      if (!externalNodeMap.has(externalClusterId)) {
        externalNodeMap.set(externalClusterId, {
          id: externalClusterId,
          name: 'External Deps',
          type: 'external',
          val: 8,
          group: 6,
        });
      }
      addLink(node.id, externalClusterId);
    } else if (!settings.groupExternalDeps) {
      for (const extDep of info.external) {
        const externalId = `external:${extDep}`;
        if (!externalNodeMap.has(externalId)) {
          externalNodeMap.set(externalId, {
            id: externalId,
            name: extDep,
            type: 'external',
            val: 6,
            group: 6,
          });
        }
        addLink(node.id, externalId);
      }
    }

    depMap[node.id] = {
      internal: info.internal.slice().sort(),
      external: info.external.slice().sort(),
      unresolved: info.unresolved.slice().sort(),
      exports: info.exports.slice().sort(),
      analysis,
    };

    parsedCount += 1;
  }

  return {
    dependencyLinks: depLinks,
    externalNodes: Array.from(externalNodeMap.values()),
    dependencyMap: depMap,
    reverseDependencyMap,
    stats: {
      filesParsed: parsedCount,
      depLinks: depLinks.length,
      externalCount: externalNodeMap.size,
      analyzedFiles: analyzedCount,
      symbolCount,
      packageCount,
      headingCount,
    },
  };
};
