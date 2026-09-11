/*
 * Thin Mobile bridge to the shared Renderer Markdown semantics (M03 T4).
 *
 * This is NOT a parser. Mobile consumes the exact same semantic sources that
 * Web/Studio ships - the shared markdown-it 15.0.1 engine configuration with
 * the H2O bounded GFM closure, and the Markdown -> Render IR adapter - so there
 * is one authoritative CommonMark/GFM path across surfaces. Nothing here forks
 * options, reimplements GFM, or introduces a second AST or version axis.
 *
 * Metro watches the repository root, so the shared sources are required in
 * place rather than copied into the Mobile tree.
 */

/* eslint-disable @typescript-eslint/no-require-imports -- the shared sources are
   classic CommonJS/UMD files consumed verbatim; require keeps them a single
   bundled module for Metro and avoids TypeScript inferring types from them. */

export type RenderMark = { kind: string; href?: string; title?: string };

export type RenderBlock = {
  kind: string;
  text?: string;
  marks?: RenderMark[];
  children?: RenderBlock[];
  blocks?: RenderBlock[];
  items?: RenderBlock[];
  rows?: RenderBlock[];
  cells?: RenderBlock[];
  level?: number;
  ordered?: boolean;
  start?: number;
  tight?: boolean;
  checked?: boolean;
  header?: boolean;
  align?: (string | null)[];
  code?: string;
  language?: string;
  info?: string;
  src?: string;
  alt?: string;
  title?: string;
};

export type SemanticMarkdown = {
  blocks: RenderBlock[];
  fallback: boolean;
  reason?: string;
};

type SharedEngineApi = {
  formalBaseEngine: () => unknown;
};

type SharedAdapterApi = {
  markdownToBlocks: (engine: unknown, source: string) => SemanticMarkdown;
};

const engineApi: SharedEngineApi =
  require('../../../../../src-surfaces-base/studio/renderer/markdown/markdown-engine.v1.js');
const adapterApi: SharedAdapterApi =
  require('../../../../../src-surfaces-base/studio/renderer/markdown/markdown-ir-adapter.v1.js');

/* One formal-base engine per JS runtime. markdown-it instances are reusable,
 * and formal CommonMark/GFM semantics are the cross-surface authority: no
 * dated provider profile is selected here. */
let sharedEngine: unknown = null;

function formalBaseEngine(): unknown {
  if (sharedEngine === null) sharedEngine = engineApi.formalBaseEngine();
  return sharedEngine;
}

/**
 * Markdown source -> Render-IR-shaped semantic blocks through the shared
 * adapter. `fallback: true` means the shared pipeline could not produce
 * semantic blocks and the author's source must be shown verbatim; there is no
 * hidden legacy parser behind it.
 */
export function parseMarkdownToRenderBlocks(source: string): SemanticMarkdown {
  const text = typeof source === 'string' ? source : String(source ?? '');
  try {
    const result = adapterApi.markdownToBlocks(formalBaseEngine(), text);
    if (!result || !Array.isArray(result.blocks)) {
      return { blocks: [], fallback: true, reason: 'adapter-returned-no-blocks' };
    }
    return result;
  } catch (error) {
    return { blocks: [], fallback: true, reason: error instanceof Error ? error.message : String(error) };
  }
}
