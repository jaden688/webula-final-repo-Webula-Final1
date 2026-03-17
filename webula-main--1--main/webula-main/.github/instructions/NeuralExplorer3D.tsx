import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import ForceGraph3D from 'react-force-graph-3d';
import * as THREE from 'three';
import { scanDependencies } from '../../src/utils/dependencyScan';
import type { DependencyInfo } from '../../src/utils/dependencyScan';
import {
  chatWithOllama,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  MAX_OLLAMA_REVIEW_CHARS,
  type OllamaChatMessage,
  reviewCodeWithOllama,
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

interface OllamaTagsResponse {
  models?: Array<{
    name?: string;
    model?: string;
  }>;
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
const OLLAMA_BASE_URL_STORAGE_KEY = 'neural-nexus-ollama-base-url-v1';
const OLLAMA_MODEL_STORAGE_KEY = 'neural-nexus-ollama-model-v1';
const ORBIT_SPEED_MULTIPLIER = 3;
const MAX_CHAT_HISTORY_MESSAGES = 14;
const MAX_CHAT_CONTEXT_CHARS = 16_000;

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
};

type StoredLayout = {
  leftWidth: number;
  rightWidth: number;
  isLeftCollapsed: boolean;
  isRightCollapsed: boolean;
};

const DEFAULT_LAYOUT: StoredLayout = {
  leftWidth: 280,
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
      leftWidth: clamp(Number(parsed.leftWidth ?? DEFAULT_LAYOUT.leftWidth), 220, 520),
      rightWidth: clamp(Number(parsed.rightWidth ?? DEFAULT_LAYOUT.rightWidth), 220, 520),
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
  const [dependencyStats, setDependencyStats] = useState<{ filesParsed: number; depLinks: number; externalCount: number } | null>(null);
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
  const [editorContent, setEditorContent] = useState<string | null>(null);
  const [editorLoadedContent, setEditorLoadedContent] = useState<string | null>(null);
  const [isEditorDirty, setIsEditorDirty] = useState(false);
  const [isEditorLoading, setIsEditorLoading] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editorStatus, setEditorStatus] = useState<string | null>(null);
  const [canReconnect, setCanReconnect] = useState(false);
  const [reconnectStatus, setReconnectStatus] = useState<string | null>(null);
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState<string>(() => (
    loadStoredText(OLLAMA_BASE_URL_STORAGE_KEY, DEFAULT_OLLAMA_BASE_URL)
  ));
  const [ollamaModel, setOllamaModel] = useState<string>(() => (
    loadStoredText(OLLAMA_MODEL_STORAGE_KEY, DEFAULT_OLLAMA_MODEL)
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
  const initialLayout = useMemo(() => loadStoredLayout(), []);
  const [leftWidth, setLeftWidth] = useState(initialLayout.leftWidth);
  const [rightWidth, setRightWidth] = useState(initialLayout.rightWidth);
  const [isLeftCollapsed, setIsLeftCollapsed] = useState(initialLayout.isLeftCollapsed);
  const [isRightCollapsed, setIsRightCollapsed] = useState(initialLayout.isRightCollapsed);
  const [isEditorModalVisible, setIsEditorModalVisible] = useState(false);
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
    setReviewStatus(`Reviewing ${selectedNode.name} with ${ollamaModel || DEFAULT_OLLAMA_MODEL}...`);
    try {
      const result = await reviewCodeWithOllama({
        baseUrl: ollamaBaseUrl,
        model: ollamaModel,
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
      const message = error instanceof Error ? error.message : 'Ollama review failed.';
      setReviewResult(null);
      setReviewError(message);
      setReviewStatus(null);
    } finally {
      setIsReviewingCode(false);
    }
  }, [editorContent, ollamaBaseUrl, ollamaModel, selectedNode]);

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
    setIsChattingWithModel(true);
    if (hasPriorUserTurn) {
      setChatStatus(`Waiting on ${ollamaModel || DEFAULT_OLLAMA_MODEL}...`);
    } else {
      setChatStatus(`Injected SparkByte MPF schema. Waiting on ${ollamaModel || DEFAULT_OLLAMA_MODEL}...`);
    }

    const codingSystemPrompt = [
      'You are a senior coding assistant.',
      'Be practical, specific, and bug-focused.',
      'When giving code changes, explain rationale and risks briefly.',
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
      const result = await chatWithOllama({
        baseUrl: ollamaBaseUrl,
        model: ollamaModel,
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
      const message = error instanceof Error ? error.message : 'Ollama chat failed.';
      setChatError(message);
      setChatStatus(null);
    } finally {
      setIsChattingWithModel(false);
    }
  }, [chatInput, chatMessages, editorContent, ollamaBaseUrl, ollamaModel, selectedNode]);

  const handleClearCodingChat = useCallback(() => {
    setChatMessages([]);
    setChatError(null);
    setChatStatus(null);
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
  }, [selectedNode?.id]);

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
    }, PULSE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isPulseActive, pulseSequence]);

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
      const message = error instanceof Error ? error.message : 'Unable to load models from Ollama.';
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
      const minWidth = 220;
      const maxWidth = 520;

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
          const trimmed = text.slice(0, MAX_PREVIEW_CHARS);
          const lines = trimmed.split(/\r?\n/).slice(0, MAX_PREVIEW_LINES);
          setPreviewText(lines.join('\n') || '(empty file)');
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

  const isCompactTopBar = viewport.width < 1550;
  const topBarHeight = isCompactTopBar ? 124 : 56;
  const panelTop = topBarHeight + 12;
  const panelBottom = 16;
  const collapsedWidth = 52;
  const activeOllamaModel = (ollamaModel || DEFAULT_OLLAMA_MODEL).trim() || DEFAULT_OLLAMA_MODEL;
  const topBarModelLabel = activeOllamaModel.length > 24
    ? `${activeOllamaModel.slice(0, 21)}...`
    : activeOllamaModel;
  const isModelSwitchBusy = isReviewingCode || isChattingWithModel;
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
    fontSize: '0.72rem',
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    color: '#7f96b2',
    marginBottom: '8px',
  };

  const panelShellStyle: React.CSSProperties = {
    background: 'rgba(8, 12, 20, 0.82)',
    borderRadius: '14px',
    boxShadow: '0 14px 30px rgba(0, 0, 0, 0.35)',
    border: '1px solid rgba(255, 255, 255, 0.05)',
    backdropFilter: 'blur(12px)',
  };

  const cardStyle: React.CSSProperties = {
    background: 'rgba(12, 16, 28, 0.8)',
    borderRadius: '12px',
    padding: '12px',
    border: '1px solid rgba(255, 255, 255, 0.06)',
  };

  const buttonStyle: React.CSSProperties = {
    background: 'rgba(255, 255, 255, 0.06)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    color: '#e6f6ff',
    padding: '8px 10px',
    cursor: 'pointer',
    fontFamily: 'Segoe UI, Arial, sans-serif',
    fontSize: '0.75rem',
    borderRadius: '8px',
    transition: 'all 0.2s',
  };

  const accentButtonStyle: React.CSSProperties = {
    ...buttonStyle,
    background: 'linear-gradient(135deg, rgba(0, 255, 255, 0.25), rgba(0, 160, 255, 0.15))',
    border: '1px solid rgba(0, 255, 255, 0.35)',
    color: '#d9feff',
  };

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        background: 'radial-gradient(circle at center, #08101a 0%, #02050a 55%, #000000 100%)',
        overflow: 'hidden',
        color: '#eef6ff',
        fontFamily: 'Segoe UI, Arial, sans-serif',
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
          <button
            style={{
              ...buttonStyle,
              opacity: isModelSwitchBusy ? 0.5 : 1,
              cursor: isModelSwitchBusy ? 'not-allowed' : 'pointer',
            }}
            onClick={handleToggleTopBarModelEditor}
            disabled={isModelSwitchBusy}
            title={`Current Ollama model: ${activeOllamaModel}`}
          >
            Model: {topBarModelLabel}
          </button>
          {isTopBarModelEditorOpen && (
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
          left: '16px',
          width: `${leftPanelWidth}px`,
          padding: isLeftCollapsed ? '10px' : '16px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
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
            right: -6,
            width: 12,
            bottom: 0,
            cursor: 'col-resize',
          }}
        />
      </div>

      {/* Inspector + Settings */}
      <div
        style={{
          position: 'absolute',
          top: `${panelTop}px`,
          bottom: `${panelBottom}px`,
          right: '16px',
          width: `${rightPanelWidth}px`,
          padding: isRightCollapsed ? '10px' : '16px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          zIndex: 20,
          overflowY: 'auto',
          ...panelShellStyle,
        }}
      >
        {isRightCollapsed ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', alignItems: 'center' }}>
            <div style={{ fontSize: '0.7rem', color: '#7f96b2', writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
              Inspector
            </div>
            <button style={buttonStyle} onClick={() => setIsRightCollapsed(false)}>&lt;</button>
          </div>
        ) : (
          <>
            <div style={sectionTitleStyle}>Inspector</div>
            <div style={cardStyle}>
              {selectedNode ? (
                <>
                  <div style={{ fontSize: '1rem', fontWeight: 600 }}>{selectedNode.name}</div>
                  <div style={{ fontSize: '0.72rem', color: '#8ea2bf', marginTop: '4px' }}>
                    Type: {selectedNode.type.toUpperCase()}
                  </div>
                  {selectedNode.path && (
                    <div style={{ fontSize: '0.7rem', color: '#6f86a3', marginTop: '4px' }}>
                      Path: {selectedNode.path}
                    </div>
                  )}
                  {selectedNode.sizeBytes !== undefined && (
                    <div style={{ fontSize: '0.72rem', color: '#9eb2cc', marginTop: '4px' }}>
                      Size: {formatBytes(selectedNode.sizeBytes)}
                    </div>
                  )}
                  <div style={{ marginTop: '12px' }}>
                    <div style={{ fontSize: '0.7rem', opacity: 0.7, marginBottom: '6px' }}>Preview</div>
                    {isPreviewLoading && (
                      <div style={{ fontSize: '0.75rem', opacity: 0.7 }}>Loading preview...</div>
                    )}
                    {!isPreviewLoading && previewError && (
                      <div style={{ fontSize: '0.75rem', opacity: 0.7 }}>{previewError}</div>
                    )}
                    {!isPreviewLoading && previewUrl && (
                      <img
                        src={previewUrl}
                        alt={selectedNode.name}
                        style={{
                          width: '100%',
                          borderRadius: '10px',
                          border: '1px solid rgba(255, 255, 255, 0.1)',
                          maxHeight: '240px',
                          objectFit: 'cover',
                        }}
                      />
                    )}
                    {!isPreviewLoading && !previewUrl && previewText && (
                      <pre
                        style={{
                          whiteSpace: 'pre-wrap',
                          background: 'rgba(0, 0, 0, 0.45)',
                          border: '1px solid rgba(255, 255, 255, 0.08)',
                          borderRadius: '10px',
                          padding: '10px',
                          fontSize: '0.72rem',
                          maxHeight: '200px',
                          overflowY: 'auto',
                          color: '#dbe7ff',
                        }}
                      >
                        {previewText}
                      </pre>
                    )}
                {!isPreviewLoading && !previewError && !previewUrl && !previewText && (
                  <div style={{ fontSize: '0.7rem', opacity: 0.6 }}>Preview unavailable.</div>
                )}
              </div>
              {selectedNode && isEditorEligibleType(selectedNode.type) && !isEditorModalVisible && (
                <div style={{ marginTop: '14px' }}>
                  <div style={{ fontSize: '0.7rem', opacity: 0.7, marginBottom: '6px' }}>
                    Code Editor
                  </div>
                  {editorContent !== null ? (
                    <>
                      <textarea
                        value={editorContent}
                        onChange={(e) => handleEditorChange(e.target.value)}
                        disabled={isEditorLoading}
                        style={{
                          width: '100%',
                          minHeight: '160px',
                          borderRadius: '10px',
                          border: '1px solid rgba(255, 255, 255, 0.08)',
                          background: 'rgba(4, 6, 12, 0.85)',
                          color: '#e0f0ff',
                          padding: '10px',
                          fontSize: '0.72rem',
                          fontFamily: 'Consolas, "SFMono-Regular", "Segoe UI", monospace',
                          resize: 'vertical',
                          lineHeight: 1.4,
                        }}
                      />
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '8px', gap: '8px' }}>
                        <div style={{ fontSize: '0.7rem', color: '#7f96b2' }}>
                          {isEditorLoading
                            ? 'Loading editor...'
                            : isEditorDirty
                              ? 'Unsaved changes'
                              : 'In sync'}
                          {editorStatus ? ` | ${editorStatus}` : ''}
                        </div>
                        <div style={{ display: 'flex', gap: '6px' }}>
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
                        <div style={{ fontSize: '0.7rem', color: '#ff7a7a', marginTop: '6px' }}>
                          {editorError}
                        </div>
                      )}
                    </>
                  ) : (
                    <div style={{ fontSize: '0.72rem', color: '#9eb2cc' }}>
                      {isEditorLoading ? 'Loading editor...' : (previewError || 'Code editor unavailable for this node.')}
                    </div>
                  )}
                </div>
              )}
              {selectedNode && isEditorEligibleType(selectedNode.type) && (
                <div
                  style={{
                    marginTop: '14px',
                    padding: '10px',
                    borderRadius: '10px',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    background: 'rgba(6, 8, 14, 0.6)',
                  }}
                >
                  <div style={{ fontSize: '0.75rem', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#9eb2cc', marginBottom: '8px' }}>
                    Local Ollama Reviewer
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <div>
                      <div style={{ fontSize: '0.68rem', color: '#7f96b2', marginBottom: '4px' }}>Base URL</div>
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
                          fontSize: '0.72rem',
                          outline: 'none',
                        }}
                      />
                    </div>
                    <div>
                      <div style={{ fontSize: '0.68rem', color: '#7f96b2', marginBottom: '4px' }}>Model</div>
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
                          fontSize: '0.72rem',
                          outline: 'none',
                        }}
                      />
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button
                        style={accentButtonStyle}
                        onClick={handleRunOllamaReview}
                        disabled={isReviewingCode || !editorContent || !editorContent.trim()}
                      >
                        {isReviewingCode ? 'Reviewing...' : 'Review Current File'}
                      </button>
                    </div>
                    <div style={{ fontSize: '0.68rem', color: '#7f96b2' }}>
                      Reviews the current editor buffer (up to {Math.floor(MAX_OLLAMA_REVIEW_CHARS / 1000)}k characters).
                    </div>
                    {reviewStatus && (
                      <div style={{ fontSize: '0.68rem', color: '#9db3d3' }}>
                        {reviewStatus}
                      </div>
                    )}
                    {reviewError && (
                      <div style={{ fontSize: '0.7rem', color: '#ff7a7a' }}>
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
                          fontSize: '0.72rem',
                          maxHeight: '260px',
                          overflowY: 'auto',
                          color: '#dbe7ff',
                          lineHeight: 1.45,
                        }}
                      >
                        {reviewResult}
                      </pre>
                    )}
                  </div>
                </div>
              )}
              {selectedNode && (
                <div
                  style={{
                    marginTop: '14px',
                    padding: '10px',
                    borderRadius: '10px',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    background: 'rgba(6, 8, 14, 0.6)',
                  }}
                >
                  <div style={{ fontSize: '0.75rem', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#9eb2cc', marginBottom: '8px' }}>
                    Coding Chat (Ollama)
                  </div>
                  <div style={{ fontSize: '0.68rem', color: '#7f96b2', marginBottom: '8px' }}>
                    Uses current model: {ollamaModel || DEFAULT_OLLAMA_MODEL}
                  </div>
                  <div
                    style={{
                      maxHeight: '220px',
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
                      <div style={{ fontSize: '0.72rem', color: '#7f96b2' }}>
                        Ask for refactors, bug checks, architecture suggestions, or test ideas.
                      </div>
                    ) : (
                      chatMessages.map((message, index) => (
                        <div
                          key={`chat-${index}`}
                          style={{
                            fontSize: '0.72rem',
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
                      minHeight: '78px',
                      borderRadius: '8px',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                      background: 'rgba(4, 6, 12, 0.85)',
                      color: '#e0f0ff',
                      padding: '8px 10px',
                      fontSize: '0.72rem',
                      fontFamily: 'Consolas, "SFMono-Regular", "Segoe UI", monospace',
                      resize: 'vertical',
                      lineHeight: 1.4,
                    }}
                  />
                  <div style={{ display: 'flex', gap: '8px', marginTop: '8px', alignItems: 'center' }}>
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
                  </div>
                  {chatStatus && (
                    <div style={{ marginTop: '8px', fontSize: '0.68rem', color: '#9db3d3' }}>
                      {chatStatus}
                    </div>
                  )}
                  {chatError && (
                    <div style={{ marginTop: '8px', fontSize: '0.7rem', color: '#ff7a7a' }}>
                      {chatError}
                    </div>
                  )}
                </div>
              )}
              <div
                style={{
                  marginTop: '14px',
                  padding: '10px',
                  borderRadius: '10px',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  background: 'rgba(6, 8, 14, 0.6)',
                }}
              >
                <div style={{ fontSize: '0.75rem', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#9eb2cc', marginBottom: '6px' }}>
                  Pulse Trace
                </div>
                <div style={{ fontSize: '0.75rem', color: '#dbe7ff', marginBottom: '10px' }}>
                  {pulseStatus || (!selectedNode ? 'Select a node and start pulse to trace dependencies.' : 'Ready to trace.') }
                  {isPulseActive && activePulseId && pulseSequence.length > 0 && (
                    <>
                      {' '}
                      | {`Now pulsing ${activePulseId} (${activePulseIndex + 1}/${pulseSequence.length})`}
                    </>
                  )}
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    style={accentButtonStyle}
                    onClick={handleStartPulseTrace}
                    disabled={!selectedNode || !dependencyLinks.length || isPulseActive}
                  >
                    Start Pulse
                  </button>
                  <button
                    style={buttonStyle}
                    onClick={handleStopPulseTrace}
                    disabled={!isPulseActive}
                  >
                    Stop Pulse
                  </button>
                </div>
              </div>
              <div style={{ marginTop: '12px' }}>
                <div style={{ fontSize: '0.7rem', opacity: 0.7, marginBottom: '6px' }}>Dependencies</div>
                {nodeDeps ? (
                  <div style={{ fontSize: '0.72rem', color: '#9eb2cc', lineHeight: 1.5 }}>
                    <div>Internal: {nodeDeps.internal.length || 0}</div>
                    <div>External: {nodeDeps.external.length || 0}</div>
                    <div>Unresolved: {nodeDeps.unresolved.length || 0}</div>
                    <div>Incoming: {nodeDependents.length || 0}</div>
                    {nodeDeps.exports.length > 0 && (
                      <div style={{ marginTop: '6px' }}>
                        Exports: {nodeDeps.exports.join(', ')}
                      </div>
                    )}
                    {nodeDeps.external.length > 0 && (
                      <div style={{ marginTop: '6px' }}>
                        External: {nodeDeps.external.slice(0, 12).join(', ')}
                        {nodeDeps.external.length > 12 ? '...' : ''}
                      </div>
                    )}
                    {nodeDeps.internal.length > 0 && (
                      <div style={{ marginTop: '6px' }}>
                        Internal: {nodeDeps.internal.slice(0, 8).map(formatPathLabel).join(', ')}
                        {nodeDeps.internal.length > 8 ? '...' : ''}
                      </div>
                    )}
                    {nodeDeps.unresolved.length > 0 && (
                      <div style={{ marginTop: '6px' }}>
                        Unresolved: {nodeDeps.unresolved.slice(0, 8).join(', ')}
                        {nodeDeps.unresolved.length > 8 ? '...' : ''}
                      </div>
                    )}
                    {nodeDependents.length > 0 && (
                      <div style={{ marginTop: '6px' }}>
                        Used by: {nodeDependents.slice(0, 8).map(formatPathLabel).join(', ')}
                        {nodeDependents.length > 8 ? '...' : ''}
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{ fontSize: '0.72rem', color: '#7b8ea8' }}>
                    Run Parse to analyze imports and dependencies.
                  </div>
                )}
              </div>
            </>
          ) : (
                <div style={{ fontSize: '0.75rem', color: '#7b8ea8' }}>
                  Select a node in the graph or explorer to inspect details and preview its contents.
                </div>
              )}
            </div>

            <div style={sectionTitleStyle}>View</div>
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

            <div style={sectionTitleStyle}>Control Deck</div>
            <div style={cardStyle}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                <div style={{ fontSize: '0.75rem', color: '#9eb2cc' }}>Simulation Tuning</div>
                <button
                  onClick={() => setIsSettingsOpen((prev) => !prev)}
                  style={{ ...buttonStyle, padding: '4px 8px', fontSize: '0.7rem' }}
                >
                  {isSettingsOpen ? 'Hide' : 'Show'}
                </button>
              </div>
              {isSettingsOpen && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <div style={{ fontSize: '0.68rem', color: '#7f96b2' }}>
                    Environment settings auto-save on this device.
                  </div>
                  <div>
                    <div style={{ fontSize: '0.7rem', opacity: 0.7 }}>Max Depth: {settings.maxDepth}</div>
                <input
                  type="range"
                  min={1}
                  max={10}
                  step={1}
                  value={settings.maxDepth}
                  onChange={(e) => updateSetting('maxDepth', Number(e.target.value))}
                  style={sliderStyle}
                />
                  </div>
                  <div>
                    <div style={{ fontSize: '0.7rem', opacity: 0.7 }}>Node Size Scale: {settings.nodeSizeScale.toFixed(1)}</div>
                <input
                  type="range"
                  min={0.5}
                  max={30}
                  step={0.5}
                  value={settings.nodeSizeScale}
                  onChange={(e) => updateSetting('nodeSizeScale', Number(e.target.value))}
                  style={sliderStyle}
                />
                  </div>
                  <div>
                    <div style={{ fontSize: '0.7rem', opacity: 0.7 }}>Folder Boost: {settings.folderSizeBoost.toFixed(2)}</div>
                <input
                  type="range"
                  min={1}
                  max={3}
                  step={0.05}
                  value={settings.folderSizeBoost}
                  onChange={(e) => updateSetting('folderSizeBoost', Number(e.target.value))}
                  style={sliderStyle}
                />
                  </div>
                  <div>
                    <div style={{ fontSize: '0.7rem', opacity: 0.7 }}>Glow: {settings.nodeGlow.toFixed(2)}</div>
                <input
                  type="range"
                  min={0}
                  max={2.5}
                  step={0.05}
                  value={settings.nodeGlow}
                  onChange={(e) => updateSetting('nodeGlow', Number(e.target.value))}
                  style={sliderStyle}
                />
                  </div>
                  <div>
                    <div style={{ fontSize: '0.7rem', opacity: 0.7 }}>Link Opacity: {settings.linkOpacity.toFixed(2)}</div>
                <input
                  type="range"
                  min={0.05}
                  max={1}
                  step={0.05}
                  value={settings.linkOpacity}
                  onChange={(e) => updateSetting('linkOpacity', Number(e.target.value))}
                  style={sliderStyle}
                />
                  </div>
                  <div>
                    <div style={{ fontSize: '0.7rem', opacity: 0.7 }}>Link Width: {settings.linkWidth.toFixed(2)}</div>
                <input
                  type="range"
                  min={0.2}
                  max={3}
                  step={0.1}
                  value={settings.linkWidth}
                  onChange={(e) => updateSetting('linkWidth', Number(e.target.value))}
                  style={sliderStyle}
                />
                  </div>
                  <div>
                    <div style={{ fontSize: '0.7rem', opacity: 0.7 }}>Charge Strength: {settings.chargeStrength}</div>
                <input
                  type="range"
                  min={-400}
                  max={-5}
                  step={5}
                  value={settings.chargeStrength}
                  onChange={(e) => updateSetting('chargeStrength', Number(e.target.value))}
                  style={sliderStyle}
                />
                  </div>
                  <div>
                    <div style={{ fontSize: '0.7rem', opacity: 0.7 }}>Focus Distance: {settings.focusDistance}</div>
                <input
                  type="range"
                  min={30}
                  max={160}
                  step={2}
                  value={settings.focusDistance}
                  onChange={(e) => updateSetting('focusDistance', Number(e.target.value))}
                  style={sliderStyle}
                />
                  </div>
                  <div>
                    <div style={{ fontSize: '0.7rem', opacity: 0.7 }}>Close Focus: {settings.focusDistanceClose}</div>
                <input
                  type="range"
                  min={12}
                  max={90}
                  step={2}
                  value={settings.focusDistanceClose}
                  onChange={(e) => updateSetting('focusDistanceClose', Number(e.target.value))}
                  style={sliderStyle}
                />
                  </div>
                  <div>
                    <div style={{ fontSize: '0.7rem', opacity: 0.7 }}>Auto Rotate</div>
                    <label style={{ fontSize: '0.75rem' }}>
                      <input
                        type="checkbox"
                        checked={settings.autoRotate}
                        onChange={(e) => updateSetting('autoRotate', e.target.checked)}
                        style={{ marginRight: 6 }}
                      />
                      Enabled
                    </label>
                  </div>
                  <div>
                    <div style={{ fontSize: '0.7rem', opacity: 0.7 }}>
                      Orbit Speed: {settings.autoRotateSpeed.toFixed(2)} (effective {(settings.autoRotateSpeed * ORBIT_SPEED_MULTIPLIER).toFixed(2)})
                    </div>
                <input
                  type="range"
                  min={0}
                  max={4}
                  step={0.05}
                  value={settings.autoRotateSpeed}
                  onChange={(e) => updateSetting('autoRotateSpeed', Number(e.target.value))}
                  style={sliderStyle}
                />
                  </div>
                  <div>
                    <div style={{ fontSize: '0.7rem', opacity: 0.7 }}>Show Labels</div>
                    <label style={{ fontSize: '0.75rem' }}>
                      <input
                        type="checkbox"
                        checked={settings.showLabels}
                        onChange={(e) => updateSetting('showLabels', e.target.checked)}
                        style={{ marginRight: 6 }}
                      />
                      Enabled
                    </label>
                  </div>
                  <div>
                    <div style={{ fontSize: '0.7rem', opacity: 0.7 }}>Focus Branch</div>
                    <label style={{ fontSize: '0.75rem' }}>
                      <input
                        type="checkbox"
                        checked={settings.focusBranchMode}
                        onChange={(e) => updateSetting('focusBranchMode', e.target.checked)}
                        style={{ marginRight: 6 }}
                      />
                      Enabled
                    </label>
                  </div>
                  <div>
                    <div style={{ fontSize: '0.7rem', opacity: 0.7 }}>Starfield</div>
                    <label style={{ fontSize: '0.75rem' }}>
                      <input
                        type="checkbox"
                        checked={settings.starfieldEnabled}
                        onChange={(e) => updateSetting('starfieldEnabled', e.target.checked)}
                        style={{ marginRight: 6 }}
                      />
                      Enabled
                    </label>
                  </div>
                  <div>
                    <div style={{ fontSize: '0.7rem', opacity: 0.7 }}>Star Count: {Math.floor(settings.starCount)}</div>
                <input
                  type="range"
                  min={0}
                  max={12000}
                  step={200}
                  value={settings.starCount}
                  onChange={(e) => updateSetting('starCount', Number(e.target.value))}
                  style={sliderStyle}
                />
                  </div>
                  <div>
                    <div style={{ fontSize: '0.7rem', opacity: 0.7 }}>Star Spread: {settings.starSpread}</div>
                <input
                  type="range"
                  min={600}
                  max={6000}
                  step={100}
                  value={settings.starSpread}
                  onChange={(e) => updateSetting('starSpread', Number(e.target.value))}
                  style={sliderStyle}
                />
                  </div>
            </div>
          )}
        </div>

        <div style={sectionTitleStyle}>Dependencies</div>
        <div style={cardStyle}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
            <div style={{ fontSize: '0.75rem', color: '#9eb2cc' }}>Import Graph</div>
            <button
              onClick={() => parseDependencies()}
              style={{ ...buttonStyle, padding: '4px 8px', fontSize: '0.7rem', opacity: isParsingDeps ? 0.6 : 1 }}
              disabled={isParsingDeps}
            >
              {isParsingDeps ? 'Parsing...' : 'Parse'}
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <label style={{ fontSize: '0.75rem' }}>
              <input
                type="checkbox"
                checked={settings.showDependencyEdges}
                onChange={(e) => updateSetting('showDependencyEdges', e.target.checked)}
                style={{ marginRight: 6 }}
              />
              Show dependency edges
            </label>
            <label style={{ fontSize: '0.75rem' }}>
              <input
                type="checkbox"
                checked={settings.autoParseDependencies}
                onChange={(e) => updateSetting('autoParseDependencies', e.target.checked)}
                style={{ marginRight: 6 }}
              />
              Auto-parse on mount
            </label>
            <label style={{ fontSize: '0.75rem' }}>
              <input
                type="checkbox"
                checked={settings.includeNodeModules}
                onChange={(e) => updateSetting('includeNodeModules', e.target.checked)}
                style={{ marginRight: 6 }}
              />
              Include node_modules
            </label>
            <label style={{ fontSize: '0.75rem' }}>
              <input
                type="checkbox"
                checked={settings.groupExternalDeps}
                onChange={(e) => updateSetting('groupExternalDeps', e.target.checked)}
                style={{ marginRight: 6 }}
              />
              Group external deps
            </label>
            <div>
              <div style={{ fontSize: '0.7rem', opacity: 0.7 }}>
                Max files: {settings.maxDependencyFiles}
              </div>
              <input
                type="range"
                min={50}
                max={1500}
                step={50}
                value={settings.maxDependencyFiles}
                onChange={(e) => updateSetting('maxDependencyFiles', Number(e.target.value))}
                style={sliderStyle}
              />
            </div>
            <div>
              <div style={{ fontSize: '0.7rem', opacity: 0.7 }}>
                Max file size: {settings.maxDependencyFileSizeKb} KB
              </div>
              <input
                type="range"
                min={64}
                max={2048}
                step={64}
                value={settings.maxDependencyFileSizeKb}
                onChange={(e) => updateSetting('maxDependencyFileSizeKb', Number(e.target.value))}
                style={sliderStyle}
              />
            </div>
            {dependencyStats && (
              <div style={{ fontSize: '0.7rem', color: '#7f96b2' }}>
                Parsed {dependencyStats.filesParsed} files, {dependencyStats.depLinks} edges, {dependencyStats.externalCount} externals
              </div>
            )}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '6px', marginTop: '4px' }}>
              <button
                style={buttonStyle}
                disabled={!selectedNode}
                onClick={isIsolationActive ? resetIsolation : isolateSelection}
              >
                {isIsolationActive ? 'Exit isolation' : 'Show connected view'}
              </button>
              {isIsolationActive && (
                <div style={{ fontSize: '0.7rem', color: '#7f96b2', alignSelf: 'center' }}>
                  Showing {isolationSet?.size ?? 0} node{(isolationSet?.size ?? 0) === 1 ? '' : 's'}
                </div>
              )}
            </div>

        <div style={sectionTitleStyle}>Actions</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
          <button style={buttonStyle} onClick={expandAllFolders}>Expand All</button>
          <button style={buttonStyle} onClick={collapseToRoot}>Collapse Root</button>
              <button style={buttonStyle} onClick={() => fgRef.current?.d3ReheatSimulation()}>Reheat</button>
              <button style={buttonStyle} onClick={resetCamera}>Fit View</button>
            </div>
          </>
        )}
        <div
          onMouseDown={beginResize('right')}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: 10,
            bottom: 0,
            cursor: 'col-resize',
            zIndex: 35,
            opacity: isRightCollapsed ? 0.7 : 0.35,
            background: 'linear-gradient(90deg, rgba(0, 255, 255, 0.35), rgba(0, 255, 255, 0))',
          }}
        />
      </div>

      {isEditorModalVisible && (
        <div
          onClick={handleEditorModalClose}
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(5, 8, 14, 0.7)',
            backdropFilter: 'blur(8px)',
            zIndex: 80,
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
              width: 'min(1100px, 96vw)',
              minHeight: '60vh',
              maxHeight: '85vh',
              display: 'flex',
              flexDirection: 'column',
              gap: '14px',
              background: 'rgba(12, 18, 32, 0.96)',
              borderRadius: '18px',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              boxShadow: '0 28px 60px rgba(0, 0, 0, 0.55)',
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
                    <textarea
                      value={editorContent}
                      onChange={(e) => handleEditorChange(e.target.value)}
                      disabled={isEditorLoading}
                      style={{
                        width: '100%',
                        minHeight: '320px',
                        flex: 1,
                        borderRadius: '12px',
                        border: '1px solid rgba(255, 255, 255, 0.08)',
                        background: 'rgba(4, 6, 12, 0.9)',
                        color: '#e0f0ff',
                        padding: '12px',
                        fontSize: '0.82rem',
                        fontFamily: 'Consolas, \"SFMono-Regular\", \"Segoe UI\", monospace',
                        resize: 'none',
                        lineHeight: 1.5,
                      }}
                    />
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                      <div style={{ fontSize: '0.75rem', color: '#7f96b2' }}>
                        {isEditorLoading
                          ? 'Loading editor...'
                          : isEditorDirty
                            ? 'Unsaved changes'
                            : 'In sync'}
                        {editorStatus ? ` | ${editorStatus}` : ''}
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
                        Local Ollama Reviewer
                      </div>
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
                        Coding Chat (Ollama)
                      </div>
                      <div style={{ fontSize: '0.72rem', color: '#7f96b2' }}>
                        Model: {ollamaModel || DEFAULT_OLLAMA_MODEL}
                      </div>
                      <div
                        style={{
                          maxHeight: '220px',
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
                      </div>
                      {chatStatus && (
                        <div style={{ fontSize: '0.72rem', color: '#9db3d3' }}>
                          {chatStatus}
                        </div>
                      )}
                      {chatError && (
                        <div style={{ fontSize: '0.72rem', color: '#ff7a7a' }}>
                          {chatError}
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
