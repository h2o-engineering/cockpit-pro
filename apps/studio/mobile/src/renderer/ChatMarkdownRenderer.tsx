import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useTheme } from '@/hooks/use-theme';
import { parseMarkdownToRenderBlocks, type RenderBlock, type RenderMark } from './semantic-markdown';
import { createChatRendererSkin } from './skin';

/*
 * Mobile PRESENTATION of the shared Markdown semantics (M03 T4).
 *
 * Semantics come from the shared markdown-it + H2O GFM pipeline through
 * ./semantic-markdown; this component only projects accepted Render IR kinds
 * and marks onto React Native primitives. It holds no parser and no second
 * token vocabulary. Links and images are presentational for T4: Mobile has no
 * governed live URL sink yet, so no navigation or resource-load authority is
 * introduced here.
 */

type ChatMarkdownRendererProps = {
  text: string;
  selectable?: boolean;
  onTextPressIn?: () => void;
  onTextPressOut?: () => void;
  onTextLongPress?: (currentText: string) => void;
};

type HeadingLevel = 1 | 2 | 3;

/* The skin defines h1-h3 typography; deeper headings use the smallest. */
function headingLevel(level: unknown): HeadingLevel {
  const n = Number(level);
  if (n <= 1) return 1;
  if (n === 2) return 2;
  return 3;
}

/* Author text of an inline collection, for long-press context. Images
 * contribute their alt text; hard breaks contribute a newline. */
function inlineToText(children: RenderBlock[] | undefined): string {
  if (!Array.isArray(children)) return '';
  return children.map((node) => {
    if (node.kind === 'text') return node.text ?? '';
    if (node.kind === 'image') return node.alt ?? node.src ?? '';
    if (node.kind === 'hardBreak') return '\n';
    return '';
  }).join('');
}

function blocksToText(blocks: RenderBlock[] | undefined): string {
  if (!Array.isArray(blocks)) return '';
  return blocks.map((block) => {
    if (block.kind === 'codeBlock') return block.code ?? '';
    if (block.kind === 'list') return blocksToText(block.items);
    if (block.kind === 'listItem' || block.kind === 'blockquote' || block.kind === 'tableCell') return blocksToText(block.blocks);
    if (block.kind === 'table') return blocksToText(block.rows);
    if (block.kind === 'tableRow') return blocksToText(block.cells);
    return inlineToText(block.children);
  }).join('\n');
}

export function ChatMarkdownRenderer({
  text,
  selectable = true,
  onTextPressIn,
  onTextPressOut,
  onTextLongPress,
}: ChatMarkdownRendererProps) {
  const th = useTheme();
  const skin = createChatRendererSkin(th);
  const parsed = parseMarkdownToRenderBlocks(text);

  function commonTextProps(currentText: string) {
    return {
      selectable,
      onPressIn: onTextPressIn,
      onPressOut: onTextPressOut,
      onLongPress: onTextLongPress ? () => onTextLongPress(currentText) : undefined,
      suppressHighlighting: true,
    };
  }

  /* Marks nest deterministically: marks[0] outermost, so wrap from the last. */
  function applyMarks(node: React.ReactNode, marks: RenderMark[] | undefined, key: number, fontSize: number): React.ReactNode {
    if (!Array.isArray(marks) || marks.length === 0) return node;
    let current = node;
    for (let i = marks.length - 1; i >= 0; i -= 1) {
      const mark = marks[i];
      if (mark.kind === 'strong') current = <Text key={`${key}-s${i}`} style={{ fontWeight: '700' }}>{current}</Text>;
      else if (mark.kind === 'emphasis') current = <Text key={`${key}-e${i}`} style={{ fontStyle: 'italic' }}>{current}</Text>;
      else if (mark.kind === 'code') current = <Text key={`${key}-c${i}`} style={skin.inlineCode(fontSize)}>{current}</Text>;
      else if (mark.kind === 'strikethrough') current = <Text key={`${key}-d${i}`} style={{ textDecorationLine: 'line-through' }}>{current}</Text>;
      else if (mark.kind === 'link') current = <Text key={`${key}-l${i}`} style={{ textDecorationLine: 'underline' }}>{current}</Text>;
    }
    return current;
  }

  function renderInline(children: RenderBlock[] | undefined, fontSize?: number): React.ReactNode[] {
    const base = fontSize ?? skin.bodyFontSize;
    if (!Array.isArray(children)) return [];
    return children.map((node, i) => {
      if (node.kind === 'text') return applyMarks(node.text ?? '', node.marks, i, base);
      if (node.kind === 'hardBreak') return '\n';
      if (node.kind === 'image') {
        /* Truthful alt/text semantics; no image sink exists on Mobile yet. */
        return <Text key={i} style={{ fontStyle: 'italic' }}>{node.alt || node.src || ''}</Text>;
      }
      return null;
    });
  }

  function renderInlineBlock(block: RenderBlock, index: number, style: unknown, fontSize?: number): React.ReactNode {
    const currentText = inlineToText(block.children);
    return (
      <Text key={index} {...commonTextProps(currentText)} style={style as never}>
        {renderInline(block.children, fontSize)}
      </Text>
    );
  }

  function renderList(block: RenderBlock, index: number, depth: number): React.ReactNode {
    const items = Array.isArray(block.items) ? block.items : [];
    const ordered = block.ordered === true;
    const start = Number.isInteger(block.start) ? Number(block.start) : 1;
    return (
      <View key={index} style={[skin.list, depth > 0 ? { marginTop: 2 } : null]}>
        {items.map((item, j) => {
          const itemBlocks = Array.isArray(item.blocks) ? item.blocks : [];
          const [first, ...rest] = itemBlocks;
          const leadInline = first && (first.kind === 'paragraph' || first.kind === 'heading') ? first.children : undefined;
          const trailing = leadInline ? rest : itemBlocks;
          const marker = typeof item.checked === 'boolean'
            ? (item.checked ? '☑' : '☐')
            : (ordered ? `${start + j}.` : '•');
          const currentText = leadInline ? inlineToText(leadInline) : blocksToText(itemBlocks);
          return (
            <View key={j}>
              <View style={skin.listRow}>
                <Text style={skin.listMarker}>{marker}</Text>
                <Text {...commonTextProps(currentText)} style={skin.listText}>
                  {leadInline ? renderInline(leadInline) : null}
                </Text>
              </View>
              {trailing.length > 0 ? (
                <View style={{ paddingLeft: 12 }}>
                  {trailing.map((child, k) => renderBlock(child, k, depth + 1))}
                </View>
              ) : null}
            </View>
          );
        })}
      </View>
    );
  }

  function renderTable(block: RenderBlock, index: number): React.ReactNode {
    const rows = Array.isArray(block.rows) ? block.rows : [];
    const align = Array.isArray(block.align) ? block.align : [];
    return (
      <View key={index} style={{ gap: 2 }}>
        {rows.map((row, r) => {
          const cells = Array.isArray(row.cells) ? row.cells : [];
          const header = row.header === true;
          return (
            <View key={r} style={{ flexDirection: 'row', gap: 8 }}>
              {cells.map((cell, c) => {
                const a = align[c];
                const textAlign = a === 'left' || a === 'center' || a === 'right' ? a : undefined;
                const inner = Array.isArray(cell.blocks) ? cell.blocks : [];
                const currentText = blocksToText(inner);
                return (
                  <Text
                    key={c}
                    {...commonTextProps(currentText)}
                    style={[skin.paragraphText, { flex: 1, textAlign, fontWeight: header ? '700' : undefined }]}
                  >
                    {inner.map((b) => (b.kind === 'paragraph' ? renderInline(b.children) : blocksToText([b])))}
                  </Text>
                );
              })}
            </View>
          );
        })}
      </View>
    );
  }

  function renderBlock(block: RenderBlock, index: number, depth = 0): React.ReactNode {
    switch (block.kind) {
      case 'heading': {
        const level = headingLevel(block.level);
        return renderInlineBlock(block, index, skin.headingText(level, index), skin.headingFontSize(level));
      }
      case 'paragraph':
        return renderInlineBlock(block, index, skin.paragraphText);
      case 'thematicBreak':
        return <View key={index} style={skin.hr} />;
      case 'codeBlock': {
        const code = block.code ?? '';
        return (
          <View key={index} style={skin.codeBlock}>
            <ScrollView horizontal showsHorizontalScrollIndicator bounces contentContainerStyle={skin.codeScrollContent}>
              <Text {...commonTextProps(code)} style={skin.codeText}>{code}</Text>
            </ScrollView>
          </View>
        );
      }
      case 'list':
        return renderList(block, index, depth);
      case 'blockquote': {
        const inner = Array.isArray(block.blocks) ? block.blocks : [];
        return (
          <View key={index} style={{ borderLeftWidth: 2, borderLeftColor: 'rgba(127,127,127,0.5)', paddingLeft: 10 }}>
            {inner.map((child, k) => renderBlock(child, k, depth + 1))}
          </View>
        );
      }
      case 'table':
        return renderTable(block, index);
      default:
        return null;
    }
  }

  if (parsed.fallback) {
    /* Deterministic whole-message verbatim fallback: the author's characters
     * stay visible as plain text. No legacy parser exists behind this. */
    if (!text) return null;
    return (
      <View style={skin.root}>
        <Text {...commonTextProps(text)} style={skin.paragraphText}>{text}</Text>
      </View>
    );
  }

  if (parsed.blocks.length === 0) return null;

  return (
    <View style={skin.root}>
      {parsed.blocks.map((block, i) => renderBlock(block, i))}
    </View>
  );
}
