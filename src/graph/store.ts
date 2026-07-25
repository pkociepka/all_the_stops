import type { CompressedGraph } from './types';

let _graph: CompressedGraph | null = null;

export function setCurrentGraph(g: CompressedGraph): void {
  _graph = g;
}

export function getCurrentGraph(): CompressedGraph | null {
  return _graph;
}

export function clearGraph(): void {
  _graph = null;
}
