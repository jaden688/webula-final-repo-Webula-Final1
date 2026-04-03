import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import ForceGraph3D from 'react-force-graph-3d';
import * as THREE from 'three';
import { scanDependencies } from '../../src/utils/dependencyScan';
import type { DependencyInfo } from '../../src/utils/dependencyScan';
import { analyzeTextFile, type FileIntelligence } from '../../src/utils/fileIntelligence';
import {
  chatWithProvider,
  type AiProvider,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  MAX_OLLAMA_REVIEW_CHARS,
  buildOllamaCorsHint,
  formatOllamaError,  
  type OllamaChatMessage,
  reviewCodeWithProvider,
} from '../../src/utils/ollamaReviewer';
import { buildSparkByteInjectedFirstUserMessage } from '../../src/utils/sparkBytePromptInjection';

// --- Types ---
type NodeType = 'folder' | 'file' | 'image' | 'code' | 'external';

interface FileNode {
  id: string;
  name: string;
  type: NodeType;
  val: number; // Legacy size hint (used when sizeBytes is missing)
  group: number; // For coloring
  sizeBytes?: number;
  path?: string;
  handle?: any;
}

interface FileLink {
  source: string;
  target: string;
  kind?: 'tree' | 'dep';
}

interface GraphData {
  nodes: FileNode[];
  links: FileLink[];
}

type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

type RightDockTab = 'inspector' | 'editor' | 'chat' | 'review' | 'controls';

interface OllamaTagsResponse {
  models?: Array<{
    name?: string;
    model?: string;
  }>;
}

interface DependencyStats {
  filesParsed: number;
  depLinks: number;
  externalCount: number;
  analyzedFiles?: number;
  symbolCount?: number;
  packageCount?: number;
  headingCount?: number;
}

interface WorkspaceSummary {
  manifestFiles: Array<{
    id: string;
    label: string;
    packageName?: string;
    dependencyCount: number;
    devDependencyCount: number;
    scripts: string[];
    entryPoints: string[];
  }>;
  frameworkHints: string[];
  entryPoints: string[];
  scripts: string[];
  headings: string[];
  symbols: string[];
}

interface Settings {
  maxDepth: number;
  nodeBaseSize: number;
  nodeSizeScale: number;
  nodeMinSize: number;
  nodeMaxSize: number;
  folderSizeBoost: number;
  nodeGlow: number;
  linkOpacity: number;
  linkWidth: number;
  velocityDecay: number;
  alphaDecay: number;
  chargeStrength: number;
  autoRotate: boolean;
  autoRotateSpeed: number;
  showLabels: boolean;
  focusBranchMode: boolean;
  starfieldEnabled: boolean;
  starCount: number;
  starSpread: number;
  starOpacity: number;
  starSize: number;
  focusDistance: number;
  focusDistanceClose: number;
  showDependencyEdges: boolean;
  autoParseDependencies: boolean;
  includeNodeModules: boolean;
  groupExternalDeps: boolean;
  maxDependencyFiles: number;
  maxDependencyFileSizeKb: number;
  pulseIntervalMs: number;
}

// --- Mock Data (fallback) ---
const generateData = (): GraphData => {
  const nodes: FileNode[] = [
    { id: 'root', name: 'Main Nexus', type: 'folder', val: 20, group: 1, sizeBytes: 18_000_000 },
    { id: 'docs', name: 'Archives', type: 'folder', val: 10, group: 2, sizeBytes: 9_500_000 },
    { id: 'imgs', name: 'Visuals', type: 'folder', val: 10, group: 2, sizeBytes: 15_200_000 },
    { id: 'proj', name: 'Projects', type: 'folder', val: 10, group: 2, sizeBytes: 12_300_000 },
    { id: 'resume', name: 'Identity.dat', type: 'file', val: 5, group: 3, sizeBytes: 220_000 },
    { id: 'budget', name: 'Credits.xls', type: 'file', val: 5, group: 3, sizeBytes: 780_000 },
    { id: 'pic1', name: 'Memory_01.png', type: 'image', val: 5, group: 4, sizeBytes: 4_500_000 },
    { id: 'pic2', name: 'Memory_02.jpg', type: 'image', val: 5, group: 4, sizeBytes: 6_200_000 },
    { id: 'code1', name: 'Core.ts', type: 'code', val: 5, group: 5, sizeBytes: 120_000 },
    { id: 'code2', name: 'Style.css', type: 'code', val: 5, group: 5, sizeBytes: 66_000 },
    { id: 'code3', name: 'Utils.ts', type: 'code', val: 5, group: 5, sizeBytes: 98_000 },
  ];

  const links: FileLink[] = [
    { source: 'root', target: 'docs', kind: 'tree' },
    { source: 'root', target: 'imgs', kind: 'tree' },
    { source: 'root', target: 'proj', kind: 'tree' },
    { source: 'docs', target: 'resume', kind: 'tree' },
    { source: 'docs', target: 'budget', kind: 'tree' },
    { source: 'imgs', target: 'pic1', kind: 'tree' },
    { source: 'imgs', target: 'pic2', kind: 'tree' },
    { source: 'proj', target: 'code1', kind: 'tree' },
    { source: 'proj', target: 'code2', kind: 'tree' },
    { source: 'proj', target: 'code3', kind: 'tree' },
  ];

  if (nodes.some((n) => n.id === undefined || n.name === undefined || n.type === undefined || n.val === undefined || n.group === undefined)) {
    throw new Error('Found undefined value in mock data');
  }

  if (links.some((l) => l.source === undefined || l.target === undefined)) {
    throw new Error('Found undefined value in mock links');
  }

  return { nodes, links };
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const formatBytes = (bytes?: number) => {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unitIndex]}`;
};

const resolveId = (value: any) => (typeof value === 'object' ? value.id : value);

const TEXT_EXTENSIONS = /\.(txt|md|json|css|js|ts|tsx|jsx|html|py|go|rs|java|yaml|yml)$/i;
const MAX_PREVIEW_LINES = 24;
const MAX_PREVIEW_CHARS = 8000;
const MAX_EDITOR_CHARS = 40000;
const PULSE_MAX_DEPTH = 10;
const PULSE_MAX_NODES = 36;
const PULSE_INTERVAL_MS = 650;
const ISOLATION_MAX_NODES = 360;

const HANDLE_DB_NAME = 'neural-nexus-handles';
const HANDLE_STORE = 'handles';
const HANDLE_KEY = 'last';

const openHandleDb = () => new Promise<IDBDatabase>((resolve, reject) => {
  if (typeof indexedDB === 'undefined') {
    reject(new Error('IndexedDB unavailable'));
    return;
  }
  const request = indexedDB.open(HANDLE_DB_NAME, 1);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(HANDLE_STORE)) {
      db.createObjectStore(HANDLE_STORE);
    }
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const saveLastHandle = async (handle: any) => {
  try {
    const db = await openHandleDb();
    const tx = db.transaction(HANDLE_STORE, 'readwrite');
    tx.objectStore(HANDLE_STORE).put(handle, HANDLE_KEY);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('Failed to persist handle', err);
  }
};

const loadLastHandle = async () => {
  try {
    const db = await openHandleDb();
    const tx = db.transaction(HANDLE_STORE, 'readonly');
    const request = tx.objectStore(HANDLE_STORE).get(HANDLE_KEY);
    const handle = await new Promise<any>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return handle ?? null;
  } catch (err) {
    console.warn('Failed to load saved handle', err);
    return null;
  }
};

const requestHandlePermission = async (handle: any, mode: 'read' | 'readwrite' = 'read') => {
  if (!handle) return false;
  if (typeof handle.queryPermission !== 'function' || typeof handle.requestPermission !== 'function') {
    return true;
  }
  const opts = { mode };
  const current = await handle.queryPermission(opts);
  if (current === 'granted') return true;
  const next = await handle.requestPermission(opts);
  return next === 'granted';
};
const isTextPreviewable = (file: File, name: string) => {
  if (file.type && file.type.startsWith('text/')) return true;
  return TEXT_EXTENSIONS.test(name);
};

const formatPathLabel = (value: string) => value.replace(/^root\//, '');
const isEditorEligibleType = (type?: NodeType | string | null) => type === 'code' || type === 'file';
const LOGO_SRC = '/jl-engine-logo.jpg';
const SETTINGS_STORAGE_KEY = 'neural-nexus-settings-v1';
const LAYOUT_STORAGE_KEY = 'neural-nexus-layout-v1';
const AI_PROVIDER_STORAGE_KEY = 'neural-nexus-ai-provider-v1';
const OLLAMA_BASE_URL_STORAGE_KEY = 'neural-nexus-ollama-base-url-v1';
const OLLAMA_MODEL_STORAGE_KEY = 'neural-nexus-ollama-model-v1';
const CLOUD_MODEL_STORAGE_KEY = 'neural-nexus-cloud-model-v1';
const OPENAI_KEY_STORAGE_KEY = 'neural-nexus-openai-key-v1';
const GEMINI_KEY_STORAGE_KEY = 'neural-nexus-gemini-key-v1';
const ANTHROPIC_KEY_STORAGE_KEY = 'neural-nexus-anthropic-key-v1';
const ORBIT_SPEED_MULTIPLIER = 3;
const MAX_CHAT_HISTORY_MESSAGES = 14;
const MAX_CHAT_CONTEXT_CHARS = 16_000;
const CODE_FENCE_RE = /```(?:[\w+-]+)?\r?\n([\s\S]*?)```/g;
const PANEL_MIN_WIDTH = 180;
const PANEL_MAX_WIDTH = 720;

const DEFAULT_SETTINGS: Settings = {
  maxDepth: 3,
  nodeBaseSize: 3.5,
  nodeSizeScale: 6,
  nodeMinSize: 2,
  nodeMaxSize: 20,
  folderSizeBoost: 1.2,
  nodeGlow: 0.72,
  linkOpacity: 0.32,
  linkWidth: 0.6,
  velocityDecay: 0.1,
  alphaDecay: 0.02,
  chargeStrength: -90,
  autoRotate: true,
  autoRotateSpeed: 0.25,
  showLabels: true,
  focusBranchMode: false,
  starfieldEnabled: true,
  starCount: 2000,
  starSpread: 1500,
  starOpacity: 0.62,
  starSize: 0.8,
  focusDistance: 80,
  focusDistanceClose: 32,
  showDependencyEdges: true,
  autoParseDependencies: false,
  includeNodeModules: false,
  groupExternalDeps: true,
  maxDependencyFiles: 400,
  maxDependencyFileSizeKb: 512,
  pulseIntervalMs: PULSE_INTERVAL_MS,
};

type StoredLayout = {
  leftWidth: number;
  rightWidth: number;
  isLeftCollapsed: boolean;
  isRightCollapsed: boolean;
};

const DEFAULT_LAYOUT: StoredLayout = {
  leftWidth: 300,
  rightWidth: 360,
  isLeftCollapsed: false,
  isRightCollapsed: false,
};

const loadStoredSettings = (): Settings => {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch (error) {
    console.warn('Failed to load stored settings', error);
    return DEFAULT_SETTINGS;
  }
};

const loadStoredLayout = (): StoredLayout => {
  if (typeof window === 'undefined') return DEFAULT_LAYOUT;
  try {
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return DEFAULT_LAYOUT;
    const parsed = JSON.parse(raw) as Partial<StoredLayout>;
    return {
      leftWidth: clamp(Number(parsed.leftWidth ?? DEFAULT_LAYOUT.leftWidth), PANEL_MIN_WIDTH, PANEL_MAX_WIDTH),
      rightWidth: clamp(Number(parsed.rightWidth ?? DEFAULT_LAYOUT.rightWidth), PANEL_MIN_WIDTH, PANEL_MAX_WIDTH),
      isLeftCollapsed: Boolean(parsed.isLeftCollapsed),
      isRightCollapsed: Boolean(parsed.isRightCollapsed),
    };
  } catch (error) {
    console.warn('Failed to load stored layout', error);
    return DEFAULT_LAYOUT;
  }
};

const loadStoredText = (key: string, fallback: string) => {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const trimmed = raw.trim();
    return trimmed || fallback;
  } catch (error) {
    console.warn(`Failed to load stored value (${key})`, error);
    return fallback;
  }
};

const createAuraSprite = (color: string, radius: number, intensity = 0.6): THREE.Sprite => {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const baseColor = new THREE.Color(color);
  const r = Math.round(baseColor.r * 255);
  const g = Math.round(baseColor.g * 255);
  const b = Math.round(baseColor.b * 255);
  if (ctx) {
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.9)`);
    gradient.addColorStop(0.35, `rgba(${r}, ${g}, ${b}, 0.45)`);
    gradient.addColorStop(0.85, `rgba(${r}, ${g}, ${b}, 0.1)`);
    gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  const material = new THREE.SpriteMaterial({
    map: texture,
    color: baseColor,
    transparent: true,
    opacity: intensity,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
  const sprite = new THREE.Sprite(material);
  const scale = radius * 2.6;
  sprite.scale.set(scale, scale, scale);
  sprite.renderOrder = 0;
  return sprite;
};

const NeuralExplorer3D: React.FC = () => {
  const [treeData, setTreeData] = useState<GraphData>(() => generateData());
  const [dependencyLinks, setDependencyLinks] = useState<FileLink[]>([]);
  const [externalNodes, setExternalNodes] = useState<FileNode[]>([]);
  const [dependencyMap, setDependencyMap] = useState<Record<string, DependencyInfo>>({});
  const [reverseDependencyMap, setReverseDependencyMap] = useState<Record<string, string[]>>({});
  const [dependencyStats, setDependencyStats] = useState<DependencyStats | null>(null);
  const [isParsingDeps, setIsParsingDeps] = useState(false);
  const fgRef = useRef<any>();
  const starsRef = useRef<THREE.Points | null>(null);
  const lightsRef = useRef<{
    ambient: THREE.AmbientLight;
    hemi: THREE.HemisphereLight;
    key: THREE.PointLight;
    fill: THREE.PointLight;
    rim: THREE.PointLight;
  } | null>(null);
  const lastDirHandleRef = useRef<any>(null);
  const lastClickRef = useRef<{ id: string; time: number } | null>(null);
  const lastModalNodeIdRef = useRef<string | null>(null);
  const dragStateRef = useRef<{ side: 'left' | 'right' | null; startX: number; startWidth: number } | null>(null);
  const didAutoFitRef = useRef(false);
  const hasAppliedChargeRef = useRef(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set(['root']));
  const [searchTerm, setSearchTerm] = useState('');
  const [mountName, setMountName] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(true);
  const [isFiltersOpen, setIsFiltersOpen] = useState(true);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const previewUrlRef = useRef<string | null>(null);
  const [selectedFileAnalysis, setSelectedFileAnalysis] = useState<FileIntelligence | null>(null);
  const [editorContent, setEditorContent] = useState<string | null>(null);
  const [editorLoadedContent, setEditorLoadedContent] = useState<string | null>(null);
  const [isEditorDirty, setIsEditorDirty] = useState(false);
  const [isEditorLoading, setIsEditorLoading] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editorStatus, setEditorStatus] = useState<string | null>(null);
  const [canReconnect, setCanReconnect] = useState(false);
  const [reconnectStatus, setReconnectStatus] = useState<string | null>(null);
  const [aiProvider, setAiProvider] = useState<AiProvider>(() => {
    const stored = loadStoredText(AI_PROVIDER_STORAGE_KEY, 'ollama').toLowerCase();
    if (stored === 'openai' || stored === 'gemini' || stored === 'anthropic' || stored === 'ollama') {
      return stored;
    }
    return 'ollama';
  });
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState<string>(() => (
    loadStoredText(OLLAMA_BASE_URL_STORAGE_KEY, DEFAULT_OLLAMA_BASE_URL)
  ));
  const [ollamaModel, setOllamaModel] = useState<string>(() => (
    loadStoredText(OLLAMA_MODEL_STORAGE_KEY, DEFAULT_OLLAMA_MODEL)
  ));
  const [cloudModel, setCloudModel] = useState<string>(() => (
    loadStoredText(CLOUD_MODEL_STORAGE_KEY, DEFAULT_OPENAI_MODEL)
  ));
  const [openaiApiKey, setOpenaiApiKey] = useState<string>(() => (
    loadStoredText(OPENAI_KEY_STORAGE_KEY, '')
  ));
  const [geminiApiKey, setGeminiApiKey] = useState<string>(() => (
    loadStoredText(GEMINI_KEY_STORAGE_KEY, '')
  ));
  const [anthropicApiKey, setAnthropicApiKey] = useState<string>(() => (
    loadStoredText(ANTHROPIC_KEY_STORAGE_KEY, '')
  ));
  const [isTopBarModelEditorOpen, setIsTopBarModelEditorOpen] = useState(false);
  const [topBarModelDraft, setTopBarModelDraft] = useState('');
  const [availableOllamaModels, setAvailableOllamaModels] = useState<string[]>([]);
  const [isLoadingOllamaModels, setIsLoadingOllamaModels] = useState(false);
  const [ollamaModelsError, setOllamaModelsError] = useState<string | null>(null);
  const [isReviewingCode, setIsReviewingCode] = useState(false);
  const [reviewResult, setReviewResult] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewStatus, setReviewStatus] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [isChattingWithModel, setIsChattingWithModel] = useState(false);
  const [chatStatus, setChatStatus] = useState<string | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatApplyStatus, setChatApplyStatus] = useState<string | null>(null);
  const [chatApplyError, setChatApplyError] = useState<string | null>(null);
  const initialLayout = useMemo(() => loadStoredLayout(), []);
  const [leftWidth, setLeftWidth] = useState(initialLayout.leftWidth);
  const [rightWidth, setRightWidth] = useState(initialLayout.rightWidth);
  const [isLeftCollapsed, setIsLeftCollapsed] = useState(initialLayout.isLeftCollapsed);
  const [isRightCollapsed, setIsRightCollapsed] = useState(initialLayout.isRightCollapsed);
  const [isEditorModalVisible, setIsEditorModalVisible] = useState(false);
  const [rightDockTab, setRightDockTab] = useState<RightDockTab>('inspector');
  const dockEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const dockEditorLinesRef = useRef<HTMLPreElement | null>(null);
  const modalEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const modalEditorLinesRef = useRef<HTMLPreElement | null>(null);
  const [editorCursor, setEditorCursor] = useState({ line: 1, column: 1 });
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [graphRefVersion, setGraphRefVersion] = useState(0);

  const [visibleTypes, setVisibleTypes] = useState<Record<NodeType, boolean>>({
    folder: true,
    file: true,
    image: true,
    code: true,
    external: true,
  });
  const [isIsolationActive, setIsIsolationActive] = useState(false);
  const [isolationSet, setIsolationSet] = useState<Set<string> | null>(null);
  const [pulseSequence, setPulseSequence] = useState<string[]>([]);
  const [isPulseActive, setIsPulseActive] = useState(false);
  const [activePulseIndex, setActivePulseIndex] = useState(0);
  const [activePulseId, setActivePulseId] = useState<string | null>(null);
  const [pulseStatus, setPulseStatus] = useState<string | null>(null);

  const [settings, setSettings] = useState<Settings>(() => loadStoredSettings());
  const activeProviderModel = useMemo(() => {
    if (aiProvider === 'ollama') {
      return (ollamaModel || DEFAULT_OLLAMA_MODEL).trim() || DEFAULT_OLLAMA_MODEL;
    }
    const explicit = (cloudModel || '').trim();
    if (explicit) return explicit;
    if (aiProvider === 'openai') return DEFAULT_OPENAI_MODEL;
    if (aiProvider === 'gemini') return DEFAULT_GEMINI_MODEL;
    return DEFAULT_ANTHROPIC_MODEL;
  }, [aiProvider, cloudModel, ollamaModel]);
  const activeProviderApiKey = useMemo(() => {
    if (aiProvider === 'openai') return openaiApiKey;
    if (aiProvider === 'gemini') return geminiApiKey;
    if (aiProvider === 'anthropic') return anthropicApiKey;
    return '';
  }, [aiProvider, anthropicApiKey, geminiApiKey, openaiApiKey]);
  const activeProviderLabel = useMemo(() => {
    if (aiProvider === 'openai') return 'OpenAI';
    if (aiProvider === 'gemini') return 'Gemini';
    if (aiProvider === 'anthropic') return 'Anthropic';
    return 'Ollama';
  }, [aiProvider]);

  const updateSetting = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch (error) {
      console.warn('Failed to persist settings', error);
    }
  }, [settings]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({
        leftWidth,
        rightWidth,
        isLeftCollapsed,
        isRightCollapsed,
      }));
    } catch (error) {
      console.warn('Failed to persist layout', error);
    }
  }, [isLeftCollapsed, isRightCollapsed, leftWidth, rightWidth]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(OLLAMA_BASE_URL_STORAGE_KEY, ollamaBaseUrl);
    } catch (error) {
      console.warn('Failed to persist Ollama base URL', error);
    }
  }, [ollamaBaseUrl]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(OLLAMA_MODEL_STORAGE_KEY, ollamaModel);
    } catch (error) {
      console.warn('Failed to persist Ollama model', error);
    }
  }, [ollamaModel]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(AI_PROVIDER_STORAGE_KEY, aiProvider);
    } catch (error) {
      console.warn('Failed to persist AI provider', error);
    }
  }, [aiProvider]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(CLOUD_MODEL_STORAGE_KEY, cloudModel);
    } catch (error) {
      console.warn('Failed to persist cloud model', error);
    }
  }, [cloudModel]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(OPENAI_KEY_STORAGE_KEY, openaiApiKey);
      window.localStorage.setItem(GEMINI_KEY_STORAGE_KEY, geminiApiKey);
      window.localStorage.setItem(ANTHROPIC_KEY_STORAGE_KEY, anthropicApiKey);
    } catch (error) {
      console.warn('Failed to persist API keys', error);
    }
  }, [anthropicApiKey, geminiApiKey, openaiApiKey]);

  const attachGraphRef = useCallback((instance: any) => {
    fgRef.current = instance;
    if (instance) {
      setGraphRefVersion((prev) => prev + 1);
    }
  }, []);

  const graphData = useMemo(() => {
    const nodeMap = new Map<string, FileNode>();
    [...treeData.nodes, ...externalNodes].forEach((node) => {
      if (!node || !node.id) return;
      if (!nodeMap.has(node.id)) nodeMap.set(node.id, node);
    });
    const nodes = Array.from(nodeMap.values()).map((node) => ({ ...node }));
    const nodeIds = new Set(nodes.map((node) => node.id));
    const links = [...treeData.links, ...dependencyLinks]
      .map((link) => ({
        ...link,
        source: resolveId(link.source),
        target: resolveId(link.target),
      }))
      .filter((link) => (
        !!link.source
        && !!link.target
        && nodeIds.has(link.source as string)
        && nodeIds.has(link.target as string)
      ));
    return { nodes, links };
  }, [dependencyLinks, externalNodes, treeData.links, treeData.nodes]);

  const pulseNodeSet = useMemo(() => new Set(pulseSequence), [pulseSequence]);
  const pulseLinkKeys = useMemo(() => {
    const keys = new Set<string>();
    for (let i = 0; i < pulseSequence.length - 1; i += 1) {
      const sourceId = pulseSequence[i];
      const targetId = pulseSequence[i + 1];
      if (sourceId && targetId) {
        keys.add(`${sourceId}->${targetId}`);
      }
    }
    return keys;
  }, [pulseSequence]);
  const activePulseLinkKey = useMemo(() => {
    if (pulseSequence.length < 2) return '';
    if (activePulseIndex === 0) {
      return `${pulseSequence[0]}->${pulseSequence[1]}`;
    }
    const sourceId = pulseSequence[activePulseIndex - 1];
    const targetId = pulseSequence[activePulseIndex];
    if (!sourceId || !targetId) return '';
    return `${sourceId}->${targetId}`;
  }, [activePulseIndex, pulseSequence]);
  const getLinkPulseInfo = useCallback(
    (link: any) => {
      const sourceId = resolveId(link.source);
      const targetId = resolveId(link.target);
      if (typeof sourceId !== 'string' || typeof targetId !== 'string') {
        return {
          sourceId: null,
          targetId: null,
          linkKey: null,
          isPulseLink: false,
          isActivePulseLink: false,
        };
      }
      const linkKey = `${sourceId}->${targetId}`;
      return {
        sourceId,
        targetId,
        linkKey,
        isPulseLink: pulseLinkKeys.has(linkKey),
        isActivePulseLink: linkKey === activePulseLinkKey,
      };
    },
    [activePulseLinkKey, pulseLinkKeys],
  );

  const selectedNode = useMemo(
    () => graphData.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [graphData.nodes, selectedNodeId],
  );
  const nodeDeps = selectedNode ? dependencyMap[selectedNode.id] : null;
  const nodeDependents = selectedNode ? reverseDependencyMap[selectedNode.id] ?? [] : [];
  const selectedGraphNodeId = selectedNode?.id ?? null;
  const selectedAnalysis = selectedFileAnalysis ?? nodeDeps?.analysis ?? null;
  const workspaceSummary = useMemo<WorkspaceSummary | null>(() => {
    const analyzedEntries = Object.entries(dependencyMap)
      .flatMap(([id, info]) => (info.analysis ? [{ id, info }] : []));

    if (analyzedEntries.length === 0) return null;

    const manifestFiles = analyzedEntries
      .filter(({ info }) => info.analysis?.packageSummary)
      .slice(0, 4)
      .map(({ id, info }) => {
        const node = treeData.nodes.find((candidate) => candidate.id === id);
        const packageSummary = info.analysis?.packageSummary;
        return {
          id,
          label: formatPathLabel(node?.path ?? id),
          packageName: packageSummary?.name,
          dependencyCount: packageSummary?.dependencyCount ?? 0,
          devDependencyCount: packageSummary?.devDependencyCount ?? 0,
          scripts: packageSummary?.scripts.slice(0, 5) ?? [],
          entryPoints: info.analysis?.entryPoints.slice(0, 5) ?? [],
        };
      });

    const frameworkHints = new Set<string>();
    const entryPoints = new Set<string>();
    const scripts = new Set<string>();
    const headings = new Set<string>();
    const symbols = new Set<string>();

    analyzedEntries.forEach(({ info }) => {
      const analysis = info.analysis;
      if (!analysis) return;
      analysis.frameworkHints.forEach((hint) => frameworkHints.add(hint));
      analysis.entryPoints.forEach((entry) => entryPoints.add(entry));
      analysis.scripts.forEach((script) => scripts.add(script));
      analysis.headings.forEach((heading) => headings.add(heading));
      analysis.symbols.slice(0, 4).forEach((symbol) => symbols.add(symbol));
    });

    return {
      manifestFiles,
      frameworkHints: Array.from(frameworkHints).slice(0, 8),
      entryPoints: Array.from(entryPoints).slice(0, 8),
      scripts: Array.from(scripts).slice(0, 8),
      headings: Array.from(headings).slice(0, 8),
      symbols: Array.from(symbols).slice(0, 8),
    };
  }, [dependencyMap, treeData.nodes]);
  const adjacencyMap = useMemo(() => {
    const map = new Map<string, Set<string>>();
    graphData.links.forEach((link) => {
      const sourceId = typeof link.source === 'string' ? link.source : null;
      const targetId = typeof link.target === 'string' ? link.target : null;
      if (!sourceId || !targetId) return;
      if (!map.has(sourceId)) map.set(sourceId, new Set());
      if (!map.has(targetId)) map.set(targetId, new Set());
      map.get(sourceId)?.add(targetId);
      map.get(targetId)?.add(sourceId);
    });
    return map;
  }, [graphData.links]);

  const activePulseNeighbors = useMemo(() => {
    if (!activePulseId) return new Set<string>();
    return new Set(adjacencyMap.get(activePulseId) ?? []);
  }, [activePulseId, adjacencyMap]);

  const computeIsolationSet = useCallback(() => {
    if (!selectedGraphNodeId) return new Set<string>();
    const result = new Set<string>();
    const queue = [selectedGraphNodeId];
    while (queue.length && result.size < ISOLATION_MAX_NODES) {
      const current = queue.shift();
      if (!current || result.has(current)) continue;
      result.add(current);
      const neighbors = adjacencyMap.get(current);
      neighbors?.forEach((neighbor) => {
        if (!result.has(neighbor)) queue.push(neighbor);
      });
    }
    return result;
  }, [adjacencyMap, selectedGraphNodeId]);

  const isolateSelection = useCallback(() => {
    if (!selectedGraphNodeId) return;
    const nodes = computeIsolationSet();
    setIsolationSet(nodes);
    setIsIsolationActive(true);
  }, [computeIsolationSet, selectedGraphNodeId]);

  const resetIsolation = useCallback(() => {
    setIsIsolationActive(false);
    setIsolationSet(null);
  }, []);

  const visibleNodeIds = useMemo(() => {
    const base = new Set(graphData.nodes.filter((node) => visibleTypes[node.type]).map((node) => node.id));
    if (isIsolationActive && isolationSet && isolationSet.size > 0) {
      return new Set([...base].filter((id) => isolationSet.has(id)));
    }
    return base;
  }, [graphData.nodes, visibleTypes, isIsolationActive, isolationSet]);

  const isNodeVisible = useCallback((node: any) => {
    if (node.type === 'external' && !settings.showDependencyEdges) return false;
    if (isIsolationActive && isolationSet && !isolationSet.has(node.id)) return false;
    return visibleTypes[node.type];
  }, [settings.showDependencyEdges, visibleTypes, isIsolationActive, isolationSet]);

  const isLinkVisible = useCallback((link: any) => {
    if (link.kind === 'dep' && !settings.showDependencyEdges) return false;
    const sourceId = resolveId(link.source);
    const targetId = resolveId(link.target);
    return visibleNodeIds.has(sourceId) && visibleNodeIds.has(targetId);
  }, [settings.showDependencyEdges, visibleNodeIds]);

  const branchNodeIds = useMemo(() => {
    if (!settings.focusBranchMode || !selectedNodeId) return null;
    if (!treeData.nodes.some((node) => node.id === selectedNodeId)) return null;

    const childrenMap = new Map<string, string[]>();
    const parentMap = new Map<string, string[]>();

    treeData.links.forEach((link: any) => {
      if (link.kind && link.kind !== 'tree') return;
      const sourceId = resolveId(link.source);
      const targetId = resolveId(link.target);
      if (!childrenMap.has(sourceId)) childrenMap.set(sourceId, []);
      childrenMap.get(sourceId)?.push(targetId);
      if (!parentMap.has(targetId)) parentMap.set(targetId, []);
      parentMap.get(targetId)?.push(sourceId);
    });

    const visited = new Set<string>();
    const stack = [selectedNodeId];

    while (stack.length) {
      const id = stack.pop();
      if (!id || visited.has(id)) continue;
      visited.add(id);
      const children = childrenMap.get(id) ?? [];
      children.forEach((child) => stack.push(child));
    }

    const ancestors = [selectedNodeId];
    while (ancestors.length) {
      const id = ancestors.pop();
      if (!id) continue;
      const parents = parentMap.get(id) ?? [];
      parents.forEach((parent) => {
        if (!visited.has(parent)) {
          visited.add(parent);
          ancestors.push(parent);
        }
      });
    }

    return visited;
  }, [selectedNodeId, settings.focusBranchMode, treeData.links]);

  const getNodeColor = (group: number) => {
    switch (group) {
      case 1: return '#6ec8ff'; // Root: Electric blue
      case 2: return '#12b4ff'; // Folders: Deep cyan
      case 3: return '#d24bff'; // Files: Rich magenta
      case 4: return '#ffae2b'; // Images: Amber
      case 5: return '#1fd96e'; // Code: Neon green
      case 6: return '#7b63ff'; // External: Violet
      case 7: return '#ff0000'; // Agents: Red
      default: return '#86a8c4';
    }
  };

  const getNodeRadius = useCallback((node: FileNode) => {
    const sizeBytes = typeof node.sizeBytes === 'number' ? node.sizeBytes : node.val * 1024 * 1024;
    const sizeMb = sizeBytes / (1024 * 1024);
    const scaled = settings.nodeBaseSize + settings.nodeSizeScale * Math.log2(sizeMb + 1);
    const boost = node.type === 'folder' ? settings.folderSizeBoost : 1;
    const typeScale = node.type === 'external' ? 0.8 : 1;
    return clamp(scaled * boost * typeScale, settings.nodeMinSize, settings.nodeMaxSize);
  }, [settings.folderSizeBoost, settings.nodeBaseSize, settings.nodeMaxSize, settings.nodeMinSize, settings.nodeSizeScale]);

  const focusNode = useCallback((node: any, distance: number, duration = 1600) => {
    const hasCoords = typeof node.x === 'number' && typeof node.y === 'number' && typeof node.z === 'number';
    if (!hasCoords) return;
    const distRatio = 1 + distance / Math.hypot(node.x, node.y, node.z);
    fgRef.current?.cameraPosition(
      { x: node.x * distRatio, y: node.y * distRatio, z: node.z * distRatio },
      node,
      duration,
    );
  }, []);

  const selectNode = useCallback((node: FileNode, distance = settings.focusDistance) => {
    if (node.type !== 'folder' && isRightCollapsed) {
      setIsRightCollapsed(false);
    }
    setSelectedNodeId(node.id);
    const focusTarget = graphData.nodes.find((candidate) => candidate.id === node.id) ?? node;
    focusNode(focusTarget, distance);
    setIsEditorModalVisible(isEditorEligibleType(node.type));
  }, [focusNode, graphData.nodes, isRightCollapsed, settings.focusDistance]);

  const handleEditorModalClose = useCallback(() => {
    setIsEditorModalVisible(false);
  }, []);

  const handleNodeClick = useCallback((node: any) => {
    const now = Date.now();
    const last = lastClickRef.current;
    const isDoubleClick = last && last.id === node.id && now - last.time < 300;

    lastClickRef.current = { id: node.id, time: now };
    setSelectedNodeId(node.id);
    if (node.type !== 'folder' && isRightCollapsed) {
      setIsRightCollapsed(false);
    }
    setIsEditorModalVisible(isEditorEligibleType(node.type));

    const distance = isDoubleClick ? settings.focusDistanceClose : settings.focusDistance;
    focusNode(node, distance, isDoubleClick ? 900 : 2000);
  }, [focusNode, isRightCollapsed, settings.focusDistance, settings.focusDistanceClose]);

  const computePulseSequence = useCallback((startId: string) => {
    const sequence: string[] = [];
    const visited = new Set<string>();
    const queue: { id: string; depth: number }[] = [{ id: startId, depth: 0 }];

    while (queue.length && sequence.length < PULSE_MAX_NODES) {
      const { id, depth } = queue.shift()!;
      if (!id || visited.has(id)) continue;
      visited.add(id);
      sequence.push(id);
      if (depth >= PULSE_MAX_DEPTH) continue;
      dependencyLinks.forEach((link) => {
        const sourceId = resolveId(link.source);
        const targetId = resolveId(link.target);
        if (sourceId === id && typeof targetId === 'string' && !visited.has(targetId)) {
          queue.push({ id: targetId, depth: depth + 1 });
        }
      });
    }

    return sequence;
  }, [dependencyLinks]);

  const handleStartPulseTrace = useCallback(() => {
    if (!selectedNode) {
      setPulseStatus('Select a node before pulsing.');
      return;
    }
    if (!dependencyLinks.length) {
      setPulseStatus('Parse dependencies to enable pulse tracing.');
      return;
    }
    const sequence = computePulseSequence(selectedNode.id);
    if (!sequence.length) {
      setPulseStatus('No outgoing dependency hops detected.');
      return;
    }
    setPulseSequence(sequence);
    setIsPulseActive(true);
    setActivePulseIndex(0);
    setActivePulseId(sequence[0]);
    setPulseStatus(`Tracing ${Math.min(sequence.length, PULSE_MAX_NODES)} hops.`);
  }, [selectedNode, dependencyLinks, computePulseSequence]);

  const handleStopPulseTrace = useCallback(() => {
    setIsPulseActive(false);
    setPulseSequence([]);
    setActivePulseIndex(0);
    setActivePulseId(null);
    setPulseStatus('Pulse trace stopped.');
  }, []);

  const toggleFolder = (id: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleEditorChange = useCallback((value: string) => {
    setEditorContent(value);
    setIsEditorDirty(true);
    setEditorStatus('Unsaved edits');
    setEditorError(null);
  }, []);

  const editorLineNumbers = useMemo(() => {
    const lineCount = Math.max(1, (editorContent ?? '').split(/\r?\n/).length);
    return Array.from({ length: lineCount }, (_, index) => String(index + 1)).join('\n');
  }, [editorContent]);

  const getCursorLineColumn = useCallback((text: string, index: number) => {
    const safeIndex = Math.max(0, Math.min(index, text.length));
    const before = text.slice(0, safeIndex);
    const segments = before.split(/\r?\n/);
    const line = segments.length;
    const column = (segments[segments.length - 1]?.length ?? 0) + 1;
    return { line, column };
  }, []);

  const handleEditorCursorUpdate = useCallback((selectionStart: number) => {
    const content = editorContent ?? '';
    setEditorCursor(getCursorLineColumn(content, selectionStart));
  }, [editorContent, getCursorLineColumn]);

  const syncEditorLineScroll = useCallback((origin: 'dock' | 'modal') => {
    if (origin === 'dock') {
      if (dockEditorLinesRef.current && dockEditorRef.current) {
        dockEditorLinesRef.current.scrollTop = dockEditorRef.current.scrollTop;
      }
      return;
    }
    if (modalEditorLinesRef.current && modalEditorRef.current) {
      modalEditorLinesRef.current.scrollTop = modalEditorRef.current.scrollTop;
    }
  }, []);

  const handleEditorSave = useCallback(async () => {
    if (!selectedNode || !selectedNode.handle || editorContent === null) return;
    setEditorStatus('Saving...');
    try {
      const granted = await requestHandlePermission(selectedNode.handle, 'readwrite');
      if (!granted) throw new Error('Permission denied');
      const writable = await selectedNode.handle.createWritable();
      await writable.write(editorContent);
      await writable.close();
      setEditorLoadedContent(editorContent);
      setIsEditorDirty(false);
      setEditorStatus('Saved');
      setEditorError(null);
      const snippet = editorContent.slice(0, MAX_PREVIEW_CHARS);
      const lines = snippet.split(/\r?\n/).slice(0, MAX_PREVIEW_LINES);
      setPreviewText(lines.join('\n') || '(empty file)');
    } catch (err) {
      setEditorError('Save failed. Make sure you granted write permission.');
      setEditorStatus('Save failed');
    }
  }, [editorContent, selectedNode]);

  const handleEditorRevert = useCallback(() => {
    if (editorLoadedContent === null) return;
    setEditorContent(editorLoadedContent);
    setIsEditorDirty(false);
    setEditorStatus('Reverted to last loaded version');
    setEditorError(null);
  }, [editorLoadedContent]);

  const handleRunOllamaReview = useCallback(async () => {
    if (!selectedNode || !isEditorEligibleType(selectedNode.type)) {
      setReviewResult(null);
      setReviewError('Select a code/text node before running review.');
      setReviewStatus(null);
      return;
    }
    if (!editorContent || !editorContent.trim()) {
      setReviewResult(null);
      setReviewError('No code available to review in the editor buffer.');
      setReviewStatus(null);
      return;
    }

    const codeForReview = editorContent.slice(0, MAX_OLLAMA_REVIEW_CHARS);
    setIsReviewingCode(true);
    setReviewError(null);
    setReviewStatus(`Reviewing ${selectedNode.name} with ${activeProviderLabel} (${activeProviderModel})...`);
    try {
      const result = await reviewCodeWithProvider({
        provider: aiProvider,
        baseUrl: ollamaBaseUrl,
        model: activeProviderModel,
        apiKey: activeProviderApiKey,
        fileName: selectedNode.name,
        filePath: selectedNode.path,
        code: codeForReview,
      });
      setReviewResult(result.content);

      const statusParts = [`Model: ${result.model}`];
      if (typeof result.totalDurationMs === 'number') {
        statusParts.push(`Time: ${(result.totalDurationMs / 1000).toFixed(2)}s`);
      }
      if (typeof result.promptEvalCount === 'number' && typeof result.evalCount === 'number') {
        statusParts.push(`Tokens: in ${result.promptEvalCount}, out ${result.evalCount}`);
      }
      setReviewStatus(statusParts.join(' | '));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'AI review failed.';
      setReviewResult(null);
      setReviewError(message);
      setReviewStatus(null);
    } finally {
      setIsReviewingCode(false);
    }
  }, [activeProviderApiKey, activeProviderLabel, activeProviderModel, aiProvider, editorContent, ollamaBaseUrl, selectedNode]);

  const extractCodeBlockFromMessage = useCallback((content: string) => {
    let match: RegExpExecArray | null;
    const blocks: string[] = [];
    CODE_FENCE_RE.lastIndex = 0;
    while (true) {
      match = CODE_FENCE_RE.exec(content);
      if (!match) break;
      blocks.push((match[1] || '').trimEnd());
    }
    if (!blocks.length) return null;
    const best = blocks.reduce((longest, block) => (block.length > longest.length ? block : longest), blocks[0]);
    return best.trim() ? best : null;
  }, []);

  const handleApplyAssistantCode = useCallback((assistantMessage: string) => {
    if (!selectedNode || !isEditorEligibleType(selectedNode.type)) {
      setChatApplyStatus(null);
      setChatApplyError('Select a code/text node before applying generated code.');
      return;
    }
    if (editorContent === null) {
      setChatApplyStatus(null);
      setChatApplyError('Editor is not ready yet.');
      return;
    }
    const extractedCode = extractCodeBlockFromMessage(assistantMessage);
    if (!extractedCode) {
      setChatApplyStatus(null);
      setChatApplyError('No fenced code block found in that model response.');
      return;
    }
    setEditorContent(extractedCode);
    setIsEditorDirty(true);
    setEditorStatus('Applied model code to editor (not saved yet)');
    setEditorError(null);
    setChatApplyError(null);
    setChatApplyStatus(`Applied code block to ${selectedNode.name}. Review then click Save.`);
  }, [editorContent, extractCodeBlockFromMessage, selectedNode]);

  const handleApplyLatestAssistantCode = useCallback(() => {
    const lastAssistantMessage = [...chatMessages].reverse().find((message) => message.role === 'assistant');
    if (!lastAssistantMessage) {
      setChatApplyStatus(null);
      setChatApplyError('No model response found yet.');
      return;
    }
    handleApplyAssistantCode(lastAssistantMessage.content);
  }, [chatMessages, handleApplyAssistantCode]);

  const handleSendCodingChat = useCallback(async () => {
    const prompt = chatInput.trim();
    if (!prompt) return;

    const hasPriorUserTurn = chatMessages.some((message) => message.role === 'user');
    const modelPrompt = hasPriorUserTurn
      ? prompt
      : buildSparkByteInjectedFirstUserMessage(prompt);

    const nextMessages: ChatMessage[] = [...chatMessages, { role: 'user', content: prompt }];
    const nextMessagesForModel: ChatMessage[] = [
      ...chatMessages,
      { role: 'user', content: modelPrompt },
    ];
    setChatMessages(nextMessages);
    setChatInput('');
    setChatError(null);
    setChatApplyError(null);
    setChatApplyStatus(null);
    setIsChattingWithModel(true);
    if (hasPriorUserTurn) {
      setChatStatus(`Waiting on ${activeProviderLabel} (${activeProviderModel})...`);
    } else {
      setChatStatus(`Injected SparkByte MPF schema. Waiting on ${activeProviderLabel} (${activeProviderModel})...`);
    }

    const codingSystemPrompt = [
      'You are a senior coding assistant.',
      'Be practical, specific, and bug-focused.',
      'When giving code changes, explain rationale and risks briefly.',
      'When you provide edited code, include it in fenced markdown code blocks.',
      'If the user asks for a full-file rewrite, output the full file content in one fenced code block.',
      'Prefer concise answers unless asked for depth.',
    ].join(' ');

    const contextLines: string[] = [];
    if (selectedNode) {
      contextLines.push(`Selected node: ${selectedNode.name}`);
      if (selectedNode.path) contextLines.push(`Path: ${selectedNode.path}`);
      contextLines.push(`Type: ${selectedNode.type}`);
    }
    if (editorContent && editorContent.trim()) {
      const contextCode = editorContent.slice(0, MAX_CHAT_CONTEXT_CHARS);
      contextLines.push('');
      contextLines.push(`Editor context (truncated to ${MAX_CHAT_CONTEXT_CHARS} chars):`);
      contextLines.push('```');
      contextLines.push(contextCode);
      contextLines.push('```');
    }

    const ollamaMessages: OllamaChatMessage[] = [
      { role: 'system', content: codingSystemPrompt },
    ];
    if (contextLines.length > 0) {
      ollamaMessages.push({ role: 'system', content: contextLines.join('\n') });
    }
    nextMessagesForModel.slice(-MAX_CHAT_HISTORY_MESSAGES).forEach((message) => {
      ollamaMessages.push({ role: message.role, content: message.content });
    });

    try {
      const result = await chatWithProvider({
        provider: aiProvider,
        baseUrl: ollamaBaseUrl,
        model: activeProviderModel,
        apiKey: activeProviderApiKey,
        messages: ollamaMessages,
        temperature: 0.25,
      });
      setChatMessages((prev) => [...prev, { role: 'assistant', content: result.content }]);
      const statusParts = [`Model: ${result.model}`];
      if (typeof result.totalDurationMs === 'number') {
        statusParts.push(`Time: ${(result.totalDurationMs / 1000).toFixed(2)}s`);
      }
      if (typeof result.promptEvalCount === 'number' && typeof result.evalCount === 'number') {
        statusParts.push(`Tokens: in ${result.promptEvalCount}, out ${result.evalCount}`);
      }
      setChatStatus(statusParts.join(' | '));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'AI chat failed.';
      setChatError(message);
      setChatStatus(null);
    } finally {
      setIsChattingWithModel(false);
    }
  }, [activeProviderApiKey, activeProviderLabel, activeProviderModel, aiProvider, chatInput, chatMessages, editorContent, ollamaBaseUrl, selectedNode]);

  const handleClearCodingChat = useCallback(() => {
    setChatMessages([]);
    setChatError(null);
    setChatStatus(null);
    setChatApplyError(null);
    setChatApplyStatus(null);
  }, []);

  useEffect(() => {
    setReviewResult(null);
    setReviewError(null);
    setReviewStatus(null);
  }, [selectedNode?.id]);

  useEffect(() => {
    setChatMessages([]);
    setChatInput('');
    setChatError(null);
    setChatStatus(null);
    setChatApplyError(null);
    setChatApplyStatus(null);
  }, [selectedNode?.id]);

  useEffect(() => {
    if (editorContent === null) {
      setEditorCursor({ line: 1, column: 1 });
      return;
    }
    setEditorCursor({ line: 1, column: 1 });
  }, [selectedNode?.id, editorContent === null]);

  useEffect(() => {
    if (!selectedNode) {
      setPulseStatus(null);
      return;
    }
    if (pulseSequence.length > 0 && selectedNode.id !== pulseSequence[0]) {       
      setIsPulseActive(false);
      setPulseSequence([]);
      setActivePulseId(null);
      setActivePulseIndex(0);
      setPulseStatus('Pulse trace interrupted by your new selection.');
    }
  }, [selectedNode?.id, pulseSequence]);

  useEffect(() => {
    if (!selectedNode) return;
    setIsRightCollapsed(false);
  }, [selectedNode]);

  useEffect(() => {
    if (!selectedNode) {
      lastModalNodeIdRef.current = null;
      setIsEditorModalVisible(false);
      return;
    }
    if (selectedNode.id !== lastModalNodeIdRef.current) {
      lastModalNodeIdRef.current = selectedNode.id;
      setIsEditorModalVisible(isEditorEligibleType(selectedNode.type));
    }
  }, [selectedNode?.id, selectedNode?.type]);

  useEffect(() => {
    if (!isPulseActive || pulseSequence.length === 0) {
      setActivePulseId(null);
      return undefined;
    }
    let localIndex = 0;
    setActivePulseId(pulseSequence[0]);
    setActivePulseIndex(0);
    const interval = setInterval(() => {
      localIndex = (localIndex + 1) % pulseSequence.length;
      setActivePulseIndex(localIndex);
      setActivePulseId(pulseSequence[localIndex]);
    }, settings.pulseIntervalMs);
    return () => clearInterval(interval);
  }, [isPulseActive, pulseSequence, settings.pulseIntervalMs]);

  useEffect(() => {
    if (!isPulseActive || pulseSequence.length === 0 || !activePulseId) {
      return;
    }
    setPulseStatus(`Pulse ${activePulseIndex + 1}/${pulseSequence.length}: ${activePulseId}`);
  }, [isPulseActive, pulseSequence.length, activePulseId, activePulseIndex]);


  const expandAllFolders = () => {
    const folderIds = treeData.nodes.filter((node) => node.type === 'folder').map((node) => node.id);
    setExpandedFolders(new Set(folderIds));
  };

  const collapseToRoot = () => {
    setExpandedFolders(new Set(['root']));
  };

  // --- 1. Cosmic Background (Starfield) ---
  useEffect(() => {
    if (!fgRef.current) return;
    const scene = fgRef.current.scene();

    if (starsRef.current) {
      scene.remove(starsRef.current);
      starsRef.current.geometry.dispose();
      (starsRef.current.material as THREE.Material).dispose();
      starsRef.current = null;
    }

    if (!settings.starfieldEnabled) return;

    const starGeo = new THREE.BufferGeometry();
    const starCount = Math.max(0, Math.floor(settings.starCount));
    const posArray = new Float32Array(starCount * 3);

    for (let i = 0; i < starCount * 3; i += 1) {
      posArray[i] = (Math.random() - 0.5) * settings.starSpread; // Spread stars in 3D space
    }

    starGeo.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
    const starMat = new THREE.PointsMaterial({
      color: 0xffffff,
      size: settings.starSize,
      transparent: true,
      opacity: settings.starOpacity,
    });

    const stars = new THREE.Points(starGeo, starMat);
    starsRef.current = stars;
    scene.add(stars);
  }, [graphRefVersion, settings.starCount, settings.starOpacity, settings.starSize, settings.starSpread, settings.starfieldEnabled]);

  useEffect(() => {
    if (!fgRef.current) return;
    const scene = fgRef.current.scene();
    if (lightsRef.current) return;

    const ambient = new THREE.AmbientLight(0xffffff, 0.95);
    const hemi = new THREE.HemisphereLight(0x8ab8ff, 0x11151c, 0.68);
    const key = new THREE.PointLight(0xffffff, 1.25);
    key.position.set(180, 200, 150);
    const fill = new THREE.PointLight(0x9bdfff, 0.72);
    fill.position.set(-170, 120, 150);
    const rim = new THREE.PointLight(0x66ccff, 0.72);
    rim.position.set(-170, -120, -140);

    scene.add(ambient);
    scene.add(hemi);
    scene.add(key);
    scene.add(fill);
    scene.add(rim);
    lightsRef.current = { ambient, hemi, key, fill, rim };

    return () => {
      scene.remove(ambient);
      scene.remove(hemi);
      scene.remove(key);
      scene.remove(fill);
      scene.remove(rim);
      lightsRef.current = null;
    };
  }, [graphData.nodes.length, graphRefVersion]);

  useEffect(() => {
    if (!fgRef.current) return;
    const renderer = fgRef.current.renderer?.();
    if (!renderer) return;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  }, [graphRefVersion, viewport.height, viewport.width]);

  useEffect(() => {
    if (!fgRef.current) return;
    const controls = fgRef.current.controls?.();
    if (!controls) return;
    const effectiveOrbitSpeed = settings.autoRotate
      ? settings.autoRotateSpeed * ORBIT_SPEED_MULTIPLIER
      : 0;
    controls.autoRotate = settings.autoRotate;
    controls.autoRotateSpeed = effectiveOrbitSpeed;
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    if (settings.autoRotate && typeof fgRef.current.getGraphBbox === 'function') {
      const bbox = fgRef.current.getGraphBbox((node: any) => isNodeVisible(node));
      if (bbox) {
        const centerX = (bbox.x[0] + bbox.x[1]) / 2;
        const centerY = (bbox.y[0] + bbox.y[1]) / 2;
        const centerZ = (bbox.z[0] + bbox.z[1]) / 2;
        controls.target.set(centerX, centerY, centerZ);
        controls.update();
      }
    }
  }, [graphData.links.length, graphData.nodes.length, graphRefVersion, isNodeVisible, settings.autoRotate, settings.autoRotateSpeed]);

  useEffect(() => {
    if (!fgRef.current) return;
    const chargeForce = fgRef.current.d3Force('charge');
    if (chargeForce && typeof chargeForce.strength === 'function') {
      chargeForce.strength(settings.chargeStrength);
      if (hasAppliedChargeRef.current && didAutoFitRef.current) {
        fgRef.current.d3ReheatSimulation();
      }
      hasAppliedChargeRef.current = true;
    }
  }, [graphRefVersion, settings.chargeStrength]);

  useEffect(() => {
    didAutoFitRef.current = false;
  }, [graphData.nodes.length, graphData.links.length]);

  const handleEngineStop = useCallback(() => {
    if (didAutoFitRef.current || graphData.nodes.length === 0) return;
    didAutoFitRef.current = true;
    fgRef.current?.zoomToFit(900, settings.focusDistance);
  }, [graphData.nodes.length, settings.focusDistance]);

  // --- 2. File System Integration ---
  const mountFromHandle = async (dirHandle: any) => {
    const newNodes: FileNode[] = [];
    const newLinks: FileLink[] = [];
    const rootId = 'root';
    const nodeMap = new Map<string, FileNode>();

    const addNode = (node: FileNode) => {
      newNodes.push(node);
      nodeMap.set(node.id, node);
    };

    addNode({
      id: rootId,
      name: dirHandle.name,
      type: 'folder',
      val: 20,
      group: 1,
      path: dirHandle.name,
      handle: dirHandle,
    });

    const readDir = async (handle: any, parentId: string, depth: number): Promise<number> => {
      if (depth > settings.maxDepth) return 0;
      let totalSize = 0;

      for await (const entry of handle.values()) {
        if (!settings.includeNodeModules && entry.kind === 'directory' && entry.name === 'node_modules') {
          continue;
        }
        const id = `${parentId}/${entry.name}`;
        const isDir = entry.kind === 'directory';

        let type: NodeType = isDir ? 'folder' : 'file';
        let group = isDir ? 2 : 3;

        if (!isDir) {
          if (/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(entry.name)) { type = 'image'; group = 4; }
          if (/\.(ts|tsx|js|jsx|mjs|cjs|css|html|json|md|py|go|rs|java|jl|toml)$/i.test(entry.name)) {
            type = 'code';
            group = 5;
          }
        }

        if (entry.name.toLowerCase().includes('agent')) {
          group = 7;
        }

        if (isDir) {
          addNode({
            id,
            name: entry.name,
            type,
            val: 10,
            group,
            path: id,
            handle: entry,
          });

          newLinks.push({ source: parentId, target: id, kind: 'tree' });
          const childSize = await readDir(entry, id, depth + 1);
          const dirNode = nodeMap.get(id);
          if (dirNode) dirNode.sizeBytes = childSize;
          totalSize += childSize;
        } else {
          const file = await entry.getFile();
          const sizeBytes = file.size;

          // Check if file content indicates it's an agent
          let isAgentContent = false;
          if (type === 'code' && sizeBytes <= settings.maxDependencyFileSizeKb * 1024) {
            try {
              const text = await file.text();
              const lowerText = text.toLowerCase();
              if (lowerText.includes('ollama') || lowerText.includes('agent') || lowerText.includes('sparkbyte') ||
                  text.includes('chatWithOllama') || text.includes('reviewCodeWithOllama') ||
                  text.includes('buildSparkByteInjectedFirstUserMessage')) {
                isAgentContent = true;
              }
            } catch (e) {
              // Ignore read errors
            }
          }

          if (isAgentContent) {
            group = 7;
          }

          addNode({
            id,
            name: entry.name,
            type,
            val: 5,
            group,
            path: id,
            handle: entry,
            sizeBytes,
          });

          newLinks.push({ source: parentId, target: id, kind: 'tree' });
          totalSize += sizeBytes;
        }
      }

      return totalSize;
    };

    const totalRootSize = await readDir(dirHandle, rootId, 0);
    const rootNode = nodeMap.get(rootId);
    if (rootNode) rootNode.sizeBytes = totalRootSize;

    setTreeData({ nodes: newNodes, links: newLinks });
    setDependencyLinks([]);
    setExternalNodes([]);
    setDependencyMap({});
    setDependencyStats(null);
    setExpandedFolders(new Set([rootId]));
    setMountName(dirHandle.name);
    if (settings.autoParseDependencies) {
      await parseDependencies({ nodes: newNodes, links: newLinks });
    }
  };

  const handleMountFileSystem = async () => {
    try {
      setReconnectStatus(null);
      if (typeof (window as any).showDirectoryPicker !== 'function') {
        setReconnectStatus('Folder picker unavailable in this runtime.');
        return;
      }
      // @ts-ignore - window.showDirectoryPicker is experimental/Chrome-only
      const dirHandle = await window.showDirectoryPicker();
      lastDirHandleRef.current = dirHandle;
      setCanReconnect(true);
      await saveLastHandle(dirHandle);
      await mountFromHandle(dirHandle);
    } catch (err) {
      console.error('Access denied or cancelled', err);
      setReconnectStatus('Mount cancelled or blocked by permissions.');
    }
  };

  const handleReconnectLastMount = async () => {
    setReconnectStatus(null);
    const handle = lastDirHandleRef.current ?? await loadLastHandle();
    if (!handle) {
      setReconnectStatus('No saved folder.');
      return;
    }
    const permitted = await requestHandlePermission(handle, 'read');
    if (!permitted) {
      setReconnectStatus('Permission denied.');
      return;
    }
    lastDirHandleRef.current = handle;
    setCanReconnect(true);
    await mountFromHandle(handle);
    setReconnectStatus('Reconnected.');
  };

  // --- JL Engine Architecture Demo Data ---
  const JL_ENGINE_ARCHITECTURE = {
    nodes: [
      {id: "EngineCore", label: "Engine Core", type: "code", path: "JL-Engine-local/src/engine/core"},
      {id: "PlatformAPI", label: "Platform API", type: "code", path: "JL-Engine-local/src/platform/api"},
      {id: "ToolSubsystem", label: "Tool Subsystem", type: "code", path: "JL-Engine-local/src/tools/subsystem"},
      {id: "ControlPlane", label: "Control Plane", type: "code", path: "JL-Engine-local/src/control/plane"},
      {id: "MemoryLattice", label: "Memory Lattice", type: "code", path: "JL-Engine-local/src/memory/lattice"},
      {id: "TaskExecutor", label: "Task Executor", type: "code", path: "JL-Engine-local/src/task/executor"},
      {id: "BehaviorEngine", label: "Behavior Engine", type: "code", path: "JL-Engine-local/src/behavior/engine"},
      {id: "GearStack", label: "Gear Stack", type: "code", path: "JL-Engine-local/src/gear/stack"},
      {id: "ConfigModule", label: "Config Module", type: "code", path: "JL-Engine-local/src/config/module"},
      {id: "RuntimeContext", label: "Runtime Context", type: "code", path: "JL-Engine-local/src/runtime/context"},
      {id: "EmotionAperture", label: "Emotion Aperture", type: "code", path: "JL-Engine-local/src/emotion/aperture"},
      {id: "CognitiveMode", label: "Cognitive Mode", type: "code", path: "JL-Engine-local/src/cognitive/mode"},
      {id: "ActionDirective", label: "Action Directive", type: "code", path: "JL-Engine-local/src/action/directive"},
      {id: "StateSnapshot", label: "State Snapshot", type: "code", path: "JL-Engine-local/src/state/snapshot"},
      {id: "AgentLattice", label: "Agent Lattice", type: "code", path: "JL-Engine-local/src/agent/lattice"}
    ],
    links: [
      {source: "EngineCore", target: "PlatformAPI"},
      {source: "EngineCore", target: "ToolSubsystem"},
      {source: "EngineCore", target: "ControlPlane"},
      {source: "EngineCore", target: "MemoryLattice"},
      {source: "ControlPlane", target: "TaskExecutor"},
      {source: "ControlPlane", target: "BehaviorEngine"},
      {source: "BehaviorEngine", target: "GearStack"},
      {source: "BehaviorEngine", target: "EmotionAperture"},
      {source: "BehaviorEngine", target: "CognitiveMode"},
      {source: "TaskExecutor", target: "ActionDirective"},
      {source: "EngineCore", target: "ConfigModule"},
      {source: "EngineCore", target: "RuntimeContext"},
      {source: "RuntimeContext", target: "StateSnapshot"},
      {source: "EngineCore", target: "AgentLattice"},
      {source: "AgentLattice", target: "BehaviorEngine"}
    ]
  };

  const loadJLEngineArchitecture = useCallback(() => {
    const newData: GraphData = {
      nodes: JL_ENGINE_ARCHITECTURE.nodes.map(n => ({
        id: n.id,
        name: n.label,
        type: n.type,
        sizeBytes: 1024
      })),
      links: JL_ENGINE_ARCHITECTURE.links.map(l => ({
        source: l.source,
        target: l.target
      }))
    };
    setTreeData(newData);
    setMountName('JL Engine Architecture');
    setSelectedNodeId(null);
    setSearchTerm('');
    setTimeout(() => fgRef.current?.zoomToFit(600), 100);
  }, []);

  // --- Search Logic ---
  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    const term = e.target.value;
    setSearchTerm(term);

    if (term) {
      const found = graphData.nodes.find((node) => node.name.toLowerCase().includes(term.toLowerCase()));
      if (found) selectNode(found);
    }
  };

  const toggleTypeVisibility = (type: NodeType) => {
    setVisibleTypes((prev) => ({ ...prev, [type]: !prev[type] }));
  };

  const resetCamera = () => {
    fgRef.current?.zoomToFit(600, settings.focusDistance);
  };

  const handleToggleTopBarModelEditor = useCallback(() => {
    const currentModel = (ollamaModel || DEFAULT_OLLAMA_MODEL).trim() || DEFAULT_OLLAMA_MODEL;
    setTopBarModelDraft(currentModel);
    setIsTopBarModelEditorOpen((prev) => !prev);
  }, [ollamaModel]);

  const handleApplyTopBarModel = useCallback(() => {
    const cleanedModel = topBarModelDraft.trim();
    setOllamaModel(cleanedModel || DEFAULT_OLLAMA_MODEL);
    setIsTopBarModelEditorOpen(false);
  }, [topBarModelDraft]);

  const handleCloseTopBarModelEditor = useCallback(() => {
    setIsTopBarModelEditorOpen(false);
  }, []);

  const fetchOllamaModels = useCallback(async () => {
    const normalizedBaseUrl = ((ollamaBaseUrl || DEFAULT_OLLAMA_BASE_URL).trim() || DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, '');
    setIsLoadingOllamaModels(true);
    setOllamaModelsError(null);
    try {
      const response = await fetch(`${normalizedBaseUrl}/api/tags`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        let details = '';
        try {
          details = await response.text();
        } catch {
          details = '';
        }
        const suffix = details ? ` ${details.slice(0, 120)}` : '';
        throw new Error(`Failed to load models (${response.status} ${response.statusText}).${suffix}`);
      }
      const payload = await response.json() as OllamaTagsResponse;
      const models = Array.from(
        new Set(
          (payload.models ?? [])
            .map((entry) => (entry.name || entry.model || '').trim())
            .filter(Boolean),
        ),
      ).sort((a, b) => a.localeCompare(b));
      setAvailableOllamaModels(models);
      if (!models.length) {
        setOllamaModelsError('Ollama is reachable, but no local models were returned.');
      }
    } catch (error) {
      const message = formatOllamaError(error, normalizedBaseUrl) || 'Unable to load models from Ollama.';
      setAvailableOllamaModels([]);
      setOllamaModelsError(message);
    } finally {
      setIsLoadingOllamaModels(false);
    }
  }, [ollamaBaseUrl]);

  useEffect(() => {
    if (!isTopBarModelEditorOpen) return;
    fetchOllamaModels();
  }, [fetchOllamaModels, isTopBarModelEditorOpen]);

  const nodeLabel = useCallback((node: any) => {
    const size = formatBytes(node.sizeBytes);
    const type = node.type ? String(node.type).toUpperCase() : '';
    const parts = [node.name, type, size].filter(Boolean);
    return parts.join('\n');
  }, []);

  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      if (!dragStateRef.current) return;
      const { side, startX, startWidth } = dragStateRef.current;
      const delta = event.clientX - startX;
      const minWidth = PANEL_MIN_WIDTH;
      const maxWidth = PANEL_MAX_WIDTH;

      if (side === 'left') {
        const next = clamp(startWidth + delta, minWidth, maxWidth);
        setLeftWidth(next);
      } else if (side === 'right') {
        const next = clamp(startWidth - delta, minWidth, maxWidth);
        setRightWidth(next);
      }
    };

    const handleUp = () => {
      if (!dragStateRef.current) return;
      dragStateRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, []);

  useEffect(() => {
    const handleResize = () => {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    let active = true;
    const loadHandle = async () => {
      const stored = await loadLastHandle();
      if (!active) return;
      if (stored) {
        lastDirHandleRef.current = stored;
        setCanReconnect(true);
      }
    };
    loadHandle();
    return () => {
      active = false;
    };
  }, []);

  const parseDependencies = useCallback(async (overrideTree?: GraphData) => {
    if (isParsingDeps) return;
    setIsParsingDeps(true);

    try {
      const sourceTree = overrideTree ?? treeData;
      const result = await scanDependencies(sourceTree, {
        includeNodeModules: settings.includeNodeModules,
        groupExternalDeps: settings.groupExternalDeps,
        maxDependencyFiles: settings.maxDependencyFiles,
        maxDependencyFileSizeKb: settings.maxDependencyFileSizeKb,
      });

      setDependencyLinks(result.dependencyLinks);
      setExternalNodes(result.externalNodes as FileNode[]);
      setDependencyMap(result.dependencyMap);
      setReverseDependencyMap(result.reverseDependencyMap);
      setDependencyStats(result.stats);
    } finally {
      setIsParsingDeps(false);
    }
  }, [isParsingDeps, settings.groupExternalDeps, settings.includeNodeModules, settings.maxDependencyFiles, settings.maxDependencyFileSizeKb, treeData]);

  useEffect(() => {
    let cancelled = false;

    const releasePreviewUrl = () => {
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = null;
      }
    };

    const resetPreviewState = () => {
      releasePreviewUrl();
      setPreviewUrl(null);
      setPreviewText(null);
      setPreviewError(null);
      setIsPreviewLoading(false);
      setSelectedFileAnalysis(null);
      setEditorContent(null);
      setEditorLoadedContent(null);
      setIsEditorDirty(false);
      setIsEditorLoading(false);
      setEditorError(null);
      setEditorStatus(null);
    };

    const loadPreview = async () => {
      resetPreviewState();

      if (!selectedNode) return;
      if (selectedNode.type === 'folder') {
        setPreviewError('Folders do not have a preview.');
        return;
      }
      if (selectedNode.type === 'external') {
        setPreviewError('External dependency node.');
        return;
      }
      if (!selectedNode.handle) {
        setPreviewError('Mount a folder to enable previews.');
        return;
      }

      setIsPreviewLoading(true);
      setIsEditorLoading(true);
      try {
        const file = await selectedNode.handle.getFile();
        if (selectedNode.type === 'image') {
          const url = URL.createObjectURL(file);
          if (cancelled) {
            URL.revokeObjectURL(url);
            return;
          }
          previewUrlRef.current = url;
          setPreviewUrl(url);
        } else if (isTextPreviewable(file, selectedNode.name)) {
          const text = await file.text();
          if (cancelled) return;
          const analysis = analyzeTextFile(selectedNode.name, text);
          const trimmed = text.slice(0, MAX_PREVIEW_CHARS);
          const lines = trimmed.split(/\r?\n/).slice(0, MAX_PREVIEW_LINES);
          setPreviewText(lines.join('\n') || '(empty file)');
          setSelectedFileAnalysis(analysis);
          const editorBuffer = text.slice(0, MAX_EDITOR_CHARS);
          setEditorContent(editorBuffer);
          setEditorLoadedContent(editorBuffer);
          setIsEditorDirty(false);
          setEditorError(null);
          setEditorStatus(editorBuffer.length >= MAX_EDITOR_CHARS ? 'Showing first 40k characters.' : null);
        } else {
          setPreviewError('Preview unavailable for this file type.');
        }
      } catch (err) {
        setPreviewError('Preview failed.');
        setEditorError('Unable to load code content.');
      } finally {
        if (!cancelled) {
          setIsPreviewLoading(false);
          setIsEditorLoading(false);
        }
      }
    };

    loadPreview();

    return () => {
      cancelled = true;
      releasePreviewUrl();
    };
  }, [selectedNode?.handle, selectedNode?.id, selectedNode?.type, selectedNode?.name]);

  // Recursive Tree Item Component
  const TreeItem = ({ nodeId, level = 0 }: { nodeId: string, level?: number }) => {
    const node = treeData.nodes.find((n) => n.id === nodeId);
    if (!node) return null;

    // Handle graph mutation of links (source/target become objects after graph init)
    const children = treeData.links
      .filter((link: any) => resolveId(link.source) === nodeId)
      .map((link: any) => treeData.nodes.find((n) => n.id === resolveId(link.target)))
      .filter((n): n is FileNode => !!n);

    const isFolder = node.type === 'folder';
    const isExpanded = expandedFolders.has(nodeId);
    const isSelected = selectedNodeId === node.id;
    const color = getNodeColor(node.group);
    const isDimmed = settings.focusBranchMode && branchNodeIds && !branchNodeIds.has(node.id);
    const itemOpacity = isDimmed ? 0.2 : (isSelected ? 1 : 0.7);

    return (
      <div style={{ marginLeft: level * 12, marginTop: 4, fontFamily: 'Segoe UI, Arial, sans-serif', fontSize: '13px' }}>
        <div
          onClick={() => {
            selectNode(node);
            if (isFolder) toggleFolder(nodeId);
          }}
          onDoubleClick={() => focusNode(node, settings.focusDistanceClose, 800)}
          style={{
            cursor: 'pointer',
            color: isSelected ? '#ffffff' : color,
            textShadow: isSelected ? `0 0 10px ${color}` : 'none',
            opacity: itemOpacity,
            display: 'flex',
            alignItems: 'center',
            userSelect: 'none',
            letterSpacing: '0.01em',
          }}
        >
          <span style={{ marginRight: 6, width: '12px', display: 'inline-block', opacity: 0.7 }}>
            {isFolder ? (isExpanded ? 'v' : '>') : '-'}
          </span>
          {node.name}
        </div>
        {isFolder && isExpanded && children.map((child) => (
          <TreeItem key={child.id} nodeId={child.id} level={level + 1} />
        ))}
      </div>
    );
  };

  const isCompactTopBar = viewport.width < 1700;
  const topBarHeight = isCompactTopBar ? 112 : 58;
  const panelTop = topBarHeight + 12;
  const panelBottom = 20;
  const collapsedWidth = 42;
  const activeOllamaModel = (ollamaModel || DEFAULT_OLLAMA_MODEL).trim() || DEFAULT_OLLAMA_MODEL;
  const topBarModelLabel = activeOllamaModel.length > 24
    ? `${activeOllamaModel.slice(0, 21)}...`
    : activeOllamaModel;
  const isModelSwitchBusy = isReviewingCode || isChattingWithModel;
  const ollamaCorsHint = aiProvider === 'ollama' ? buildOllamaCorsHint(ollamaBaseUrl) : '';
  const leftPanelWidth = isLeftCollapsed ? collapsedWidth : leftWidth;
  const rightPanelWidth = isRightCollapsed ? collapsedWidth : rightWidth;

  const beginResize = (side: 'left' | 'right') => (event: React.MouseEvent<HTMLDivElement>) => {
    if (side === 'left' && isLeftCollapsed) setIsLeftCollapsed(false);
    if (side === 'right' && isRightCollapsed) setIsRightCollapsed(false);
    dragStateRef.current = {
      side,
      startX: event.clientX,
      startWidth: side === 'left' ? leftWidth : rightWidth,
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    event.preventDefault();
  };

  const sliderStyle: React.CSSProperties = {
    width: '100%',
    accentColor: '#7bf6ff',
  };

  const sectionTitleStyle: React.CSSProperties = {
    fontSize: '0.78rem',
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    color: '#7f96b2',
    marginBottom: '10px',
  };

  const panelShellStyle: React.CSSProperties = {
    background: 'rgba(7, 11, 20, 0.58)',
    borderRadius: '10px',
    boxShadow: '0 8px 20px rgba(0, 0, 0, 0.22)',
    border: '1px solid rgba(120, 180, 255, 0.12)',
    backdropFilter: 'blur(8px)',
  };

  const cardStyle: React.CSSProperties = {
    background: 'rgba(12, 16, 28, 0.8)',
    borderRadius: '12px',
    padding: '14px',
    border: '1px solid rgba(255, 255, 255, 0.06)',
  };

  const buttonStyle: React.CSSProperties = {
    background: 'rgba(255, 255, 255, 0.06)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    color: '#e6f6ff',
    padding: '9px 12px',
    cursor: 'pointer',
    fontFamily: 'Segoe UI, Arial, sans-serif',
    fontSize: '0.8rem',
    borderRadius: '8px',
    transition: 'all 0.2s',
  };

  const accentButtonStyle: React.CSSProperties = {
    ...buttonStyle,
    background: 'linear-gradient(135deg, rgba(0, 255, 255, 0.25), rgba(0, 160, 255, 0.15))',
    border: '1px solid rgba(0, 255, 255, 0.35)',
    color: '#d9feff',
  };

  const rightTabButtonStyle = (tab: RightDockTab): React.CSSProperties => ({
    ...buttonStyle,
    flex: 1,
    padding: '7px 8px',
    fontSize: '0.74rem',
    borderRadius: '7px',
    border: tab === rightDockTab
      ? '1px solid rgba(125, 220, 255, 0.55)'
      : '1px solid rgba(255, 255, 255, 0.07)',
    background: tab === rightDockTab
      ? 'linear-gradient(135deg, rgba(85, 180, 255, 0.33), rgba(40, 100, 220, 0.14))'
      : 'rgba(255, 255, 255, 0.05)',
    color: tab === rightDockTab ? '#dff7ff' : '#b8d6ee',
  });

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        background: 'radial-gradient(circle at center, #08101a 0%, #02050a 55%, #000000 100%)',
        overflow: 'hidden',
        color: '#eef6ff',
        fontFamily: 'Segoe UI, Arial, sans-serif',
        fontSize: '15px',
        lineHeight: 1.5,
      }}
    >
      {/* Top Command Bar */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: `${topBarHeight}px`,
          display: 'flex',
          alignItems: isCompactTopBar ? 'flex-start' : 'center',
          flexWrap: isCompactTopBar ? 'wrap' : 'nowrap',
          padding: isCompactTopBar ? '8px 18px' : '0 18px',
          gap: isCompactTopBar ? '8px 12px' : '16px',
          background: 'linear-gradient(90deg, rgba(6, 8, 14, 0.92), rgba(10, 14, 22, 0.7))',
          borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
          backdropFilter: 'blur(12px)',
          zIndex: 40,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <img
            src={LOGO_SRC}
            alt="JL Engine logo"
            style={{
              width: 56,
              height: 32,
              borderRadius: 10,
              border: '1px solid rgba(255,255,255,0.25)',
              background: 'rgba(0,0,0,0.6)',
              objectFit: 'cover',
              boxShadow: '0 0 8px rgba(0, 255, 170, 0.45)',
            }}
          />
          <div style={{ fontWeight: 600, letterSpacing: '0.2em', fontSize: '0.8rem' }}>NEURAL NEXUS</div>
          <div style={{ fontSize: '0.72rem', color: '#6f86a3' }}>SCOUT CONSOLE</div>
        </div>
        <div
          style={{
            flex: isCompactTopBar ? '1 1 100%' : '1 1 auto',
            maxWidth: isCompactTopBar ? '100%' : '400px',
            order: isCompactTopBar ? 3 : 2,
          }}
        >
          <input
            type="text"
            placeholder="Search files, folders, nodes..."
            value={searchTerm}
            onChange={handleSearch}
            style={{
              width: '100%',
              background: 'rgba(6, 8, 14, 0.8)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: '10px',
              padding: '8px 12px',
              color: '#e7f3ff',
              fontSize: '0.85rem',
              outline: 'none',
            }}
          />
        </div>
        <div
          style={{
            display: 'flex',
            gap: '10px',
            flexWrap: 'wrap',
            width: isCompactTopBar ? '100%' : 'auto',
            order: isCompactTopBar ? 2 : 3,
          }}
        >
          <button style={accentButtonStyle} onClick={handleMountFileSystem}>Mount Folder</button>
          <button style={accentButtonStyle} onClick={loadJLEngineArchitecture} title="Load JL Engine Architecture Demo">
            Load JL Engine
          </button>
          <button
            style={{
              ...buttonStyle,
              opacity: isModelSwitchBusy || aiProvider !== 'ollama' ? 0.5 : 1,
              cursor: isModelSwitchBusy || aiProvider !== 'ollama' ? 'not-allowed' : 'pointer',
            }}
            onClick={handleToggleTopBarModelEditor}
            disabled={isModelSwitchBusy || aiProvider !== 'ollama'}
            title={aiProvider === 'ollama'
              ? `Current Ollama model: ${activeOllamaModel}`
              : `Switch provider/model in Controls tab (current: ${activeProviderLabel})`}
          >
            Model: {aiProvider === 'ollama' ? topBarModelLabel : `${activeProviderLabel}`}
          </button>
          {isTopBarModelEditorOpen && aiProvider === 'ollama' && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'stretch',
                gap: '6px',
                padding: '4px 6px',
                borderRadius: '8px',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                background: 'rgba(4, 6, 12, 0.75)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <select
                  value={topBarModelDraft}
                  onChange={(event) => setTopBarModelDraft(event.target.value)}
                  disabled={isModelSwitchBusy || isLoadingOllamaModels || availableOllamaModels.length === 0}
                  style={{
                    width: isCompactTopBar ? '100%' : '220px',
                    background: 'rgba(4, 6, 12, 0.85)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    borderRadius: '8px',
                    padding: '7px 9px',
                    color: '#e0f0ff',
                    fontSize: '0.72rem',
                    outline: 'none',
                  }}
                  title="Detected models from Ollama /api/tags"
                >
                  {!availableOllamaModels.includes(topBarModelDraft) && !!topBarModelDraft && (
                    <option value={topBarModelDraft}>{topBarModelDraft} (current)</option>
                  )}
                  {availableOllamaModels.map((modelName) => (
                    <option key={modelName} value={modelName}>{modelName}</option>
                  ))}
                  {availableOllamaModels.length === 0 && (
                    <option value={topBarModelDraft || DEFAULT_OLLAMA_MODEL}>
                      {isLoadingOllamaModels ? 'Loading models...' : 'No detected models'}
                    </option>
                  )}
                </select>
                <button style={buttonStyle} onClick={fetchOllamaModels} disabled={isModelSwitchBusy || isLoadingOllamaModels}>
                  {isLoadingOllamaModels ? 'Loading...' : 'Refresh'}
                </button>
              </div>
              <input
                value={topBarModelDraft}
                onChange={(event) => setTopBarModelDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    handleApplyTopBarModel();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    handleCloseTopBarModelEditor();
                  }
                }}
                placeholder={DEFAULT_OLLAMA_MODEL}
                style={{
                  width: isCompactTopBar ? '100%' : '220px',
                  background: 'rgba(4, 6, 12, 0.85)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  borderRadius: '8px',
                  padding: '7px 9px',
                  color: '#e0f0ff',
                  fontSize: '0.72rem',
                  outline: 'none',
                }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <button style={accentButtonStyle} onClick={handleApplyTopBarModel} disabled={isModelSwitchBusy}>
                  Apply
                </button>
                <button style={buttonStyle} onClick={handleCloseTopBarModelEditor}>Close</button>
              </div>
              {ollamaModelsError && (
                <div style={{ fontSize: '0.68rem', color: '#ffb8b8', maxWidth: '360px' }}>
                  {ollamaModelsError}
                </div>
              )}
            </div>
          )}
          <button
            style={{
              ...buttonStyle,
              opacity: canReconnect ? 1 : 0.4,
              cursor: canReconnect ? 'pointer' : 'not-allowed',
            }}
            onClick={handleReconnectLastMount}
            disabled={!canReconnect}
          >
            Reconnect
          </button>
          <button style={buttonStyle} onClick={resetCamera}>Reset View</button>
          <button
            style={buttonStyle}
            onClick={() => setIsLeftCollapsed((prev) => !prev)}
          >
            {isLeftCollapsed ? 'Show Explorer' : 'Hide Explorer'}
          </button>
          <button
            style={buttonStyle}
            onClick={() => setIsRightCollapsed((prev) => !prev)}
          >
            {isRightCollapsed ? 'Show Inspector' : 'Hide Inspector'}
          </button>
        </div>
      </div>

      {/* Explorer Panel */}
      <div
        style={{
          position: 'absolute',
          top: `${panelTop}px`,
          bottom: `${panelBottom}px`,
          left: '8px',
          width: `${leftPanelWidth}px`,
          padding: isLeftCollapsed ? '12px' : '18px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          zIndex: 20,
          ...panelShellStyle,
        }}
      >
        {isLeftCollapsed ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', alignItems: 'center' }}>
            <div style={{ fontSize: '0.7rem', color: '#7f96b2', writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
              Explorer
            </div>
            <button style={buttonStyle} onClick={() => setIsLeftCollapsed(false)}>&gt;</button>
          </div>
        ) : (
          <>
            <div style={sectionTitleStyle}>Explorer</div>
            <div style={{ fontSize: '0.82rem', fontWeight: 600, color: '#d6e5ff' }}>Workspace</div>
            <div style={{ fontSize: '0.72rem', color: mountName ? '#7bf6ff' : '#6b7c96' }}>
              {mountName ? `Mounted: ${mountName}` : 'No folder mounted.'}
            </div>
            {reconnectStatus && (
              <div style={{ fontSize: '0.7rem', color: '#9db3d3', marginTop: '4px' }}>
                {reconnectStatus}
              </div>
            )}
            {workspaceSummary && (
              <div
                style={{
                  ...cardStyle,
                  marginTop: '10px',
                  padding: '10px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                }}
              >
                <div style={{ fontSize: '0.72rem', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#9eb2cc' }}>
                  Workspace Intelligence
                </div>
                {workspaceSummary.frameworkHints.length > 0 && (
                  <div style={{ fontSize: '0.7rem', color: '#c6d9f3', lineHeight: 1.45 }}>
                    Stack: {workspaceSummary.frameworkHints.slice(0, 4).join(', ')}
                    {workspaceSummary.frameworkHints.length > 4 ? '...' : ''}
                  </div>
                )}
                {workspaceSummary.manifestFiles.length > 0 && (
                  <div style={{ fontSize: '0.7rem', color: '#9eb2cc', lineHeight: 1.45 }}>
                    Manifests: {workspaceSummary.manifestFiles.slice(0, 3).map((item) => item.label).join(', ')}
                    {workspaceSummary.manifestFiles.length > 3 ? '...' : ''}
                  </div>
                )}
                {workspaceSummary.entryPoints.length > 0 && (
                  <div style={{ fontSize: '0.7rem', color: '#9eb2cc', lineHeight: 1.45 }}>
                    Entry points: {workspaceSummary.entryPoints.slice(0, 3).map(formatPathLabel).join(', ')}
                    {workspaceSummary.entryPoints.length > 3 ? '...' : ''}
                  </div>
                )}
                {workspaceSummary.scripts.length > 0 && (
                  <div style={{ fontSize: '0.7rem', color: '#9eb2cc', lineHeight: 1.45 }}>
                    Scripts: {workspaceSummary.scripts.slice(0, 4).join(', ')}
                    {workspaceSummary.scripts.length > 4 ? '...' : ''}
                  </div>
                )}
                {workspaceSummary.headings.length > 0 && (
                  <div style={{ fontSize: '0.7rem', color: '#7f96b2', lineHeight: 1.45 }}>
                    Docs: {workspaceSummary.headings.slice(0, 3).join(' | ')}
                    {workspaceSummary.headings.length > 3 ? '...' : ''}
                  </div>
                )}
              </div>
            )}
            <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
              <div style={sectionTitleStyle}>Files</div>
              <div style={{ flex: 1, overflowY: 'auto', paddingRight: '6px', maxHeight: '100%' }}>
                <TreeItem nodeId="root" />
              </div>
            </div>
          </>
        )}
        <div
          onMouseDown={beginResize('left')}
          style={{
            position: 'absolute',
            top: 0,
            right: -5,
            width: 10,
            bottom: 0,
            cursor: 'col-resize',
            zIndex: 35,
            opacity: isLeftCollapsed ? 0.7 : 0.35,
            background: 'linear-gradient(270deg, rgba(110, 210, 255, 0.35), rgba(110, 210, 255, 0))',
          }}
        />
      </div>

      {/* IDE Right Dock */}
      <div
        style={{
          position: 'absolute',
          top: `${panelTop}px`,
          bottom: `${panelBottom}px`,
          right: '8px',
          width: `${rightPanelWidth}px`,
          padding: isRightCollapsed ? '10px' : '12px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
          zIndex: 20,
          overflow: 'hidden',
          ...panelShellStyle,
        }}
      >
        {isRightCollapsed ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'center' }}>
            <div style={{ fontSize: '0.7rem', color: '#7f96b2', writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
              Dock
            </div>
            <button style={buttonStyle} onClick={() => setIsRightCollapsed(false)}>&lt;</button>
          </div>
        ) : (
          <>
            <div style={{ ...sectionTitleStyle, marginBottom: '0px' }}>Right Dock</div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button style={rightTabButtonStyle('inspector')} onClick={() => setRightDockTab('inspector')}>Inspector</button>
              <button style={rightTabButtonStyle('editor')} onClick={() => setRightDockTab('editor')}>Editor</button>
              <button style={rightTabButtonStyle('chat')} onClick={() => setRightDockTab('chat')}>Chat</button>
              <button style={rightTabButtonStyle('review')} onClick={() => setRightDockTab('review')}>Review</button>
              <button style={rightTabButtonStyle('controls')} onClick={() => setRightDockTab('controls')}>Controls</button>
            </div>

            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                paddingRight: '4px',
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
              }}
            >
              {rightDockTab === 'inspector' && (
                <>
                  <div style={cardStyle}>
                    {selectedNode ? (
                      <>
                        <div style={{ fontSize: '0.95rem', fontWeight: 600 }}>{selectedNode.name}</div>
                        <div style={{ fontSize: '0.72rem', color: '#8ea2bf', marginTop: '4px' }}>
                          {selectedNode.type.toUpperCase()}
                          {selectedNode.sizeBytes !== undefined ? ` | ${formatBytes(selectedNode.sizeBytes)}` : ''}
                        </div>
                        {selectedNode.path && (
                          <div style={{ fontSize: '0.7rem', color: '#6f86a3', marginTop: '4px' }}>
                            {selectedNode.path}
                          </div>
                        )}

                        <div style={{ marginTop: '10px' }}>
                          <div style={{ fontSize: '0.72rem', color: '#9eb2cc', marginBottom: '6px' }}>Preview</div>
                          {isPreviewLoading && <div style={{ fontSize: '0.72rem', color: '#8ea2bf' }}>Loading preview...</div>}
                          {!isPreviewLoading && previewError && <div style={{ fontSize: '0.72rem', color: '#ff9b9b' }}>{previewError}</div>}
                          {!isPreviewLoading && previewUrl && (
                            <img
                              src={previewUrl}
                              alt={selectedNode.name}
                              style={{ width: '100%', maxHeight: '220px', objectFit: 'cover', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.08)' }}
                            />
                          )}
                          {!isPreviewLoading && !previewUrl && previewText && (
                            <pre
                              style={{
                                whiteSpace: 'pre-wrap',
                                background: 'rgba(0,0,0,0.35)',
                                border: '1px solid rgba(255,255,255,0.08)',
                                borderRadius: '8px',
                                padding: '8px',
                                fontSize: '0.72rem',
                                maxHeight: '180px',
                                overflowY: 'auto',
                                color: '#dbe7ff',
                              }}
                            >
                              {previewText}
                            </pre>
                          )}
                        </div>
                      </>
                    ) : (
                      <div style={{ fontSize: '0.75rem', color: '#7b8ea8' }}>
                        Select a node in the graph or explorer.
                      </div>
                    )}
                  </div>

                  <div style={cardStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                      <div style={{ fontSize: '0.75rem', color: '#9eb2cc' }}>Dependencies</div>
                      <button
                        onClick={() => parseDependencies()}
                        style={{ ...buttonStyle, padding: '4px 8px', fontSize: '0.7rem', opacity: isParsingDeps ? 0.65 : 1 }}
                        disabled={isParsingDeps}
                      >
                        {isParsingDeps ? 'Parsing...' : 'Parse'}
                      </button>
                    </div>
                    {nodeDeps ? (
                      <div style={{ fontSize: '0.72rem', color: '#9eb2cc', lineHeight: 1.45 }}>
                        <div>Internal: {nodeDeps.internal.length}</div>
                        <div>External: {nodeDeps.external.length}</div>
                        <div>Unresolved: {nodeDeps.unresolved.length}</div>
                        <div>Incoming: {nodeDependents.length}</div>
                      </div>
                    ) : (
                      <div style={{ fontSize: '0.72rem', color: '#7b8ea8' }}>Run Parse to analyze imports.</div>
                    )}
                    <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
                      <button style={buttonStyle} disabled={!selectedNode} onClick={isIsolationActive ? resetIsolation : isolateSelection}>
                        {isIsolationActive ? 'Exit isolation' : 'Show connected'}
                      </button>
                    </div>
                  </div>
                </>
              )}

              {rightDockTab === 'editor' && (
                <div style={cardStyle}>
                  <div style={{ fontSize: '0.75rem', color: '#9eb2cc', marginBottom: '8px' }}>Code Editor</div>
                  {selectedNode && isEditorEligibleType(selectedNode.type) ? (
                    editorContent !== null ? (
                      <>
                        <div
                          style={{
                            display: 'grid',
                            gridTemplateColumns: '52px 1fr',
                            minHeight: '360px',
                            borderRadius: '8px',
                            border: '1px solid rgba(255,255,255,0.1)',
                            background: 'rgba(4, 6, 12, 0.9)',
                            overflow: 'hidden',
                          }}
                        >
                          <pre
                            ref={dockEditorLinesRef}
                            style={{
                              margin: 0,
                              padding: '10px 6px 10px 0',
                              textAlign: 'right',
                              fontSize: '0.72rem',
                              color: '#6f86a3',
                              fontFamily: 'Consolas, "SFMono-Regular", "Segoe UI", monospace',
                              lineHeight: 1.45,
                              userSelect: 'none',
                              overflow: 'hidden',
                              borderRight: '1px solid rgba(255,255,255,0.08)',
                              background: 'rgba(20, 28, 44, 0.55)',
                            }}
                          >
                            {editorLineNumbers}
                          </pre>
                          <textarea
                            ref={dockEditorRef}
                            value={editorContent}
                            onChange={(e) => handleEditorChange(e.target.value)}
                            onScroll={() => syncEditorLineScroll('dock')}
                            onSelect={(e) => handleEditorCursorUpdate((e.target as HTMLTextAreaElement).selectionStart)}
                            onKeyUp={(e) => handleEditorCursorUpdate((e.target as HTMLTextAreaElement).selectionStart)}
                            onClick={(e) => handleEditorCursorUpdate((e.target as HTMLTextAreaElement).selectionStart)}
                            disabled={isEditorLoading}
                            spellCheck={false}
                            wrap="off"
                            style={{
                              width: '100%',
                              minHeight: '360px',
                              border: 'none',
                              background: 'transparent',
                              color: '#e0f0ff',
                              padding: '10px',
                              fontSize: '0.76rem',
                              fontFamily: 'Consolas, "SFMono-Regular", "Segoe UI", monospace',
                              resize: 'vertical',
                              lineHeight: 1.45,
                              outline: 'none',
                            }}
                          />
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', marginTop: '8px', alignItems: 'center' }}>
                          <div style={{ fontSize: '0.72rem', color: '#7f96b2' }}>
                            {isEditorLoading ? 'Loading editor...' : isEditorDirty ? 'Unsaved changes' : 'In sync'}
                            {editorStatus ? ` | ${editorStatus}` : ''}
                            {` | Ln ${editorCursor.line}, Col ${editorCursor.column}`}
                          </div>
                          <div style={{ display: 'flex', gap: '6px' }}>
                            <button style={accentButtonStyle} onClick={handleEditorSave} disabled={isEditorLoading || !isEditorDirty}>Save</button>
                            <button style={buttonStyle} onClick={handleEditorRevert} disabled={isEditorLoading || !isEditorDirty}>Revert</button>
                          </div>
                        </div>
                        {editorError && <div style={{ marginTop: '6px', fontSize: '0.72rem', color: '#ff7a7a' }}>{editorError}</div>}
                      </>
                    ) : (
                      <div style={{ fontSize: '0.75rem', color: '#9eb2cc' }}>{isEditorLoading ? 'Loading editor...' : 'Editor unavailable for this node.'}</div>
                    )
                  ) : (
                    <div style={{ fontSize: '0.75rem', color: '#7b8ea8' }}>
                      Select a code/text node to edit.
                    </div>
                  )}
                </div>
              )}

              {rightDockTab === 'chat' && (
                <div style={cardStyle}>
                  <div style={{ fontSize: '0.75rem', color: '#9eb2cc', marginBottom: '8px' }}>
                    Coding Chat ({activeProviderLabel}: {activeProviderModel})
                  </div>
                  <div style={{ maxHeight: '320px', overflowY: 'auto', borderRadius: '8px', background: 'rgba(0, 0, 0, 0.35)', border: '1px solid rgba(255,255,255,0.06)', padding: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {chatMessages.length === 0 ? (
                      <div style={{ fontSize: '0.74rem', color: '#7f96b2' }}>Ask for refactors, bug checks, architecture suggestions, or test ideas.</div>
                    ) : (
                      chatMessages.map((message, index) => (
                        <div
                          key={`chat-${index}`}
                          style={{
                            fontSize: '0.74rem',
                            lineHeight: 1.45,
                            color: message.role === 'assistant' ? '#dbe7ff' : '#9cdcff',
                            whiteSpace: 'pre-wrap',
                            borderRadius: '8px',
                            padding: '6px 8px',
                            background: message.role === 'assistant' ? 'rgba(40, 70, 120, 0.18)' : 'rgba(0, 160, 255, 0.14)',
                          }}
                        >
                          <strong style={{ color: '#c9f0ff' }}>{message.role === 'assistant' ? 'Model' : 'You'}:</strong>{' '}
                          {message.content}
                          {message.role === 'assistant' && (
                            <div style={{ marginTop: '6px' }}>
                              <button style={buttonStyle} onClick={() => handleApplyAssistantCode(message.content)} disabled={isChattingWithModel || editorContent === null}>
                                Apply Code To Editor
                              </button>
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                  <textarea
                    value={chatInput}
                    onChange={(event) => setChatInput(event.target.value)}
                    placeholder="Ask the coding model about this file..."
                    disabled={isChattingWithModel}
                    style={{
                      width: '100%',
                      marginTop: '8px',
                      minHeight: '92px',
                      borderRadius: '8px',
                      border: '1px solid rgba(255,255,255,0.08)',
                      background: 'rgba(4, 6, 12, 0.85)',
                      color: '#e0f0ff',
                      padding: '8px 10px',
                      fontSize: '0.74rem',
                      fontFamily: 'Consolas, "SFMono-Regular", "Segoe UI", monospace',
                      resize: 'vertical',
                      lineHeight: 1.4,
                    }}
                  />
                  <div style={{ display: 'flex', gap: '8px', marginTop: '8px', alignItems: 'center' }}>
                    <button style={accentButtonStyle} onClick={handleSendCodingChat} disabled={isChattingWithModel || !chatInput.trim()}>
                      {isChattingWithModel ? 'Thinking...' : 'Send'}
                    </button>
                    <button style={buttonStyle} onClick={handleClearCodingChat} disabled={isChattingWithModel || chatMessages.length === 0}>Clear</button>
                    <button style={buttonStyle} onClick={handleApplyLatestAssistantCode} disabled={isChattingWithModel || chatMessages.length === 0 || editorContent === null}>Apply Latest Code</button>
                  </div>
                  {chatStatus && <div style={{ marginTop: '8px', fontSize: '0.72rem', color: '#9db3d3' }}>{chatStatus}</div>}
                  {chatApplyStatus && <div style={{ marginTop: '8px', fontSize: '0.72rem', color: '#9ff6bf' }}>{chatApplyStatus}</div>}
                  {chatError && <div style={{ marginTop: '8px', fontSize: '0.72rem', color: '#ff7a7a' }}>{chatError}</div>}
                  {chatApplyError && <div style={{ marginTop: '8px', fontSize: '0.72rem', color: '#ff9b9b' }}>{chatApplyError}</div>}
                </div>
              )}

              {rightDockTab === 'review' && (
                <div style={cardStyle}>
                  <div style={{ fontSize: '0.75rem', color: '#9eb2cc', marginBottom: '8px' }}>
                    AI Reviewer ({activeProviderLabel}: {activeProviderModel})
                  </div>
                  {ollamaCorsHint && (
                    <div style={{ marginBottom: '8px', padding: '8px 10px', borderRadius: '8px', border: '1px solid rgba(255,180,80,0.25)', background: 'rgba(120,70,0,0.14)', color: '#ffd8a6', fontSize: '0.68rem', lineHeight: 1.45 }}>
                      Hosted Webula can only reach a local Ollama server if Ollama allows this site origin. {ollamaCorsHint}
                    </div>
                  )}
                  {aiProvider === 'ollama' ? (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                      <input
                        value={ollamaBaseUrl}
                        onChange={(event) => setOllamaBaseUrl(event.target.value)}
                        placeholder={DEFAULT_OLLAMA_BASE_URL}
                        style={{ width: '100%', background: 'rgba(4,6,12,0.85)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px', padding: '8px 10px', color: '#e0f0ff', fontSize: '0.72rem', outline: 'none' }}
                      />
                      <input
                        value={ollamaModel}
                        onChange={(event) => setOllamaModel(event.target.value)}
                        placeholder={DEFAULT_OLLAMA_MODEL}
                        style={{ width: '100%', background: 'rgba(4,6,12,0.85)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px', padding: '8px 10px', color: '#e0f0ff', fontSize: '0.72rem', outline: 'none' }}
                      />
                    </div>
                  ) : (
                    <div style={{ fontSize: '0.72rem', color: '#9db3d3' }}>
                      Using {activeProviderLabel} with model `{activeProviderModel}`.
                      {!activeProviderApiKey.trim() && (
                        <> Enter an API key in the Controls tab.</>
                      )}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: '8px', marginTop: '8px', alignItems: 'center' }}>
                    <button style={accentButtonStyle} onClick={handleRunOllamaReview} disabled={isReviewingCode || !editorContent || !editorContent.trim()}>
                      {isReviewingCode ? 'Reviewing...' : 'Review Current File'}
                    </button>
                    <div style={{ fontSize: '0.7rem', color: '#7f96b2' }}>Max {Math.floor(MAX_OLLAMA_REVIEW_CHARS / 1000)}k chars</div>
                  </div>
                  {reviewStatus && <div style={{ marginTop: '8px', fontSize: '0.72rem', color: '#9db3d3' }}>{reviewStatus}</div>}
                  {reviewError && <div style={{ marginTop: '8px', fontSize: '0.72rem', color: '#ff7a7a' }}>{reviewError}</div>}
                  {reviewResult && (
                    <pre
                      style={{
                        marginTop: '8px',
                        whiteSpace: 'pre-wrap',
                        background: 'rgba(0,0,0,0.45)',
                        border: '1px solid rgba(255,255,255,0.08)',
                        borderRadius: '10px',
                        padding: '10px',
                        fontSize: '0.74rem',
                        maxHeight: '360px',
                        overflowY: 'auto',
                        color: '#dbe7ff',
                        lineHeight: 1.45,
                      }}
                    >
                      {reviewResult}
                    </pre>
                  )}
                </div>
              )}

              {rightDockTab === 'controls' && (
                <>
                  <div style={cardStyle}>
                    <div style={{ fontSize: '0.75rem', color: '#9eb2cc', marginBottom: '8px' }}>AI Providers</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      <select
                        value={aiProvider}
                        onChange={(event) => setAiProvider(event.target.value as AiProvider)}
                        style={{
                          width: '100%',
                          background: 'rgba(4,6,12,0.85)',
                          border: '1px solid rgba(255,255,255,0.08)',
                          borderRadius: '8px',
                          padding: '8px 10px',
                          color: '#e0f0ff',
                          fontSize: '0.74rem',
                          outline: 'none',
                        }}
                      >
                        <option value="ollama">Ollama (Local)</option>
                        <option value="openai">OpenAI</option>
                        <option value="gemini">Gemini</option>
                        <option value="anthropic">Anthropic (Claude)</option>
                      </select>
                      {aiProvider === 'ollama' ? (
                        <>
                          <input
                            value={ollamaBaseUrl}
                            onChange={(event) => setOllamaBaseUrl(event.target.value)}
                            placeholder={DEFAULT_OLLAMA_BASE_URL}
                            style={{ width: '100%', background: 'rgba(4,6,12,0.85)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px', padding: '8px 10px', color: '#e0f0ff', fontSize: '0.74rem', outline: 'none' }}
                          />
                          <input
                            value={ollamaModel}
                            onChange={(event) => setOllamaModel(event.target.value)}
                            placeholder={DEFAULT_OLLAMA_MODEL}
                            style={{ width: '100%', background: 'rgba(4,6,12,0.85)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px', padding: '8px 10px', color: '#e0f0ff', fontSize: '0.74rem', outline: 'none' }}
                          />
                        </>
                      ) : (
                        <>
                          <input
                            value={cloudModel}
                            onChange={(event) => setCloudModel(event.target.value)}
                            placeholder={aiProvider === 'openai' ? DEFAULT_OPENAI_MODEL : aiProvider === 'gemini' ? DEFAULT_GEMINI_MODEL : DEFAULT_ANTHROPIC_MODEL}
                            style={{ width: '100%', background: 'rgba(4,6,12,0.85)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px', padding: '8px 10px', color: '#e0f0ff', fontSize: '0.74rem', outline: 'none' }}
                          />
                          <input
                            type="password"
                            value={aiProvider === 'openai' ? openaiApiKey : aiProvider === 'gemini' ? geminiApiKey : anthropicApiKey}
                            onChange={(event) => {
                              if (aiProvider === 'openai') setOpenaiApiKey(event.target.value);
                              else if (aiProvider === 'gemini') setGeminiApiKey(event.target.value);
                              else setAnthropicApiKey(event.target.value);
                            }}
                            placeholder={`${activeProviderLabel} API key`}
                            style={{ width: '100%', background: 'rgba(4,6,12,0.85)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px', padding: '8px 10px', color: '#e0f0ff', fontSize: '0.74rem', outline: 'none' }}
                          />
                          <div style={{ fontSize: '0.7rem', color: '#7f96b2' }}>
                            Keys are stored only in this browser's local storage for this app.
                          </div>
                        </>
                      )}
                    </div>
                  </div>

                  <div style={cardStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                      <div style={{ fontSize: '0.75rem', color: '#9eb2cc' }}>Node Filters</div>
                      <button
                        onClick={() => setIsFiltersOpen((prev) => !prev)}
                        style={{ ...buttonStyle, padding: '4px 8px', fontSize: '0.7rem' }}
                      >
                        {isFiltersOpen ? 'Hide' : 'Show'}
                      </button>
                    </div>
                    {isFiltersOpen && (
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 10px' }}>
                        {(['folder', 'file', 'image', 'code', 'external'] as NodeType[]).map((type) => (
                          <label key={type} style={{ fontSize: '0.75rem', opacity: visibleTypes[type] ? 1 : 0.5 }}>
                            <input
                              type="checkbox"
                              checked={visibleTypes[type]}
                              onChange={() => toggleTypeVisibility(type)}
                              style={{ marginRight: 6 }}
                            />
                            {type.toUpperCase()}
                          </label>
                        ))}
                      </div>
                    )}
                  </div>

                  <div style={cardStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                      <div style={{ fontSize: '0.75rem', color: '#9eb2cc' }}>Environment</div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                      <div>
                        <div style={{ fontSize: '0.7rem', opacity: 0.7 }}>Charge Strength: {settings.chargeStrength}</div>
                        <input type="range" min={-400} max={-5} step={5} value={settings.chargeStrength} onChange={(e) => updateSetting('chargeStrength', Number(e.target.value))} style={sliderStyle} />
                      </div>
                      <div>
                        <div style={{ fontSize: '0.7rem', opacity: 0.7 }}>Node Glow: {settings.nodeGlow.toFixed(2)}</div>
                        <input type="range" min={0} max={2.5} step={0.05} value={settings.nodeGlow} onChange={(e) => updateSetting('nodeGlow', Number(e.target.value))} style={sliderStyle} />
                      </div>
                      <div>
                        <div style={{ fontSize: '0.7rem', opacity: 0.7 }}>Link Opacity: {settings.linkOpacity.toFixed(2)}</div>
                        <input type="range" min={0.05} max={1} step={0.05} value={settings.linkOpacity} onChange={(e) => updateSetting('linkOpacity', Number(e.target.value))} style={sliderStyle} />
                      </div>
                      <div>
                        <div style={{ fontSize: '0.7rem', opacity: 0.7 }}>Link Width: {settings.linkWidth.toFixed(2)}</div>
                        <input type="range" min={0.2} max={3} step={0.1} value={settings.linkWidth} onChange={(e) => updateSetting('linkWidth', Number(e.target.value))} style={sliderStyle} />
                      </div>
                      <div>
                        <div style={{ fontSize: '0.7rem', opacity: 0.7 }}>Node Size Scale: {settings.nodeSizeScale.toFixed(1)}</div>
                        <input type="range" min={0.5} max={30} step={0.5} value={settings.nodeSizeScale} onChange={(e) => updateSetting('nodeSizeScale', Number(e.target.value))} style={sliderStyle} />
                      </div>
                      <div>
                        <div style={{ fontSize: '0.7rem', opacity: 0.7 }}>Pulse Interval: {settings.pulseIntervalMs} ms</div>
                        <input type="range" min={200} max={3000} step={50} value={settings.pulseIntervalMs} onChange={(e) => updateSetting('pulseIntervalMs', Number(e.target.value))} style={sliderStyle} />
                      </div>
                    </div>
                  </div>

                  <div style={cardStyle}>
                    <div style={{ fontSize: '0.75rem', color: '#9eb2cc', marginBottom: '8px' }}>Stars</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                      <label style={{ fontSize: '0.75rem' }}>
                        <input
                          type="checkbox"
                          checked={settings.starfieldEnabled}
                          onChange={(e) => updateSetting('starfieldEnabled', e.target.checked)}
                          style={{ marginRight: 6 }}
                        />
                        Starfield enabled
                      </label>
                      <div>
                        <div style={{ fontSize: '0.7rem', opacity: 0.7 }}>Star Count: {Math.floor(settings.starCount)}</div>
                        <input type="range" min={0} max={12000} step={200} value={settings.starCount} onChange={(e) => updateSetting('starCount', Number(e.target.value))} style={sliderStyle} />
                      </div>
                      <div>
                        <div style={{ fontSize: '0.7rem', opacity: 0.7 }}>Star Spread: {settings.starSpread}</div>
                        <input type="range" min={600} max={6000} step={100} value={settings.starSpread} onChange={(e) => updateSetting('starSpread', Number(e.target.value))} style={sliderStyle} />
                      </div>
                      <div>
                        <div style={{ fontSize: '0.7rem', opacity: 0.7 }}>Star Opacity: {settings.starOpacity.toFixed(2)}</div>
                        <input type="range" min={0.05} max={1} step={0.05} value={settings.starOpacity} onChange={(e) => updateSetting('starOpacity', Number(e.target.value))} style={sliderStyle} />
                      </div>
                      <div>
                        <div style={{ fontSize: '0.7rem', opacity: 0.7 }}>Star Size: {settings.starSize.toFixed(2)}</div>
                        <input type="range" min={0.2} max={3} step={0.05} value={settings.starSize} onChange={(e) => updateSetting('starSize', Number(e.target.value))} style={sliderStyle} />
                      </div>
                    </div>
                  </div>

                  <div style={cardStyle}>
                    <div style={{ fontSize: '0.75rem', color: '#9eb2cc', marginBottom: '8px' }}>Pulse Trace</div>
                    <div style={{ fontSize: '0.72rem', color: '#7f96b2', marginBottom: '8px' }}>
                      {pulseStatus || 'Select a node to trace dependency pulses.'}
                    </div>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                      <button style={accentButtonStyle} onClick={handleStartPulseTrace} disabled={!selectedNode}>
                        Start Pulse
                      </button>
                      <button style={buttonStyle} onClick={handleStopPulseTrace} disabled={!isPulseActive}>
                        Stop Pulse
                      </button>
                      <button style={buttonStyle} onClick={() => fgRef.current?.d3ReheatSimulation()}>Reheat</button>
                      <button style={buttonStyle} onClick={resetCamera}>Fit View</button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </>
        )}
        <div
          onMouseDown={beginResize('right')}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: 12,
            bottom: 0,
            cursor: 'col-resize',
            zIndex: 35,
            opacity: isRightCollapsed ? 0.75 : 0.45,
            background: 'linear-gradient(90deg, rgba(110, 210, 255, 0.42), rgba(110, 210, 255, 0))',
          }}
        />
      </div>

      {isEditorModalVisible && (
        <div
          onClick={handleEditorModalClose}
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(5, 8, 14, 0.45)',
            backdropFilter: 'blur(14px) saturate(120%)',
            zIndex: 80,
            pointerEvents: 'none',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
            padding: '32px 24px',
            overflowY: 'auto',
          }}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            style={{
              pointerEvents: 'auto',
              width: 'min(1100px, 96vw)',
              minHeight: '60vh',
              maxHeight: '85vh',
              display: 'flex',
              flexDirection: 'column',
              gap: '14px',
              background: 'linear-gradient(160deg, rgba(15, 28, 50, 0.68), rgba(8, 14, 24, 0.56))',
              borderRadius: '18px',
              border: '1px solid rgba(160, 220, 255, 0.26)',
              boxShadow: '0 28px 60px rgba(0, 0, 0, 0.42)',
              backdropFilter: 'blur(18px) saturate(125%)',
              padding: '22px',
              marginTop: '6vh',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
              <div>
                <div style={{ fontSize: '1.05rem', fontWeight: 600 }}>ORB Code Editor</div>
                <div style={{ fontSize: '0.78rem', color: '#9eb2cc', marginTop: '4px' }}>
                  {selectedNode?.name ?? 'No file selected'}
                </div>
              </div>
              <button style={buttonStyle} onClick={handleEditorModalClose}>Close</button>
            </div>
            {isEditorEligibleType(selectedNode?.type) ? (
              <>
                {editorContent !== null ? (
                  <>
                    <div
                      style={{
                        width: '100%',
                        minHeight: '320px',
                        flex: 1,
                        borderRadius: '12px',
                        border: '1px solid rgba(180, 230, 255, 0.2)',
                        background: 'rgba(4, 10, 20, 0.48)',
                        backdropFilter: 'blur(10px) saturate(120%)',
                        display: 'grid',
                        gridTemplateColumns: '60px 1fr',
                        overflow: 'hidden',
                      }}
                    >
                      <pre
                        ref={modalEditorLinesRef}
                        style={{
                          margin: 0,
                          padding: '12px 8px 12px 0',
                          textAlign: 'right',
                          fontSize: '0.76rem',
                          color: '#8ba8c6',
                          fontFamily: 'Consolas, "SFMono-Regular", "Segoe UI", monospace',
                          lineHeight: 1.5,
                          userSelect: 'none',
                          overflow: 'hidden',
                          borderRight: '1px solid rgba(255, 255, 255, 0.09)',
                          background: 'rgba(16, 26, 44, 0.45)',
                        }}
                      >
                        {editorLineNumbers}
                      </pre>
                      <textarea
                        ref={modalEditorRef}
                        value={editorContent}
                        onChange={(e) => handleEditorChange(e.target.value)}
                        onScroll={() => syncEditorLineScroll('modal')}
                        onSelect={(e) => handleEditorCursorUpdate((e.target as HTMLTextAreaElement).selectionStart)}
                        onKeyUp={(e) => handleEditorCursorUpdate((e.target as HTMLTextAreaElement).selectionStart)}
                        onClick={(e) => handleEditorCursorUpdate((e.target as HTMLTextAreaElement).selectionStart)}
                        disabled={isEditorLoading}
                        spellCheck={false}
                        wrap="off"
                        style={{
                          width: '100%',
                          minHeight: '320px',
                          flex: 1,
                          border: 'none',
                          background: 'transparent',
                          color: '#e0f0ff',
                          padding: '12px',
                          fontSize: '0.82rem',
                          fontFamily: 'Consolas, "SFMono-Regular", "Segoe UI", monospace',
                          resize: 'none',
                          lineHeight: 1.5,
                          outline: 'none',
                        }}
                      />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                      <div style={{ fontSize: '0.75rem', color: '#7f96b2' }}>
                        {isEditorLoading
                          ? 'Loading editor...'
                          : isEditorDirty
                            ? 'Unsaved changes'
                            : 'In sync'}
                        {editorStatus ? ` | ${editorStatus}` : ''}
                        {` | Ln ${editorCursor.line}, Col ${editorCursor.column}`}
                      </div>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <button
                          style={accentButtonStyle}
                          onClick={handleEditorSave}
                          disabled={isEditorLoading || !isEditorDirty}
                        >
                          Save
                        </button>
                        <button
                          style={buttonStyle}
                          onClick={handleEditorRevert}
                          disabled={isEditorLoading || !isEditorDirty}
                        >
                          Revert
                        </button>
                      </div>
                    </div>
                    {editorError && (
                      <div style={{ fontSize: '0.72rem', color: '#ff7a7a' }}>
                        {editorError}
                      </div>
                    )}
                    <div
                      style={{
                        borderRadius: '12px',
                        border: '1px solid rgba(255, 255, 255, 0.08)',
                        background: 'rgba(6, 8, 14, 0.6)',
                        padding: '12px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '10px',
                      }}
                    >
                      <div style={{ fontSize: '0.72rem', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#9eb2cc' }}>
                        AI Reviewer ({activeProviderLabel})
                      </div>
                      {ollamaCorsHint && (
                        <div
                          style={{
                            padding: '8px 10px',
                            borderRadius: '8px',
                            border: '1px solid rgba(255, 180, 80, 0.25)',
                            background: 'rgba(120, 70, 0, 0.14)',
                            color: '#ffd8a6',
                            fontSize: '0.68rem',
                            lineHeight: 1.45,
                          }}
                        >
                          Hosted Webula can only reach a local Ollama server if Ollama allows this site origin. {ollamaCorsHint}
                        </div>
                      )}
                      {aiProvider === 'ollama' && (
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                          <input
                            value={ollamaBaseUrl}
                            onChange={(event) => setOllamaBaseUrl(event.target.value)}
                            placeholder={DEFAULT_OLLAMA_BASE_URL}
                            style={{
                              width: '100%',
                              background: 'rgba(4, 6, 12, 0.85)',
                              border: '1px solid rgba(255, 255, 255, 0.08)',
                              borderRadius: '8px',
                              padding: '8px 10px',
                              color: '#e0f0ff',
                              fontSize: '0.74rem',
                              outline: 'none',
                            }}
                          />
                          <input
                            value={ollamaModel}
                            onChange={(event) => setOllamaModel(event.target.value)}
                            placeholder={DEFAULT_OLLAMA_MODEL}
                            style={{
                              width: '100%',
                              background: 'rgba(4, 6, 12, 0.85)',
                              border: '1px solid rgba(255, 255, 255, 0.08)',
                              borderRadius: '8px',
                              padding: '8px 10px',
                              color: '#e0f0ff',
                              fontSize: '0.74rem',
                              outline: 'none',
                            }}
                          />
                        </div>
                      )}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <button
                          style={accentButtonStyle}
                          onClick={handleRunOllamaReview}
                          disabled={isReviewingCode || !editorContent || !editorContent.trim()}
                        >
                          {isReviewingCode ? 'Reviewing...' : 'Review Current File'}
                        </button>
                        <div style={{ fontSize: '0.7rem', color: '#7f96b2' }}>
                          Max {Math.floor(MAX_OLLAMA_REVIEW_CHARS / 1000)}k chars
                        </div>
                      </div>
                      {reviewStatus && (
                        <div style={{ fontSize: '0.72rem', color: '#9db3d3' }}>
                          {reviewStatus}
                        </div>
                      )}
                      {reviewError && (
                        <div style={{ fontSize: '0.72rem', color: '#ff7a7a' }}>
                          {reviewError}
                        </div>
                      )}
                      {reviewResult && (
                        <pre
                          style={{
                            whiteSpace: 'pre-wrap',
                            background: 'rgba(0, 0, 0, 0.45)',
                            border: '1px solid rgba(255, 255, 255, 0.08)',
                            borderRadius: '10px',
                            padding: '10px',
                            fontSize: '0.74rem',
                            maxHeight: '220px',
                            overflowY: 'auto',
                            color: '#dbe7ff',
                            lineHeight: 1.45,
                          }}
                        >
                          {reviewResult}
                        </pre>
                      )}
                    </div>
                    <div
                      style={{
                        borderRadius: '12px',
                        border: '1px solid rgba(255, 255, 255, 0.08)',
                        background: 'rgba(6, 8, 14, 0.6)',
                        padding: '12px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '10px',
                      }}
                    >
                      <div style={{ fontSize: '0.72rem', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#9eb2cc' }}>
                        Coding Chat ({activeProviderLabel})
                      </div>
                      <div style={{ fontSize: '0.72rem', color: '#7f96b2' }}>
                        Model: {activeProviderModel}
                      </div>
                      <div
                        style={{
                          maxHeight: '300px',
                          overflowY: 'auto',
                          borderRadius: '8px',
                          background: 'rgba(0, 0, 0, 0.35)',
                          border: '1px solid rgba(255, 255, 255, 0.06)',
                          padding: '8px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '6px',
                        }}
                      >
                        {chatMessages.length === 0 ? (
                          <div style={{ fontSize: '0.74rem', color: '#7f96b2' }}>
                            Ask for bug hunts, refactors, architecture help, or test strategy.
                          </div>
                        ) : (
                          chatMessages.map((message, index) => (
                            <div
                              key={`modal-chat-${index}`}
                              style={{
                                fontSize: '0.74rem',
                                lineHeight: 1.45,
                                color: message.role === 'assistant' ? '#dbe7ff' : '#9cdcff',
                                whiteSpace: 'pre-wrap',
                                borderRadius: '8px',
                                padding: '6px 8px',
                                background: message.role === 'assistant'
                                  ? 'rgba(40, 70, 120, 0.18)'
                                  : 'rgba(0, 160, 255, 0.14)',
                              }}
                            >
                              <strong style={{ color: '#c9f0ff' }}>{message.role === 'assistant' ? 'Model' : 'You'}:</strong>{' '}
                              {message.content}
                              {message.role === 'assistant' && (
                                <div style={{ marginTop: '6px' }}>
                                  <button
                                    style={buttonStyle}
                                    onClick={() => handleApplyAssistantCode(message.content)}
                                    disabled={isChattingWithModel || editorContent === null}
                                  >
                                    Apply Code To Editor
                                  </button>
                                </div>
                              )}
                            </div>
                          ))
                        )}
                      </div>
                      <textarea
                        value={chatInput}
                        onChange={(event) => setChatInput(event.target.value)}
                        placeholder="Ask the coding model about this file..."
                        disabled={isChattingWithModel}
                        style={{
                          width: '100%',
                          minHeight: '86px',
                          borderRadius: '8px',
                          border: '1px solid rgba(255, 255, 255, 0.08)',
                          background: 'rgba(4, 6, 12, 0.85)',
                          color: '#e0f0ff',
                          padding: '8px 10px',
                          fontSize: '0.74rem',
                          fontFamily: 'Consolas, "SFMono-Regular", "Segoe UI", monospace',
                          resize: 'vertical',
                          lineHeight: 1.4,
                        }}
                      />
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        <button
                          style={accentButtonStyle}
                          onClick={handleSendCodingChat}
                          disabled={isChattingWithModel || !chatInput.trim()}
                        >
                          {isChattingWithModel ? 'Thinking...' : 'Send'}
                        </button>
                        <button
                          style={buttonStyle}
                          onClick={handleClearCodingChat}
                          disabled={isChattingWithModel || chatMessages.length === 0}
                        >
                          Clear
                        </button>
                        <button
                          style={buttonStyle}
                          onClick={handleApplyLatestAssistantCode}
                          disabled={isChattingWithModel || chatMessages.length === 0 || editorContent === null}
                        >
                          Apply Latest Code
                        </button>
                      </div>
                      {chatStatus && (
                        <div style={{ fontSize: '0.72rem', color: '#9db3d3' }}>
                          {chatStatus}
                        </div>
                      )}
                      {chatApplyStatus && (
                        <div style={{ fontSize: '0.72rem', color: '#9ff6bf' }}>
                          {chatApplyStatus}
                        </div>
                      )}
                      {chatError && (
                        <div style={{ fontSize: '0.72rem', color: '#ff7a7a' }}>
                          {chatError}
                        </div>
                      )}
                      {chatApplyError && (
                        <div style={{ fontSize: '0.72rem', color: '#ff9b9b' }}>
                          {chatApplyError}
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <div style={{ fontSize: '0.78rem', color: '#9eb2cc' }}>
                    Loading editor...
                  </div>
                )}
              </>
            ) : (
              <div style={{ fontSize: '0.78rem', color: '#9eb2cc' }}>
                Select a code ORB to open the editor.
              </div>
            )}
          </div>
        </div>
      )}

      <ForceGraph3D
        ref={attachGraphRef}
        graphData={graphData}
        nodeVisibility={isNodeVisible}
        linkVisibility={isLinkVisible}
        nodeLabel={settings.showLabels ? nodeLabel : undefined}
        backgroundColor="rgba(0,0,0,0)"
        width={viewport.width}
        height={viewport.height}
        showNavInfo={false}
        d3VelocityDecay={settings.velocityDecay}
        d3AlphaDecay={settings.alphaDecay}
        warmupTicks={80}
        cooldownTime={6000}
        onEngineStop={handleEngineStop}
        linkColor={(link: any) => {
          const linkInfo = getLinkPulseInfo(link);
          if (!linkInfo.sourceId || !linkInfo.targetId) {
            return 'rgba(255, 255, 255, 0)';
          }
          const { sourceId, targetId, isPulseLink, isActivePulseLink } = linkInfo;
          const isDep = link.kind === 'dep';
          const inBranch = branchNodeIds ? branchNodeIds.has(sourceId) && branchNodeIds.has(targetId) : true;
          const isNeighborLink = isPulseActive && activePulseId
            ? sourceId === activePulseId || targetId === activePulseId
            : false;

          if (isPulseLink) {
            return isActivePulseLink ? 'rgba(0, 255, 240, 0.95)' : 'rgba(0, 150, 255, 0.55)';
          }

          if (isNeighborLink) {
            return 'rgba(110, 200, 255, 0.45)';
          }

          if (isDep) {
            return inBranch ? 'rgba(170, 120, 255, 0.55)' : 'rgba(120, 90, 180, 0.2)';
          }
          return inBranch ? 'rgba(255, 255, 255, 0.95)' : 'rgba(255, 255, 255, 0.18)';
        }}
        linkWidth={(link: any) => {
          const linkInfo = getLinkPulseInfo(link);
          if (!linkInfo.sourceId || !linkInfo.targetId) {
            return settings.linkWidth;
          }
          const { sourceId, targetId, isPulseLink } = linkInfo;
          const isNeighborLink = isPulseActive && activePulseId
            ? sourceId === activePulseId || targetId === activePulseId
            : false;
          const highlightLink = isPulseLink || isNeighborLink;
          const inBranch = branchNodeIds ? branchNodeIds.has(sourceId) && branchNodeIds.has(targetId) : true;
          const base = link.kind === 'dep'
            ? Math.max(0.1, settings.linkWidth * 0.6)
            : settings.linkWidth;
          const multiplier = highlightLink ? 1.8 : 1;
          if (inBranch) return base * multiplier;
          return Math.max(0.2, base * 0.5 * multiplier);
        }}
        linkDirectionalArrowLength={(link: any) => (link.kind === 'dep' ? 3 : 0)}
        linkDirectionalArrowRelPos={0.8}
        linkDirectionalArrowColor={(link: any) => (link.kind === 'dep' ? 'rgba(170, 120, 255, 0.8)' : 'rgba(0,0,0,0)')}
        linkOpacity={settings.linkOpacity}
        linkDirectionalParticles={(link: any) => {
          if (!isPulseActive || !settings.showDependencyEdges) return 0;
          const info = getLinkPulseInfo(link);
          const isNeighborLink = isPulseActive && activePulseId
            ? info.sourceId === activePulseId || info.targetId === activePulseId
            : false;
          const highlightLink = info.isPulseLink || isNeighborLink;
          if (!highlightLink) return 0;
          return info.isActivePulseLink ? 4 : 2;
        }}
        linkDirectionalParticleWidth={(link: any) => {
          const info = getLinkPulseInfo(link);
          const isNeighborLink = isPulseActive && activePulseId
            ? info.sourceId === activePulseId || info.targetId === activePulseId
            : false;
          const highlightLink = info.isPulseLink || isNeighborLink;
          if (!highlightLink) return 0;
          return info.isActivePulseLink ? 1.2 : 0.8;
        }}
        linkDirectionalParticleColor={(link: any) => {
          const info = getLinkPulseInfo(link);
          const isNeighborLink = isPulseActive && activePulseId
            ? info.sourceId === activePulseId || info.targetId === activePulseId
            : false;
          const highlightLink = info.isPulseLink || isNeighborLink;
          if (!highlightLink) return 'rgba(0,0,0,0)';
          return info.isActivePulseLink ? 'rgba(150, 255, 255, 0.95)' : 'rgba(120, 200, 255, 0.65)';
        }}
        linkDirectionalParticleSpeed={(link: any) => {
          if (!isPulseActive) return 0;
          const info = getLinkPulseInfo(link);
          const isNeighborLink = isPulseActive && activePulseId
            ? info.sourceId === activePulseId || info.targetId === activePulseId
            : false;
          const highlightLink = info.isPulseLink || isNeighborLink;
          if (!highlightLink) return 0;
          return info.isActivePulseLink ? 0.012 : 0.006;
        }}
        nodeThreeObject={(node: any) => {
          const color = getNodeColor(node.group);
          const radius = getNodeRadius(node);
          const isDimmed = settings.focusBranchMode && branchNodeIds && !branchNodeIds.has(node.id);
          const baseColor = new THREE.Color(color);
          const orbColor = baseColor.clone();
          orbColor.offsetHSL(0, 0.16, -0.12);
          const pulseHighlight = new THREE.Color('#4ff7fe');
          const isPulseNodeHighlighted = pulseNodeSet.has(node.id);
          const isActivePulseNode = node.id === activePulseId;
          const isPulseNeighbor = isPulseActive && activePulseNeighbors.has(node.id);
          const pulseRelated = isPulseNodeHighlighted || isPulseNeighbor;
          const pulseDim = isPulseActive && !pulseRelated;
          const opacity = isDimmed ? 0.22 : (pulseDim ? 0.38 : 0.94);
          const emissiveIntensity = pulseRelated ? (isActivePulseNode ? 1.2 : 0.92) : 0.72;
          const geometry = new THREE.SphereGeometry(radius, 24, 24);
          const material = new THREE.MeshStandardMaterial({
            color: orbColor.clone(),
            transparent: true,
            opacity,
            roughness: 0.46,
            metalness: 0.1,
            emissive: orbColor.clone().multiplyScalar(0.34),
            emissiveIntensity,
          });
          if (isPulseNodeHighlighted) {
            material.color.lerp(pulseHighlight, isActivePulseNode ? 0.45 : 0.22);
            material.emissive.lerp(pulseHighlight, 0.4);
          } else if (isPulseNeighbor) {
            material.color.lerp(pulseHighlight, 0.22);
            material.emissive.lerp(pulseHighlight, 0.18);
          }
          if (node.group === 7) {
            material.emissive = new THREE.Color('#ff0000').multiplyScalar(0.8);
            material.emissiveIntensity = 2.0;
          }
          const core = new THREE.Mesh(geometry, material);
          const group = new THREE.Group();
          group.add(core);

          if (settings.nodeGlow > 0.05) {
            const aura = createAuraSprite(
              color,
              radius * (1 + settings.nodeGlow * 0.32),
              Math.min(0.58, settings.nodeGlow * 0.45),
            );
            group.add(aura);
          }

          const outlineStrength = Math.min(0.12, 0.03 + settings.nodeGlow * 0.05);
          if (outlineStrength > 0.06) {
            const outlineGeo = new THREE.SphereGeometry(radius * 1.06, 16, 16);
            const outlineMaterial = new THREE.MeshBasicMaterial({
              color: orbColor.clone(),
              transparent: true,
              opacity: outlineStrength,
              depthWrite: false,
              side: THREE.BackSide,
            });
            const outline = new THREE.Mesh(outlineGeo, outlineMaterial);
            outline.renderOrder = -1;
            group.add(outline);
          }

          if (isActivePulseNode) {
            const pulseAura = createAuraSprite('#72e8ff', radius * 2.1, 0.62);
            pulseAura.renderOrder = 3;
            group.add(pulseAura);
          }

          return group;
        }}
        onNodeClick={handleNodeClick}
      />
    </div>
  );
};

export default NeuralExplorer3D;

